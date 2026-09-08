/**
 * END TO END: x402 settle -> openHold -> network-executed refund.
 *
 * The two halves have been proven separately and never as one sequence:
 *
 *   spike 10  a real x402 payment through Blocky402 landing in a contract
 *   spike 11  a hold opened and refunded unattended, funded by a plain transfer
 *
 * This runs them joined up, which is the actual product:
 *
 *   1. a fresh buyer pays the ESCROW via Blocky402 /settle
 *   2. the escrow is credited WITHOUT its code running (C12)
 *   3. the server calls openHold, attributing those funds and arming the refund
 *   4. nobody does anything
 *   5. the network executes the refund and the buyer is made whole
 *
 * Step 4 is the product. Step 3 is the window the README discloses.
 *
 * Moves real testnet HBAR between accounts we own.
 *
 *   npx hardhat run scripts/e2e-settle-open-refund.cjs --network hederaTestnet
 */
const hre = require("hardhat");
const { ethers } = hre;
const { PrivateKey, AccountId, TransferTransaction, TransactionId, Hbar } = require("@hashgraph/sdk");
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
  weibarToTinybar,
  sleep,
} = require("./lib.cjs");

const FACILITATOR = (process.env.X402_FACILITATOR_URL || "https://api.testnet.blocky402.com").replace(/\/$/, "");
const NETWORK = "hedera:testnet";
const HBAR_ASSET = "0.0.0";
const PRICE_TINYBAR = 50_000_000n; // 0.5 HBAR — the "price" of the API call
const FUND_BUYER_HBAR = "3.0";
const DEADLINE_SECONDS = 45;
const OPEN_TX_GAS = 5_000_000;
const NODE_ACCOUNTS = [AccountId.fromString("0.0.3")];
const H = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function post(path, body) {
  const res = await fetch(`${FACILITATOR}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** The contract result for a network-executed call — not listed under the contract (spike 8). */
async function scheduledResult(ts) {
  const t = await mirrorGet(`/api/v1/transactions?timestamp=${ts}`, { label: "sched tx" });
  const txn = (t.ok ? t.body.transactions || [] : []).find((x) => x.name === "CONTRACTCALL");
  if (!txn?.transaction_hash) return { txn: null, result: null };
  const hash = "0x" + Buffer.from(txn.transaction_hash, "base64").toString("hex").slice(0, 64);
  const r = await mirrorGet(`/api/v1/contracts/results/${hash}`, { label: "sched result" });
  return { txn, result: r.ok ? r.body : null, hash };
}

async function main() {
  const [operator] = await ethers.getSigners(); // acts as the resource server / seller
  const escrowAddress = process.env.ESCROW_ADDRESS || readEvidence("escrow-deploy.json")?.contract;
  const escrow = await ethers.getContractAt("HoldEscrow", escrowAddress, operator);

  const cInfo = await mirrorGet(`/api/v1/contracts/${escrowAddress}`, { label: "escrow id" });
  const escrowEntityId = cInfo.ok ? cInfo.body.contract_id : null;
  if (!escrowEntityId) throw new Error("Could not resolve the escrow's entity id.");

  console.log(`\n  escrow    ${escrowAddress}  =  ${escrowEntityId}   <- the x402 payTo`);
  console.log(`  seller    ${operator.address}`);
  console.log(`  free      ${fmtTinybar(await escrow.freeTinybar())}`);
  console.log(`  reserve   ${fmtTinybar(await escrow.requiredReserveTinybar())} required`);

  const sup = await (await fetch(`${FACILITATOR}/supported`)).json();
  const feePayer = (sup.kinds || []).find((k) => k.network === NETWORK)?.extra?.feePayer;
  console.log(`  facilitator ${FACILITATOR}  feePayer ${feePayer}`);

  /* ═══════════════════ 1. a buyer, and its first ever payment ═══════════════ */
  const buyer = ethers.Wallet.createRandom();
  console.log(`\n  === 1. a fresh agent wallet ===`);
  console.log(`  buyer ${buyer.address}`);
  // 2,000,000 gas: paying an address Hedera has never seen also CREATES it (spike 4).
  await (
    await operator.sendTransaction({
      to: buyer.address,
      value: ethers.parseEther(FUND_BUYER_HBAR),
      gasLimit: 2_000_000,
    })
  ).wait();
  await sleep(4000);
  const bInfo = await mirrorGet(`/api/v1/accounts/${buyer.address}`, { label: "buyer id" });
  const buyerAccountId = bInfo.ok ? bInfo.body.account : null;
  if (!buyerAccountId) throw new Error("Buyer account did not materialise.");
  const buyerStart = weibarToTinybar(await ethers.provider.getBalance(buyer.address));
  console.log(`  ${buyerAccountId}   ${fmtTinybar(buyerStart)}`);

  /* ════════════════════════ 2. settle through x402 ═════════════════════════ */
  console.log(`\n  === 2. the agent pays ${Number(PRICE_TINYBAR) / 1e8} HBAR through Blocky402 ===`);
  const escrowFreeBefore = await escrow.freeTinybar();
  const buyerKey = PrivateKey.fromStringECDSA(buyer.privateKey.slice(2));

  const requirements = {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_TINYBAR.toString(),
    asset: HBAR_ASSET,
    payTo: escrowEntityId, // THE ESCROW. The seller never holds the money.
    maxTimeoutSeconds: 300,
    extra: { feePayer },
  };
  const build = () =>
    new TransferTransaction()
      .setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)))
      .setNodeAccountIds(NODE_ACCOUNTS)
      .addHbarTransfer(AccountId.fromString(buyerAccountId), Hbar.fromTinybars(-Number(PRICE_TINYBAR)))
      .addHbarTransfer(AccountId.fromString(escrowEntityId), Hbar.fromTinybars(Number(PRICE_TINYBAR)))
      .freeze()
      .sign(buyerKey);
  const body = async () => ({
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction: Buffer.from((await build()).toBytes()).toString("base64") },
    },
    paymentRequirements: requirements,
  });

  const v = await post("/verify", await body());
  console.log(`  /verify  ${v.status}  ${JSON.stringify(v.json)}`);
  const s = await post("/settle", await body());
  console.log(`  /settle  ${s.status}  ${JSON.stringify(s.json)}`);
  const settleTxId = s.json?.transaction ?? null;

  await sleep(6000);
  const buyerAfterSettle = weibarToTinybar(await ethers.provider.getBalance(buyer.address));
  console.log(`  buyer paid: ${fmtTinybar(buyerStart)} -> ${fmtTinybar(buyerAfterSettle)}`);
  const escrowFreeAfterSettle = await escrow.freeTinybar();
  const credited = escrowFreeAfterSettle - escrowFreeBefore;
  console.log(`  escrow free ${fmtTinybar(escrowFreeBefore)} -> ${fmtTinybar(escrowFreeAfterSettle)}`);
  console.log(`  credited ${credited} tinybar  (openHold has funds to attribute)`);

  /* ═══════════════ 3. the server arms the refund over those funds ══════════ */
  console.log(`\n  === 3. the server opens a hold over the settled payment ===`);
  const nowSec = (await ethers.provider.getBlock("latest")).timestamp;
  const secret = H(`agent-result-${Date.now()}`);
  const p = {
    payer: buyer.address, // the refund goes back HERE if the seller stays silent
    payee: operator.address,
    amountTinybar: PRICE_TINYBAR,
    deadline: BigInt(nowSec + DEADLINE_SECONDS),
    hKey: ethers.keccak256(secret),
    hCipher: H("ciphertext-of-the-result"),
    hPlain: H("plaintext-the-seller-claims"),
    hRequest: H(`GET /premium?q=e2e&n=${Date.now()}`),
  };
  const openTx = await escrow.openHold(p, { gasLimit: OPEN_TX_GAS });
  const openRc = await openTx.wait();
  const ev = findEvent(escrow, openRc, "HoldOpened");
  const holdId = ev.args.holdId;
  const entityId = toEntityId(ev.args.scheduleAddress);
  console.log(`  holdId ${holdId}  schedule ${entityId}  gas ${openRc.gasUsed}`);
  console.log(`  ${scheduleLink(entityId)}`);
  console.log(`  ${txLink(openTx.hash)}`);
  console.log(`  armed for ${ev.args.armedDeadline}`);

  /* ════════════════════════ 4. NOBODY DOES ANYTHING ════════════════════════ */
  const armed = Number(ev.args.armedDeadline);
  const waitS = armed + 20 - Math.floor(Date.now() / 1000);
  console.log(`\n  === 4. the seller stays silent. Waiting ${waitS}s. Nothing is submitted. ===`);
  if (waitS > 0) await sleep(waitS * 1000);

  /* ═════════════════════ 5. the network refunds the buyer ══════════════════ */
  console.log(`\n  === 5. the network executes the refund ===`);
  const sched = await mirrorGetUntil(`/api/v1/schedules/${entityId}`, (r) => !!r.executed_timestamp, {
    label: "refund",
  });
  const executedTimestamp = sched.record?.executed_timestamp;
  const { txn, result } = await scheduledResult(executedTimestamp);
  const hold = await escrow.getHold(holdId);
  const buyerEnd = weibarToTinybar(await ethers.provider.getBalance(buyer.address));

  console.log(`  executed_timestamp ${executedTimestamp}`);
  console.log(`  signatures         ${JSON.stringify(sched.record?.signatures)}`);
  console.log(`  scheduled tx       ${txn?.result}   gas ${result?.gas_used} of ${result?.gas_limit}`);
  console.log(`  hold status        ${hold.status} (3 = REFUNDED)`);
  console.log(`  buyer balance      start ${fmtTinybar(buyerStart)} -> after paying ${fmtTinybar(buyerAfterSettle)} -> after refund ${fmtTinybar(buyerEnd)}`);

  // The buyer paid before the refund, so the meaningful assertions are that the
  // settlement debited them and the refund put them back exactly where they
  // started. A raw start-to-end delta of zero IS the success condition here.
  const paid = buyerStart - buyerAfterSettle;
  const refundLanded = buyerEnd - buyerAfterSettle;
  const allPassed = report("END TO END — settle, open, refund", [
    { name: "/settle succeeded through Blocky402", expected: "success", actual: JSON.stringify(s.json), pass: s.status === 200 && s.json?.success === true },
    { name: "the escrow was credited by the settlement", expected: `${PRICE_TINYBAR} tinybar`, actual: `${credited}`, pass: credited === PRICE_TINYBAR },
    { name: "openHold armed a refund over those funds", expected: "HoldOpened", actual: `holdId ${holdId}, schedule ${entityId}`, pass: Boolean(ev) },
    { name: "the network executed it with NOBODY acting", expected: "executed, signatures []", actual: `${executedTimestamp}, ${JSON.stringify(sched.record?.signatures)}`, pass: sched.settled && Array.isArray(sched.record?.signatures) && sched.record.signatures.length === 0 },
    { name: "the hold is REFUNDED", expected: "3", actual: String(hold.status), pass: hold.status === 3n },
    { name: "the settlement debited the buyer", expected: `-${PRICE_TINYBAR} tinybar`, actual: `-${paid}`, pass: paid === PRICE_TINYBAR },
    { name: "the refund put it back", expected: `+${PRICE_TINYBAR} tinybar`, actual: `+${refundLanded}`, pass: refundLanded === PRICE_TINYBAR },
    { name: "the buyer is exactly whole — paid, and made whole, with nobody acting", expected: `${buyerStart}`, actual: `${buyerEnd}`, pass: buyerEnd === buyerStart },
  ]);

  saveEvidence(
    "e2e-settle-open-refund.json",
    jsonSafe({
      passed: allPassed,
      escrow: escrowAddress,
      escrowEntityId,
      facilitator: FACILITATOR,
      feePayer,
      buyer: buyer.address,
      buyerAccountId,
      seller: operator.address,
      priceTinybar: PRICE_TINYBAR,
      verify: v,
      settle: s,
      settleTxId,
      creditedTinybar: credited,
      holdId,
      openHoldTx: openTx.hash,
      openHoldGasUsed: openRc.gasUsed,
      scheduleEntityId: entityId,
      scheduleHashscan: scheduleLink(entityId),
      armedDeadline: ev.args.armedDeadline,
      probesUsed: ev.args.probesUsed,
      executedTimestamp,
      signatures: sched.record?.signatures ?? null,
      refundGasUsed: result?.gas_used ?? null,
      holdStatus: hold.status,
      buyerStartTinybar: buyerStart,
      buyerAfterSettleTinybar: buyerAfterSettle,
      buyerEndTinybar: buyerEnd,
      paidTinybar: paid,
      refundLandedTinybar: refundLanded,
      buyerIsWhole: buyerEnd === buyerStart,
      ranAt: new Date().toISOString(),
    }),
  );

  if (!allPassed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
