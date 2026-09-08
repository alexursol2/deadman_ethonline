# Deadman

> **Every x402 escrow needs someone to push a button. Ours is the only one where the protocol pushes it.**

An x402 payment settles into a hold instead of to the seller. The hold then books its own refund
with the Hedera network, sixty seconds out.

- Seller delivers, reveals the key, gets paid, and the booked refund is cancelled.
- Seller does nothing, **nobody does anything**, and the network itself executes the refund at the
  appointed second.

This is possible because of [HIP-1215](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-1215.md):
a contract can schedule a call that the network executes on its own, with no transaction from
anyone. Hedera has had network-executed scheduled *transfers* since HIP-423. **What is new here is
that a contract arms its own refund from inside the EVM, atomically, in the transaction that takes
the money.**

## Limits we are not hiding

**The refund is armed one transaction after the payment lands, not in the same one.** We wanted
atomicity and it is not available: `@x402/hedera` settles with a `TransferTransaction` and its
facilitator rejects anything else by name, and a Hedera HAPI transfer to a contract credits the
balance **without running its code** — both measured in
[spike 9](docs/spikes/09-settlement-atomicity.md). So the payment credits the escrow directly, and
the server then arms the refund.

The escrow being a valid x402 destination is verified and settled end to end, not assumed —
[spike 10](docs/spikes/10-payto-contract.md), a real 0.1 HBAR payment through Blocky402 landing in a
contract.

What that costs: a window of one transaction in which the money is in the escrow but no refund is
armed. What it does **not** cost: the seller never holds the money, and `claim()` is the only path
to the payee, so a server that settles and skips arming gets nothing. The failure mode is a crash
leaving funds in the escrow, recoverable by an operator-attributed sweep — a disclosed
"someone must act" path that we would rather name than bury.

**The refund itself is unaffected.** Once armed, the network executes it with nobody acting, and
nobody — including us — can cancel it. That is the claim in the one-liner and it is intact.

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

**The saturated-second path has never run on a real network.** When the requested second is full,
`openHold` walks exponential-backoff candidates looking for a free one. Testnet is uncongested, so
`hasScheduleCapacity` has returned true on every probe we have ever made. The minute-boundary skip
*has* run on testnet ([measured](docs/spikes/11-escrow-gas.md)), and the whole path has unit tests
against a mocked Schedule Service — but the congestion branch has evidence only from a mock, and we
are not claiming otherwise.

**Opening a hold costs ~1.67M gas.** The `scheduleCall` precompile's ~1.45M floor dominates
([measured](docs/spikes/11-escrow-gas.md)), so the transaction that opens a hold needs ~3M and we
send 5M. Not a normal EVM cost; budget for it rather than discover it, because below the floor it
fails with empty returndata that reads like a contract bug.

**`scheduleCall` does revert, in one case HIP-1215 does not mention.** The HIP says it never reverts
and returns failure codes instead. That holds for business failures — a saturated second returns
`SCHEDULE_EXPIRY_IS_BUSY`. Starved of gas it reverts with *empty returndata* and consumes everything
forwarded to it. A contract that checks only the returned code will misread gas starvation as its
own bug. Ours checks both.

**System-contract effects do unwind on revert — but only where there is a transaction to unwind.**
A successful `deleteSchedule` is rolled back if the enclosing transaction later reverts
([spike 7](docs/spikes/07-delete-atomicity.md)), which HIP-1215 does not document either way. That
protects the claim path. It does **not** protect a scheduled execution: by the time a scheduled
call's body runs, the schedule has already fired, and a revert inside it cannot un-fire that.

**A scheduled call that reverts still spends its schedule.** It fires once and is not re-queued
([spike 8](docs/spikes/08-scheduled-revert.md)), and the contract is charged for the failed
execution. That is why our refund path cannot contain anything that reverts once it has started.

**Network-executed calls are invisible in the obvious place.** They do not appear in the mirror
node's `/contracts/{address}/results`; you have to go schedule record → `executed_timestamp` →
`/transactions?timestamp=`. A refund that fired and failed looks exactly like one that never fired,
in the one endpoint a dashboard would poll.

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

**Working end to end on Hedera testnet.** A real x402 payment settled through Blocky402 into
`HoldEscrow` (`0.0.10419881`), a hold armed over it, the seller stayed silent, and the network
refunded the buyer with `signatures: []` — nobody acted.
[The run](docs/spikes/12-end-to-end.md).

The [resource server](server/) and [paying agent](agent/) are built and working against that escrow.
Three scenarios recorded: the seller delivers and the buyer decrypts; the seller goes dark and the
network refunds; and **the server is killed while alive and holding the key, and the refund still
lands** ([the runs](docs/spikes/13-server-agent.md)).

Still to build: a public deployment (this runs on localhost against testnet), the live board, Privy,
`verify.ts`, and HCS receipts.

Start with
[`docs/SESSION-01.md`](docs/SESSION-01.md) for what was verified and what was not; the individual
reports and their raw mirror-node evidence are in [`docs/spikes/`](docs/spikes/).
`HoldEscrow.sol` is not written yet.

## Layout

```
/contracts    HoldEscrow.sol, the spike contracts, tests
/server       x402 resource server — settles into the escrow, arms the refund
/agent        the paying client — pays, watches, never has to act
/web          live board and Privy (not started)
/docs         plans/, reviews/, spikes/ (raw evidence for every claim above)
```

## Setup

```bash
cp .env.example .env      # fill in an ECDSA Hedera testnet key — ED25519 will not work
cd contracts && npm install && npx hardhat test
```

Then deploy the escrow, and run the two services against it:

```bash
cd contracts && npx hardhat run scripts/deploy-escrow.cjs --network hederaTestnet
cd server   && npm install && npm start
cd agent    && npm install && npm start
```

Set `ESCROW_ADDRESS` in `.env` from the deploy output. The escrow needs an operating float: it pays
every armed refund's execution gas from its own balance, and `openHold` refuses to open a hold it
could not afford to refund.

## AI use

Parts of this repo are agent-written. Per ETHGlobal's attribution requirement, the plan for each
work package is written to [`docs/plans/`](docs/plans/) and committed **before** the implementation
it describes, and each plan names the model and states what a human reviewed and changed.
