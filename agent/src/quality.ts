/**
 * quality.ts — the soft channel: was the answer any good?
 *
 * This is the question no commitment can answer. A seller that encrypts a
 * worthless reply and commits honestly to it passes every check in audit.ts,
 * because it did not lie about any element — it answered badly, and the chain
 * has no opinion about that. Somebody has to form one, and it can only be the
 * buyer, after the fact, off-chain.
 *
 * SCORING IS NOT FREE, and the honest thing is to say so in the code rather
 * than hide it behind a helper. The 402Pilot benchmark (arXiv 2608.01341) uses
 * a cached judge; in production an LLM judge is one more paid call, sometimes
 * dearer than the service being judged, and the business outcome it is standing
 * in for may only surface a day later.
 *
 * So there are two judges here and neither is pretending to be more than it is:
 *
 *   structural  the default. Does the payload parse, and does the answer
 *               actually address the question we paid for? Free, instant, and
 *               DELIBERATELY WEAK — a seller who knows the criterion can
 *               satisfy it without doing the work. It is a placeholder with the
 *               right shape, not a solution.
 *
 *   remote      QUALITY_JUDGE_URL. POST {query, plaintext} -> {score}. This is
 *               where a real judge goes, and where its cost lands.
 *
 * The defence against a seller gaming the judge is not a cleverer heuristic, it
 * is a PRIVATE one: a criterion the seller cannot see is the only one it cannot
 * satisfy without doing the work. Which is an argument for keeping this local
 * and per-buyer, and against ever publishing the scores — see docs/reputation.md.
 */

export interface Judgement {
  /** 0 = worthless, 1 = fully answers what we asked. */
  score: number;
  judge: string;
  detail: string;
}

const JUDGE_URL = (process.env.QUALITY_JUDGE_URL || "").trim();

/**
 * Content words.
 *
 * Short and function words carry no signal and would put a floor under every
 * score: a junk reply that happens to contain "the" would score above zero for
 * any question, which is exactly the kind of accidental generosity that makes a
 * cheap judge useless.
 */
const STOP = new Set(
  ("the a an and or of to in on for is are was were be been it its this that these those " +
    "what which who whom whose how why when where do does did can could would should will " +
    "with without from into than then there here about as at by if not no yes you your our my")
    .split(" "),
);

function contentTokens(s: string): string[] {
  return Array.from(
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOP.has(t)),
    ),
  );
}

/**
 * Free, weak, and honest about it.
 *
 * Two things are asked: is the payload well formed, and does its answer contain
 * the content words of the question we paid for. A real answer to "what is the
 * airspeed velocity of an unladen swallow" mentions swallows; the junk reply a
 * seller ships when it skipped the work does not.
 *
 * What this does NOT measure is whether the answer is CORRECT. Nothing this
 * cheap can.
 */
function structural(query: string, plaintext: string): Judgement {
  let answer = plaintext;
  let wellFormed = plaintext.trim().length > 0;

  try {
    const parsed = JSON.parse(plaintext);
    if (parsed && typeof parsed === "object") {
      const a = (parsed as any).answer;
      wellFormed = typeof a === "string" && a.trim().length > 0;
      answer = typeof a === "string" ? a : JSON.stringify(parsed);
    }
  } catch {
    /* not JSON; the whole payload is the answer */
  }

  if (!wellFormed) return { score: 0, judge: "structural", detail: "empty or malformed payload" };

  const asked = contentTokens(query);
  if (!asked.length) {
    return { score: 1, judge: "structural", detail: "no content words in the query; nothing to check against" };
  }
  const said = new Set(contentTokens(answer));
  const hit = asked.filter((t) => said.has(t));
  const coverage = hit.length / asked.length;

  return {
    score: coverage,
    judge: "structural",
    detail: `${hit.length}/${asked.length} of the question's content words appear in the answer`,
  };
}

async function remote(query: string, plaintext: string): Promise<Judgement> {
  const res = await fetch(JUDGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, plaintext }),
  });
  if (!res.ok) throw new Error(`judge answered ${res.status}`);
  const body = (await res.json()) as any;
  const score = Number(body?.score);
  if (!Number.isFinite(score)) throw new Error("judge returned no numeric score");
  return {
    score: Math.max(0, Math.min(1, score)),
    judge: `remote:${new URL(JUDGE_URL).host}`,
    detail: String(body?.detail ?? "scored by the configured judge"),
  };
}

export async function judgeDelivery(query: string, plaintext: string): Promise<Judgement> {
  if (!JUDGE_URL) return structural(query, plaintext);
  try {
    return await remote(query, plaintext);
  } catch (e: any) {
    // A judge that is down must not silently become a judge that says "good".
    // Falling back to structural is stated in the detail so the score is never
    // mistaken for the one that was paid for.
    const s = structural(query, plaintext);
    return { ...s, judge: "structural (remote judge unavailable)", detail: `${e.message}; ${s.detail}` };
  }
}
