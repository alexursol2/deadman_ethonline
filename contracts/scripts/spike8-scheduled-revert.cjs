/**
 * SPIKE 8 — if a scheduled call's execution reverts, is the schedule consumed?
 *
 * Plan 04 Q4 rests on "the schedule is consumed by its execution, and there is
 * no second schedule". Never measured. It decides whether refund()'s
 * no-revert-after-CAS rule is critical or merely tidy.
 *
 * Two schedules armed together:
 *   S_ok      -> ping(),          expected to execute normally.  THE CONTROL.
 *   S_revert  -> alwaysReverts(), reverts inside the scheduled execution.
 *
 * Without S_ok, "S_revert never executed" is indistinguishable from "the network
 * was not executing scheduled calls in that window at all".
 *
 *   npx hardhat run scripts/spike8-scheduled-revert.cjs --network hederaTestnet
 */
const hre = require("hardhat");
const { ethers } = hre;
const {
  readEvidence,
  saveEvidence,
  findEvent,
  mirrorGet,
  mirrorGetUntil,
  toEntityId,
  scheduleLink,
  txLink,
  jsonSafe,
  report,
  fmtTinybar,
  sleep,
} = require("./lib.cjs");

const ARM_TX_GAS = 5_000_000;
const ATTEMPT_GAS = 4_000_000;
const DELAY_SECONDS = 90;
const SCHEDULED_GAS = 150_000;
const EXTRA_WATCH_MS = 60_000; // does it retry later rather than never?

async function armTarget(c, fnName, tag) {
  const inner = c.interface.encodeFunctionData(fnName, [ethers.encodeBytes32String(tag)]);
  const tx = await c.armWithValue(await c.getAddress(), DELAY_SECONDS, SCHEDULED_GAS, 0, inner, {
    gasLimit: ARM_TX_GAS,
  });
  const ev = findEvent(c, await tx.wait(), "ArmedWithValue");
  if (!ev) throw new Error(`No ArmedWithValue event in ${tx.hash}`);
  const entityId = toEntityId(ev.args.scheduleAddress);
  console.log(`    ${tag.padEnd(9)} -> ${fnName}()  schedule ${entityId}  expiry ${ev.args.expirySecond}`);
  console.log(`                 ${scheduleLink(entityId)}`);
  return {
    tag,
    fnName,
    txHash: tx.hash,
    scheduleAddress: ev.args.scheduleAddress,
    entityId,
    expirySecond: Number(ev.args.expirySecond),
  };
}

async function readSched(entityId, label) {
  const r = await mirrorGet(`/api/v1/schedules/${entityId}`, { label });
  return r.ok ? r.body : null;
}

async function main() {
  const [operator] = await ethers.getSigners();
  const address = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;
  const c = await ethers.getContractAt("SpikeSchedule", address, operator);
  console.log(`\n  contract  ${address}`);

  const before = {
    balanceTinybar: await c.balanceTinybar(),
    pingCount: await c.pingCount(),
  };
  console.log(`  balance   ${fmtTinybar(before.balanceTinybar)}`);
  console.log(`  pingCount ${before.pingCount}`);

  console.log(`\n  arming both, ${DELAY_SECONDS}s out:`);
  const sOk = await armTarget(c, "ping", "s-ok");
  const sRevert = await armTarget(c, "alwaysReverts", "s-revert");

  // Control reads. Neither result means anything if the schedules were not there.
  console.log(`\n  control reads:`);
  for (const s of [sOk, sRevert]) {
    const rec = await readSched(s.entityId, `control ${s.tag}`);
    if (!rec || rec.deleted === true || rec.executed_timestamp) {
      throw new Error(`Control failed for ${s.tag} (${s.entityId}) — result would be meaningless.`);
    }
    console.log(`    ${s.tag.padEnd(9)} exists, deleted=${rec.deleted}, executed=${rec.executed_timestamp}`);
  }

  const latestExpiry = Math.max(sOk.expirySecond, sRevert.expirySecond);
  const waitS = latestExpiry + 30 - Math.floor(Date.now() / 1000);
  if (waitS > 0) {
    console.log(`\n  waiting ${waitS}s for both target seconds to pass...`);
    await sleep(waitS * 1000);
  }

  // The control must have executed, or nothing below is interpretable.
  console.log(`\n  polling the CONTROL (s-ok):`);
  const okRes = await mirrorGetUntil(`/api/v1/schedules/${sOk.entityId}`, (r) => !!r.executed_timestamp, {
    label: "s-ok executed",
  });
  console.log(`    executed_timestamp ${okRes.record?.executed_timestamp}  (after ${okRes.waitedMs}ms)`);
  const controlExecuted = okRes.settled;
  if (!controlExecuted) {
    console.log(`    *** the control did NOT execute. The network was not running schedules.`);
    console.log(`    *** Nothing can be concluded about s-revert from this run.`);
  }

  console.log(`\n  polling the SUBJECT (s-revert):`);
  const revRes = await mirrorGetUntil(
    `/api/v1/schedules/${sRevert.entityId}`,
    (r) => !!r.executed_timestamp,
    { label: "s-revert executed" },
  );
  console.log(`    executed_timestamp ${revRes.record?.executed_timestamp}  (after ${revRes.waitedMs}ms)`);
  console.log(`    deleted            ${revRes.record?.deleted}`);

  // Did it fire late, or retry?
  console.log(`\n  watching s-revert a further ${EXTRA_WATCH_MS / 1000}s for a late or retried execution...`);
  await sleep(EXTRA_WATCH_MS);
  const revLate = await readSched(sRevert.entityId, "s-revert late");
  console.log(`    executed_timestamp ${revLate?.executed_timestamp}  deleted ${revLate?.deleted}`);

  const consumed = !!revLate?.executed_timestamp;

  const after = {
    balanceTinybar: await c.balanceTinybar(),
    pingCount: await c.pingCount(),
  };
  const spentTinybar = before.balanceTinybar - after.balanceTinybar;
  console.log(`\n  balance   ${fmtTinybar(before.balanceTinybar)} -> ${fmtTinybar(after.balanceTinybar)}`);
  console.log(`  spent     ${spentTinybar} tinybar across BOTH executions`);
  console.log(`  pingCount ${before.pingCount} -> ${after.pingCount}`);

  // Find the reverting execution's own contract result, if the mirror recorded one.
  let revertResult = null;
  const results = await mirrorGet(`/api/v1/contracts/${address}/results?limit=25&order=desc`, {
    label: "contract results",
  });
  if (results.ok && Array.isArray(results.body?.results)) {
    const hit = results.body.results.find(
      (r) => r.result === "CONTRACT_REVERT_EXECUTED" && r.timestamp >= String(sRevert.expirySecond),
    );
    if (hit) {
      revertResult = { timestamp: hit.timestamp, result: hit.result, errorMessage: hit.error_message, hash: hit.hash };
      console.log(`\n  the reverting execution IS recorded on the mirror:`);
      console.log(`    ${hit.timestamp}  ${hit.result}  error ${hit.error_message}`);
    } else {
      console.log(`\n  no CONTRACT_REVERT_EXECUTED found at or after ${sRevert.expirySecond}`);
    }
  }

  /* --------------------------------------------------------------- cleanup */
  let cleanedUp = null;
  if (!consumed) {
    console.log(`\n  s-revert is still armed. Deleting it so it cannot fire into a later run...`);
    try {
      const tx = await c.tryCancelViaHss(sRevert.scheduleAddress, { gasLimit: ATTEMPT_GAS });
      const ev = findEvent(c, await tx.wait(), "CancelAttempt");
      cleanedUp = ev?.args.code?.toString() === "22";
      console.log(`    code ${ev?.args.code}  ${txLink(tx.hash)}`);
    } catch (err) {
      console.log(`    THREW ${String(err.shortMessage || err.message).slice(0, 120)}`);
      cleanedUp = false;
    }
  }

  /* --------------------------------------------------------------- verdict */
  const verdict = !controlExecuted
    ? "INCONCLUSIVE — the control schedule did not execute either"
    : consumed
      ? "CONSUMED — a reverting scheduled execution still spends its schedule"
      : "NOT CONSUMED — the schedule survived a reverting execution";

  const allPassed = report("SPIKE 8 — does a reverting scheduled execution consume its schedule?", [
    {
      name: "CONTROL: s-ok executed, so the network was running schedules",
      expected: "executed_timestamp present",
      actual: String(okRes.record?.executed_timestamp),
      pass: controlExecuted,
    },
    {
      name: "CONTROL: pingCount incremented exactly once",
      expected: String(before.pingCount + 1n),
      actual: String(after.pingCount),
      pass: after.pingCount === before.pingCount + 1n,
    },
    {
      name: "SUBJECT: s-revert's executed_timestamp (this is the measurement, either value is a valid finding)",
      expected: "recorded either way",
      actual: consumed ? `present: ${revLate.executed_timestamp}` : "null — still armed",
      pass: true,
    },
  ]);

  console.log(`  VERDICT: ${verdict}\n`);

  saveEvidence(
    "spike8-result.json",
    jsonSafe({
      verdict,
      controlExecuted,
      scheduleConsumedByRevertingExecution: controlExecuted ? consumed : null,
      contract: address,
      control: { ...sOk, record: okRes.record },
      subject: { ...sRevert, recordAfterExpiry: revRes.record, recordAfterExtraWatch: revLate },
      revertingExecutionRecord: revertResult,
      before,
      after,
      spentTinybarBothExecutions: spentTinybar,
      cleanedUp,
      ranAt: new Date().toISOString(),
    }),
  );

  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
