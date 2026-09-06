/**
 * SPIKE 1, part 2 — did the network execute the call on its own?
 *
 * Four pass conditions, no partial credit:
 *   executed_timestamp present   the network ran it
 *   signatures: []               nobody signed it, which is the entire point
 *   wait_for_expiry: true        it waited for the second rather than firing on signature
 *   pingCount == 1               our state actually changed
 */
const hre = require("hardhat");
const { ethers } = hre;
const { readEvidence, saveEvidence, mirrorGet, report, jsonSafe, scheduleLink, sleep } = require("./lib.cjs");

async function main() {
  const armed = readEvidence("spike1-armed.json");
  if (!armed) throw new Error("No spike1-armed.json. Run spike1:arm first.");

  const { contract: address, scheduleEntityId, expirySecond } = armed;
  const contract = await ethers.getContractAt("SpikeSchedule", address);

  // Do not read before the target second has passed — a null executed_timestamp
  // at T-5s means "not yet", and reporting that as a failure would be wrong.
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < expirySecond + 15) {
    const waitMs = (expirySecond + 15 - nowSec) * 1000;
    console.log(`\n  target second not yet passed. Waiting ${Math.round(waitMs / 1000)}s...`);
    await sleep(waitMs);
  }

  // 1. On-chain state.
  const [pingCount, lastPingTimestamp, lastPingSender, lastTag] = await Promise.all([
    contract.pingCount(),
    contract.lastPingTimestamp(),
    contract.lastPingSender(),
    contract.lastTag(),
  ]);

  console.log(`\n  ON-CHAIN STATE`);
  console.log(`  pingCount          ${pingCount}`);
  console.log(`  lastPingTimestamp  ${lastPingTimestamp}`);
  console.log(`  lastPingSender     ${lastPingSender}`);
  console.log(`  lastTag            ${lastTag}`);

  // 2. Mirror node record.
  console.log(`\n  MIRROR NODE  /api/v1/schedules/${scheduleEntityId}`);
  const res = await mirrorGet(`/api/v1/schedules/${scheduleEntityId}`, { label: "schedule" });
  if (!res.ok) {
    console.error(`  mirror returned ${res.status} after ${res.attemptsUsed} attempts`);
    console.error(JSON.stringify(res.body, null, 2));
  }
  const rec = res.ok ? res.body : {};
  saveEvidence("spike1-schedule.json", jsonSafe(rec));

  const executedTimestamp = rec.executed_timestamp ?? null;
  const signatures = rec.signatures ?? null;
  const waitForExpiry = rec.wait_for_expiry ?? null;

  console.log(`  executed_timestamp ${executedTimestamp}`);
  console.log(`  signatures         ${JSON.stringify(signatures)}`);
  console.log(`  wait_for_expiry    ${waitForExpiry}`);
  console.log(`  deleted            ${rec.deleted}`);

  // How late into its target second did the network run it?
  let latencyMs = null;
  if (executedTimestamp) {
    latencyMs = Math.round((Number(executedTimestamp) - Number(expirySecond)) * 1000);
    console.log(`\n  executed ${latencyMs} ms after the target second`);
  }

  const allPassed = report("SPIKE 1 — network-executed scheduled call", [
    {
      name: "executed_timestamp present",
      expected: "non-null",
      actual: String(executedTimestamp),
      pass: executedTimestamp !== null && executedTimestamp !== undefined,
    },
    {
      name: "signatures is empty — nobody signed it",
      expected: "[]",
      actual: JSON.stringify(signatures),
      pass: Array.isArray(signatures) && signatures.length === 0,
    },
    {
      name: "wait_for_expiry is true",
      expected: "true",
      actual: String(waitForExpiry),
      pass: waitForExpiry === true,
    },
    {
      name: "pingCount incremented on chain",
      expected: "1",
      actual: String(pingCount),
      pass: pingCount === 1n,
    },
  ]);

  console.log(`  ${scheduleLink(scheduleEntityId)}`);

  if (!armed.jitterFallbackExercised) {
    console.log(`\n  CAVEAT (review amendment 5)`);
    console.log(`  probesUsed was 0: testnet was uncongested, the first-choice second was free,`);
    console.log(`  and the capacity/jitter fallback never ran. It is UNTESTED CODE ON THE`);
    console.log(`  CRITICAL PATH and must not be reported as verified.\n`);
  }

  saveEvidence(
    "spike1-result.json",
    jsonSafe({
      passed: allPassed,
      scheduleEntityId,
      scheduleHashscan: scheduleLink(scheduleEntityId),
      expirySecond,
      executedTimestamp,
      executionLatencyMs: latencyMs,
      signatures,
      waitForExpiry,
      deleted: rec.deleted ?? null,
      pingCount: pingCount,
      lastPingTimestamp: lastPingTimestamp,
      lastPingSender,
      lastTag,
      mirrorAttemptsUsed: res.attemptsUsed,
      jitterFallbackExercised: armed.jitterFallbackExercised,
      jitterCaveat:
        "probesUsed was 0 — testnet uncongested, capacity/jitter fallback never executed. Untested code on the critical path. Not verified.",
      prevrandaoVerdict: armed.prevrandaoVerdict,
      prngVerdict: armed.prngVerdict,
      verifiedAt: new Date().toISOString(),
    }),
  );

  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
