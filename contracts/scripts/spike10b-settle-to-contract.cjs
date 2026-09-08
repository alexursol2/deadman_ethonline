/**
 * SPIKE 10b — will Blocky402 actually SETTLE an x402 payment into a contract?
 *
 * Spike 10 showed /verify accepts a contract as payTo. Verify checks policy;
 * settle submits. The facilitator could still refuse at submission, and finding
 * that out on demo day would be the worst possible time.
 *
 * This one MOVES MONEY: 0.1 testnet HBAR, from a throwaway buyer we funded, to
 * a contract we own. Both ends are ours, the amount is trivial, and it is
 * testnet. It is also a dry run of the Hedera track's "at least one real paid
 * request end to end" requirement.
 *
 *   npx hardhat run scripts/spike10b-settle-to-contract.cjs --network hederaTestnet
 */
const hre = require("hardhat");
const { ethers } = hre;
const { PrivateKey, AccountId, TransferTransaction, TransactionId, Hbar } = require("@hashgraph/sdk");
const {
  readEvidence,
  saveEvidence,
  mirrorGet,
  mirrorGetUntil,
  jsonSafe,
  report,
  fmtTinybar,
  weibarToTinybar,
  sleep,
} = require("./lib.cjs");

const FACILITATOR = (process.env.X402_FACILITATOR_URL || "https://api.testnet.blocky402.com").replace(/\/$/, "");
const NETWORK = "hedera:testnet";
const HBAR_ASSET = "0.0.0";
const AMOUNT_TINYBAR = "10000000"; // 0.1 HBAR
const FUND_BUYER_HBAR = "5.0";
const NODE_ACCOUNTS = [AccountId.fromString("0.0.3")];

function buildSigned(buyerAccountId, buyerKey, payTo, feePayer) {
  return new TransferTransaction()
    .setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)))
    .setNodeAccountIds(NODE_ACCOUNTS)
    .addHbarTransfer(AccountId.fromString(buyerAccountId), Hbar.fromTinybars(-Number(AMOUNT_TINYBAR)))
    .addHbarTransfer(AccountId.fromString(payTo), Hbar.fromTinybars(Number(AMOUNT_TINYBAR)))
    .freeze()
    .sign(buyerKey);
}

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

async function main() {
  const [operator] = await ethers.getSigners();

  const sup = await (await fetch(`${FACILITATOR}/supported`)).json();
  const feePayer = (sup.kinds || []).find((k) => k.network === NETWORK)?.extra?.feePayer;
  console.log(`\n  facilitator ${FACILITATOR}   feePayer ${feePayer}`);

  const contractEvm = readEvidence("spike9-result.json")?.sinkEvm;
  const cInfo = await mirrorGet(`/api/v1/contracts/${contractEvm}`, { label: "contract id" });
  const payTo = cInfo.ok ? cInfo.body.contract_id : null;
  if (!payTo) throw new Error("Could not resolve the destination contract's entity id.");
  console.log(`  destination CONTRACT ${payTo}  <- ${contractEvm}`);

  const sink = await ethers.getContractAt("ValueSink", contractEvm);
  const balBefore = await sink.balanceTinybar();
  const receiveCallsBefore = await sink.receiveCalls();
  console.log(`  balance before ${fmtTinybar(balBefore)}   receiveCalls ${receiveCallsBefore}`);

  /* ------------------------------------------------------- fresh buyer */
  const buyer = ethers.Wallet.createRandom();
  console.log(`\n  funding a throwaway buyer ${buyer.address}...`);
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
  console.log(`  buyer ${buyerAccountId}`);
  const buyerKey = PrivateKey.fromStringECDSA(buyer.privateKey.slice(2));

  const requirements = {
    scheme: "exact",
    network: NETWORK,
    amount: AMOUNT_TINYBAR,
    asset: HBAR_ASSET,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { feePayer },
  };
  const mkBody = (signed) => ({
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction: Buffer.from(signed.toBytes()).toString("base64") },
    },
    paymentRequirements: requirements,
  });

  /* ------------------------------------------------------------ verify */
  // A Hedera transaction is only valid for ~180s, so build fresh and move.
  console.log(`\n  POST /verify ...`);
  const v = await post("/verify", mkBody(await buildSigned(buyerAccountId, buyerKey, payTo, feePayer)));
  console.log(`  HTTP ${v.status}  ${JSON.stringify(v.json)}`);

  /* ------------------------------------------------------------ settle */
  console.log(`\n  POST /settle ... (this moves 0.1 testnet HBAR into the contract)`);
  const s = await post("/settle", mkBody(await buildSigned(buyerAccountId, buyerKey, payTo, feePayer)));
  console.log(`  HTTP ${s.status}  ${JSON.stringify(s.json)}`);

  await sleep(6000);
  const balAfter = await sink.balanceTinybar();
  const receiveCallsAfter = await sink.receiveCalls();
  const credited = balAfter - balBefore;
  console.log(`\n  balance after ${fmtTinybar(balAfter)}   credited ${credited} tinybar`);
  console.log(`  receiveCalls ${receiveCallsBefore} -> ${receiveCallsAfter}`);

  const settleOk = s.status === 200 && (s.json?.success === true || !!s.json?.transaction);
  const landed = credited === BigInt(AMOUNT_TINYBAR);

  const allPassed = report("SPIKE 10b — settling an x402 payment into a contract", [
    { name: "/verify accepted the contract payTo", expected: "isValid true", actual: JSON.stringify(v.json), pass: v.json?.isValid === true },
    { name: "/settle accepted and submitted", expected: "HTTP 200, success", actual: `HTTP ${s.status} ${JSON.stringify(s.json)}`, pass: settleOk },
    { name: "the contract was actually credited", expected: `${AMOUNT_TINYBAR} tinybar`, actual: `${credited} tinybar`, pass: landed },
    {
      name: "receive() did NOT run (confirms spike 9 on the real settlement path)",
      expected: "unchanged",
      actual: `${receiveCallsBefore} -> ${receiveCallsAfter}`,
      pass: receiveCallsAfter === receiveCallsBefore,
    },
  ]);

  saveEvidence(
    "spike10b-result.json",
    jsonSafe({
      passed: allPassed,
      facilitator: FACILITATOR,
      feePayer,
      buyerAccountId,
      payToContract: payTo,
      contractEvm,
      amountTinybar: AMOUNT_TINYBAR,
      verify: v,
      settle: s,
      balanceBeforeTinybar: balBefore,
      balanceAfterTinybar: balAfter,
      creditedTinybar: credited,
      receiveCallsBefore,
      receiveCallsAfter,
      ranAt: new Date().toISOString(),
    }),
  );

  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
