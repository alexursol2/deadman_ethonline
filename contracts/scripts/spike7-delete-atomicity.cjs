/**
 * SPIKE 7 — is a successful deleteSchedule rolled back when the transaction reverts?
 *
 * deleteSchedule mutates consensus-node state outside the EVM's storage model.
 * "It is one transaction, a revert unwinds it" is an EVM intuition, and HIP-1215
 * does not say whether it holds here.
 *
 * If the deletion survives the revert, HoldEscrow.claim() must never have a
 * revertible operation after its delete: the caller sees a failed transaction,
 * assumes nothing happened, and the armed refund is gone.
 *
 *   npx hardhat run scripts/spike7-delete-atomicity.cjs --network hederaTestnet
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
} = require("./lib.cjs");

const ARM_TX_GAS = 5_000_000;
const ATTEMPT_GAS = 4_000_000;
const DELAY_SECONDS = 600;
const SCHEDULED_GAS = 150_000;

const SEL_DELIBERATE_REVERT = "0x84921ad7"; // DeliberateRevert()
const SEL_HSS_NOT_SUCCESS = "0xe9aa2cd2"; // HssNotSuccess(string,int64)

async function main() {
  const [operator] = await ethers.getSigners();
  const address = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;
  const c = await ethers.getContractAt("SpikeSchedule", address, operator);
  console.log(`\n  contract  ${address}`);

  /* -------------------------------------------------------------- 1. arm */
  console.log(`\n  arming a schedule ${DELAY_SECONDS}s out...`);
  const armTx = await c.arm(DELAY_SECONDS, SCHEDULED_GAS, ethers.encodeBytes32String("spike7"), {
    gasLimit: ARM_TX_GAS,
  });
  const armed = findEvent(c, await armTx.wait(), "Armed");
  if (!armed) throw new Error(`No Armed event in ${armTx.hash}`);
  const scheduleAddress = armed.args.scheduleAddress;
  const entityId = toEntityId(scheduleAddress);
  console.log(`  schedule  ${entityId}  ${scheduleLink(entityId)}`);

  /* ---------------------------------------------------- 2. control read */
  const control = await mirrorGet(`/api/v1/schedules/${entityId}`, { label: `control ${entityId}` });
  if (!control.ok || control.body.deleted === true) {
    throw new Error(`Control failed: ${entityId} absent or already deleted. Result would be meaningless.`);
  }
  console.log(`  control   exists, deleted=${control.body.deleted}, executed=${control.body.executed_timestamp}`);

  /* ------------------------------------------- 3. delete, then revert */
  console.log(`\n  calling deleteThenRevert(${scheduleAddress})...`);
  let txHash = null;
  let errorMessage = null;
  let revertedWith = null;
  try {
    const tx = await c.deleteThenRevert(scheduleAddress, { gasLimit: ATTEMPT_GAS });
    txHash = tx.hash;
    await tx.wait();
    console.log(`  *** the transaction did NOT revert. The test did not run. ***`);
  } catch (err) {
    txHash = err.receipt?.hash ?? txHash;
    console.log(`  reverted as intended: ${String(err.shortMessage || err.message).slice(0, 90)}`);
  }
  if (!txHash) throw new Error("No transaction hash; cannot read the revert reason.");
  console.log(`  ${txLink(txHash)}`);

  const res = await mirrorGet(`/api/v1/contracts/results/${txHash}`, { label: "revert reason" });
  errorMessage = res.ok ? res.body.error_message : null;
  const sel = errorMessage ? errorMessage.slice(0, 10) : null;
  if (sel === SEL_DELIBERATE_REVERT) revertedWith = "DeliberateRevert()";
  else if (sel === SEL_HSS_NOT_SUCCESS) revertedWith = "HssNotSuccess(...) — the delete was REFUSED";
  else revertedWith = `unrecognised (${sel})`;
  console.log(`  status    ${res.ok ? res.body.result : "?"}`);
  console.log(`  error     ${errorMessage}`);
  console.log(`  decoded   ${revertedWith}`);

  const testRan = sel === SEL_DELIBERATE_REVERT;
  if (!testRan) {
    console.log(`\n  The delete did not return 22, so this run says nothing about atomicity.`);
  }

  /* ------------------------------------- 4. did the deletion survive? */
  console.log(`\n  polling the mirror to see whether the deletion survived the revert...`);
  const after = await mirrorGetUntil(`/api/v1/schedules/${entityId}`, (r) => r.deleted === true, {
    label: "survived?",
  });
  const survived = after.settled; // deleted === true means the delete SURVIVED the revert
  console.log(`  deleted=${after.record?.deleted} after ${after.waitedMs}ms of polling`);
  console.log(`  -> ${survived ? "*** DELETION SURVIVED THE REVERT — NOT ATOMIC ***" : "deletion was rolled back"}`);

  /* ------------------------------- 5. positive control, the load-bearing bit */
  // Whatever step 4 said, prove the schedule was genuinely deletable. Without
  // this, a malformed delete call yields "still alive" and we would report
  // atomicity we never tested.
  console.log(`\n  positive control: deleting ${entityId} for real...`);
  let controlCode = null;
  let controlOk = null;
  try {
    const tx = await c.tryCancelViaHss(scheduleAddress, { gasLimit: ATTEMPT_GAS });
    const ev = findEvent(c, await tx.wait(), "CancelAttempt");
    controlOk = ev?.args.callOk ?? null;
    controlCode = ev?.args.code?.toString() ?? null;
    console.log(`  callOk=${controlOk} code=${controlCode}  ${txLink(tx.hash)}`);
  } catch (err) {
    console.log(`  THREW ${String(err.shortMessage || err.message).slice(0, 120)}`);
  }
  const finalRead = await mirrorGetUntil(`/api/v1/schedules/${entityId}`, (r) => r.deleted === true, {
    label: "final",
  });
  console.log(`  final deleted=${finalRead.record?.deleted}`);

  // If the deletion was rolled back, the schedule must still have been deletable (code 22).
  // If it survived, this second delete must be refused (already gone).
  const positiveControlHolds = survived ? controlCode !== "22" : controlCode === "22" && finalRead.settled;

  /* ------------------------------------------------------------ verdict */
  const verdict = !testRan
    ? "INCONCLUSIVE — the delete was refused, so nothing about atomicity was tested"
    : !positiveControlHolds
      ? "INCONCLUSIVE — the positive control did not behave consistently"
      : survived
        ? "NOT ATOMIC — a successful deleteSchedule SURVIVES an EVM revert"
        : "ATOMIC — the deletion is rolled back with the transaction";

  const allPassed = report("SPIKE 7 — deleteSchedule vs EVM revert", [
    {
      name: "the test actually ran (delete returned 22, then we reverted on purpose)",
      expected: "DeliberateRevert()",
      actual: revertedWith,
      pass: testRan,
    },
    {
      name: "the deletion was rolled back with the transaction",
      expected: "schedule still alive after the revert",
      actual: survived ? "schedule is GONE — deletion survived" : "schedule still alive",
      pass: !survived,
    },
    {
      name: "positive control: the schedule was genuinely deletable",
      expected: survived ? "second delete refused (already gone)" : "second delete returns 22",
      actual: `code ${controlCode}, final deleted=${finalRead.record?.deleted}`,
      pass: positiveControlHolds,
    },
  ]);

  console.log(`  VERDICT: ${verdict}\n`);

  saveEvidence(
    "spike7-result.json",
    jsonSafe({
      verdict,
      atomic: testRan && positiveControlHolds ? !survived : null,
      testRan,
      positiveControlHolds,
      contract: address,
      scheduleEntityId: entityId,
      scheduleHashscan: scheduleLink(entityId),
      armTx: armTx.hash,
      deleteThenRevertTx: txHash,
      revertErrorMessage: errorMessage,
      revertDecoded: revertedWith,
      deletionSurvivedRevert: survived,
      pollWaitedMs: after.waitedMs,
      positiveControlCode: controlCode,
      recordAfterRevert: after.record,
      recordFinal: finalRead.record,
      ranAt: new Date().toISOString(),
    }),
  );
  saveEvidence("spike7-schedule.json", jsonSafe(finalRead.record ?? {}));

  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
