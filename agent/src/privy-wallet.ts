/**
 * Provision the agent's Privy server wallet.
 *
 * The point of this file: after it runs, the agent's signing key does not exist
 * on this machine. Privy holds it, we hold a wallet id, and every signature is
 * an authenticated API call. That is the difference between "an agent with a
 * private key in a .env" and "an agent with a custodied, policy-bounded wallet".
 *
 *   npx tsx src/privy-wallet.ts            # create, or show the one in .env
 *
 * Prints the wallet id and EVM address. Put PRIVY_WALLET_ID in .env afterwards
 * so this is idempotent — re-running must not orphan a funded wallet.
 */
import { PrivyClient } from "@privy-io/server-auth";
// side effect: loads .env from the repo root before this module body runs
import { RPC, hbar } from "../../server/src/shared.js";
import { ethers } from "ethers";

const APP_ID = process.env.PRIVY_APP_ID;
const APP_SECRET = process.env.PRIVY_APP_SECRET;
const AUTH_KEY = process.env.PRIVY_AUTHORIZATION_KEY;
const WALLET_ID = process.env.PRIVY_WALLET_ID;

if (!APP_ID || !APP_SECRET) {
  console.error("PRIVY_APP_ID and PRIVY_APP_SECRET must be set in .env");
  process.exit(1);
}

const privy = new PrivyClient(APP_ID, APP_SECRET, {
  walletApi: AUTH_KEY ? { authorizationPrivateKey: AUTH_KEY } : undefined,
});

async function main() {
  let id: string;
  let address: string;

  if (WALLET_ID) {
    const w = await privy.walletApi.getWallet({ id: WALLET_ID });
    id = w.id;
    address = w.address;
    console.log("reusing wallet from PRIVY_WALLET_ID");
  } else {
    const w = await privy.walletApi.create({ chainType: "ethereum" });
    id = w.id;
    address = w.address;
    console.log("created a new wallet");
  }

  console.log(`  wallet id : ${id}`);
  console.log(`  address   : ${address}`);

  // Hedera detail that has bitten us before: an address the network has never
  // seen does not exist yet. Paying it CREATES it, and that costs the sender
  // 607,854 gas (measured) rather than a transfer's 21,000, and it needs a limit
  // well above that or it fails outright. A zero balance here is not an error,
  // it means "not funded, and the funding tx will be expensive".
  const provider = new ethers.JsonRpcProvider(RPC);
  const balWeibar = await provider.getBalance(address);
  const tinybar = balWeibar / 10_000_000_000n;
  console.log(`  balance   : ${hbar(tinybar)} (${tinybar} tinybar)`);
  if (tinybar === 0n) {
    console.log("\n  not funded yet — run: npx tsx src/privy-fund.ts");
  }

  if (!WALLET_ID) {
    console.log(`\nadd to .env:\n  PRIVY_WALLET_ID=${id}`);
  }
}

main().catch((e) => {
  console.error("failed:", e?.message || e);
  process.exit(1);
});
