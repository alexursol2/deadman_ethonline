/**
 * SPIKE: does a Privy spend policy actually bind the agent, and does it reach
 * the rail x402 actually uses?
 *
 * A cap that has never refused anything is not evidence. Same discipline as the
 * contract suite: prove the guard by tripping it.
 *
 * First finding, from the first run: Privy policies are DEFAULT-DENY. A policy
 * built out of DENY rules refused everything, including the under-cap transfer
 * it was meant to permit. Rules must therefore be written as ALLOWs.
 *
 * That leaves the question this spike exists to answer. The agent pays x402 with
 * a Hedera-native TransferTransaction, which needs walletApi's raw
 * secp256k1Sign. PolicyMethod has no entry for raw signing — only the EVM
 * methods and a wildcard. So:
 *
 *   A. rules = [ALLOW eth_sendTransaction WHERE value <= cap]
 *   B. rules = A + [ALLOW *]
 *
 * If B allows the over-cap transfer, then on this rail a spend cap and the
 * ability to pay for x402 at all are mutually exclusive. Worth knowing, and
 * worth telling Privy.
 */
import { PrivyClient } from "@privy-io/server-auth";
import { ethers } from "ethers";
import { AccountId, Client, Hbar, PublicKey, TransferTransaction } from "@hashgraph/sdk";
import { RPC, entityIdOf } from "../../server/src/shared.js";

const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, PRIVY_WALLET_ID, PRIVY_WALLET_ADDRESS } = process.env;
const OPERATOR_EVM = "0x130C7B90E7aCE67680AfDd17355BF58812146435";
const CAP_HBAR = 6n;
const CAP_WEI = (CAP_HBAR * 10n ** 18n).toString();
const NL = "\n";

const privy = new PrivyClient(PRIVY_APP_ID!, PRIVY_APP_SECRET!, {
  walletApi: PRIVY_AUTHORIZATION_KEY ? { authorizationPrivateKey: PRIVY_AUTHORIZATION_KEY } : undefined,
});
const provider = new ethers.JsonRpcProvider(RPC);

const ALLOW_UNDER_CAP = {
  name: "allow transfers up to the cap",
  method: "eth_sendTransaction",
  action: "ALLOW",
  conditions: [{ fieldSource: "ethereum_transaction", field: "value", operator: "lte", value: CAP_WEI }],
};
const ALLOW_EVERYTHING = { name: "allow anything", method: "*", action: "ALLOW", conditions: [] };

async function evmSend(amountHbar: number) {
  const nonce = await provider.getTransactionCount(PRIVY_WALLET_ADDRESS!);
  const fee = await provider.getFeeData();
  return privy.walletApi.ethereum.sendTransaction({
    walletId: PRIVY_WALLET_ID!,
    caip2: "eip155:296",
    transaction: {
      to: OPERATOR_EVM,
      value: "0x" + ethers.parseEther(String(amountHbar)).toString(16),
      chainId: 296, nonce, gasLimit: 100_000,
      maxFeePerGas: "0x" + (fee.maxFeePerGas ?? 500_000_000_000n).toString(16),
      maxPriorityFeePerGas: "0x" + (fee.maxPriorityFeePerGas ?? 0n).toString(16),
      type: 2,
    },
  } as any);
}

async function attempt(label: string, fn: () => Promise<any>) {
  try { const r = await fn(); console.log("  " + label + ": ALLOWED  " + (r?.hash ?? "")); return true; }
  catch (e: any) { console.log("  " + label + ": DENIED   " + (e?.message || e)); return false; }
}

async function hederaTransferViaPrivy() {
  const probe = ethers.keccak256(ethers.toUtf8Bytes("deadman-privy-pubkey-probe"));
  const pr: any = await privy.walletApi.ethereum.secp256k1Sign({ walletId: PRIVY_WALLET_ID!, hash: probe as `0x${string}` } as any);
  const compressed = ethers.SigningKey.computePublicKey(ethers.SigningKey.recoverPublicKey(probe, pr.signature), true);
  const hPub = PublicKey.fromStringECDSA(compressed.slice(2));
  const from = (await entityIdOf(PRIVY_WALLET_ADDRESS!))!;
  const to = (await entityIdOf(OPERATOR_EVM))!;
  const client = Client.forTestnet();
  client.setOperatorWith(AccountId.fromString(from), hPub, async (bytes: Uint8Array) => {
    const r: any = await privy.walletApi.ethereum.secp256k1Sign({
      walletId: PRIVY_WALLET_ID!, hash: ethers.keccak256(bytes) as `0x${string}`,
    } as any);
    return ethers.getBytes(r.signature).slice(0, 64);
  });
  try {
    const tx = await new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(from), Hbar.fromTinybars(-100_000_000))
      .addHbarTransfer(AccountId.fromString(to), Hbar.fromTinybars(100_000_000))
      .execute(client);
    const rc = await tx.getReceipt(client);
    return rc.status.toString();
  } finally { client.close(); }
}

async function tryHedera() {
  try { const s = await hederaTransferViaPrivy(); console.log("  hedera via secp256k1Sign: " + s); return s; }
  catch (e: any) { console.log("  hedera via secp256k1Sign: DENIED — " + (e?.message || e)); return "DENIED"; }
}

async function main() {
  const policy: any = await privy.walletApi.createPolicy({
    name: "deadman-agent-spend-cap",
    version: "1.0",
    chainType: "ethereum",
    rules: [ALLOW_UNDER_CAP],
  } as any);
  console.log("policy " + policy.id + "   cap " + CAP_HBAR + " HBAR");
  await privy.walletApi.updateWallet({ id: PRIVY_WALLET_ID!, policyIds: [policy.id] } as any);

  console.log(NL + "=== A. rules = [ALLOW eth_sendTransaction WHERE value <= cap] ===");
  const a1 = await attempt("1 HBAR  (under cap, must be ALLOWED)", () => evmSend(1));
  const a2 = await attempt("10 HBAR (over cap,  must be DENIED) ", () => evmSend(10));
  const a3 = await tryHedera();

  console.log(NL + "=== B. rules = A + [ALLOW *] ===");
  await privy.walletApi.updatePolicy({ id: policy.id, rules: [ALLOW_UNDER_CAP, ALLOW_EVERYTHING] } as any);
  const b1 = await attempt("10 HBAR (over cap)                  ", () => evmSend(10));
  const b2 = await tryHedera();

  console.log(NL + "--- verdict ---");
  console.log("  A: under-cap allowed         " + (a1 ? "yes" : "NO — the cap is unusable"));
  console.log("  A: over-cap denied           " + (!a2 ? "yes" : "NO — THE CAP DOES NOT BIND"));
  console.log("  A: hedera rail               " + a3);
  console.log("  B: over-cap with wildcard    " + (b1 ? "ALLOWED — wildcard nullifies the cap" : "still denied"));
  console.log("  B: hedera rail with wildcard " + b2);
  console.log(NL + "  policy id: " + policy.id);
}

main().catch((e) => { console.error("failed: " + (e?.message || e)); process.exit(1); });
