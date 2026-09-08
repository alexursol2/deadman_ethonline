/**
 * verify.ts — the buyer's tool for catching a lying seller.
 *
 * The contract enforces exactly ONE of the four commitments: keccak256(k) must
 * equal the committed H(k), or claim() reverts. That is all it can do — it
 * cannot decrypt, so it cannot know whether the key it just accepted actually
 * opens the ciphertext the buyer was handed.
 *
 * Which leaves this cheat, and it is the reason there are four commitments:
 *
 *     the seller encrypts C with key k1
 *     commits H(k2) and reveals k2
 *     claim() checks H(k2) == H(k2), passes, and pays the seller
 *     the buyer's ciphertext never opens
 *
 * On-chain everything looks perfect. This tool is what makes it provable, and it
 * names WHICH element was a lie rather than just saying something is wrong:
 *
 *     H(C)       the seller committed to a different ciphertext than it sent us
 *     decrypt    the revealed key does not open the ciphertext  <- the cheat above
 *     H(m)       it opened, but to different plaintext than was committed
 *     H(request) this hold answers a different request
 *
 * We guarantee delivery, not correctness: a seller can still encrypt garbage,
 * commit to the hash of that garbage, and pass every check here. That limit is
 * on the first screen of the README. What this catches is a seller who was paid
 * for something the buyer provably cannot read.
 *
 *   npm run verify <holdId>
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  ESCROW_ABI,
  HOLD_STATUS,
  RPC,
  TOPIC,
  asTopic,
  contractLogs,
  decrypt,
  hashBytes,
  hashUtf8,
  hbar,
  requestHash,
} from "../../server/src/shared.js";

const iface = new ethers.Interface(ESCROW_ABI);

interface Check {
  name: string;
  detail: string;
  ok: boolean | null; // null = not applicable
}

function line(c: Check) {
  const mark = c.ok === null ? "  –  " : c.ok ? " OK  " : "FAIL ";
  return `  [${mark}] ${c.name}\n           ${c.detail}`;
}

async function main() {
  const holdId = process.argv[2];
  if (!holdId) throw new Error("usage: npm run verify <holdId>");

  const receiptPath = resolve(dirname(fileURLToPath(import.meta.url)), `../receipts/hold-${holdId}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const escrowAddress: string = receipt.escrow || process.env.ESCROW_ADDRESS || "";

  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 296, name: "hedera-testnet" });
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);

  console.log(`\n  verify — hold ${holdId}`);
  console.log(`  ${"─".repeat(70)}`);
  console.log(`  escrow   ${escrowAddress}`);
  console.log(`  receipt  agent/receipts/hold-${holdId}.json`);

  /* ── 1. the authoritative commitments, from the chain ── */
  const openedLogs = await contractLogs(escrowAddress, { topic0: TOPIC.HoldOpened, topic1: asTopic(holdId) }, 100);
  if (!openedLogs.length) throw new Error(`No HoldOpened event for hold ${holdId}. Wrong escrow, or too old.`);
  const opened = iface.parseLog({ topics: openedLogs[0].topics, data: openedLogs[0].data })!;

  const onChain = {
    hKey: opened.args.hKey as string,
    hCipher: opened.args.hCipher as string,
    hPlain: opened.args.hPlain as string,
    hRequest: opened.args.hRequest as string,
  };
  const amount = opened.args.amountTinybar as bigint;
  console.log(`  amount   ${hbar(amount)}`);

  const hold = await escrow.getHold(holdId);
  const status = HOLD_STATUS[Number(hold.status)];
  console.log(`  status   ${status}`);

  const checks: Check[] = [];

  /* ── 2. did the server's HTTP reply match what it actually committed? ── */
  // The seller told us its commitments over HTTP. That claim is not evidence.
  const claimed = receipt.commitmentsClaimedByServer ?? {};
  const httpMatches = (["hKey", "hCipher", "hPlain", "hRequest"] as const).every(
    (k) => String(claimed[k]).toLowerCase() === String((onChain as any)[k]).toLowerCase(),
  );
  checks.push({
    name: "the seller's HTTP response matches what it committed on-chain",
    detail: httpMatches
      ? "the reply and the log agree"
      : "the reply advertised different commitments than the log records — the log is what counts",
    ok: httpMatches,
  });

  /* ── 3. the request this hold answers ── */
  const expectedRequest = requestHash(receipt.requestMethod, receipt.url, receipt.settleTxId);
  const requestOk = expectedRequest.toLowerCase() === onChain.hRequest.toLowerCase();
  checks.push({
    name: "H(request) — this hold answers OUR request",
    detail: requestOk
      ? `${onChain.hRequest.slice(0, 18)}…`
      : `committed ${onChain.hRequest.slice(0, 18)}… but our request hashes to ${expectedRequest.slice(0, 18)}…`,
    ok: requestOk,
  });

  /* ── 4. the ciphertext we were handed ── */
  const ourCipherHash = hashBytes(ethers.getBytes(receipt.ciphertext));
  const cipherOk = ourCipherHash.toLowerCase() === onChain.hCipher.toLowerCase();
  checks.push({
    name: "H(C) — the seller committed to the ciphertext it sent us",
    detail: cipherOk
      ? `${onChain.hCipher.slice(0, 18)}…`
      : `committed ${onChain.hCipher.slice(0, 18)}… but we hold bytes hashing to ${ourCipherHash.slice(0, 18)}…`,
    ok: cipherOk,
  });

  /* ── 5. the key, if it was ever revealed ── */
  const claimedLogs = await contractLogs(escrowAddress, { topic0: TOPIC.Claimed, topic1: asTopic(holdId) }, 100);
  let plaintext: string | null = null;

  if (!claimedLogs.length) {
    const refunded = Number(hold.status) === 3;
    console.log(
      refunded
        ? `\n  The seller never revealed a key and the hold was REFUNDED.`
        : `\n  No key revealed yet. Nothing to verify until the seller claims or the refund fires.`,
    );
    checks.push({ name: "H(k) — the revealed key matches its commitment", detail: "no key revealed", ok: null });
    checks.push({ name: "the key opens the ciphertext", detail: "no key revealed", ok: null });
    checks.push({ name: "H(m) — the plaintext matches its commitment", detail: "no key revealed", ok: null });
  } else {
    const k = ethers.getBytes(claimedLogs[0].data as string);

    // Contract-enforced, so this passing proves nothing about honesty — it is
    // here so a failure would be unmissable, because it would mean the chain
    // itself disagrees with itself.
    const keyOk = hashBytes(k).toLowerCase() === onChain.hKey.toLowerCase();
    checks.push({
      name: "H(k) — the revealed key matches its commitment",
      detail: keyOk ? "enforced on-chain by claim(); consistent" : "THE CHAIN DISAGREES WITH ITSELF",
      ok: keyOk,
    });

    // The check the contract cannot make.
    let decryptOk = false;
    try {
      plaintext = decrypt(receipt.ciphertext, k);
      decryptOk = true;
    } catch {
      decryptOk = false;
    }
    checks.push({
      name: "the revealed key OPENS the ciphertext",
      detail: decryptOk
        ? `${Buffer.byteLength(plaintext!)} bytes of plaintext recovered`
        : "the key was accepted on-chain and does NOT decrypt what we were given",
      ok: decryptOk,
    });

    if (decryptOk) {
      const ourPlainHash = hashUtf8(plaintext!);
      const plainOk = ourPlainHash.toLowerCase() === onChain.hPlain.toLowerCase();
      checks.push({
        name: "H(m) — the plaintext matches its commitment",
        detail: plainOk
          ? `${onChain.hPlain.slice(0, 18)}…`
          : `committed ${onChain.hPlain.slice(0, 18)}… but it decrypts to something hashing to ${ourPlainHash.slice(0, 18)}…`,
        ok: plainOk,
      });
    } else {
      checks.push({ name: "H(m) — the plaintext matches its commitment", detail: "cannot check; it did not open", ok: null });
    }
  }

  /* ── verdict ── */
  console.log(`\n${checks.map(line).join("\n")}`);
  const failed = checks.filter((c) => c.ok === false);
  console.log(`  ${"─".repeat(70)}`);

  if (!failed.length) {
    const anyChecked = checks.some((c) => c.ok === true);
    console.log(anyChecked ? `  VERDICT: everything the seller committed to holds up.` : `  VERDICT: nothing to check yet.`);
    if (plaintext) console.log(`\n${plaintext.split("\n").map((l) => `      ${l}`).join("\n")}`);
    console.log(
      `\n  Note: this proves DELIVERY, not correctness. A seller can encrypt` +
        `\n  garbage, commit to the hash of that garbage, and pass every check here.\n`,
    );
    return;
  }

  console.log(`  VERDICT: THE SELLER CHEATED. ${failed.length} commitment${failed.length > 1 ? "s" : ""} broken:\n`);
  for (const f of failed) console.log(`    • ${f.name}\n      ${f.detail}`);
  console.log(
    `\n  This is cryptographic proof, not an accusation: the commitments are in` +
      `\n  the HoldOpened log for hold ${holdId}, the key is in the Claimed log, and` +
      `\n  anyone can re-run this against the same chain data.\n`,
  );
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
});
