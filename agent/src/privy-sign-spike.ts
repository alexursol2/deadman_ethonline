/**
 * SPIKE: can a Privy server wallet produce a signature Hedera will accept?
 *
 * This is the go/no-go for the whole Privy integration. Two paths, in order of
 * preference:
 *
 *   A. walletApi.ethereum.sendTransaction({ caip2: "eip155:296" })
 *      Privy signs AND broadcasts. Requires Privy to know chain 296, which is
 *      not a mainstream chain, so this is the one likely to fail.
 *
 *   B. walletApi.ethereum.signTransaction(...) then broadcast it ourselves
 *      through HashIO. Privy still holds the key and we never see it, which is
 *      the entire claim. Losing A costs us convenience, not the story.
 *
 * Sends 1 HBAR back to the operator either way, so a success is visible on
 * HashScan rather than asserted.
 */
import { PrivyClient } from "@privy-io/server-auth";
import { ethers } from "ethers";
import { RPC } from "../../server/src/shared.js";

const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, PRIVY_WALLET_ID, PRIVY_WALLET_ADDRESS } = process.env;
const OPERATOR = "0x130C7B90E7aCE67680AfDd17355BF58812146435";

const privy = new PrivyClient(PRIVY_APP_ID!, PRIVY_APP_SECRET!, {
  walletApi: PRIVY_AUTHORIZATION_KEY ? { authorizationPrivateKey: PRIVY_AUTHORIZATION_KEY } : undefined,
});
const provider = new ethers.JsonRpcProvider(RPC);

async function baseTx() {
  const nonce = await provider.getTransactionCount(PRIVY_WALLET_ADDRESS!);
  const fee = await provider.getFeeData();
  return {
    to: OPERATOR,
    value: "0x" + ethers.parseEther("1").toString(16),
    chainId: 296,
    nonce,
    gasLimit: 100_000,
    maxFeePerGas: "0x" + (fee.maxFeePerGas ?? 500_000_000_000n).toString(16),
    maxPriorityFeePerGas: "0x" + (fee.maxPriorityFeePerGas ?? 0n).toString(16),
    type: 2 as const,
  };
}

async function pathA() {
  console.log("\n=== A. Privy signs AND broadcasts (caip2 eip155:296) ===");
  try {
    const r: any = await privy.walletApi.ethereum.sendTransaction({
      walletId: PRIVY_WALLET_ID!,
      caip2: "eip155:296",
      transaction: await baseTx(),
    } as any);
    console.log("  SUCCESS — hash", r?.hash);
    return true;
  } catch (e: any) {
    console.log("  FAILED —", e?.message || e);
    return false;
  }
}

async function pathB() {
  console.log("\n=== B. Privy signs, we broadcast through HashIO ===");
  try {
    const r: any = await privy.walletApi.ethereum.signTransaction({
      walletId: PRIVY_WALLET_ID!,
      transaction: await baseTx(),
    } as any);
    const raw = r?.signedTransaction;
    console.log("  signed  —", String(raw).slice(0, 40) + "...");
    // Prove the signature really belongs to the Privy wallet before spending gas.
    const parsed = ethers.Transaction.from(raw);
    console.log("  recovered from :", parsed.from);
    console.log("  expected       :", PRIVY_WALLET_ADDRESS);
    if (parsed.from?.toLowerCase() !== PRIVY_WALLET_ADDRESS!.toLowerCase()) {
      console.log("  MISMATCH — the signature is not from our wallet");
      return false;
    }
    const sent = await provider.broadcastTransaction(raw);
    console.log("  broadcast —", sent.hash);
    const rc = await sent.wait();
    console.log("  status    —", rc?.status === 1 ? "SUCCESS" : "FAILED", "gas", rc?.gasUsed?.toString());
    return rc?.status === 1;
  } catch (e: any) {
    console.log("  FAILED —", e?.shortMessage || e?.message || e);
    return false;
  }
}

async function main() {
  console.log("wallet ", PRIVY_WALLET_ADDRESS);
  const a = await pathA();
  const b = a ? null : await pathB();
  console.log("\n--- verdict ---");
  console.log(`  A (Privy broadcasts) : ${a ? "WORKS" : "no"}`);
  if (b !== null) console.log(`  B (we broadcast)     : ${b ? "WORKS" : "no"}`);
  if (!a && !b) console.log("  neither path works — stop and use the embedded-wallet fallback");
}

main().catch((e) => { console.error(e); process.exit(1); });
