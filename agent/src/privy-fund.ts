/**
 * Fund the Privy server wallet from the operator.
 *
 * Hedera detail, already measured in the spikes and re-confirmed here: an
 * address the network has never seen DOES NOT EXIST. Paying it is what creates
 * it, and the account-creation cost falls on the SENDER. Measured here: 607,854
 * gas charged, against a plain transfer's 21,000. Send this with a normal gas
 * LIMIT and it fails for a reason that has nothing to do with our code.
 *
 *   npx tsx src/privy-fund.ts [hbar]      # default 20
 */
import { ethers } from "ethers";
import { RPC, hbar } from "../../server/src/shared.js";

const AMOUNT_HBAR = Number(process.argv[2] || 20);
const TARGET = process.env.PRIVY_WALLET_ADDRESS;
const KEY = process.env.HEDERA_OPERATOR_KEY;

if (!TARGET) {
  console.error("PRIVY_WALLET_ADDRESS must be set in .env (see privy-wallet.ts)");
  process.exit(1);
}
if (!KEY) {
  console.error("HEDERA_OPERATOR_KEY must be set in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC);
const operator = new ethers.Wallet(KEY.startsWith("0x") ? KEY : `0x${KEY}`, provider);

const toTinybar = (weibar: bigint) => weibar / 10_000_000_000n;

async function main() {
  const before = toTinybar(await provider.getBalance(TARGET!));
  console.log(`operator      ${operator.address}`);
  console.log(`target        ${TARGET}`);
  console.log(`target before ${hbar(before)}`);

  if (before > 0n) {
    console.log("\nalready funded — the account exists, so a top-up would only cost 21,000 gas.");
  }

  // 1 HBAR = 1e18 weibar over JSON-RPC. Inside the EVM it is 1e8 tinybar; the
  // boundary converts by exactly 1e10. Never mix the two.
  const value = ethers.parseEther(String(AMOUNT_HBAR));

  const t0 = Date.now();
  const tx = await operator.sendTransaction({
    to: TARGET,
    value,
    // ~2M for account creation. A funded target needs 21,000, but overpaying the
    // LIMIT costs nothing on Hedera — only gas actually used is charged.
    gasLimit: before > 0n ? 100_000 : 2_000_000,
  });
  console.log(`\nsent ${AMOUNT_HBAR} HBAR — ${tx.hash}`);
  const rc = await tx.wait();
  const elapsed = Date.now() - t0;

  const after = toTinybar(await provider.getBalance(TARGET!));
  console.log(`status        ${rc?.status === 1 ? "SUCCESS" : "FAILED"}`);
  console.log(`gas used      ${rc?.gasUsed?.toString()}`);
  console.log(`elapsed       ${elapsed} ms`);
  console.log(`target after  ${hbar(after)}`);
}

main().catch((e) => {
  console.error("failed:", e?.shortMessage || e?.message || e);
  process.exit(1);
});
