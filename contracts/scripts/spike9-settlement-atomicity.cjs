/**
 * SPIKE 9 — can the x402 settlement arm a hold atomically?
 *
 * Part A (package read, done separately): @x402/hedera's exact scheme builds a
 * TransferTransaction and the facilitator rejects anything else with
 * "invalid_exact_hedera_payload_contains_non_transfer_ops". So the settlement
 * cannot BE a contract call.
 *
 * Part B, measured here: does a HAPI CryptoTransfer to a contract run its
 * receive()? On the EVM a value transfer does. A HAPI CryptoTransfer is not an
 * EVM transaction and may just credit the account.
 *
 *   receive() runs      -> the escrow can be the x402 payTo and open the hold itself
 *   receive() does NOT  -> atomicity is not available; the gap must be designed for
 *
 *   npx hardhat run scripts/spike9-settlement-atomicity.cjs --network hederaTestnet
 */
const hre = require("hardhat");
const { ethers } = hre;
const {
  Client,
  PrivateKey,
  AccountId,
  ContractId,
  TransferTransaction,
  Hbar,
} = require("@hashgraph/sdk");
const { saveEvidence, mirrorGet, jsonSafe, report, txLink, fmtTinybar, sleep } = require("./lib.cjs");

const EVM_SEND_HBAR = "1.0";
const HAPI_SEND_TINYBAR = 200_000_000; // 2 HBAR, distinct from the control so deltas are unambiguous

async function main() {
  const [operator] = await ethers.getSigners();

  /* ------------------------------------------------------- fresh sink */
  console.log(`\n  deploying a fresh ValueSink...`);
  const sink = await (await ethers.getContractFactory("ValueSink")).deploy({ gasLimit: 3_000_000 });
  await sink.waitForDeployment();
  const sinkEvm = await sink.getAddress();
  const info = await mirrorGet(`/api/v1/contracts/${sinkEvm}`, { label: "sink id" });
  const sinkEntityId = info.ok ? info.body.contract_id : null;
  console.log(`  sink   ${sinkEvm}  =  ${sinkEntityId}`);
  if (!sinkEntityId) throw new Error("Could not resolve the sink's Hedera entity id.");

  const snap = async () => ({
    receiveCalls: await sink.receiveCalls(),
    landings: await sink.landings(),
    balanceTinybar: await sink.balanceTinybar(),
  });
  const s0 = await snap();
  console.log(`  start  receiveCalls=${s0.receiveCalls} balance=${fmtTinybar(s0.balanceTinybar)}`);

  /* ---------------------------------------- CONTROL: EVM value transfer */
  // Proves the counter works and the contract is reachable. Without this,
  // "receiveCalls did not move" is indistinguishable from a broken counter.
  console.log(`\n  === CONTROL: ordinary EVM value transfer of ${EVM_SEND_HBAR} HBAR (JSON-RPC) ===`);
  const evmTx = await operator.sendTransaction({
    to: sinkEvm,
    value: ethers.parseEther(EVM_SEND_HBAR),
    gasLimit: 200_000,
  });
  await evmTx.wait();
  const s1 = await snap();
  console.log(`  tx     ${evmTx.hash}`);
  console.log(`         ${txLink(evmTx.hash)}`);
  console.log(`  after  receiveCalls=${s1.receiveCalls} balance=${fmtTinybar(s1.balanceTinybar)}`);
  const controlRan = s1.receiveCalls === s0.receiveCalls + 1n;
  console.log(`  -> receive() ${controlRan ? "RAN" : "*** DID NOT RUN — the counter is broken ***"}`);

  /* ------------------------------- SUBJECT: HAPI CryptoTransfer */
  console.log(`\n  === SUBJECT: HAPI CryptoTransfer of ${HAPI_SEND_TINYBAR / 1e8} HBAR (consensus node) ===`);
  const rawKey = (process.env.HEDERA_OPERATOR_KEY || "").trim();
  const opKey = PrivateKey.fromStringECDSA(rawKey.startsWith("0x") ? rawKey.slice(2) : rawKey);

  // Resolve the operator's Hedera account id from its EVM address.
  const opInfo = await mirrorGet(`/api/v1/accounts/${operator.address}`, { label: "operator id" });
  const opAccountId = opInfo.ok ? opInfo.body.account : null;
  if (!opAccountId) throw new Error("Could not resolve the operator's Hedera account id.");
  console.log(`  operator account ${opAccountId}`);

  const client = Client.forTestnet().setOperator(AccountId.fromString(opAccountId), opKey);
  let hapiStatus = null;
  let hapiTxId = null;
  try {
    const tx = await new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(opAccountId), Hbar.fromTinybars(-HAPI_SEND_TINYBAR))
      // The contract, addressed as an ACCOUNT. This is what an x402 payTo would do.
      .addHbarTransfer(ContractId.fromString(sinkEntityId), Hbar.fromTinybars(HAPI_SEND_TINYBAR))
      .execute(client);
    const receipt = await tx.getReceipt(client);
    hapiStatus = receipt.status.toString();
    hapiTxId = tx.transactionId.toString();
    console.log(`  status ${hapiStatus}`);
    console.log(`  tx id  ${hapiTxId}`);
  } catch (err) {
    hapiStatus = `THREW: ${String(err.message).slice(0, 160)}`;
    console.log(`  ${hapiStatus}`);
  } finally {
    client.close();
  }

  await sleep(5000); // let the mirror catch up before reading state back
  const s2 = await snap();
  console.log(`  after  receiveCalls=${s2.receiveCalls} balance=${fmtTinybar(s2.balanceTinybar)}`);

  const hapiCredited = s2.balanceTinybar - s1.balanceTinybar;
  const hapiRanReceive = s2.receiveCalls > s1.receiveCalls;
  console.log(`  credited ${hapiCredited} tinybar`);
  console.log(`  -> receive() ${hapiRanReceive ? "RAN" : "did NOT run"}`);

  /* ------------------------------------------------------------ verdict */
  const verdict = !controlRan
    ? "INCONCLUSIVE — the control did not run, so the counter cannot be trusted"
    : hapiRanReceive
      ? "HAPI TRANSFERS EXECUTE CONTRACT CODE — the escrow can be the x402 payTo and open the hold itself"
      : hapiCredited === BigInt(HAPI_SEND_TINYBAR)
        ? "HAPI TRANSFERS CREDIT WITHOUT EXECUTING CODE — atomicity is NOT available"
        : "UNEXPECTED — the transfer neither ran code nor credited the expected amount";

  const allPassed = report("SPIKE 9 — does a HAPI CryptoTransfer to a contract run receive()?", [
    {
      name: "CONTROL: an EVM value transfer runs receive()",
      expected: `receiveCalls ${s0.receiveCalls} -> ${s0.receiveCalls + 1n}`,
      actual: `${s0.receiveCalls} -> ${s1.receiveCalls}`,
      pass: controlRan,
    },
    {
      name: "SUBJECT: the HAPI transfer was accepted",
      expected: "SUCCESS",
      actual: String(hapiStatus),
      pass: hapiStatus === "SUCCESS",
    },
    {
      name: "SUBJECT: the balance was credited",
      expected: `${HAPI_SEND_TINYBAR} tinybar`,
      actual: `${hapiCredited} tinybar`,
      pass: hapiCredited === BigInt(HAPI_SEND_TINYBAR),
    },
    {
      name: "SUBJECT: did receive() run? (either answer is a valid finding)",
      expected: "recorded either way",
      actual: hapiRanReceive ? "yes" : "no",
      pass: true,
    },
  ]);

  console.log(`  VERDICT: ${verdict}\n`);

  saveEvidence(
    "spike9-result.json",
    jsonSafe({
      verdict,
      controlRan,
      hapiTransferRanReceive: hapiRanReceive,
      hapiTransferCreditedTinybar: hapiCredited,
      atomicSettlementAvailable: controlRan ? hapiRanReceive : null,
      sinkEvm,
      sinkEntityId,
      operatorAccountId: opAccountId,
      evmControlTx: evmTx.hash,
      hapiTxId,
      hapiStatus,
      snapshots: { start: s0, afterEvmTransfer: s1, afterHapiTransfer: s2 },
      ranAt: new Date().toISOString(),
    }),
  );

  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
