/**
 * Put the wallet's policy into its final, honest state.
 *
 * We would rather ship a 6 HBAR spend cap. We measured that we cannot: the x402
 * Hedera rail pays with a native TransferTransaction, which needs raw
 * secp256k1Sign, which no PolicyMethod covers, so the only rule that permits it
 * is ALLOW *. And ALLOW * lets an over-cap EVM transfer through — verified, 10
 * HBAR under a 6 HBAR cap. A cap left attached next to the wildcard would look
 * like protection while providing none.
 *
 * So the policy is one wildcard rule whose NAME states the limitation, because
 * the dashboard is where someone will look next.
 */
import { PrivyClient } from "@privy-io/server-auth";
// side effect only: loads .env from the repo root. A bare import is deliberate —
// a named import that went unused would be tree-shaken and the env would vanish.
import "../../server/src/shared.js";

const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, PRIVY_WALLET_ID } = process.env;
const POLICY_ID = process.argv[2];

const privy = new PrivyClient(PRIVY_APP_ID!, PRIVY_APP_SECRET!, {
  walletApi: PRIVY_AUTHORIZATION_KEY ? { authorizationPrivateKey: PRIVY_AUTHORIZATION_KEY } : undefined,
});

async function main() {
  await privy.walletApi.updatePolicy({
    id: POLICY_ID,
    name: "deadman-agent",
    rules: [{
      // 50-char limit, enforced by Privy. The detail is in docs/spikes/16-privy.md.
      name: "allow all - a cap cannot bind Hedera x402",
      method: "*",
      action: "ALLOW",
      conditions: [],
    }],
  } as any);
  const p: any = await privy.walletApi.getPolicy({ id: POLICY_ID } as any);
  console.log("policy " + p.id + "  (" + p.name + ")");
  for (const r of p.rules) console.log("  " + r.action + " " + r.method + "  -  " + r.name);
  const w: any = await privy.walletApi.getWallet({ id: PRIVY_WALLET_ID! });
  console.log("wallet policyIds: " + JSON.stringify(w.policyIds));
}
main().catch((e) => { console.error("failed: " + (e?.message || e)); process.exit(1); });
