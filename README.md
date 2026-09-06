# Deadman

> **Every x402 escrow needs someone to push a button. Ours is the only one where the protocol pushes it.**

An x402 payment settles into a hold instead of to the seller. In the same transaction, the hold
books its own refund with the Hedera network, sixty seconds out.

- Seller delivers, reveals the key, gets paid, and the booked refund is cancelled.
- Seller does nothing, **nobody does anything**, and the network itself executes the refund at the
  appointed second.

This is possible because of [HIP-1215](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-1215.md):
a contract can schedule a call that the network executes on its own, with no transaction from
anyone. Hedera has had network-executed scheduled *transfers* since HIP-423. **What is new here is
that a contract arms its own refund from inside the EVM, atomically, in the transaction that takes
the money.**

## Limits we are not hiding

**We guarantee delivery, not correctness.** A seller can encrypt garbage, commit to the hash of that
garbage, reveal the correct key, and get paid. The contract cannot read the plaintext and does not
try to judge it.

What the four commitments (`H(k)`, `H(C)`, `H(m)`, `H(request)`) do buy: a cheated buyer holds
cryptographic proof of exactly which element the seller lied about, and `verify.ts` detects it in
one command. That is evidence, not enforcement.

Known solutions we did not build, and why:

- **ZKCP** (zero-knowledge contingent payment) would prove on-chain that the revealed key opens the
  committed ciphertext. It still does not prove the content is good, so it closes the smaller of the
  two holes — and a circuit plus tooling plus debugging does not fit a six-day window.
- **Dual-deposit escrow** makes cheating unprofitable but requires the buyer to dispute, which
  reintroduces the exact dependency this design removes.
  ([USC dual-deposit paper](https://anrg.usc.edu/www/papers/Dual_Deposit_ICBC_2019.pdf),
  [arxiv 1806.08379](https://arxiv.org/pdf/1806.08379))
- **Optimistic fraud proofs** with a seller bond and a challenge window are the most promising
  extension, and the challenge window would itself be a second HIP-1215 schedule — the same
  primitive rather than a new keeper. **This is our documented next step.**

Further limits get added here as the spikes find them. This section grows; it does not shrink.

## Status

Pre-implementation. This repo currently contains de-risking spikes only — see
[`docs/plans/01-spikes.md`](docs/plans/01-spikes.md) and [`docs/spikes/`](docs/spikes/).
`HoldEscrow.sol` is not written yet.

## Layout

```
/contracts    Hardhat project — spike contract now, HoldEscrow next
/server       x402 resource server
/agent        the paying client
/web          live board and Privy
/docs         plans/, reviews/, spikes/ (raw evidence)
```

## Setup

```bash
cp .env.example .env      # fill in an ECDSA Hedera testnet key — ED25519 will not work
cd contracts && npm install
```

## AI use

Parts of this repo are agent-written. Per ETHGlobal's attribution requirement, the plan for each
work package is written to [`docs/plans/`](docs/plans/) and committed **before** the implementation
it describes, and each plan names the model and states what a human reviewed and changed.
