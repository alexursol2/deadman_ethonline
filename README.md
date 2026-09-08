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

### Limits the spikes found

**The jitter fallback is untested.** When the requested second is saturated, `arm()` walks
exponential-backoff candidates looking for a free one. Testnet is uncongested, so that path has
never executed against a real network — `probesUsed` was `0` on every run. It has unit tests against
a mocked Schedule Service; it does not have evidence. We are not claiming otherwise.

**Opening a hold is expensive.** The `scheduleCall` precompile needs ~1.45M gas of its own
([measured](docs/spikes/gas-probe.json)), so the x402 settlement that opens a hold has to carry
several million gas. Anyone integrating should budget for that rather than discovering it.

**`scheduleCall` does revert, in one case HIP-1215 does not mention.** The HIP says it never reverts
and returns failure codes instead. That holds for business failures — a saturated second returns
`SCHEDULE_EXPIRY_IS_BUSY`. Starved of gas it reverts with *empty returndata* and consumes everything
forwarded to it. A contract that checks only the returned code will misread gas starvation as its
own bug. Ours checks both.

**A rejected `deleteSchedule` looks like a successful transaction.** Only the creating contract
can delete its own schedule — verified, a stranger gets `INVALID_SIGNATURE`
([spike 4](docs/spikes/04-third-party-delete.md)) — but the refusal arrives as a *return code*, not
a revert. The transaction succeeds. A contract that discards that code will believe it cancelled a
refund that is still armed, pay the seller, and then have the refund fire and pay the buyer too. We
revert on anything other than `22`.

**Not even we can cancel a refund.** Deletion is gated on the schedule's admin key, which is the
creating contract's ContractID — read directly off the schedule record, not inferred
([spike 5c](docs/spikes/05-caveat-closure.md)). A stranger is refused, and so is the EOA that
deployed the contract ([5b](docs/spikes/05-caveat-closure.md)). Once a hold is open the operator has
no cancel to be compelled into using.

**The mirror node returns stale data with a 200.** Reading a schedule immediately after changing it
can show the old state. We hit this and briefly recorded a successful delete as a failure. Anything
that reads back a state change — the live board especially — must poll on the condition, not on the
HTTP status.

**HBAR has two scales and the EVM shows you one of them.** Everything inside the EVM —
`address(this).balance`, `msg.value`, `scheduleCall`'s `value` — is in **tinybars** (1e8/HBAR).
Everything over JSON-RPC is in **weibars** (1e18/HBAR). The boundary converts, exactly 1e10.
Solidity's `ether` literal is 1e18, so `balance >= 5 ether` in a Hedera contract can never pass —
we got that wrong first time. Measured on every surface, not assumed:
[units](docs/spikes/05-caveat-closure.md), [value parameter](docs/spikes/06-value-units.md).

Further limits get added here as we find them. This section grows; it does not shrink.

## Status

Pre-implementation. This repo currently contains de-risking spikes only. Start with
[`docs/SESSION-01.md`](docs/SESSION-01.md) for what was verified and what was not; the individual
reports and their raw mirror-node evidence are in [`docs/spikes/`](docs/spikes/).
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
