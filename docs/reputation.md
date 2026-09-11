# The buyer-side policy

**What the escrow cannot do, who can do it instead, and what that costs.**

`HoldEscrow` guarantees that a silent seller cannot keep the money. It cannot guarantee that a
talkative one gives you anything worth having. That gap is an oracle problem, it does not close
on-chain, and this document is about the half of the answer that is not a proof.

Shipped: [`agent/src/reputation.ts`](../agent/src/reputation.ts), `npm run reputation`. No contract
change; nothing here touches the deployed escrow.

---

## The three cheats, which are not equally bad

The contract enforces exactly one of the four commitments: `keccak256(k)` against the committed
`H(k)`, or `claim()` reverts. `H(C)`, `H(m)` and `H(request)` are recorded and checked by nobody
on-chain. So a paid-and-cheated buyer is in one of three positions:

| | The seller | What the buyer holds | Who catches it |
|---|---|---|---|
| **T1** | claims without ever handing over a ciphertext | nothing | the absence is the evidence. `audit.ts` flags a CLAIMED hold with no delivery |
| **T2** | sends a ciphertext its commitments do not match | a provable inconsistency | `verify.ts`, from chain data, by anyone, forever |
| **T3** | sends a worthless answer and commits **honestly** to it | a perfect, consistent record | nobody. There is no lie to find |

T2 works and is demonstrated — holds 14, 15, 16 in [spike 14](spikes/14-verify.md) are three real
cheats caught on the live escrow.

**T3 is the one a rational seller picks.** T2 costs the same money and leaves a permanent public
proof; T3 costs the same money and leaves nothing. So the commitments catch the *inconsistent*
liar, not the *consistent* one — which is the difference between a bug and an adversary.

`SELLER_CHEAT=garbage` on the resource server is T3: no work done, a plausible-looking reply that
answers nothing, and honest hashes over exactly the bytes the buyer receives. `verify.ts` gives it a
clean bill of health, because it deserves one. That is not a flaw in `verify.ts`; it is the boundary
of what a hash can mean.

## Two channels, and only one of them is discounted

[402Pilot](https://arxiv.org/abs/2608.01341) (Li et al., arXiv 2608.01341, 2 Aug 2026) describes the
shape of the fix: a *buyer-side decision layer* that does not change what a payment guarantees, only
who gets the next request. Its policy, PA-DCT, keeps a discounted belief per provider and
reallocates a finite wallet as evidence arrives. It reports spending 39–43% of the wallet at
comparable quality on a benchmark of 823 tasks over five provider pipelines and three market
regimes.

What that closes here: T3 stops being free. The robbed payment is gone, but the stream after it is
what the cheat loses.

**One change matters, and it comes from what the escrow already emits.** Deadman produces two kinds
of evidence and they must not be scored the same way:

| | | |
|---|---|---|
| **hard** | T1 and T2 | Recomputable by anyone from `HoldOpened` and `Claimed`. An honest seller cannot produce one. **Never discounted; one is permanent exclusion.** |
| **soft** | T3, and a seller that goes dark | A crash and a scam look identical from one observation. **Discounted with age; a provider recovers.** |

Discounting a proof is how you get farmed. PA-DCT forgets old observations so a provider can recover
from a bad patch — correct against a stationary defect, and a *channel* against a strategic one:
cheat below the forgetting rate and stay above the selection threshold. The paper's own limitations
name this. Its adversary is a provider that is wrong 60% of the time and one that bills 40% of its
timeouts: those are defects, not opponents. Keeping proofs out of the decay closes that channel for
every cheat we can actually prove, and leaves it open only where the evidence is genuinely an
opinion.

**This is the direction of the connection that works.** 402Pilot has a policy and no trustworthy
substrate. The substrate is precisely what ~98% of ERC-8004 feedback is missing — no proof of
payment or task behind the review — and `HoldOpened` + `Claimed` + `Refunded` already carry it:
payer, payee, amount, `H(request)`, and the outcome, recomputable by a stranger a year later.

## What it decides

```
BLOCK   hard evidence exists. Permanent. Does not decay, does not average away.
AVOID   no proof, but discounted quality × reliability is under the threshold.
TRY     no history. Cold start.
USE     above the threshold.
```

Quality comes from [`quality.ts`](../agent/src/quality.ts), and it is **deliberately weak**. Scoring
is not free: the paper's benchmark uses a cached judge, and in production an LLM judge is one more
paid call — sometimes dearer than the service being judged — whose real answer, the business
outcome, may only surface a day later. The default judge is structural: does the payload parse, and
does its answer contain the content words of the question we paid for. That is cheap because it is
weak, and a seller who knows the criterion satisfies it without doing the work.

The defence is not a cleverer heuristic. It is a **private** one — a criterion the seller cannot see
is the only one it cannot satisfy without doing the work — which is an argument for keeping scores
local and per-buyer, and against ever publishing them. `QUALITY_JUDGE_URL` is the seam where a real
judge goes.

## The Sybil problem, and the one number that is ours

A blocked provider re-registers under a new URL and a new payee address and starts from zero. Every
reputation system has this problem and most lose to it. The measured state of the nearest comparable
system, reported in
[the write-up](https://philpher0x.dev/posts/truman_show_economy_what_ai_agents_see_on_market/):

- ERC-8004 Sybil review share: **41.4%** on Ethereum, **92.6%** on Base, **96.3%** on BSC.
- On BSC, **76 addresses wrote 29,444 reviews** — 387 each.
- **~98%** of reviews have no proof of payment or task behind them; **6.2%** of reviewers have any
  payment history at all.
- Scoring one of them costs $0.055 on Ethereum, $0.0027 on Base.

So a fake review costs a fraction of a cent. What does a fake *sale* cost on this escrow?

**1,668,661 gas, charged 1.77 HBAR — about $0.09 at $0.05/HBAR, and the seller pays it.** ~87% is
`scheduleCall`'s own floor, which cannot be optimised away, and it is spent per sale whether the
seller is honest or not ([the measurements](deploy.md)).

That does not make fraud impossible. It makes farmed signal roughly two orders of magnitude dearer
than this market's current baseline, and it is the only anti-Sybil property this design gets for
free.

**It is also the exact number the README lists as the project's worst limit** — the reason Deadman
does not work for sub-cent calls. Both readings are true and both belong on the page: the cost that
rules out micro-payments is the same cost that makes a Deadman record worth more than a review.

## Why the buyer side is the scarce side

The case for spending effort here rather than on another on-chain guarantee, from the same
write-up's measurements of live x402 traffic:

- **136,708,672 payments** worth **$44,121,383.81** — and **84.98% of settlements are operators
  settling with themselves.**
- **25,163 resources** listed against **811 recipient addresses**, of which **624** ever received a
  payment and **249** ever earned $10 in total.
- A **median seller lifetime of $3.96**.
- **20 domains hold 58%** of the "unique payers" in the Coinbase catalogue; one server added nearly
  half of all listings and intercepted **71.8%** of agent traffic.

The market is almost entirely storefront. Sellers vastly outnumber buyers, and the constraint on
growth is not that sellers cannot get paid — it is that buyers cannot tell who is worth paying. That
is a buyer-side problem, and it is why a buyer-side layer is worth more right now than another
seller-side guarantee.

**It also bounds our own claim honestly.** The future stream we threaten a cheat with is, at a
median lifetime of $3.96, worth almost nothing today. The economic argument against T3 is
*structurally* right and *numerically* weak until the buyer side grows by one to two orders of
magnitude. Saying so is better than pretending the mechanism works at today's volumes.

## ERC-8004: what the on-chain version is, and why it is not built

The registry is the natural on-chain home for all of this, and the missing piece there is exactly
the piece we have. A Deadman hold is a feedback record that needs no trust in its author:

```
hold  -> a ValidationRegistry entry, where
  agent      = payee from HoldOpened          the on-chain seller identity
  task       = hRequest                       which request, bound to the settlement tx id
  payment    = amountTinybar, and the settle transaction that funded the hold
  outcome    = Claimed or Refunded            the network's own record, not a claim
  evidence   = the HoldOpened and Claimed logs, from which anyone recomputes the verdict
```

That is the thing a reviewer cannot fake: to write one, you must actually have been paid, and the
proof of it is a transaction someone else's facilitator submitted.

**Not built, and the reasons are in this order:**

1. **The public signal on the registry is currently noise.** Publishing into a feedback set that is
   92.6% Sybil on the chain we would publish to does not make the set better; it makes our record
   indistinguishable from the farm. The fix is not integration, it is the evidence requirement — and
   the evidence requirement is the part we would be contributing, which is a protocol argument, not
   a hackathon deliverable.
2. **Publishing scores defeats the private-criterion defence.** A public score is a target. A
   published *proof* is not, which is why the on-chain sketch above carries only the hard channel
   and leaves quality judgements local.
3. **Scope.** ERC-8004/HCS-14 identity was cut on 2026-09-06 with HTS, multi-agent budgeting and UCP
   discovery, for a scope reason that has not changed. It is an identity system, not a payment one,
   and the track gate does not ask for it.

The honest next step is narrower than "integrate ERC-8004": publish the hard channel — and only the
hard channel — as validation records, keyed on the payee address, with the hold as the evidence
pointer. The identity binding it needs, URL to payee address, is the one thing neither this repo nor
the registry currently does, and `reputation.ts` infers it by payee and says so in the code.

## Limits

- **It does not get a robbed payment back.** It bounds the *rate*, not the event. A2 and A3 in the
  threat model stay open; what changes is that they now have a second half.
- **With one provider configured, "avoid" means "stop buying", not "buy elsewhere".** PA-DCT over
  one provider is theatre. What ships is the ledger, the two-channel rule and the decision — the
  part that is real at N=1. The sampler goes in when there are providers to sample over.
- **The structural judge is a placeholder** and a seller who reads this file can satisfy it.
- **The URL-to-payee join is an inference.** A provider can rotate payee addresses; two providers can
  share one.
- **The ledger rebuilds from the chain on every run.** Correct, and O(holds) mirror reads. At demo
  volumes that is seconds.

## Sources

- 402Pilot: *An x402 Decision Layer for Autonomous Agent Micropayments*, Li, He, Yang, Lawana, Li,
  Zeng, Tang, Tsung. [arXiv 2608.01341](https://arxiv.org/abs/2608.01341), 2 Aug 2026.
- Market and ERC-8004 figures:
  [The Truman Show Economy](https://philpher0x.dev/posts/truman_show_economy_what_ai_agents_see_on_market/),
  which draws them from *How Agentic Is Agentic Commerce?* and *Can Trustless Agents Be Trusted?*
- Gas and cost figures: [`docs/deploy.md`](deploy.md) and
  [spike 11](spikes/11-escrow-gas.md), measured on Hedera testnet.
- The design decision and what was deliberately not built:
  [`docs/plans/10-buyer-side-policy.md`](plans/10-buyer-side-policy.md).
