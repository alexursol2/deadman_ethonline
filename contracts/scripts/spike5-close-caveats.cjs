/**
 * SPIKE 5 — close the caveats spikes 1, 2 and 4 left open.
 *
 *   5a  can the OWNER contract cancel via the redirect path (0xc61dea85)?
 *       Implemented in spike 2 and never exercised, because 2a passed first.
 *
 *   5b  can the DEPLOYING EOA delete a schedule its own contract created?
 *       Spike 4 used a fresh stranger's key on purpose, which left our own
 *       operator's position untested. Expected: no. If it is yes, we hold a
 *       privileged cancel over every hold and the pitch has to say so.
 *
 *   5c  decode the schedule's admin_key from the mirror record, so the
 *       authorisation model is evidence rather than inference.
 *
 *   npx hardhat run scripts/spike5-close-caveats.cjs --network hederaTestnet
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
  report,
} = require("./lib.cjs");

const HSS_ADDRESS = "0x000000000000000000000000000000000000016b";
const SEL_DELETE_SCHEDULE = "0x72d42394";
const SEL_DELETE_REDIRECT = "0xc61dea85";

const ARM_TX_GAS = 5_000_000;
const ATTEMPT_GAS = 4_000_000;
const DELAY_SECONDS = 600;
const SCHEDULED_GAS = 150_000;

/**
 * Decode a Hedera protobuf-encoded Key just far enough to answer "is this a
 * ContractID, and which one?". Hand-rolled because pulling the whole SDK in to
 * read seven bytes is worse than showing the reader the seven bytes.
 *
 * Key.contractID is field 1, wire type 2. ContractID.contractNum is field 3, varint.
 */
function decodeKey(hexKey) {
  const b = Buffer.from(hexKey.replace(/^0x/, ""), "hex");
  const out = { raw: hexKey, kind: "unknown", contractNum: null, entityId: null };
  if (b.length < 2) return out;
  const tag = b[0];
  if (tag >> 3 !== 1 || (tag & 7) !== 2) {
    out.kind = `not a contractID (field ${tag >> 3}, wiretype ${tag & 7})`;
    return out;
  }
  const inner = b.subarray(2, 2 + b[1]);
  if (inner.length < 2 || inner[0] >> 3 !== 3) {
    out.kind = "contractID with no contractNum";
    return out;
  }
  let v = 0n;
  let shift = 0n;
  for (let i = 1; i < inner.length; i++) {
    v |= BigInt(inner[i] & 0x7f) << shift;
    shift += 7n;
    if (!(inner[i] & 0x80)) break;
  }
  out.kind = "ContractID";
  out.contractNum = v.toString();
  out.entityId = `0.0.${v}`;
  return out;
}

async function readSchedule(entityId, label) {
  const res = await mirrorGet(`/api/v1/schedules/${entityId}`, { label });
  return { exists: res.ok, attemptsUsed: res.attemptsUsed, record: res.ok ? res.body : null };
}

async function armAndControl(victim, tag) {
  const tx = await victim.arm(DELAY_SECONDS, SCHEDULED_GAS, ethers.encodeBytes32String(tag), {
    gasLimit: ARM_TX_GAS,
  });
  const receipt = await tx.wait();
  const ev = findEvent(victim, receipt, "Armed");
  if (!ev) throw new Error(`No Armed event in ${tx.hash}`);
  const scheduleAddress = ev.args.scheduleAddress;
  const entityId = toEntityId(scheduleAddress);
  console.log(`    armed ${entityId}  ${scheduleLink(entityId)}`);

  const control = await readSchedule(entityId, `control ${entityId}`);
  if (!control.exists || control.record.deleted === true) {
    throw new Error(`Control failed for ${entityId} — result would be meaningless.`);
  }
  console.log(`    control: exists after ${control.attemptsUsed} attempt(s), deleted=${control.record.deleted}`);
  return { scheduleAddress, entityId, control };
}

async function main() {
  const [operator] = await ethers.getSigners();
  const victimAddress = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;
  const victim = await ethers.getContractAt("SpikeSchedule", victimAddress, operator);
  const results = {};

  console.log(`\n  contract   ${victimAddress}`);
  console.log(`  operator   ${operator.address}  (the DEPLOYER — this is the point of 5b)`);

  /* ------------------------------------------------------------------ 5a */
  console.log(`\n  === 5a: owner contract cancels via the REDIRECT path 0xc61dea85 ===`);
  const a = await armAndControl(victim, "spike5a");
  const aTx = await victim.tryCancelViaRedirect(a.scheduleAddress, { gasLimit: ATTEMPT_GAS });
  const aReceipt = await aTx.wait();
  const aEv = findEvent(victim, aReceipt, "CancelAttempt");
  console.log(`    callOk=${aEv?.args.callOk} code=${aEv?.args.code} returnData=${aEv?.args.returnData}`);
  console.log(`    ${txLink(aTx.hash)}`);
  const aAfter = await readSchedule(a.entityId, "5a after");
  console.log(`    mirror: deleted=${aAfter.record?.deleted}`);
  const passed5a = aEv?.args.callOk === true && aEv?.args.code === 22n && aAfter.record?.deleted === true;
  results["5a"] = {
    entityId: a.entityId,
    hashscan: scheduleLink(a.entityId),
    txHash: aTx.hash,
    callOk: aEv?.args.callOk ?? null,
    code: aEv?.args.code?.toString() ?? null,
    returnData: aEv?.args.returnData ?? null,
    deletedAfter: aAfter.record?.deleted ?? null,
    passed: passed5a,
  };

  /* ------------------------------------------------------------------ 5b */
  console.log(`\n  === 5b: the DEPLOYING EOA tries to delete its own contract's schedule ===`);
  const b = await armAndControl(victim, "spike5b");
  const attempts = {};
  for (const [id, to, data] of [
    ["hss", HSS_ADDRESS, SEL_DELETE_SCHEDULE + ethers.zeroPadValue(b.scheduleAddress, 32).slice(2)],
    ["redirect", b.scheduleAddress, SEL_DELETE_REDIRECT],
  ]) {
    console.log(`\n    deployer EOA -> ${id}`);
    let rec = { txHash: null, txStatus: null, callResult: null, threw: null };
    try {
      const tx = await operator.sendTransaction({ to, data, gasLimit: ATTEMPT_GAS });
      const r = await tx.wait();
      rec.txHash = tx.hash;
      rec.txStatus = r.status;
      console.log(`      tx status ${r.status} gasUsed ${r.gasUsed}  ${txLink(tx.hash)}`);
      // The refusal lives in the return data, not in a revert — see spike 4.
      const mr = await mirrorGet(`/api/v1/contracts/results/${tx.hash}`, { label: `${id} result` });
      rec.callResult = mr.ok ? mr.body.call_result : null;
      rec.decodedCode = rec.callResult && rec.callResult !== "0x" ? BigInt(rec.callResult).toString() : null;
      console.log(`      call_result ${rec.callResult}  -> code ${rec.decodedCode}`);
    } catch (err) {
      rec.threw = String(err.shortMessage || err.message).slice(0, 200);
      console.log(`      THREW ${rec.threw}`);
    }
    const after = await readSchedule(b.entityId, `5b ${id} after`);
    rec.deletedAfter = after.record?.deleted ?? null;
    rec.refused = after.record?.deleted !== true;
    console.log(`      mirror: deleted=${rec.deletedAfter} -> ${rec.refused ? "REFUSED" : "*** DELETED ***"}`);
    attempts[id] = rec;
  }
  const passed5b = attempts.hss.refused && attempts.redirect.refused;
  results["5b"] = { entityId: b.entityId, hashscan: scheduleLink(b.entityId), attempts, passed: passed5b };

  /* ------------------------------------------------------------------ 5c */
  console.log(`\n  === 5c: admin_key on the schedule record ===`);
  const keyHex = b.control.record.admin_key?.key;
  const decoded = decodeKey(keyHex ?? "");
  const contractInfo = await mirrorGet(`/api/v1/contracts/${victimAddress}`, { label: "contract id" });
  const victimEntityId = contractInfo.ok ? contractInfo.body.contract_id : null;
  console.log(`    admin_key raw     ${keyHex}`);
  console.log(`    decoded           ${decoded.kind} ${decoded.entityId ?? ""}`);
  console.log(`    victim contract   ${victimEntityId}`);
  console.log(`    creator_account   ${b.control.record.creator_account_id}  (paid for the arming tx)`);
  console.log(`    payer_account     ${b.control.record.payer_account_id}  (pays at execution)`);
  const passed5c = decoded.kind === "ContractID" && decoded.entityId === victimEntityId;
  results["5c"] = {
    adminKeyRaw: keyHex,
    decoded,
    victimEntityId,
    creatorAccountId: b.control.record.creator_account_id,
    payerAccountId: b.control.record.payer_account_id,
    adminKeyIsCreatingContract: passed5c,
  };

  /* -------------------------------------------------------------- cleanup */
  console.log(`\n  cleanup: contract deletes the 5b schedule...`);
  let cleanedUp = false;
  try {
    await (await victim.tryCancelViaHss(b.scheduleAddress, { gasLimit: ATTEMPT_GAS })).wait();
    const after = await readSchedule(b.entityId, "cleanup");
    cleanedUp = after.record?.deleted === true;
  } catch (err) {
    console.log(`    cleanup threw ${err.shortMessage || err.message}`);
  }
  console.log(`    ${cleanedUp ? "ok" : "FAILED — a schedule is still armed and will fire"}`);

  const allPassed = report("SPIKE 5 — caveat closure", [
    {
      name: "5a  owner contract CAN cancel via the redirect path",
      expected: "code 22, deleted true",
      actual: `code ${results["5a"].code}, deleted ${results["5a"].deletedAfter}`,
      pass: passed5a,
    },
    {
      name: "5b  the DEPLOYING EOA cannot delete its contract's schedule",
      expected: "both paths refused, schedule survives",
      actual: `hss ${attempts.hss.refused ? "refused" : "DELETED"}, redirect ${attempts.redirect.refused ? "refused" : "DELETED"}`,
      pass: passed5b,
    },
    {
      name: "5c  admin_key is the creating contract's ContractID",
      expected: victimEntityId,
      actual: `${decoded.kind} ${decoded.entityId ?? "-"}`,
      pass: passed5c,
    },
    { name: "cleanup left no live schedule", expected: "true", actual: String(cleanedUp), pass: cleanedUp },
  ]);

  saveEvidence("spike5-result.json", jsonSafe({ passed: allPassed, contract: victimAddress, operator: operator.address, results, cleanedUp, ranAt: new Date().toISOString() }));
  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
