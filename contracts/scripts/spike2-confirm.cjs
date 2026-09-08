/**
 * SPIKE 2, final condition — did the cancelled schedule stay dead?
 *
 * Separate from spike2.cjs because the wait past the expiry second is minutes
 * long and a killed process should not cost us the run. spike2.cjs proves the
 * delete was ACCEPTED; this proves the network then did not execute it anyway.
 *
 *   SPIKE2_SCHEDULE_ID=0.0.x SPIKE2_EXPIRY=<second> SPIKE2_PING_BEFORE=<n> \
 *     npx hardhat run scripts/spike2-confirm.cjs --network hederaTestnet
 */
const { ethers } = require("hardhat");
const { readEvidence, saveEvidence, mirrorGet, report, jsonSafe, scheduleLink, sleep } = require("./lib.cjs");

async function main() {
  const entityId = process.env.SPIKE2_SCHEDULE_ID;
  const expirySecond = Number(process.env.SPIKE2_EXPIRY);
  const pingBefore = BigInt(process.env.SPIKE2_PING_BEFORE ?? "0");
  if (!entityId || !expirySecond) throw new Error("Set SPIKE2_SCHEDULE_ID and SPIKE2_EXPIRY.");

  const address = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;
  const contract = await ethers.getContractAt("SpikeSchedule", address);

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < expirySecond + 60) {
    const waitS = expirySecond + 60 - nowSec;
    console.log(`\n  waiting ${waitS}s to get clear of the expiry second...`);
    await sleep(waitS * 1000);
  }
  console.log(`\n  now ${Math.floor(Date.now() / 1000)}, expiry second was ${expirySecond} ` +
              `(${Math.floor(Date.now() / 1000) - expirySecond}s ago)`);

  const pingAfter = await contract.pingCount();
  const res = await mirrorGet(`/api/v1/schedules/${entityId}`, { label: `final ${entityId}` });
  const rec = res.ok ? res.body : {};

  console.log(`\n  pingCount        before ${pingBefore} / after ${pingAfter}`);
  console.log(`  deleted          ${rec.deleted}`);
  console.log(`  executed_timestamp ${rec.executed_timestamp}`);

  saveEvidence("spike2-final-schedule.json", jsonSafe(rec));

  const allPassed = report("SPIKE 2 — the cancelled schedule stayed dead", [
    {
      name: "mirror still shows deleted: true",
      expected: "true",
      actual: String(rec.deleted),
      pass: rec.deleted === true,
    },
    {
      name: "executed_timestamp never populated, past its expiry second",
      expected: "null",
      actual: String(rec.executed_timestamp),
      pass: rec.executed_timestamp === null || rec.executed_timestamp === undefined,
    },
    {
      name: "pingCount unchanged — the call never ran",
      expected: String(pingBefore),
      actual: String(pingAfter),
      pass: pingAfter === pingBefore,
    },
  ]);

  saveEvidence(
    "spike2-confirm.json",
    jsonSafe({
      passed: allPassed,
      scheduleEntityId: entityId,
      scheduleHashscan: scheduleLink(entityId),
      expirySecond,
      secondsPastExpiry: Math.floor(Date.now() / 1000) - expirySecond,
      pingCountBefore: pingBefore,
      pingCountAfter: pingAfter,
      deleted: rec.deleted ?? null,
      executedTimestamp: rec.executed_timestamp ?? null,
      confirmedAt: new Date().toISOString(),
    }),
  );

  if (!allPassed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
