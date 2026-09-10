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
 * on the first screen of the README, `SELLER_CHEAT=garbage` exercises it, and
 * `npm run reputation` is the thing that sees it. What this catches is a seller
 * who was paid for something the buyer provably cannot read.
 *
 * The checks themselves live in audit.ts, so this tool and the policy cannot
 * disagree about what an honest seller looks like.
 *
 *   npm run verify <holdId>
 *   npm run verify <holdId> -- --json
 */
import { ethers } from "ethers";
import { ESCROW_ABI, RPC, hbar } from "../../server/src/shared.js";
import { auditHold, loadReceipt, receiptPathFor, type Check } from "./audit.js";

function line(c: Check) {
  const mark = c.ok === null ? "  –  " : c.ok ? " OK  " : "FAIL ";
  return `  [${mark}] ${c.name}\n           ${c.detail}`;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const holdId = args.find((a) => !a.startsWith("--"));
  if (!holdId) throw new Error("usage: npm run verify <holdId> [-- --json]");

  const receipt = loadReceipt(holdId);
  const escrowAddress: string = receipt?.escrow || process.env.ESCROW_ADDRESS || "";
  if (!escrowAddress) throw new Error("No escrow address: no receipt for this hold and ESCROW_ADDRESS unset.");

  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 296, name: "hedera-testnet" });
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);

  if (!asJson) {
    console.log(`\n  verify — hold ${holdId}`);
    console.log(`  ${"─".repeat(70)}`);
    console.log(`  escrow   ${escrowAddress}`);
    console.log(`  receipt  ${receipt ? `agent/receipts/hold-${holdId}.json` : `MISSING — ${receiptPathFor(holdId)}`}`);
  }

  const audit = await auditHold(holdId, escrow, escrowAddress);

  /* Machine-readable, because a verdict a human has to read is a verdict no
   * buying policy can act on. This is the record ERC-8004 feedback is missing:
   * bound to a payment, recomputable by anyone from the same chain data. */
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          holdId: audit.holdId,
          escrow: audit.escrow,
          provider: audit.provider,
          payer: audit.payer,
          payee: audit.payee,
          amountTinybar: audit.amountTinybar.toString(),
          status: audit.status,
          verdict: audit.verdict,
          commitments: audit.onChain,
          checks: audit.checks,
          broken: audit.broken.map((c) => c.id),
        },
        null,
        2,
      ),
    );
    if (audit.broken.length) process.exitCode = 1;
    return;
  }

  console.log(`  amount   ${hbar(audit.amountTinybar)}`);
  console.log(`  status   ${audit.status}`);
  if (audit.note) console.log(audit.note);

  console.log(`\n${audit.checks.map(line).join("\n")}`);
  const failed = audit.broken;
  console.log(`  ${"─".repeat(70)}`);

  if (!failed.length) {
    const anyChecked = audit.checks.some((c) => c.ok === true);
    console.log(anyChecked ? `  VERDICT: everything the seller committed to holds up.` : `  VERDICT: nothing to check yet.`);
    if (audit.plaintext) console.log(`\n${audit.plaintext.split("\n").map((l) => `      ${l}`).join("\n")}`);
    console.log(
      `\n  Note: this proves DELIVERY, not correctness. A seller can encrypt` +
        `\n  garbage, commit to the hash of that garbage, and pass every check here.` +
        `\n  That cheat is invisible to this tool by construction; run` +
        `\n  \`npm run reputation\` for the part of the answer that is not a proof.\n`,
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
