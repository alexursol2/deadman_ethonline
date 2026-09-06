/**
 * SPIKE 1, part 1 — arm a scheduled call 60 seconds out.
 *
 * Then run spike1-verify.cjs at T+90s. Split into two scripts on purpose: if the
 * arming script also did the waiting, a crash during the wait would lose the
 * schedule id and we would have to burn another 60 seconds to get it back.
 */
const hre = require("hardhat");
const { ethers } = hre;
const {
  saveEvidence,
  readEvidence,
  findEvent,
  toEntityId,
  scheduleLink,
  txLink,
  jsonSafe,
  sleep,
  SEED_SOURCE,
  weibarToTinybar,
  fmtTinybar,
} = require("./lib.cjs");

const DELAY_SECONDS = 60;
const GAS_LIMIT = 150_000;
const TAG = ethers.encodeBytes32String("spike1");

async function main() {
  const [signer] = await ethers.getSigners();
  const address = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;
  if (!address) throw new Error("No contract address. Run deploy first, or set SPIKE_CONTRACT_ADDRESS.");

  const contract = await ethers.getContractAt("SpikeSchedule", address, signer);

  // 1. Balance, printed. The contract pays execution gas from here at expiry.
  //    RPC gives weibars, the contract compares tinybars — convert, do not guess.
  const balanceTinybar = weibarToTinybar(await ethers.provider.getBalance(address));
  const minTinybar = await contract.MIN_BALANCE_TINYBAR();
  console.log(`
  contract       ${address}`);
  console.log(`  balance        ${fmtTinybar(balanceTinybar)}`);
  console.log(`  arming floor   ${fmtTinybar(minTinybar)}`);
  if (balanceTinybar < minTinybar) throw new Error("Below the arming floor — arm() would revert.");

  // 2. Randomness probe, twice, in different blocks (amendment 1).
  //    One sample cannot distinguish "constant" from "happened to be that value".
  console.log(`\n  probing randomness sources (twice, different blocks)...`);
  const probes = [];
  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(4000);
    const tx = await contract.probeRandomness({ gasLimit: 400_000 });
    const receipt = await tx.wait();
    const ev = findEvent(contract, receipt, "RandomnessProbe");
    const p = {
      attempt: i + 1,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      prevrandao: ev?.args?.prevrandao ?? null,
      prngSeed: ev?.args?.prngSeed ?? null,
      prngOk: ev?.args?.prngOk ?? null,
    };
    probes.push(p);
    console.log(`    #${p.attempt} block ${p.blockNumber}`);
    console.log(`       prevrandao ${p.prevrandao}`);
    console.log(`       prng 0x169 ${p.prngSeed}  (ok=${p.prngOk})`);
  }

  const ZERO32 = `0x${"0".repeat(64)}`;
  const verdict = (name, a, b) => {
    if (a === null || b === null) return `${name}: UNAVAILABLE (call failed)`;
    if (a === ZERO32 && b === ZERO32) return `${name}: UNUSABLE (zero in both blocks)`;
    if (a === b) return `${name}: UNUSABLE (identical across two blocks — constant)`;
    return `${name}: USABLE (non-zero, varies across blocks)`;
  };
  const prevrandaoVerdict = verdict("prevrandao", probes[0].prevrandao, probes[1].prevrandao);
  const prngVerdict = verdict("prng 0x169 ", probes[0].prngSeed, probes[1].prngSeed);
  console.log(`\n    ${prevrandaoVerdict}`);
  console.log(`    ${prngVerdict}`);

  // 3. Arm.
  console.log(`\n  arming: ping() at now + ${DELAY_SECONDS}s, gasLimit ${GAS_LIMIT}...`);
  const armTx = await contract.arm(DELAY_SECONDS, GAS_LIMIT, TAG, { gasLimit: 1_500_000 });
  const armReceipt = await armTx.wait();
  const armed = findEvent(contract, armReceipt, "Armed");
  if (!armed) throw new Error(`No Armed event in ${armTx.hash}. Check HssRaw in the receipt.`);

  const scheduleAddress = armed.args.scheduleAddress;
  const expirySecond = Number(armed.args.expirySecond);
  const requestedSecond = Number(armed.args.requestedSecond);
  const probesUsed = Number(armed.args.probesUsed);
  const entityId = toEntityId(scheduleAddress);

  console.log(`\n  tx             ${armTx.hash}`);
  console.log(`                 ${txLink(armTx.hash)}`);
  console.log(`  code           ${armed.args.code}  (22 = SUCCESS)`);
  console.log(`  schedule       ${scheduleAddress}`);
  console.log(`  schedule id    ${entityId}`);
  console.log(`                 ${scheduleLink(entityId)}`);
  console.log(`  requested s    ${requestedSecond}`);
  console.log(`  expiry s       ${expirySecond}${expirySecond === requestedSecond ? " (first choice was free)" : ` (moved +${expirySecond - requestedSecond}s)`}`);
  console.log(`  probesUsed     ${probesUsed}`);
  console.log(`  seed source    ${SEED_SOURCE[Number(armed.args.seedSource)] ?? armed.args.seedSource}`);

  if (probesUsed === 0) {
    console.log(`\n  NOTE: probesUsed = 0. The capacity/jitter fallback did NOT execute.`);
    console.log(`        It is untested code on the critical path. Do not report it as verified.`);
  }

  saveEvidence(
    "spike1-armed.json",
    jsonSafe({
      contract: address,
      armTx: armTx.hash,
      armTxHashscan: txLink(armTx.hash),
      code: armed.args.code,
      scheduleAddress,
      scheduleEntityId: entityId,
      scheduleHashscan: scheduleLink(entityId),
      requestedSecond,
      expirySecond,
      movedBySeconds: expirySecond - requestedSecond,
      probesUsed,
      jitterFallbackExercised: probesUsed > 0,
      seedSource: SEED_SOURCE[Number(armed.args.seedSource)] ?? String(armed.args.seedSource),
      prevrandaoAtArm: armed.args.prevrandao,
      seedUsed: armed.args.prngSeed,
      balanceAtArmTinybar: armed.args.balanceAtArmTinybar,
      randomnessProbes: probes,
      prevrandaoVerdict,
      prngVerdict,
      armedAt: new Date().toISOString(),
      expiresAtIso: new Date(expirySecond * 1000).toISOString(),
    }),
  );

  const waitFor = expirySecond + 30 - Math.floor(Date.now() / 1000);
  console.log(`\n  Now wait ~${waitFor}s, then: npm run spike1:verify\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
