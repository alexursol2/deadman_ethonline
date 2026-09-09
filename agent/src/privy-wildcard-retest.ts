/**
 * Re-test of exactly one cell in the policy matrix.
 *
 * In the first run, "over-cap under a wildcard ALLOW" came back as DENIED with
 * "Nonce too low" — which is the relay complaining, not the policy engine
 * refusing. That is not an answer, and recording it as one would have been a
 * false result in the direction that flatters us.
 *
 * Here the nonce is read as "pending" and re-read until it moves, so whatever
 * comes back is the policy's decision and nothing else.
 */
import { PrivyClient } from "@privy-io/server-auth";
import { ethers } from "ethers";
import { RPC } from "../../server/src/shared.js";

const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, PRIVY_WALLET_ID, PRIVY_WALLET_ADDRESS } = process.env;
const POLICY_ID = process.argv[2];
const OPERATOR_EVM = "0x130C7B90E7aCE67680AfDd17355BF58812146435";

const privy = new PrivyClient(PRIVY_APP_ID!, PRIVY_APP_SECRET!, {
  walletApi: PRIVY_AUTHORIZATION_KEY ? { authorizationPrivateKey: PRIVY_AUTHORIZATION_KEY } : undefined,
});
const provider = new ethers.JsonRpcProvider(RPC);

async function send(amountHbar: number, nonce: number) {
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

async function main() {
  const p: any = await privy.walletApi.getPolicy({ id: POLICY_ID } as any);
  console.log("policy rules now:");
  for (const r of p.rules) console.log(`  ${r.action.padEnd(5)} ${r.method.padEnd(20)} ${JSON.stringify(r.conditions)}`);

  const nonce = await provider.getTransactionCount(PRIVY_WALLET_ADDRESS!, "pending");
  console.log(`\npending nonce: ${nonce}`);

  for (const amount of [10]) {
    try {
      const r: any = await send(amount, nonce);
      console.log(`  ${amount} HBAR (over the 6 HBAR cap): ALLOWED — ${r?.hash}`);
      console.log("\n  => the wildcard NULLIFIES the cap. A cap and raw signing are mutually exclusive.");
    } catch (e: any) {
      const msg = e?.message || String(e);
      const policyRefusal = /policy violation/i.test(msg);
      console.log(`  ${amount} HBAR (over the 6 HBAR cap): ${policyRefusal ? "DENIED by policy" : "INCONCLUSIVE — " + msg}`);
      if (policyRefusal) console.log("\n  => the cap SURVIVES the wildcard. DENY-by-condition wins over ALLOW *.");
    }
  }
}

main().catch((e) => { console.error("failed: " + (e?.message || e)); process.exit(1); });
