# Plan 10 — the buyer-side policy, and the cheat no commitment can catch

**Implementing agent:** Claude Opus 5 (Claude Code). **Requested by:** Alex, 2026-09-10.
Committed before the implementation it describes.

Trigger: Alex's own research into the buyer side of x402 —
[402Pilot](https://arxiv.org/abs/2608.01341) (Li et al., arXiv 2608.01341, 2 Aug 2026) and
[the write-up](https://philpher0x.dev/posts/truman_show_economy_what_ai_agents_see_on_market/)
that measures what agents actually see on this market. The question he asked: does a buyer-side
rating layer close the correctness hole this project has documented since day one?

**It does not, and the honest version of the answer is worth more than a yes.** What follows is the
part that is true, the part that is not, and what gets built.

## 1. The hole, stated more precisely than the README currently states it

`HoldEscrow` enforces exactly one of the four commitments: `keccak256(k)` against the committed
`H(k)`, or `claim()` reverts. The other three are recorded and never checked by anything on-chain.
So a paid-and-cheated buyer is in one of three positions, and they are not equally bad:

| | The seller | What the buyer holds | Who can catch it |
|---|---|---|---|
| **T1** | claims without ever sending a ciphertext | nothing | nobody on-chain; the absence is the only evidence |
| **T2** | sends a ciphertext its commitments do not match | a provable inconsistency | `verify.ts`, from chain data, by anyone, forever |
| **T3** | sends a worthless answer and commits **honestly** to it | a perfect, consistent record | nobody. There is no lie to find |

T2 is what `verify.ts` was built for and it works — holds 14, 15, 16 in
[spike 14](../spikes/14-verify.md) are three real cheats caught on the live escrow.

**T3 is the one that matters, and the README currently undersells how clean it is.** The seller does
the work-free version, hashes what it is about to send, and every check passes. There is no
"element the seller lied about", because the seller did not lie about any element. It answered the
question badly, which is not a statement the chain can hold an opinion about.

A rational cheat is always T3. T2 is strictly worse for the seller — same money, plus a permanent
public proof. So the commitments catch the **inconsistent** liar, not the **consistent** one, and
the difference is the difference between a bug and an adversary.

**This is not a new hole.** It is the same oracle problem the README has named since the first
screen. What is new is naming which cheat a rational seller actually picks, and building the thing
that sees it.

## 2. What 402Pilot does and does not buy

402Pilot is a *buyer-side decision layer*: it does not change what a payment guarantees, it changes
who the buyer pays next. Its policy, PA-DCT, keeps a discounted belief per provider and reallocates
a finite wallet as evidence arrives.

**What that closes here:** T3 stops being free. A provider that ships junk gets a low observation,
its posterior falls, and the buyer's spend moves elsewhere. The loss is not the robbed payment — it
is the stream after it.

**What that does not close, and must be said out loud:**

- **Not one trade.** The robbed payment is gone. Nothing off-chain gets it back. What is bounded is
  the *rate*, not the event.
- **Not against an adaptive seller.** PA-DCT discounts old observations so a provider can recover
  from a bad patch. That is correct against a stationary defect and it is a channel against a
  strategic one: cheat below the forgetting rate and stay above the selection threshold. The paper's
  own limitations name this — its benchmark has *no seller strategic behaviour*, and its adversary
  is a fixed 60%-wrong provider, which is a defect, not an opponent.
- **Not without volume.** The measured median lifetime earnings of an x402 seller is $3.96. The
  future stream we threaten a cheat with is, today, worth almost nothing.
- **Not with public ratings.** Sybil share of ERC-8004 feedback is 41.4% / 92.6% / 96.3% on
  Ethereum / Base / BSC, and ~98% of reviews have no proof of payment or task behind them.
  A public rating is a cold-start prior and nothing more.

## 3. The design that follows from that: two channels, and only one of them is discounted

The mistake would be to score everything the same way. Deadman produces two different *kinds* of
evidence and they deserve different treatment:

**Hard channel — proofs.** T1 and T2 are not opinions. They are recomputable by anyone from
`HoldOpened` and `Claimed`, they cannot be produced by an honest seller, and they do not degrade
with time. So they are **never discounted**: one is permanent exclusion. Discounting a proof is how
you get farmed.

> **Corrected 2026-09-11, after running it.** T1 is not recomputable by anyone: it rests on the
> buyer *not* holding a receipt, which a lost or relocated file produces just as well. Tested: with
> one honest hold's receipt removed, the policy permanently blocked our own endpoint. T1 is now a
> soft strike and only T2 is proof. The plan above is left as written; this note is the correction.

**Soft channel — judgements.** T3 and a seller that goes dark are noisy: a crash and a scam look
identical from one observation. These are discounted, exactly as PA-DCT does, and a provider can
recover from them.

That split is the whole contribution, and it exists only because the escrow already emits
proof-grade evidence. **This is the direction of the connection that actually works:** 402Pilot has
a policy and no trustworthy substrate; the substrate is the thing ~98% of ERC-8004 reviews are
missing, and `HoldOpened` + `Claimed` + `Refunded` already contain it — payer, payee, amount,
`H(request)`, and the outcome. **No contract change is required for any of this**, which is why it
is safe to build four days from submission.

## 4. What gets built

Agent-side only. The contract is deployed, has 53 adversarial tests against it, and is not being
touched.

| File | What it is |
|---|---|
| `agent/src/audit.ts` | **new.** One place that turns (receipt, chain) into a structured verdict. |
| `agent/src/verify.ts` | **refactored to a renderer.** Human output preserved byte for byte. |
| `agent/src/quality.ts` | **new.** The soft-channel judge. Structural by default, `QUALITY_JUDGE_URL` for a real one. |
| `agent/src/reputation.ts` | **new.** The ledger and the policy. `npm run reputation`. |
| `agent/src/index.ts` | consults the policy before paying; records the provider on the receipt. |
| `server/src/index.ts` | **`SELLER_CHEAT=garbage`** — honest commitments over a worthless answer. |

`verify.ts` and `reputation.ts` must not each implement the commitment checks. Two implementations
of one rule drift, and a drifted implementation here looks exactly like a lying seller — which is
the failure `shared.ts` already exists to prevent. Hence `audit.ts`.

**`SELLER_CHEAT=garbage` is the point of the whole package.** The three existing cheat modes all
produce a `verify.ts` FAIL. This one produces a clean bill of health from `verify.ts` and a bad
score from `reputation.ts`, in the same run. A limit that has never been demonstrated is an
assertion, and the same rule that put the other three cheats in the server applies here.

## 5. Where the judge comes from, and why it is deliberately weak

Scoring is not free. The paper's benchmark uses a cached judge; in production it is another paid
call, sometimes dearer than the service being judged, and the business outcome may only surface a
day later. Pretending otherwise would be the same kind of dishonesty as an untested guard.

So: `quality.ts` ships a **structural** judge — does the payload parse, does it answer the query we
asked — and it is stated plainly that this is a placeholder for an LLM judge, that it is cheap
because it is weak, and that a seller who knows the criterion can satisfy it without doing the work.
`QUALITY_JUDGE_URL` is the seam for a real one. The private-criterion argument is the honest defence
and it belongs in the docs, not in a hardcoded heuristic: a criterion the seller cannot see is the
only one that cannot be gamed.

## 6. The Sybil answer, and the one number that is actually ours

A dropped provider re-registers under a new URL and a new payee address, and the policy starts from
zero. Every reputation scheme has this problem and most of them lose to it.

What is different here is measured and already in the README for an unrelated reason: **`openHold`
costs the seller 1,668,661 gas, charged 1.77 HBAR, ~$0.09.** The seller cannot avoid it — it is
`scheduleCall`'s own floor and it is spent per sale, honest or not.

So a fake ERC-8004 review costs a fraction of a cent to write, and a fake *sale* on this escrow
costs the seller ~$0.09 of gas it cannot get back. That does not make fraud impossible. It makes
farmed signal about two orders of magnitude dearer than the market's current baseline, and it is the
one anti-Sybil property this design has for free.

This is also the answer to the README's own worst number. The 1.9 HBAR per hold has been written up
as a limit — the reason Deadman does not work for sub-cent calls. It is simultaneously the reason a
Deadman record is worth more than a review. Both are true and both should be on the page.

## 7. What is explicitly NOT built

- **No ERC-8004 integration.** It is the natural on-chain home for this and it stays a roadmap item
  with a concrete sketch. Building it now would mean publishing into a registry whose feedback is
  92.6% Sybil on the chain we would publish to, four days before submission, against a cut list that
  ruled it out on 2026-09-06 for scope reasons that have not changed.
- **No bandit.** PA-DCT over one provider is theatre. What ships is the ledger, the two-channel
  rule and the decision — the part that is real with N=1 — and the policy interface is where a
  sampler goes when there are providers to sample over.
- **No claim that A3 is closed.** The threat model says "not closed and not closable by hashes" and
  that stays true. What changes is that the sentence now has a second half.

## 8. How it gets demonstrated

Against the live escrow, using cheat modes that already exist plus the new one:

1. `SELLER_CHEAT=none` — `verify.ts` clean, quality high, provider `USE`.
2. `SELLER_CHEAT=wrong-key` — `verify.ts` names the broken commitment, provider `BLOCK`, permanently, on one observation.
3. `SELLER_CHEAT=garbage` — **`verify.ts` clean, quality low.** The pair is the demo.
4. `DEMO_DARK=1` — network refunds, buyer whole, provider's reliability drops but recovers.

Runs and their hold ids go in `docs/spikes/17-buyer-policy.md` when they have been executed. Until
then nothing in the README claims they have.
