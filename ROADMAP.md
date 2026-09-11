# Roadmap

This file contains future ideas only. Nothing described here is part of the current Deadman
implementation or demo.

## Where this goes

Igor's framing of the whole arc: four layers of protection for an agent that buys.

1. **Bound it and roll it back.** If delivery fails for any reason, the network refunds the buyer
   on its own. Shipped. This is Deadman.
2. **Do not start a claim that can no longer win.** The server refuses to claim inside a margin
   before the deadline, because a claim that misses consensus loses to the refund and still
   publishes the key. Shipped as `SELLER_CLAIM_MARGIN_SECONDS` (PR #4).
3. **Encryption as the contract between buyer and seller.** Four commitments, a key revealed
   on-chain, and `verify.ts` naming whichever one was broken. Shipped.
4. **Buyer-side reputation**, for the one cheat the first three cannot see: an honest commitment
   to a worthless answer. Not built. Below.

## Buyer-side reputation and provider selection

**Status: not implemented.** The repository has no reputation engine, provider score, quality
judge, reputation ledger, provider-selection policy, or reputation-related CLI/npm command. It
does not publish feedback to an on-chain registry.

The problem this work may address is deliberately outside the current escrow: the contract and
`agent/src/verify.ts` can detect inconsistent commitments, but they cannot decide whether an
honestly committed response is useful or correct.

**Why it has to be private to the buyer.** Igor's own write-up,
[The Truman Show Economy](https://philpher0x.dev/posts/truman_show_economy_what_ai_agents_see_on_market/),
argues that any public score becomes an optimisation target, and that ERC-8004 feedback in
practice is cheap to fake and mostly carries no proof that a transaction ever happened. A
reputation that works is kept by the buyer, for the buyer: fully off-chain, or committed on-chain
to a contract the agent owns, but never published to a shared registry where it can be farmed.
An independent arbiter does not escape this either, since it can be gamed the same way.

402Pilot learns from observed outcomes against a budget, so in Igor's reading it suits an agent
that buys the same kind of thing repeatedly, and does little for a one-off purchase.

Possible research and implementation steps:

1. Define which observations are objective commitment failures and which are subjective quality
   judgements.
2. Evaluate a buyer-local provider history and selection policy, including approaches described by
   [402Pilot](https://arxiv.org/abs/2608.01341). No 402Pilot algorithm is implemented today.
3. Define a quality signal and its threat model before adding any scoring code.
4. Add tests for cold start, provider identity changes, Sybil behaviour, score decay, and malicious
   providers before connecting the policy to payments.
5. Evaluate ERC-8004 only after the provider-to-on-chain-identity mapping, evidence format, privacy
   boundary, and Sybil assumptions are specified. There is no ERC-8004 integration or published
   feedback today.

Any future implementation must update the README and code map only after the code and tests exist.

## Other possible extensions

These are also not implemented. Why we did not build the first three is argued in the README,
under the correctness limit.

- **Optimistic fraud proofs** with a seller bond, where the challenge window is itself a second
  HIP-1215 schedule rather than a keeper. Our documented next step.
- ZK contingent payment for proving that a revealed key opens the committed ciphertext.
- Dual-deposit escrow, which reintroduces a buyer who must dispute.
- Session holds that amortise scheduling costs across multiple requests.

