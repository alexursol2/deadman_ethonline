/**
 * SPIKE 10 — will Blocky402 accept a CONTRACT's account id as x402 `payTo`?
 *
 * Plan 04 §8.8, and the last thing standing between spike 9's recommended
 * design and writing HoldEscrow.
 *
 * Spike 9 proved the on-chain half: a HAPI CryptoTransfer to a contract account
 * succeeds and credits it. What is unknown is whether the FACILITATOR permits a
 * contract as the destination — `validatePayToPolicy` calls `resolveAccount`,
 * which is the facilitator's own code and is not public.
 *
 * If it refuses, escrow-as-payTo dies, the fallback is a plain account
 * forwarding to the escrow, and the seller holds the buyer's money for a
 * moment — which is the exact gap this project exists to close.
 *
 * ONLY /verify IS CALLED. Verify validates a payment; it does not settle one.
 * /settle is never touched by this script.
 *
 *   npx hardhat run scripts/spike10-payto-contract.cjs --network hederaTestnet
 */
const hre = require("hardhat");
const { ethers } = hre;
const {
  Client,
  PrivateKey,
  AccountId,
  TransferTransaction,
  TransactionId,
  Hbar,
} = require("@hashgraph/sdk");
const { readEvidence, saveEvidence, mirrorGet, jsonSafe, report, fmtTinybar, weibarToTinybar, sleep } = require("./lib.cjs");

const FACILITATOR = (process.env.X402_FACILITATOR_URL || "https://api.testnet.blocky402.com").replace(/\/$/, "");
const NETWORK = "hedera:testnet";
const HBAR_ASSET = "0.0.0";
const AMOUNT_TINYBAR = "10000000"; // 0.1 HBAR. Never settled, only verified.
const FUND_BUYER_HBAR = "5.0";
const NODE_ACCOUNTS = [AccountId.fromString("0.0.3")];

/** Build the partially-signed transfer the exact-Hedera scheme expects. */
function buildPayload(buyerAccountId, buyerKey, payTo, feePayer) {
  // Fee delegation: the transaction ID belongs to the FACILITATOR (it pays the
  // fee), and the buyer signs to authorise the debit from their own account.
  const txId = TransactionId.generate(AccountId.fromString(feePayer));
  const tx = new TransferTransaction()
    .setTransactionId(txId)
    .setNodeAccountIds(NODE_ACCOUNTS)
    .addHbarTransfer(AccountId.fromString(buyerAccountId), Hbar.fromTinybars(-Number(AMOUNT_TINYBAR)))
    .addHbarTransfer(AccountId.fromString(payTo), Hbar.fromTinybars(Number(AMOUNT_TINYBAR)))
    .freeze();
  const signed = tx.sign(buyerKey);
  return signed;
}

async function verify(payTo, buyerAccountId, buyerKey, feePayer, label) {
  const signed = await buildPayload(buyerAccountId, buyerKey, payTo, feePayer);
  const transaction = Buffer.from(signed.toBytes()).toString("base64");

  const requirements = {
    scheme: "exact",
    network: NETWORK,
    amount: AMOUNT_TINYBAR,
    asset: HBAR_ASSET,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { feePayer },
  };
  const body = {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction } },
    paymentRequirements: requirements,
  };

  console.log(`\n  === ${label} ===`);
  console.log(`  payTo ${payTo}`);
  let status = null;
  let json = null;
  try {
    const res = await fetch(`${FACILITATOR}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  } catch (err) {
    json = { fetchError: String(err.message) };
  }
  console.log(`  HTTP ${status}`);
  console.log(`  ${JSON.stringify(json)}`);
  return { label, payTo, status, response: json };
}

async function main() {
  const [operator] = await ethers.getSigners();

  /* --------------------------------------------- what does it advertise? */
  const sup = await (await fetch(`${FACILITATOR}/supported`)).json();
  const hederaKind = (sup.kinds || []).find((k) => k.network === NETWORK);
  const feePayer = hederaKind?.extra?.feePayer;
  console.log(`\n  facilitator ${FACILITATOR}`);
  console.log(`  feePayer    ${feePayer}`);
  if (!feePayer) throw new Error("No hedera:testnet feePayer advertised; cannot build a payload.");

  /* ------------------------------------------------------ the two payTos */
  const opInfo = await mirrorGet(`/api/v1/accounts/${operator.address}`, { label: "operator id" });
  const operatorAccountId = opInfo.ok ? opInfo.body.account : null;

  // A contract we control. Reuse spike 9's sink if present, else deploy one.
  let contractEvm = readEvidence("spike9-result.json")?.sinkEvm;
  if (!contractEvm) {
    const sink = await (await ethers.getContractFactory("ValueSink")).deploy({ gasLimit: 3_000_000 });
    await sink.waitForDeployment();
    contractEvm = await sink.getAddress();
  }
  const cInfo = await mirrorGet(`/api/v1/contracts/${contractEvm}`, { label: "contract id" });
  const contractAccountId = cInfo.ok ? cInfo.body.contract_id : null;
  if (!contractAccountId) throw new Error("Could not resolve the contract's entity id.");

  console.log(`  control payTo (plain account) ${operatorAccountId}`);
  console.log(`  subject payTo (CONTRACT)      ${contractAccountId}  <- ${contractEvm}`);

  /* ------------------------------------------------------- a fresh buyer */
  // Not the operator: the operator is the control's payTo, and buyer == payTo
  // would be rejected for a reason that has nothing to do with the question.
  const buyer = ethers.Wallet.createRandom();
  console.log(`\n  funding a fresh buyer ${buyer.address} with ${FUND_BUYER_HBAR} HBAR...`);
  // 2,000,000 gas: a transfer to an unseen address also CREATES the account. Spike 4.
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
  const buyerBal = weibarToTinybar(await ethers.provider.getBalance(buyer.address));
  console.log(`  buyer ${buyerAccountId}  ${fmtTinybar(buyerBal)}`);
  const buyerKey = PrivateKey.fromStringECDSA(buyer.privateKey.slice(2));

  /* --------------------------------------------------------- the two calls */
  // Control first. If the control is rejected, our payload shape is wrong and
  // the subject's result says nothing about contracts.
  const control = await verify(operatorAccountId, buyerAccountId, buyerKey, feePayer, "CONTROL — plain account as payTo");
  const subject = await verify(contractAccountId, buyerAccountId, buyerKey, feePayer, "SUBJECT — CONTRACT as payTo");

  const ok = (r) => r.status === 200 && r.response?.isValid === true;
  const reason = (r) => r.response?.invalidReason ?? r.response?.error ?? null;

  const controlOk = ok(control);
  const subjectOk = ok(subject);
  const sameReason = reason(control) && reason(control) === reason(subject);

  const verdict = !controlOk
    ? `INCONCLUSIVE — the control was rejected too (${reason(control)}). Payload shape is wrong; nothing learned about contracts.`
    : subjectOk
      ? "CONTRACT ACCEPTED as payTo — escrow-as-payTo is viable"
      : sameReason
        ? `INCONCLUSIVE — both rejected for the same reason (${reason(subject)})`
        : `CONTRACT REJECTED as payTo (${reason(subject)}) — escrow-as-payTo is NOT available`;

  const allPassed = report("SPIKE 10 — contract as x402 payTo", [
    {
      name: "CONTROL: a plain account is accepted as payTo",
      expected: "isValid true",
      actual: `HTTP ${control.status}, isValid=${control.response?.isValid}, reason=${reason(control)}`,
      pass: controlOk,
    },
    {
      name: "SUBJECT: a contract account is accepted as payTo",
      expected: "isValid true",
      actual: `HTTP ${subject.status}, isValid=${subject.response?.isValid}, reason=${reason(subject)}`,
      pass: subjectOk,
    },
  ]);

  console.log(`  VERDICT: ${verdict}\n`);

  saveEvidence(
    "spike10-result.json",
    jsonSafe({
      verdict,
      controlAccepted: controlOk,
      contractAcceptedAsPayTo: controlOk ? subjectOk : null,
      facilitator: FACILITATOR,
      feePayer,
      buyerAccountId,
      controlPayTo: operatorAccountId,
      subjectPayTo: contractAccountId,
      subjectContractEvm: contractEvm,
      amountTinybar: AMOUNT_TINYBAR,
      control,
      subject,
      note: "Only /verify was called. No settlement was attempted.",
      ranAt: new Date().toISOString(),
    }),
  );

  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
