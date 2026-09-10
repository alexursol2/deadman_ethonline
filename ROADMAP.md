# Roadmap

This file contains future ideas only. Nothing described here is part of the current Deadman
implementation or demo.

## Buyer-side reputation and provider selection

**Status: not implemented.** The repository has no reputation engine, provider score, quality
judge, reputation ledger, provider-selection policy, or reputation-related CLI/npm command. It
does not publish feedback to an on-chain registry.

The problem this work may address is deliberately outside the current escrow: the contract and
`agent/src/verify.ts` can detect inconsistent commitments, but they cannot decide whether an
honestly committed response is useful or correct.

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

These are also not implemented:

- ZK contingent payment for proving that a revealed key opens the committed ciphertext.
- Dual-deposit or optimistic fraud-proof flows for disputes over delivery.
- Session holds that amortise scheduling costs across multiple requests.

