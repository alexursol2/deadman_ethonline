/**
 * SPIKE 4 — can a third party delete someone else's schedule?
 *
 * Spike 2 proved the creating contract can. This asks whether anyone else can,
 * which decides whether the refund guarantee survives contact with an attacker.
 *
 * PASS = every cell FAILS. This is the one spike where success is bad news.
 *
 *   npx hardhat run scripts/spike4-third-party-delete.cjs --network hederaTestnet
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
  weibarToTinybar,
  fmtTinybar,
} = require("./lib.cjs");

const HSS_ADDRESS = "0x000000000000000000000000000000000000016b";
const SEL_DELETE_SCHEDULE = "0x72d42394";
const SEL_DELETE_REDIRECT = "0xc61dea85";

const ARM_TX_GAS = 5_000_000;
/**
 * Generous on purpose. A starved system-contract call reverts with empty
 * returndata, which reads exactly like "not authorised" but is not. A cell only
 * counts as an authorisation refusal if it comes back with a CODE.
 */
const ATTEMPT_GAS = 4_000_000;

const DELAY_SECONDS = 600;
const SCHEDULED_GAS = 150_000;
const FUND_ATTACKER_HBAR = "15.0";

async function readSchedule(entityId, label) {
  const res = await mirrorGet(`/api/v1/schedules/${entityId}`, { label });
  if (!res.ok) return { exists: false, attemptsUsed: res.attemptsUsed, record: null };
  return { exists: true, attemptsUsed: res.attemptsUsed, record: res.body };
}

async function stillAlive(entityId, label) {
  const { record } = await readSchedule(entityId, label);
  const alive = record && record.deleted !== true;
  console.log(`      mirror: deleted=${record?.deleted} executed=${record?.executed_timestamp} -> ${alive ? "STILL ALIVE" : "GONE"}`);
  return { alive, record };
}

async function main() {
  const [operator] = await ethers.getSigners();
  const victimAddress = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;
  if (!victimAddress) throw new Error("No victim contract. Run deploy first.");
  const victim = await ethers.getContractAt("SpikeSchedule", victimAddress, operator);

  const cells = {};

  console.log(`\n  victim contract   ${victimAddress}`);
  console.log(`  operator (owner)  ${operator.address}`);

  /* ---------------------------------------------- a genuinely unrelated EOA */
  // Must NOT be the deployer. If authorisation keys off the payer account, using
  // our own key would pass for the wrong reason and we would ship a false negative.
  const attackerEoa = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log(`\n  attacker EOA      ${attackerEoa.address}  (freshly generated, unrelated)`);
  console.log(`  funding it with ${FUND_ATTACKER_HBAR} HBAR...`);
  // 2,000,000, not 21,000. A transfer to an address Hedera has never seen also
  // CREATES the account (lazy/hollow creation), and that costs far more than an
  // EVM value transfer. At 300,000 it reverts having burned the lot, with no
  // reason string. Same class of trap as the scheduleCall gas floor.
  //
  // Worth carrying to the frontend: the brief's Privy gotcha — "a fresh Privy
  // wallet's EVM address needs an activated Hedera account" — is this, and it
  // will fail the same way if the activating transfer is sent with default gas.
  const fundTx = await operator.sendTransaction({
    to: attackerEoa.address,
    value: ethers.parseEther(FUND_ATTACKER_HBAR),
    gasLimit: 2_000_000,
  });
  await fundTx.wait();
  const attackerBal = weibarToTinybar(await ethers.provider.getBalance(attackerEoa.address));
  console.log(`  attacker balance  ${fmtTinybar(attackerBal)}`);
  if (attackerBal === 0n) throw new Error("Attacker EOA did not get funded; cannot run 3a/3b.");

  /* ------------------------------------------------- an unrelated contract */
  console.log(`\n  deploying Attacker.sol...`);
  const attackerContract = await (await ethers.getContractFactory("Attacker")).deploy({ gasLimit: 3_000_000 });
  await attackerContract.waitForDeployment();
  const attackerContractAddress = await attackerContract.getAddress();
  console.log(`  attacker contract ${attackerContractAddress}`);

  /* -------------------------------------------------- arm the victim schedule */
  console.log(`\n  victim arms a schedule ${DELAY_SECONDS}s out...`);
  const armTx = await victim.arm(DELAY_SECONDS, SCHEDULED_GAS, ethers.encodeBytes32String("spike4"), {
    gasLimit: ARM_TX_GAS,
  });
  const armReceipt = await armTx.wait();
  const armed = findEvent(victim, armReceipt, "Armed");
  if (!armed) throw new Error(`No Armed event in ${armTx.hash}`);
  const scheduleAddress = armed.args.scheduleAddress;
  const entityId = toEntityId(scheduleAddress);
  const expirySecond = Number(armed.args.expirySecond);
  console.log(`  schedule          ${entityId} (${scheduleAddress}) expiring ${expirySecond}`);
  console.log(`                    ${scheduleLink(entityId)}`);

  // Control read — without it, "the attacker failed" is indistinguishable from
  // "there was nothing there to delete".
  console.log(`\n  control read:`);
  const control = await readSchedule(entityId, `control ${entityId}`);
  if (!control.exists || control.record.deleted === true) {
    throw new Error(`Control failed: schedule ${entityId} absent or already deleted. Result would be meaningless.`);
  }
  console.log(`      exists after ${control.attemptsUsed} attempt(s), deleted=${control.record.deleted}`);

  /* ------------------------------------------------------------- attempts */
  const eoaAttempt = async (id, label, to, data) => {
    console.log(`\n  === ${id}: ${label} ===`);
    let out = { id, label, txHash: null, txStatus: null, threw: null, succeeded: false };
    try {
      const tx = await attackerEoa.sendTransaction({ to, data, gasLimit: ATTEMPT_GAS });
      const receipt = await tx.wait();
      out.txHash = tx.hash;
      out.txStatus = receipt.status;
      out.gasUsed = receipt.gasUsed.toString();
      console.log(`      tx ${tx.hash}  status ${receipt.status}  gasUsed ${receipt.gasUsed}`);
      console.log(`      ${txLink(tx.hash)}`);
    } catch (err) {
      out.threw = String(err.shortMessage || err.message).slice(0, 200);
      if (err.receipt) {
        out.txHash = err.receipt.hash;
        out.txStatus = err.receipt.status;
        out.gasUsed = err.receipt.gasUsed?.toString();
      }
      console.log(`      THREW: ${out.threw}`);
    }
    const { alive, record } = await stillAlive(entityId, `${id} after`);
    out.succeeded = !alive;
    out.recordAfter = record;
    cells[id] = out;
    return !alive;
  };

  const contractAttempt = async (id, label, fn) => {
    console.log(`\n  === ${id}: ${label} ===`);
    let out = { id, label, txHash: null, callOk: null, code: null, returnData: null, threw: null, succeeded: false };
    try {
      const tx = await attackerContract[fn](scheduleAddress, { gasLimit: ATTEMPT_GAS });
      const receipt = await tx.wait();
      const ev = findEvent(attackerContract, receipt, "AttemptResult");
      out.txHash = tx.hash;
      out.txStatus = receipt.status;
      out.callOk = ev ? ev.args.callOk : null;
      out.code = ev ? ev.args.code.toString() : null;
      out.returnData = ev ? ev.args.returnData : null;
      console.log(`      callOk=${out.callOk} code=${out.code} returnData=${out.returnData}`);
      console.log(`      ${txLink(tx.hash)}`);
    } catch (err) {
      out.threw = String(err.shortMessage || err.message).slice(0, 200);
      console.log(`      THREW: ${out.threw}`);
    }
    const { alive, record } = await stillAlive(entityId, `${id} after`);
    out.succeeded = !alive;
    out.recordAfter = record;
    cells[id] = out;
    return !alive;
  };

  const victimScheduleArg = SEL_DELETE_SCHEDULE + ethers.zeroPadValue(scheduleAddress, 32).slice(2);

  let breached = false;
  breached =
    (await eoaAttempt("3a", "unrelated EOA -> 0x16b deleteSchedule(address)", HSS_ADDRESS, victimScheduleArg)) ||
    breached;
  if (!breached)
    breached =
      (await eoaAttempt("3b", "unrelated EOA -> redirect deleteSchedule() on the schedule", scheduleAddress, SEL_DELETE_REDIRECT)) ||
      breached;
  if (!breached) breached = (await contractAttempt("3c", "unrelated CONTRACT -> 0x16b deleteSchedule(address)", "tryHss")) || breached;
  if (!breached) breached = (await contractAttempt("3d", "unrelated CONTRACT -> redirect deleteSchedule()", "tryRedirect")) || breached;

  /* --------------------------------------------------------------- cleanup */
  // Do not leave a live schedule to fire later and confuse a future run.
  let cleanedUp = false;
  if (!breached) {
    console.log(`\n  cleanup: the victim deletes its own schedule...`);
    try {
      const tx = await victim.tryCancelViaHss(scheduleAddress, { gasLimit: ATTEMPT_GAS });
      await tx.wait();
      const { alive } = await stillAlive(entityId, "cleanup");
      cleanedUp = !alive;
      console.log(`      cleanup ${cleanedUp ? "ok" : "FAILED — schedule will fire at expiry"}`);
    } catch (err) {
      console.log(`      cleanup threw: ${err.shortMessage || err.message}`);
    }
  }

  /* --------------------------------------------------------------- verdict */
  const conditions = Object.values(cells).map((c) => ({
    name: `${c.id}  ${c.label}`,
    expected: "rejected — schedule still alive",
    actual: c.succeeded ? "*** DELETED THE SCHEDULE ***" : `rejected (code ${c.code ?? "n/a"}${c.threw ? ", threw" : ""})`,
    pass: !c.succeeded,
  }));
  const allPassed = report("SPIKE 4 — third-party deletion (every cell must FAIL)", conditions);

  saveEvidence(
    "spike4-result.json",
    jsonSafe({
      passed: allPassed,
      breached,
      victimContract: victimAddress,
      attackerEoa: attackerEoa.address,
      attackerContract: attackerContractAddress,
      scheduleEntityId: entityId,
      scheduleAddress,
      scheduleHashscan: scheduleLink(entityId),
      expirySecond,
      controlRecord: control.record,
      cells,
      cleanedUp,
      ranAt: new Date().toISOString(),
    }),
  );

  if (breached) {
    console.log(`  *** A THIRD PARTY DELETED OUR SCHEDULE. The refund guarantee does not hold. ***`);
    console.log(`  *** STOP. Report to Alex before HoldEscrow.refund() is written. ***\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
