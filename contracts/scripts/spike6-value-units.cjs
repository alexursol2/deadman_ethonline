/**
 * SPIKE 6 — what unit is scheduleCall's `uint64 value` in?
 *
 * Every prior spike passed zero. The session-01 report INFERRED tinybars from
 * "a weibar amount cannot fit in uint64". Sound reasoning, not a measurement,
 * and refund() moves real money on this parameter.
 *
 * VALUE_PARAM = 3e8 makes the two hypotheses unmistakable:
 *   tinybars -> 3 HBAR lands
 *   weibars  -> 0.03 tinybar, i.e. sub-tinybar, nothing lands
 *
 *   npx hardhat run scripts/spike6-value-units.cjs --network hederaTestnet
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
  weibarToTinybar,
  fmtTinybar,
  sleep,
} = require("./lib.cjs");

const VALUE_PARAM = 300_000_000n; // 3e8
const EXPECT_TINYBAR = 300_000_000n; // if the unit is tinybars, exactly 3 HBAR
const DELAY_SECONDS = 60;
const SCHEDULED_GAS = 250_000; // more than the value-free 150k; a transfer does more work
const ARM_TX_GAS = 5_000_000;

async function main() {
  const [operator] = await ethers.getSigners();
  const escrowAddress = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;
  const escrow = await ethers.getContractAt("SpikeSchedule", escrowAddress, operator);

  console.log(`\n  paying contract  ${escrowAddress}`);

  // Fresh sink each run, so its balance delta is unambiguous.
  console.log(`  deploying ValueSink...`);
  const sink = await (await ethers.getContractFactory("ValueSink")).deploy({ gasLimit: 3_000_000 });
  await sink.waitForDeployment();
  const sinkAddress = await sink.getAddress();
  console.log(`  sink             ${sinkAddress}`);

  const before = {
    sinkRpcWeibar: await ethers.provider.getBalance(sinkAddress),
    sinkEvmTinybar: await sink.balanceTinybar(),
    escrowRpcWeibar: await ethers.provider.getBalance(escrowAddress),
    escrowEvmTinybar: await escrow.balanceTinybar(),
    landings: await sink.landings(),
  };
  console.log(`\n  BEFORE`);
  console.log(`    sink   eth_getBalance ${before.sinkRpcWeibar}  | EVM ${before.sinkEvmTinybar} tinybar`);
  console.log(`    escrow eth_getBalance ${before.escrowRpcWeibar}  | EVM ${before.escrowEvmTinybar} tinybar`);

  // Arm: scheduled call to sink.land(tag), carrying VALUE_PARAM.
  const tag = ethers.encodeBytes32String("spike6");
  const callData = sink.interface.encodeFunctionData("land", [tag]);
  console.log(`\n  arming with value = ${VALUE_PARAM}  (gasLimit ${SCHEDULED_GAS}, ${DELAY_SECONDS}s out)`);
  console.log(`    if tinybars -> ${Number(VALUE_PARAM) / 1e8} HBAR should land`);
  console.log(`    if weibars  -> ${Number(VALUE_PARAM) / 1e18} HBAR, i.e. nothing should land`);

  const armTx = await escrow.armWithValue(sinkAddress, DELAY_SECONDS, SCHEDULED_GAS, VALUE_PARAM, callData, {
    gasLimit: ARM_TX_GAS,
  });
  const armReceipt = await armTx.wait();
  const armed = findEvent(escrow, armReceipt, "ArmedWithValue");
  if (!armed) throw new Error(`No ArmedWithValue event in ${armTx.hash}`);
  const scheduleAddress = armed.args.scheduleAddress;
  const entityId = toEntityId(scheduleAddress);
  const expirySecond = Number(armed.args.expirySecond);
  console.log(`    code ${armed.args.code}  schedule ${entityId}`);
  console.log(`    ${scheduleLink(entityId)}`);
  console.log(`    ${txLink(armTx.hash)}`);

  // Wait for it to fire on its own.
  const waitS = expirySecond + 25 - Math.floor(Date.now() / 1000);
  if (waitS > 0) {
    console.log(`\n  waiting ${waitS}s for the network to execute it...`);
    await sleep(waitS * 1000);
  }
  const sched = await mirrorGetUntil(
    `/api/v1/schedules/${entityId}`,
    (r) => r.executed_timestamp !== null && r.executed_timestamp !== undefined,
    { label: "executed" },
  );
  console.log(`  executed_timestamp ${sched.record?.executed_timestamp}  signatures ${JSON.stringify(sched.record?.signatures)}`);
  saveEvidence("spike6-schedule.json", jsonSafe(sched.record ?? {}));

  const after = {
    sinkRpcWeibar: await ethers.provider.getBalance(sinkAddress),
    sinkEvmTinybar: await sink.balanceTinybar(),
    escrowRpcWeibar: await ethers.provider.getBalance(escrowAddress),
    escrowEvmTinybar: await escrow.balanceTinybar(),
    landings: await sink.landings(),
    lastMsgValue: await sink.lastMsgValue(),
    lastSender: await sink.lastSender(),
    lastBalanceTinybar: await sink.lastBalanceTinybar(),
  };

  const sinkGainTinybar = after.sinkEvmTinybar - before.sinkEvmTinybar;
  const sinkGainViaRpcTinybar = weibarToTinybar(after.sinkRpcWeibar - before.sinkRpcWeibar);
  const escrowDropTinybar = before.escrowEvmTinybar - after.escrowEvmTinybar;

  console.log(`\n  AFTER`);
  console.log(`    sink   eth_getBalance ${after.sinkRpcWeibar}  | EVM ${after.sinkEvmTinybar} tinybar`);
  console.log(`    escrow eth_getBalance ${after.escrowRpcWeibar}  | EVM ${after.escrowEvmTinybar} tinybar`);
  console.log(`    landings ${before.landings} -> ${after.landings}`);
  console.log(`    msg.value seen inside the scheduled call: ${after.lastMsgValue}`);
  console.log(`    scheduled call's msg.sender:              ${after.lastSender}`);

  console.log(`\n  DELTAS`);
  console.log(`    sink gained (EVM tinybars)      ${sinkGainTinybar}  = ${fmtTinybar(sinkGainTinybar)}`);
  console.log(`    sink gained (via eth_getBalance) ${sinkGainViaRpcTinybar} tinybar`);
  console.log(`    escrow lost (EVM tinybars)      ${escrowDropTinybar}  = ${fmtTinybar(escrowDropTinybar)}`);
  console.log(`    escrow lost minus sink gained   ${escrowDropTinybar - sinkGainTinybar} tinybar (execution gas)`);

  const isTinybar = sinkGainTinybar === EXPECT_TINYBAR;
  const verdict = isTinybar
    ? "TINYBARS — the inference was right"
    : sinkGainTinybar === 0n
      ? "*** NOTHING LANDED — value is NOT tinybars. refund() changes. ***"
      : `*** UNEXPECTED: ${sinkGainTinybar} tinybar landed for a value of ${VALUE_PARAM} ***`;

  const allPassed = report("SPIKE 6 — units of scheduleCall's value parameter", [
    {
      name: "the schedule executed unattended",
      expected: "executed_timestamp present, signatures []",
      actual: `${sched.record?.executed_timestamp}, ${JSON.stringify(sched.record?.signatures)}`,
      pass: sched.settled && Array.isArray(sched.record?.signatures) && sched.record.signatures.length === 0,
    },
    {
      name: "the scheduled call actually ran",
      expected: "landings incremented",
      actual: `${before.landings} -> ${after.landings}`,
      pass: after.landings === before.landings + 1n,
    },
    {
      name: `value ${VALUE_PARAM} landed as ${EXPECT_TINYBAR} tinybar (3 HBAR)`,
      expected: `${EXPECT_TINYBAR} tinybar`,
      actual: `${sinkGainTinybar} tinybar`,
      pass: isTinybar,
    },
    {
      name: "the two balance surfaces agree once converted",
      expected: "equal",
      actual: `EVM ${sinkGainTinybar} vs RPC-converted ${sinkGainViaRpcTinybar}`,
      pass: sinkGainTinybar === sinkGainViaRpcTinybar,
    },
  ]);

  console.log(`  VERDICT: ${verdict}\n`);

  saveEvidence(
    "spike6-result.json",
    jsonSafe({
      passed: allPassed,
      verdict,
      valueParamPassed: VALUE_PARAM,
      unitIsTinybar: isTinybar,
      payingContract: escrowAddress,
      sink: sinkAddress,
      scheduleEntityId: entityId,
      scheduleHashscan: scheduleLink(entityId),
      armTx: armTx.hash,
      expirySecond,
      executedTimestamp: sched.record?.executed_timestamp ?? null,
      signatures: sched.record?.signatures ?? null,
      scheduledGasRequested: SCHEDULED_GAS,
      before,
      after,
      sinkGainTinybar,
      sinkGainViaRpcTinybar,
      escrowDropTinybar,
      executionGasTinybar: escrowDropTinybar - sinkGainTinybar,
      msgValueInsideScheduledCall: after.lastMsgValue,
      scheduledCallMsgSender: after.lastSender,
      ranAt: new Date().toISOString(),
    }),
  );

  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
