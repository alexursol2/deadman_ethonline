/**
 * SPIKE 2 — can a contract cancel its own pending schedule?
 *
 * This is the one that changes the design. If a contract cannot delete the
 * schedule it created, the happy path stops being "seller delivers, refund is
 * cancelled" and becomes "the refund always fires and the seller re-collects",
 * which is a different product.
 *
 * HIP-1215 documents TWO delete paths and does not say who is authorised to use
 * either, so this is a matrix, not a yes/no:
 *
 *            | deleteSchedule(address) on 0x16b | redirect deleteSchedule() on the schedule
 *   contract | 2a  the happy path               | 2c  the fallback that could save the design
 *   EOA      | 2b  diagnostic only              | 2d  diagnostic only
 *
 * 2a is the only cell that has to pass. 2c runs automatically if 2a fails.
 * 2b and 2d run only if BOTH contract-side cells fail, and then we stop — they
 * distinguish "nobody may delete" from "only an external signer may delete",
 * which are different products and need a human decision, not another script.
 */
const hre = require("hardhat");
const { ethers } = hre;
const {
  readEvidence,
  saveEvidence,
  findEvent,
  mirrorGet,
  toEntityId,
  scheduleLink,
  txLink,
  jsonSafe,
  sleep,
  report,
} = require("./lib.cjs");

/** See spike1-arm.cjs — scheduleCall needs ~1.45M gas of its own. */
const ARM_TX_GAS = 5_000_000;
/** deleteSchedule is a system-contract call too; do not starve it. */
const CANCEL_TX_GAS = 4_000_000;

const DELAY_SECONDS = 300;
const GAS_LIMIT = 150_000;
const HSS_ADDRESS = "0x000000000000000000000000000000000000016b";
const SEL_DELETE_SCHEDULE = "0x72d42394";
const SEL_DELETE_REDIRECT = "0xc61dea85";

/** Arm one schedule and return everything we need to talk about it. */
async function armOne(contract, tag) {
  const tx = await contract.arm(DELAY_SECONDS, GAS_LIMIT, ethers.encodeBytes32String(tag), {
    gasLimit: ARM_TX_GAS,
  });
  const receipt = await tx.wait();
  const ev = findEvent(contract, receipt, "Armed");
  if (!ev) throw new Error(`No Armed event in ${tx.hash}`);
  const scheduleAddress = ev.args.scheduleAddress;
  const entityId = toEntityId(scheduleAddress);
  const expirySecond = Number(ev.args.expirySecond);
  console.log(`    armed ${entityId} (${scheduleAddress}) expiring ${expirySecond}`);
  console.log(`    ${scheduleLink(entityId)}`);
  return { tag, txHash: tx.hash, scheduleAddress, entityId, expirySecond, code: ev.args.code };
}

/**
 * The control read. Without this, "never executed" proves nothing — the schedule
 * might never have been created in the first place.
 *
 * Amendment 3: 3 attempts with backoff before concluding absence, because the
 * mirror node is eventually consistent and a cold read here looks exactly like a
 * design failure.
 */
async function controlRead(entityId) {
  const res = await mirrorGet(`/api/v1/schedules/${entityId}`, { label: `control ${entityId}` });
  if (!res.ok) {
    return { exists: false, attemptsUsed: res.attemptsUsed, status: res.status, record: res.body };
  }
  const r = res.body;
  console.log(
    `    exists after ${res.attemptsUsed} attempt(s): deleted=${r.deleted} executed_timestamp=${r.executed_timestamp}`,
  );
  return { exists: true, attemptsUsed: res.attemptsUsed, status: res.status, record: r };
}

/** Try one contract-side cancel path and read the CancelAttempt event. */
async function tryCancel(contract, path, scheduleAddress) {
  const fn = path === "hss" ? "tryCancelViaHss" : "tryCancelViaRedirect";
  console.log(`\n    calling ${fn}(${scheduleAddress})...`);
  let txHash = null;
  try {
    const tx = await contract[fn](scheduleAddress, { gasLimit: CANCEL_TX_GAS });
    txHash = tx.hash;
    const receipt = await tx.wait();
    const ev = findEvent(contract, receipt, "CancelAttempt");
    const out = {
      path,
      txHash,
      txStatus: receipt.status,
      callOk: ev ? ev.args.callOk : null,
      code: ev ? ev.args.code.toString() : null,
      returnData: ev ? ev.args.returnData : null,
      success: ev ? ev.args.callOk === true && ev.args.code === 22n : false,
    };
    console.log(`    callOk=${out.callOk} code=${out.code} returnData=${out.returnData}`);
    console.log(`    ${txLink(txHash)}`);
    return out;
  } catch (err) {
    console.log(`    THREW: ${err.shortMessage || err.message}`);
    return { path, txHash, callOk: false, code: null, returnData: null, success: false, error: String(err.shortMessage || err.message) };
  }
}

/** Diagnostics only. Runs when both contract-side cells have already failed. */
async function eoaCancel(signer, label, to, data) {
  console.log(`\n    ${label}: EOA -> ${to} ${data}`);
  try {
    const tx = await signer.sendTransaction({ to, data, gasLimit: CANCEL_TX_GAS });
    const receipt = await tx.wait();
    console.log(`    tx ${tx.hash} status ${receipt.status}`);
    return { label, txHash: tx.hash, txStatus: receipt.status, success: receipt.status === 1 };
  } catch (err) {
    console.log(`    THREW: ${err.shortMessage || err.message}`);
    return { label, success: false, error: String(err.shortMessage || err.message) };
  }
}

async function main() {
  const [signer] = await ethers.getSigners();
  const address = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;
  if (!address) throw new Error("No contract address. Run deploy first, or set SPIKE_CONTRACT_ADDRESS.");
  const contract = await ethers.getContractAt("SpikeSchedule", address, signer);

  const results = { contract, cells: {} };
  const pingBefore = await contract.pingCount();
  console.log(`\n  contract       ${address}`);
  console.log(`  pingCount now  ${pingBefore}`);

  /* ---------------------------------------------------------------- 2a */
  console.log(`\n  === 2a: contract deletes via 0x16b deleteSchedule(address) ===`);
  const a = await armOne(contract, "spike2a");
  console.log(`\n    control read before cancelling:`);
  const aControl = await controlRead(a.entityId);
  if (!aControl.exists) {
    throw new Error(
      `Control read failed: schedule ${a.entityId} not on the mirror node after ` +
        `${aControl.attemptsUsed} attempts. Cannot draw any conclusion about deletion — ` +
        `a "never executed" result here would be meaningless.`,
    );
  }
  const aCancel = await tryCancel(contract, "hss", a.scheduleAddress);
  console.log(`\n    re-reading after cancel:`);
  const aAfter = await controlRead(a.entityId);
  results.cells["2a"] = { ...a, control: aControl, cancel: aCancel, afterCancel: aAfter.record };

  const a_deleted = aAfter.exists && aAfter.record.deleted === true;
  const passed2a = aCancel.success && a_deleted;

  /* ---------------------------------------------------------------- 2c */
  let passed2c = null;
  let c = null;
  if (!passed2a) {
    console.log(`\n  2a did NOT pass. Trying the second contract-side path.`);
    console.log(`\n  === 2c: contract deletes via redirect deleteSchedule() on the schedule ===`);
    c = await armOne(contract, "spike2c");
    console.log(`\n    control read before cancelling:`);
    const cControl = await controlRead(c.entityId);
    const cCancel = await tryCancel(contract, "redirect", c.scheduleAddress);
    console.log(`\n    re-reading after cancel:`);
    const cAfter = await controlRead(c.entityId);
    results.cells["2c"] = { ...c, control: cControl, cancel: cCancel, afterCancel: cAfter.record };
    passed2c = cCancel.success && cAfter.exists && cAfter.record.deleted === true;
  }

  /* ------------------------------------------------------------ 2b / 2d */
  if (!passed2a && !passed2c) {
    console.log(`\n  *** BOTH CONTRACT-SIDE PATHS FAILED ***`);
    console.log(`  Running EOA diagnostics to distinguish "nobody may delete" from`);
    console.log(`  "only an external signer may delete". These are different products.`);

    const b = await armOne(contract, "spike2b");
    await controlRead(b.entityId);
    const bRes = await eoaCancel(
      signer,
      "2b EOA -> 0x16b deleteSchedule(address)",
      HSS_ADDRESS,
      SEL_DELETE_SCHEDULE + ethers.zeroPadValue(b.scheduleAddress, 32).slice(2),
    );
    const bAfter = await controlRead(b.entityId);
    results.cells["2b"] = { ...b, cancel: bRes, afterCancel: bAfter.record };

    const d = await armOne(contract, "spike2d");
    await controlRead(d.entityId);
    const dRes = await eoaCancel(signer, "2d EOA -> redirect deleteSchedule()", d.scheduleAddress, SEL_DELETE_REDIRECT);
    const dAfter = await controlRead(d.entityId);
    results.cells["2d"] = { ...d, cancel: dRes, afterCancel: dAfter.record };
  }

  /* ------------------------------------------------- did it stay dead? */
  const winner = passed2a ? a : passed2c ? c : null;
  let neverExecuted = null;
  if (winner) {
    const waitSec = winner.expirySecond + 60 - Math.floor(Date.now() / 1000);
    console.log(`\n  Cancel reported success. Waiting ${waitSec}s past the expiry second to`);
    console.log(`  confirm the schedule stays dead rather than merely being marked deleted...`);
    if (waitSec > 0) await sleep(waitSec * 1000);

    const pingAfter = await contract.pingCount();
    const finalRead = await controlRead(winner.entityId);
    neverExecuted = pingAfter === pingBefore && !finalRead.record?.executed_timestamp;
    console.log(`\n  pingCount before ${pingBefore} / after ${pingAfter}`);
    console.log(`  executed_timestamp ${finalRead.record?.executed_timestamp ?? null}`);
    results.finalPingCount = pingAfter.toString();
    results.finalRecord = finalRead.record;
  }

  /* ---------------------------------------------------------- verdict */
  const passedPath = passed2a ? "2a (0x16b deleteSchedule(address))" : passed2c ? "2c (redirect deleteSchedule())" : "NONE";
  const allPassed = report("SPIKE 2 — contract cancels its own schedule", [
    {
      name: "a contract-side delete path returned SUCCESS (22)",
      expected: "2a, or 2c as fallback",
      actual: passedPath,
      pass: Boolean(passed2a || passed2c),
    },
    {
      name: "mirror node shows deleted: true",
      expected: "true",
      actual: String(passed2a ? a_deleted : passed2c ? true : false),
      pass: Boolean(passed2a || passed2c),
    },
    {
      name: "the schedule never executed after its expiry second",
      expected: "pingCount unchanged, executed_timestamp null",
      actual: neverExecuted === null ? "not reached — no path succeeded" : String(neverExecuted),
      pass: neverExecuted === true,
    },
  ]);

  saveEvidence(
    "spike2-result.json",
    jsonSafe({
      passed: allPassed,
      passedPath,
      passed2a,
      passed2c,
      pingCountBefore: pingBefore,
      neverExecuted,
      cells: results.cells,
      finalRecord: results.finalRecord ?? null,
      ranAt: new Date().toISOString(),
    }),
  );

  if (!allPassed) {
    console.log(`  *** STOP. This changes the design. Report to Alex before writing anything else. ***\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
