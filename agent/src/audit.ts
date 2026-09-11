/**
 * audit.ts — one place that turns (our receipt, the chain) into a verdict.
 *
 * Both `verify.ts` and `reputation.ts` need to know whether a seller kept its
 * commitments, and they must never answer that question differently. Two
 * implementations of one rule drift, and a drifted implementation here looks
 * exactly like a lying seller — which is the failure `shared.ts` already exists
 * to prevent. So the rule lives here once; verify.ts renders it for a human and
 * reputation.ts counts it.
 *
 * What the chain enforces, and what it does not:
 *
 *   H(k)       enforced. claim() reverts unless keccak256(k) matches.
 *   H(C)       recorded, never checked on-chain. The ciphertext arrives over HTTP.
 *   H(m)       recorded, never checked on-chain. Nothing can decrypt in a contract.
 *   H(request) recorded, never checked on-chain.
 *
 * So three of the four are evidence rather than enforcement, and this is the
 * tool that turns them into evidence. It sorts a paid round into one of four
 * outcomes:
 *
 *   delivered  every commitment holds and the ciphertext opened
 *   cheated    a commitment in a receipt we hold is provably broken
 *   unaccounted  CLAIMED, but this machine holds no receipt. Not evidence
 *              either way: see "the case where we hold nothing" below
 *   refunded   the seller never revealed, and the network paid the buyer back
 *   pending    still open, or the key has not surfaced in the log yet
 *
 * The gap it CANNOT see is the whole reason `reputation.ts` exists: a seller
 * that encrypts a worthless answer and commits honestly to it produces a
 * flawless audit. There is no lie to find, because it did not lie about any
 * element — it answered badly, which is not a claim the chain holds an opinion
 * about. See docs/plans/10-buyer-side-policy.md §1.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  ESCROW_ABI,
  HOLD_STATUS,
  TOPIC,
  asTopic,
  contractLogs,
  decrypt,
  hashBytes,
  hashUtf8,
  requestHash,
} from "../../server/src/shared.js";

export const RECEIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../receipts");

const iface = new ethers.Interface(ESCROW_ABI);

/** One commitment, checked. `ok: null` means the check does not apply yet. */
export interface Check {
  id: string;
  name: string;
  detail: string;
  ok: boolean | null;
}

export type Verdict = "delivered" | "cheated" | "refunded" | "pending" | "unaccounted";

export interface Receipt {
  holdId: string;
  escrow: string;
  requestMethod: string;
  url: string;
  ciphertext: string;
  commitmentsClaimedByServer?: Record<string, string>;
  settleTxId: string;
  scheduleEntityId?: string;
  armedDeadline?: number;
  receivedAt?: string;
  /** Added 2026-09-10. Older receipts do not have it; the provider reads as unknown. */
  origin?: string;
  /** Added 2026-09-10, so a judge can be handed the question that was asked. */
  query?: string;
}

export interface HoldAudit {
  holdId: string;
  escrow: string;
  provider: string | null;
  query: string | null;
  payer: string;
  payee: string;
  amountTinybar: bigint;
  status: string;
  onChain: { hKey: string; hCipher: string; hPlain: string; hRequest: string };
  checks: Check[];
  /** Checks that failed. Non-empty means proof of a broken commitment. */
  broken: Check[];
  /** Something a human should be told before the checks are printed. */
  note: string | null;
  plaintext: string | null;
  verdict: Verdict;
  receivedAt: string | null;
}

export function receiptPathFor(holdId: string) {
  return resolve(RECEIPTS_DIR, `hold-${holdId}.json`);
}

/** The receipt for a hold, or null when we hold none — which is itself evidence. */
export function loadReceipt(holdId: string): Receipt | null {
  const path = receiptPathFor(holdId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Receipt;
}

/** Hold ids we have receipts for, oldest id first. */
export function knownHoldIds(): string[] {
  if (!existsSync(RECEIPTS_DIR)) return [];
  return readdirSync(RECEIPTS_DIR)
    .map((f) => /^hold-(\d+)\.json$/.exec(f)?.[1])
    .filter((id): id is string => Boolean(id))
    .sort((a, b) => Number(a) - Number(b));
}

/**
 * Audit one hold against the chain.
 *
 * `escrow` is a read-only ethers contract; the caller supplies it so a batch
 * audit does not build one per hold.
 */
export async function auditHold(
  holdId: string,
  escrow: ethers.Contract,
  escrowAddress: string,
): Promise<HoldAudit> {
  const loaded = loadReceipt(holdId);
  // Hold ids restart at 1 on every escrow, and receipts from a retired escrow
  // stay in the same folder. Auditing one against another escrow's hold of the
  // same number compares two unrelated holds and reads as a broken commitment:
  // a false proof, and a permanent block. A receipt only counts for its own escrow.
  if (loaded?.escrow && loaded.escrow.toLowerCase() !== escrowAddress.toLowerCase()) {
    throw new Error(`receipt for hold ${holdId} belongs to escrow ${loaded.escrow}, not this one`);
  }
  const receipt = loaded;

  const openedLogs = await contractLogs(
    escrowAddress,
    { topic0: TOPIC.HoldOpened, topic1: asTopic(holdId) },
    100,
  );
  if (!openedLogs.length) {
    throw new Error(`No HoldOpened event for hold ${holdId}. Wrong escrow, or too old.`);
  }
  const opened = iface.parseLog({ topics: openedLogs[0].topics, data: openedLogs[0].data })!;

  const onChain = {
    hKey: opened.args.hKey as string,
    hCipher: opened.args.hCipher as string,
    hPlain: opened.args.hPlain as string,
    hRequest: opened.args.hRequest as string,
  };

  const hold = await escrow.getHold(holdId);
  const status = HOLD_STATUS[Number(hold.status)] ?? "UNKNOWN";

  const checks: Check[] = [];
  let note: string | null = null;
  let plaintext: string | null = null;

  /* ── the case where we hold nothing at all ──
   * A CLAIMED hold with no receipt on this machine is EITHER a seller that was
   * paid and never handed us a ciphertext, OR a receipt that lives on another
   * machine or was lost. The absence of a local file cannot tell them apart,
   * so it is not evidence against the seller and must never be a broken check.
   *
   * It used to be. On 2026-09-11, removing one receipt made reputation.ts
   * permanently BLOCK our own honest seller, and this tool would have printed
   * THE SELLER CHEATED for a hold that was delivered. Making non-delivery
   * provable needs a receipt written at payment time, before the reply, so that
   * "paid, and nothing recorded" is a first-hand record instead of an absence.
   * Not built. */
  if (!receipt) {
    const paid = Number(hold.status) === 2;
    checks.push({
      id: "delivery",
      name: "we were handed a ciphertext at all",
      detail: paid
        ? "the hold was CLAIMED and this machine holds no receipt for it: either we were never handed a ciphertext, or the receipt is elsewhere. From here those look identical, so this is not evidence"
        : "no receipt on this machine for this hold",
      ok: null,
    });
    note = paid
      ? `\n  Hold ${holdId} was CLAIMED and there is no receipt for it here. Unaccounted, not proven.`
      : `\n  No receipt for hold ${holdId}. Nothing local to check it against.`;
  } else {
    /* ── 1. did the seller's HTTP reply match what it actually committed? ── */
    // The seller told us its commitments over HTTP. That claim is not evidence.
    const claimed = receipt.commitmentsClaimedByServer ?? {};
    const httpMatches = (["hKey", "hCipher", "hPlain", "hRequest"] as const).every(
      (k) => String(claimed[k]).toLowerCase() === String(onChain[k]).toLowerCase(),
    );
    checks.push({
      id: "http-matches-chain",
      name: "the seller's HTTP response matches what it committed on-chain",
      detail: httpMatches
        ? "the reply and the log agree"
        : "the reply advertised different commitments than the log records — the log is what counts",
      ok: httpMatches,
    });

    /* ── 2. the request this hold answers ── */
    const expectedRequest = requestHash(receipt.requestMethod, receipt.url, receipt.settleTxId);
    const requestOk = expectedRequest.toLowerCase() === onChain.hRequest.toLowerCase();
    checks.push({
      id: "h-request",
      name: "H(request) — this hold answers OUR request",
      detail: requestOk
        ? `${onChain.hRequest.slice(0, 18)}…`
        : `committed ${onChain.hRequest.slice(0, 18)}… but our request hashes to ${expectedRequest.slice(0, 18)}…`,
      ok: requestOk,
    });

    /* ── 3. the ciphertext we were handed ── */
    const ourCipherHash = hashBytes(ethers.getBytes(receipt.ciphertext));
    const cipherOk = ourCipherHash.toLowerCase() === onChain.hCipher.toLowerCase();
    checks.push({
      id: "h-cipher",
      name: "H(C) — the seller committed to the ciphertext it sent us",
      detail: cipherOk
        ? `${onChain.hCipher.slice(0, 18)}…`
        : `committed ${onChain.hCipher.slice(0, 18)}… but we hold bytes hashing to ${ourCipherHash.slice(0, 18)}…`,
      ok: cipherOk,
    });

    /* ── 4. the key, if it was ever revealed ── */
    const claimedLogs = await contractLogs(
      escrowAddress,
      { topic0: TOPIC.Claimed, topic1: asTopic(holdId) },
      100,
    );

    if (!claimedLogs.length) {
      note =
        Number(hold.status) === 3
          ? `\n  The seller never revealed a key and the hold was REFUNDED.`
          : `\n  No key revealed yet. Nothing to verify until the seller claims or the refund fires.`;
      checks.push({ id: "h-key", name: "H(k) — the revealed key matches its commitment", detail: "no key revealed", ok: null });
      checks.push({ id: "decrypts", name: "the key opens the ciphertext", detail: "no key revealed", ok: null });
      checks.push({ id: "h-plain", name: "H(m) — the plaintext matches its commitment", detail: "no key revealed", ok: null });
    } else {
      const k = ethers.getBytes(claimedLogs[0].data as string);

      // Contract-enforced, so this passing proves nothing about honesty — it is
      // here so a failure would be unmissable, because it would mean the chain
      // itself disagrees with itself.
      const keyOk = hashBytes(k).toLowerCase() === onChain.hKey.toLowerCase();
      checks.push({
        id: "h-key",
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
        id: "decrypts",
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
          id: "h-plain",
          name: "H(m) — the plaintext matches its commitment",
          detail: plainOk
            ? `${onChain.hPlain.slice(0, 18)}…`
            : `committed ${onChain.hPlain.slice(0, 18)}… but it decrypts to something hashing to ${ourPlainHash.slice(0, 18)}…`,
          ok: plainOk,
        });
      } else {
        checks.push({ id: "h-plain", name: "H(m) — the plaintext matches its commitment", detail: "cannot check; it did not open", ok: null });
      }
    }
  }

  const broken = checks.filter((c) => c.ok === false);

  let verdict: Verdict;
  if (broken.length) verdict = "cheated";
  else if (Number(hold.status) === 3) verdict = "refunded";
  else if (Number(hold.status) === 2 && plaintext !== null) verdict = "delivered";
  else if (!receipt && Number(hold.status) === 2) verdict = "unaccounted";
  else verdict = "pending";

  return {
    holdId,
    escrow: escrowAddress,
    provider: receipt?.origin ?? null,
    query: receipt?.query ?? queryFromUrl(receipt?.url),
    payer: String(opened.args.payer),
    payee: String(opened.args.payee),
    amountTinybar: BigInt(opened.args.amountTinybar),
    status,
    onChain,
    checks,
    broken,
    note,
    plaintext,
    verdict,
    receivedAt: receipt?.receivedAt ?? null,
  };
}

/** Receipts written before 2026-09-10 carry the query only inside the path. */
function queryFromUrl(url?: string): string | null {
  if (!url) return null;
  const q = new URLSearchParams(url.split("?")[1] ?? "").get("q");
  return q ?? null;
}
