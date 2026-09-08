/**
 * Measure refund()'s WORST case on testnet: the payer rejects the push, so the
 * credit-on-failure branch runs.
 *
 * The happy path measured 46,744 gas. Sizing REFUND_GAS off that would repeat
 * the mistake plan 04 §Q7 already made once — budgeting from the case that is
 * easy to observe rather than the one that has to survive. The expensive branch
 * is the one where a hostile or broken payer burns the whole payout stipend and
 * the contract then writes a cold storage slot to credit them instead.
 *
 *   npx hardhat run scripts/measure-refund-worstcase.cjs --network hederaTestnet
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
  sleep,
} = require("./lib.cjs");

const OPEN_TX_GAS = 5_000_000;
const AMOUNT_TINYBAR = 100_000_000n;
const DELAY_SECONDS = 45;
const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

/** Contract result for a network-executed call, via its transaction hash. */
async function scheduledResult(executedTimestamp) {
  const t = await mirrorGet(`/api/v1/transactions?timestamp=${executedTimestamp}`, { label: "sched tx" });
  const txn = (t.ok ? t.body.transactions || [] : []).find((x) => x.name === "CONTRACTCALL");
  if (!txn?.transaction_hash) return { txn: null, result: null };
  // Mirror gives the hash base64, and /contracts/results wants the 32-byte
  // prefix in hex — the full 48-byte value is rejected with a 400.
  const hex = "0x" + Buffer.from(txn.transaction_hash, "base64").toString("hex").slice(0, 64);
  const r = await mirrorGet(`/api/v1/contracts/results/${hex}`, { label: "sched result" });
  return { txn, result: r.ok ? r.body : null, hash: hex };
}

async function main() {
  const [operator] = await ethers.getSigners();
  const address = process.env.ESCROW_ADDRESS || readEvidence("escrow-deploy.json")?.contract;
  const escrow = await ethers.getContractAt("HoldEscrow", address, operator);
  console.log(`\n  escrow ${address}`);

  // "reject" reverts immediately and uses almost none of the payout stipend.
  // "burn" consumes the WHOLE stipend before failing, which is the genuinely
  // worst case — a cheap revert flatters the measurement by ~30k.
  const kind = process.env.PAYER_KIND || "reject";
  const factory = kind === "burn" ? "GasBurningRecipient" : "RejectingRecipient";
  console.log(`  deploying a hostile payer (${factory})...`);
  const rejecting = await (await ethers.getContractFactory(factory)).deploy({ gasLimit: 1_000_000 });
  await rejecting.waitForDeployment();
  const badPayer = await rejecting.getAddress();
  console.log(`  hostile payer ${badPayer}`);

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const p = {
    payer: badPayer, // the refund will be pushed here and bounce
    payee: operator.address,
    amountTinybar: AMOUNT_TINYBAR,
    deadline: BigInt(now + DELAY_SECONDS),
    hKey: ethers.keccak256(H("k-worst")),
    hCipher: H("c-worst"),
    hPlain: H("m-worst"),
    hRequest: H(`req-worst-${Date.now()}`),
  };

  const tx = await escrow.openHold(p, { gasLimit: OPEN_TX_GAS });
  const rc = await tx.wait();
  const ev = findEvent(escrow, rc, "HoldOpened");
  const holdId = ev.args.holdId;
  const entityId = toEntityId(ev.args.scheduleAddress);
  console.log(`\n  holdId ${holdId}  schedule ${entityId}  probesUsed ${ev.args.probesUsed}`);
  console.log(`  ${scheduleLink(entityId)}`);
  console.log(`  ${txLink(tx.hash)}`);

  const armed = Number(ev.args.armedDeadline);
  const waitS = armed + 20 - Math.floor(Date.now() / 1000);
  if (waitS > 0) {
    console.log(`\n  waiting ${waitS}s for the refund to fire and bounce...`);
    await sleep(waitS * 1000);
  }

  const sched = await mirrorGetUntil(`/api/v1/schedules/${entityId}`, (r) => !!r.executed_timestamp, {
    label: "worst-case refund",
  });
  const executedTimestamp = sched.record?.executed_timestamp;
  console.log(`  executed_timestamp ${executedTimestamp}   signatures ${JSON.stringify(sched.record?.signatures)}`);

  const { txn, result, hash } = await scheduledResult(executedTimestamp);
  const hold = await escrow.getHold(holdId);
  const credited = await escrow.withdrawableTinybar(badPayer);

  console.log(`\n  scheduled tx result   ${txn?.result}`);
  console.log(`  gas_used              ${result?.gas_used} of ${result?.gas_limit}`);
  console.log(`  hold status           ${hold.status}  (3 = REFUNDED — NOT stuck)`);
  console.log(`  credited to payer     ${credited} tinybar`);

  const measured = result?.gas_used ? BigInt(result.gas_used) : null;
  let recommended = null;
  if (measured) {
    const doubled = measured * 2n;
    recommended = ((doubled + 49_999n) / 50_000n) * 50_000n;
  }

  console.log(`\n  ═══════════════ WORST CASE ═══════════════`);
  console.log(`  refund with a bouncing payer   ${measured} gas`);
  console.log(`  REFUND_GAS currently           ${await escrow.REFUND_GAS()}`);
  console.log(`  RECOMMENDED (2x, to 50k)       ${recommended}`);
  console.log(`  ══════════════════════════════════════════\n`);

  saveEvidence(
    `gas-worstcase-${kind}.json`,
    jsonSafe({
      escrow: address,
      hostilePayer: badPayer,
      hostilePayerKind: kind,
      holdId,
      scheduleEntityId: entityId,
      scheduleHashscan: scheduleLink(entityId),
      openHoldGasUsed: rc.gasUsed,
      probesUsed: ev.args.probesUsed,
      executedTimestamp,
      signatures: sched.record?.signatures ?? null,
      scheduledTxResult: txn?.result ?? null,
      scheduledTxHash: hash ?? null,
      refundGasUsedWorstCase: result?.gas_used ?? null,
      refundGasLimit: result?.gas_limit ?? null,
      holdStatus: hold.status,
      creditedTinybar: credited,
      currentRefundGas: await escrow.REFUND_GAS(),
      recommendedRefundGas: recommended,
      measuredAt: new Date().toISOString(),
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
