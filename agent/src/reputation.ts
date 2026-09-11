/**
 * reputation.ts — the buyer-side policy. The half of the answer that is not a proof.
 *
 * `HoldEscrow` guarantees that a silent seller cannot keep the money. It cannot
 * guarantee that a talkative one gives you anything worth having. That gap is an
 * oracle problem and it does not close on-chain, ever. What closes is the
 * ECONOMICS of it, and only for a buyer that plays more than one round:
 *
 *   the robbed payment is gone; the stream after it is what a cheat loses.
 *
 * This is the shape 402Pilot (arXiv 2608.01341) describes — a buyer-side layer
 * that decides who gets the next request — with one change that matters here.
 *
 * TWO CHANNELS, AND ONLY ONE OF THEM IS DISCOUNTED
 *
 *   hard   audit.ts found a broken commitment in a receipt we hold. That is
 *          not an opinion: given the receipt, anyone can recompute it from
 *          HoldOpened and Claimed, and an honest seller cannot produce one. So
 *          it is NEVER discounted. One is permanent exclusion.
 *
 *   soft   the answer was poor, the seller went dark and the network refunded
 *          us, or a hold was CLAIMED and we hold no receipt for it. A crash and
 *          a scam look identical from one observation, and so do "never handed
 *          us a ciphertext" and "the receipt is on another machine", so these
 *          decay with age and a provider can recover from them, exactly as
 *          PA-DCT does.
 *
 * Discounting a proof is how you get farmed. PA-DCT forgets old observations so
 * a provider can recover from a bad patch, which is right against a stationary
 * defect and is a CHANNEL against a strategic one: cheat below the forgetting
 * rate and stay above the selection threshold. The paper's own limitations name
 * this — its benchmark has no strategic seller. Keeping proofs out of the decay
 * closes that channel for the cheats we can actually prove.
 *
 * WHAT THIS DOES NOT DO, said plainly:
 *
 *   - It does not get one robbed payment back. It bounds the RATE, not the event.
 *   - With one provider configured, "avoid" means "stop buying", not "buy elsewhere".
 *   - A blocked seller can return under a new URL and a new payee address. What
 *     makes that costly is not this file: it is the 1.77 HBAR of gas `openHold`
 *     charges the seller per sale, honest or not. A fake review costs a fraction
 *     of a cent; a fake sale here costs ~$0.09 that cannot be avoided.
 *
 * Sources for every number quoted above are in docs/reputation.md.
 *
 *   npm run reputation
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { ESCROW_ABI, RPC, TOPIC, contractLogs } from "../../server/src/shared.js";
import { RECEIPTS_DIR, auditHold, knownHoldIds, type HoldAudit } from "./audit.js";
import { judgeDelivery, type Judgement } from "./quality.js";

/** How fast an OPINION ages. Proofs do not age at all. */
const DECAY = Number(process.env.REPUTATION_DECAY || 0.8);
/** Below this a provider is not worth buying from. */
const MIN_SCORE = Number(process.env.REPUTATION_MIN_SCORE || 0.6);

const QUALITY_CACHE = resolve(RECEIPTS_DIR, "quality.json");

export type Action = "USE" | "TRY" | "AVOID" | "BLOCK";

export interface Observation {
  holdId: string;
  kind: "delivered" | "dark" | "broken" | "unaccounted";
  quality: number;
  amountHbar: number;
  detail: string;
}

export interface ProviderState {
  key: string;
  payees: string[];
  observations: Observation[];
  /** Never discounted. Non-empty means BLOCK. */
  hardEvidence: Observation[];
  weightedQuality: number;
  reliability: number;
  score: number;
  spentHbar: number;
  qualityPerHbar: number;
  action: Action;
  reason: string;
}

/* ─────────────────────── the judge's answers, cached ─────────────────────── */

/**
 * A remote judge is a paid call. Re-scoring the same plaintext on every run
 * would charge for an answer we already have, so judgements are cached by hold
 * id — a hold's plaintext is immutable once claimed.
 */
function loadQualityCache(): Record<string, Judgement> {
  if (!existsSync(QUALITY_CACHE)) return {};
  try {
    return JSON.parse(readFileSync(QUALITY_CACHE, "utf8"));
  } catch {
    return {};
  }
}

function saveQualityCache(cache: Record<string, Judgement>) {
  mkdirSync(RECEIPTS_DIR, { recursive: true });
  writeFileSync(QUALITY_CACHE, `${JSON.stringify(cache, null, 2)}\n`);
}

/* ──────────────────────────── gathering evidence ─────────────────────────── */

/**
 * Which provider an observation belongs to.
 *
 * A buyer SELECTS on a URL, so that is the identity the policy keys on. The
 * payee address is what a registry would key on, and binding the two is exactly
 * the job ERC-8004 exists for and does not do — see docs/reputation.md.
 *
 * Two kinds of hold carry no URL: ones discovered on-chain (a receipt is what
 * records the URL, and the point of the chain scan is to find holds we have no
 * receipt for) and receipts written before 2026-09-10. Both are joined to a URL
 * by payee when that payee has been seen under one.
 *
 * THAT JOIN IS AN INFERENCE, NOT A PROOF. A provider can rotate payee addresses
 * and two providers can share one. It is the best available from chain data
 * alone, and the fact that it is the best available is the argument for the
 * registry, not against the join.
 */
function keyResolver(audits: HoldAudit[]): (a: HoldAudit) => string {
  const originOfPayee = new Map<string, string>();
  for (const a of audits) if (a.provider) originOfPayee.set(a.payee.toLowerCase(), a.provider);
  return (a) => a.provider ?? originOfPayee.get(a.payee.toLowerCase()) ?? `payee:${a.payee}`;
}

/**
 * Every hold this buyer can account for.
 *
 * Receipts are the primary source, but a receipt is a local file and the cheat
 * that produces NO receipt — a seller that claims without ever handing over a
 * ciphertext — would be invisible if we stopped there. So after auditing what we
 * have, we look for holds on-chain paid by the same addresses and audit those
 * too. The chain is the record that cannot be lost. What it cannot say is
 * whether we were handed anything: those holds come back "unaccounted" and count
 * as a soft strike, never as proof, because a receipt that is merely on another
 * machine looks exactly the same from here.
 */
export async function gather(escrowAddress: string): Promise<HoldAudit[]> {
  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 296, name: "hedera-testnet" });
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);

  const audits: HoldAudit[] = [];
  const seen = new Set<string>();

  for (const holdId of knownHoldIds()) {
    try {
      audits.push(await auditHold(holdId, escrow, escrowAddress));
      seen.add(holdId);
    } catch (e: any) {
      // Receipts from a retired escrow are expected and are not news; say nothing.
      if (!String(e.message).includes("belongs to escrow")) {
        console.log(`  (skipping hold ${holdId}: ${e.message})`);
      }
    }
  }

  const ourPayers = new Set(audits.map((a) => a.payer.toLowerCase()));
  if (ourPayers.size) {
    const iface = new ethers.Interface(ESCROW_ABI);
    const logs = await contractLogs(escrowAddress, { topic0: TOPIC.HoldOpened }, 100);
    for (const log of logs) {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;
      const holdId = parsed.args.holdId.toString();
      if (seen.has(holdId)) continue;
      if (!ourPayers.has(String(parsed.args.payer).toLowerCase())) continue;
      try {
        audits.push(await auditHold(holdId, escrow, escrowAddress));
        seen.add(holdId);
      } catch {
        /* a hold we cannot read is not evidence either way */
      }
    }
  }

  return audits.sort((a, b) => Number(a.holdId) - Number(b.holdId));
}

/* ──────────────────────────────── scoring ────────────────────────────────── */

export async function buildLedger(escrowAddress: string): Promise<{ audits: HoldAudit[]; providers: ProviderState[] }> {
  const audits = await gather(escrowAddress);
  const cache = loadQualityCache();
  let cacheDirty = false;

  const keyOf = keyResolver(audits);
  const byProvider = new Map<string, HoldAudit[]>();
  for (const a of audits) {
    const key = keyOf(a);
    if (!byProvider.has(key)) byProvider.set(key, []);
    byProvider.get(key)!.push(a);
  }

  const providers: ProviderState[] = [];

  for (const [key, list] of byProvider) {
    const observations: Observation[] = [];

    for (const a of list) {
      const amountHbar = Number(a.amountTinybar) / 1e8;

      if (a.verdict === "cheated") {
        observations.push({
          holdId: a.holdId,
          kind: "broken",
          quality: 0,
          amountHbar,
          detail: a.broken.map((c) => c.id).join(", "),
        });
        continue;
      }

      if (a.verdict === "unaccounted") {
        // Paid and claimed, and no receipt here. Not proof, because the receipt
        // may simply live on another machine, so it is a soft strike: it lowers
        // reliability, decays like any opinion, and can never BLOCK.
        observations.push({
          holdId: a.holdId,
          kind: "unaccounted",
          quality: 0,
          amountHbar,
          detail: "CLAIMED, and no receipt on this machine",
        });
        continue;
      }

      if (a.verdict === "refunded") {
        // The money came back. The request still failed, and that is a real cost
        // to an agent on a deadline — but it is the failure this project is
        // built to survive, so it must not be treated as fraud.
        observations.push({
          holdId: a.holdId,
          kind: "dark",
          quality: 0,
          amountHbar: 0,
          detail: "seller never revealed; the network refunded us",
        });
        continue;
      }

      if (a.verdict === "delivered" && a.plaintext !== null) {
        let judgement = cache[a.holdId];
        if (!judgement) {
          judgement = await judgeDelivery(a.query ?? "", a.plaintext);
          cache[a.holdId] = judgement;
          cacheDirty = true;
        }
        observations.push({
          holdId: a.holdId,
          kind: "delivered",
          quality: judgement.score,
          amountHbar,
          detail: `${judgement.judge}: ${judgement.detail}`,
        });
      }
      /* pending holds are not evidence yet and are deliberately not counted */
    }

    providers.push(score(key, list, observations));
  }

  if (cacheDirty) saveQualityCache(cache);
  return { audits, providers };
}

function score(key: string, list: HoldAudit[], observations: Observation[]): ProviderState {
  const payees = Array.from(new Set(list.map((a) => a.payee)));
  // Only a broken commitment in a receipt we hold is proof. A missing receipt
  // is not: on 2026-09-11, removing one receipt made this policy permanently
  // BLOCK our own honest seller. See audit.ts, "the case where we hold nothing".
  const hardEvidence = observations.filter((o) => o.kind === "broken");

  // Newest first, so the freshest observation carries weight 1.
  const soft = observations
    .filter((o) => o.kind === "delivered" || o.kind === "dark" || o.kind === "unaccounted")
    .reverse();
  let wSum = 0;
  let qSum = 0;
  let rSum = 0;
  soft.forEach((o, i) => {
    const w = DECAY ** i;
    wSum += w;
    qSum += w * o.quality;
    rSum += w * (o.kind === "delivered" ? 1 : 0);
  });

  const weightedQuality = wSum ? qSum / wSum : 0;
  const reliability = wSum ? rSum / wSum : 0;
  const combined = weightedQuality * reliability;

  const paid = observations.filter((o) => o.amountHbar > 0);
  const spentHbar = paid.reduce((s, o) => s + o.amountHbar, 0);
  const qualityPerHbar = spentHbar > 0 ? (weightedQuality * paid.length) / spentHbar : 0;

  let action: Action;
  let reason: string;

  if (hardEvidence.length) {
    action = "BLOCK";
    const first = hardEvidence[0];
    reason = `broke a commitment on hold ${first.holdId} (${first.detail}). Proof, not opinion — never expires.`;
  } else if (!soft.length) {
    action = "TRY";
    reason = "no evidence yet. A public rating would be the prior here, and we deliberately do not use one.";
  } else if (combined >= MIN_SCORE) {
    action = "USE";
    reason = `${soft.length} observation${soft.length > 1 ? "s" : ""}, quality ${weightedQuality.toFixed(2)} × reliability ${reliability.toFixed(2)}`;
  } else {
    action = "AVOID";
    reason = `score ${combined.toFixed(2)} is under ${MIN_SCORE}. Nothing is provably broken — this one just is not worth the money.`;
  }

  return {
    key,
    payees,
    observations,
    hardEvidence,
    weightedQuality,
    reliability,
    score: combined,
    spentHbar,
    qualityPerHbar,
    action,
    reason,
  };
}

/* ─────────────────────── what the agent actually calls ───────────────────── */

/**
 * The decision for one endpoint, for the agent to consult before it pays.
 *
 * Falls back to TRY when there is no history — the cold-start case, and the one
 * place a public rating would legitimately be used as a prior if any public
 * rating on this market were worth using.
 */
export async function decideForEndpoint(escrowAddress: string, endpoint: string): Promise<ProviderState> {
  const origin = new URL(endpoint).origin;
  const { providers } = await buildLedger(escrowAddress);
  return (
    providers.find((p) => p.key === origin) ?? {
      key: origin,
      payees: [],
      observations: [],
      hardEvidence: [],
      weightedQuality: 0,
      reliability: 0,
      score: 0,
      spentHbar: 0,
      qualityPerHbar: 0,
      action: "TRY" as Action,
      reason: "never bought from this provider before",
    }
  );
}

/* ──────────────────────────────── the report ─────────────────────────────── */

const MARK: Record<Action, string> = { USE: " USE  ", TRY: " TRY  ", AVOID: "AVOID ", BLOCK: "BLOCK " };

async function main() {
  const escrowAddress = process.env.ESCROW_ADDRESS || "";
  if (!escrowAddress) throw new Error("Set ESCROW_ADDRESS.");

  console.log(`\n  buyer-side policy`);
  console.log(`  ${"─".repeat(70)}`);
  console.log(`  escrow   ${escrowAddress}`);
  console.log(`  decay    ${DECAY}   (opinions only; proofs never decay)`);
  console.log(`  minimum  ${MIN_SCORE}`);

  const { audits, providers } = await buildLedger(escrowAddress);

  if (!audits.length) {
    console.log(`\n  No holds to score. Buy something first: npm start\n`);
    return;
  }

  for (const p of providers) {
    console.log(`\n  [${MARK[p.action]}] ${p.key}`);
    console.log(`           ${p.reason}`);
    if (p.payees.length) console.log(`           paid to ${p.payees.join(", ")}`);
    if (p.spentHbar > 0) {
      console.log(
        `           spent ${p.spentHbar.toFixed(2)} HBAR, quality ${p.weightedQuality.toFixed(2)}, ` +
          `reliability ${p.reliability.toFixed(2)}, ${p.qualityPerHbar.toFixed(3)} quality/HBAR`,
      );
    }
    for (const o of p.observations) {
      const tag =
        o.kind === "delivered"
          ? `q=${o.quality.toFixed(2)}`
          : o.kind === "dark"
            ? "refunded"
            : o.kind === "unaccounted"
              ? "no receipt"
              : "PROOF";
      console.log(`             hold ${o.holdId.padEnd(4)} ${tag.padEnd(9)} ${o.detail}`);
    }
  }

  const blocked = providers.filter((p) => p.action === "BLOCK");
  const quiet = audits.filter((a) => a.verdict === "delivered" && !a.broken.length);

  console.log(`\n  ${"─".repeat(70)}`);
  console.log(
    `  ${audits.length} hold${audits.length > 1 ? "s" : ""} scored across ${providers.length} provider${providers.length > 1 ? "s" : ""}.` +
      ` ${blocked.length} provider${blocked.length === 1 ? "" : "s"} blocked on proof.`,
  );
  console.log(
    `\n  What this is and is not: the ${blocked.length} block${blocked.length === 1 ? "" : "s"} above ${blocked.length === 1 ? "is" : "are"} recomputable by anyone from` +
      `\n  chain data. The quality scores are not — they are this buyer's opinion,` +
      `\n  they decay, and a seller that games the judge scores well. Of the ${quiet.length} clean` +
      `\n  deliver${quiet.length === 1 ? "y" : "ies"}, verify.ts cannot tell you which were worth paying for. That is` +
      `\n  the line between the two channels, and it does not move.\n`,
  );
}

// Only when run directly; the agent imports decideForEndpoint from here.
if (process.argv[1] && process.argv[1].endsWith("reputation.ts")) {
  main().catch((e) => {
    console.error(`\n  ${e.message}\n`);
    process.exitCode = 1;
  });
}
