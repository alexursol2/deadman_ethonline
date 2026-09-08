/**
 * Measure what HoldEscrow actually costs on testnet, and set REFUND_GAS from
 * the measurement rather than from the pre-implementation budget.
 *
 * Plan 04 §Q7 derived 400,000 by adding up EVM gas-schedule line items on top of
 * spike 6's measured ~132,000. That was an estimate wearing arithmetic. This
 * arms a real refund, lets the network execute it, and reads the gas.
 *
 * Also measures openHold, because the resource server has to set a gas limit on
 * the transaction that calls it and C4 makes that number unusually large.
 *
 *   npx hardhat run scripts/measure-gas.cjs --network hederaTestnet
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
  fmtTinybar,
  sleep,
} = require("./lib.cjs");

const OPEN_TX_GAS = 5_000_000;
const AMOUNT_TINYBAR = 100_000_000n; // 1 HBAR
const DELAY_SECONDS = 45;

const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function openOne(escrow, payer, payee, tag) {
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const p = {
    payer,
    payee,
    amountTinybar: AMOUNT_TINYBAR,
    deadline: BigInt(now + DELAY_SECONDS),
    hKey: ethers.keccak256(H(`key-${tag}`)),
    hCipher: H(`cipher-${tag}`),
    hPlain: H(`plain-${tag}`),
    hRequest: H(`request-${tag}-${Date.now()}`),
  };
  const tx = await escrow.openHold(p, { gasLimit: OPEN_TX_GAS });
  const rc = await tx.wait();
  const ev = findEvent(escrow, rc, "HoldOpened");
  if (!ev) throw new Error(`No HoldOpened in ${tx.hash}`);
  return { p, tx, rc, ev, key: H(`key-${tag}`) };
}

/**
 * Find a network-executed call's own record.
 *
 * Spike 8: scheduled executions do NOT appear under
 * /contracts/{address}/results. Only /transactions?timestamp= sees them, and
 * the per-result endpoint has to be reached by the transaction's own hash.
 */
async function scheduledExecutionRecord(executedTimestamp) {
  const t = await mirrorGet(`/api/v1/transactions?timestamp=${executedTimestamp}`, { label: "sched tx" });
  const txn = (t.ok ? t.body.transactions || [] : []).find((x) => x.name === "CONTRACTCALL");
  if (!txn?.transaction_hash) return { txn: null, result: null, hash: null };
  // The mirror gives the hash base64 and 48 bytes long; /contracts/results wants
  // the 32-byte prefix in hex. The full value is rejected with a 400, and
  // /contracts/{address}/results does not list scheduled executions at all.
  const hash = "0x" + Buffer.from(txn.transaction_hash, "base64").toString("hex").slice(0, 64);
  const r = await mirrorGet(`/api/v1/contracts/results/${hash}`, { label: "sched result" });
  return { txn, result: r.ok ? r.body : null, hash };
}

async function main() {
  const [operator] = await ethers.getSigners();
  const address = process.env.ESCROW_ADDRESS || readEvidence("escrow-deploy.json")?.contract;
  const escrow = await ethers.getContractAt("HoldEscrow", address, operator);
  console.log(`\n  escrow ${address}`);
  console.log(`  REFUND_GAS currently ${await escrow.REFUND_GAS()}`);

  const out = {};

  /* ═══════════════════════ 1. a hold that gets REFUNDED ═══════════════════ */
  console.log(`\n  === 1. open a hold and let the network refund it ===`);
  const balBefore = await escrow.balanceTinybar();
  const a = await openOne(escrow, operator.address, operator.address, "refunded");
  const entityId = toEntityId(a.ev.args.scheduleAddress);
  console.log(`  holdId ${a.ev.args.holdId}   schedule ${entityId}`);
  console.log(`  ${scheduleLink(entityId)}`);
  console.log(`  openHold gasUsed ${a.rc.gasUsed}   probesUsed ${a.ev.args.probesUsed}`);
  console.log(`  armed for ${a.ev.args.armedDeadline} (requested ${a.ev.args.requestedDeadline})`);
  console.log(`  ${txLink(a.tx.hash)}`);
  out.openHoldGasUsed = a.rc.gasUsed;
  out.probesUsed = a.ev.args.probesUsed;

  const armed = Number(a.ev.args.armedDeadline);
  const waitS = armed + 20 - Math.floor(Date.now() / 1000);
  if (waitS > 0) {
    console.log(`\n  waiting ${waitS}s for the network to execute the refund...`);
    await sleep(waitS * 1000);
  }

  const sched = await mirrorGetUntil(
    `/api/v1/schedules/${entityId}`,
    (r) => !!r.executed_timestamp,
    { label: "refund executed" },
  );
  console.log(`  executed_timestamp ${sched.record?.executed_timestamp}  signatures ${JSON.stringify(sched.record?.signatures)}`);

  const hold1 = await escrow.getHold(a.ev.args.holdId);
  console.log(`  hold status ${hold1.status} (3 = REFUNDED)`);

  const { txn, result, hash } = await scheduledExecutionRecord(sched.record?.executed_timestamp);
  console.log(`  scheduled tx result ${txn?.result}   charged ${txn?.charged_tx_fee} tinybar`);
  if (result) {
    console.log(`  REFUND gas_used ${result.gas_used}  of gas_limit ${result.gas_limit}`);
  } else {
    console.log(`  (no contract result row; falling back to fee-derived gas)`);
  }

  out.refundExecutedTimestamp = sched.record?.executed_timestamp ?? null;
  out.refundSignatures = sched.record?.signatures ?? null;
  out.refundTxResult = txn?.result ?? null;
  out.refundChargedTinybar = txn?.charged_tx_fee ?? null;
  out.refundGasUsed = result?.gas_used ?? null;
  out.refundGasLimit = result?.gas_limit ?? null;
  out.refundTxHash = hash ?? null;
  out.holdStatusAfterRefund = hold1.status;

  const balAfter = await escrow.balanceTinybar();
  console.log(`  escrow balance ${fmtTinybar(balBefore)} -> ${fmtTinybar(balAfter)}`);

  /* ═════════════════════════ 2. a hold that gets CLAIMED ══════════════════ */
  console.log(`\n  === 2. open a hold and claim it ===`);
  const b = await openOne(escrow, operator.address, operator.address, "claimed");
  const bEntity = toEntityId(b.ev.args.scheduleAddress);
  console.log(`  holdId ${b.ev.args.holdId}   schedule ${bEntity}`);
  console.log(`  openHold gasUsed ${b.rc.gasUsed}`);

  const claimTx = await escrow.claim(b.ev.args.holdId, b.key, { gasLimit: 3_000_000 });
  const claimRc = await claimTx.wait();
  console.log(`  claim gasUsed ${claimRc.gasUsed}   ${txLink(claimTx.hash)}`);

  const bAfter = await mirrorGetUntil(`/api/v1/schedules/${bEntity}`, (r) => r.deleted === true, {
    label: "claim deleted schedule",
  });
  const hold2 = await escrow.getHold(b.ev.args.holdId);
  console.log(`  schedule deleted ${bAfter.record?.deleted}   hold status ${hold2.status} (2 = CLAIMED)`);

  out.claimGasUsed = claimRc.gasUsed;
  out.claimDeletedSchedule = bAfter.settled;
  out.holdStatusAfterClaim = hold2.status;
  out.openHoldGasUsedSecond = b.rc.gasUsed;

  /* ══════════════════════════════ recommendation ═════════════════════════ */
  const measured = out.refundGasUsed ? BigInt(out.refundGasUsed) : null;
  let recommended = null;
  if (measured) {
    // 2x the measured worst case, rounded up to the next 50k. Over-requesting is
    // nearly free (C8: charged for gas used); under-requesting strands the hold
    // (C11: the schedule is spent and cannot be re-armed).
    const doubled = measured * 2n;
    recommended = ((doubled + 49_999n) / 50_000n) * 50_000n;
  }

  console.log(`\n  ═══════════════ RESULT ═══════════════`);
  console.log(`  openHold                 ${out.openHoldGasUsed} gas`);
  console.log(`  claim                    ${out.claimGasUsed} gas`);
  console.log(`  refund (network-executed) ${out.refundGasUsed ?? "?"} gas of ${out.refundGasLimit ?? "?"} requested`);
  if (recommended) {
    console.log(`  REFUND_GAS currently     ${await escrow.REFUND_GAS()}`);
    console.log(`  RECOMMENDED              ${recommended}   (2x measured, rounded to 50k)`);
  }
  console.log(`  ══════════════════════════════════════\n`);

  out.recommendedRefundGas = recommended;
  saveEvidence("gas-measurements.json", jsonSafe({ escrow: address, ...out, measuredAt: new Date().toISOString() }));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
