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

## Live

| | |
|---|---|
| x402 endpoint | **https://deadman-server.onrender.com** — `GET /premium?q=…` |
| live board | **https://deadman-board.onrender.com** |
| escrow | [`0.0.10426758`](https://hashscan.io/testnet/contract/0x1f928BF2261979A818Ade961f3b6d8aC1AAbe860) on Hedera testnet |
| facilitator | Blocky402 (`api.testnet.blocky402.com`), fee payer `0.0.7162784` |

The board reads the Hedera mirror node **directly from your browser**. It never calls our server,
so it keeps working while we shut that server down — which is the demo.

## Why nobody else can say "nobody"

Every x402 escrow that exists needs a party to act when the seller does not deliver:

| Design | Who has to act |
|---|---|
| x402 `upto` / `batch-settlement` | buyer locks, seller pulls vouchers — no timeout at all |
| aegis-protocol (Base) | "permissionless validation": anyone *can* call it, so someone *must* |
| Bonded escrow (Pranesh) | the buyer submits a signed receipt to claim |
| Aegis402 | an LLM auditor decides |
| Reckon402 | prior interactions have to accrue first |
| Pinout (Hedera x402 winner) | metered-session remainder, not a delivery guarantee |
| [Boson x402B](https://github.com/bosonprotocol/x402B) (Base) | the **buyer**, and quickly — silence releases the money to the seller |
| [Held](https://github.com/lxfoundry/held) (Boson on Base) | a hosted watchdog raises the dispute *for* the buyer |
| **Deadman** | **nobody** |

Hedera has had network-executed scheduled *transfers* since HIP-423 — a person could already
schedule one months out. What is new here is that **a contract arms its own refund from inside the
EVM**, in the transaction that takes custody of the money, and then nothing further is required of
anyone.

Boson's [x402B](https://github.com/bosonprotocol/x402B) is the closest prior work we have found, and
it is a serious piece of engineering — a non-custodial escrow scheme for x402 with a published wire
format. It differs from this in the direction its clock points. There, funds *"release to the seller
only after the buyer signals delivery (or the dispute window expires)"*: silence pays the seller, and
the buyer must open a dispute to stop it. Here silence refunds the buyer. That inversion is the whole
argument — an autonomous agent is exactly the buyer least able to notice it has been cheated and act
inside a window.

The second difference is who moves the funds. The x402-escrow-schema state machine marks its expiry
transitions with no actor at all, which is the honest thing for a wire format to do: it is
implementation-defined, and on an EVM chain a state change still needs somebody to send a
transaction. This is the gap HIP-1215 closes, and it is why the project is on Hedera.

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
cryptographic proof of exactly which element the seller lied about, and
[`verify.ts`](agent/src/verify.ts) detects it in one command. That is evidence, not enforcement.

**And it only catches the seller that was inconsistent.** A seller that does no work, answers with
something worthless, and commits honestly to the hash of exactly those bytes has lied about no
element — so there is nothing for `verify.ts` to find. That cheat costs the same money as the other
three and leaves no proof, which makes it the one a rational seller picks. The commitments catch the
*inconsistent* liar, not the *consistent* one, and that is the difference between a bug and an
adversary. `SELLER_CHEAT=garbage` is that cheat, in the server, so the limit is demonstrable rather
than asserted.

The answer to it is not a cryptographic one. `npm run reputation` is a buyer-side policy over the
same chain data: proofs never expire and are one strike, quality judgements decay and a provider can
recover from them. It bounds the *rate* at which a seller can rob you. It does not get a single
payment back, the judge it ships with is deliberately weak, and the market it assumes has a median
seller lifetime of $3.96 — all of which is set out in
[docs/reputation.md](docs/reputation.md) before anything is claimed for it.

This is an oracle problem, and we do not claim to have solved it. Ludo of LX Foundry put the
boundary precisely when we asked him: a contract cannot know whether a *future* delivery will be
correct unless the result is predictable before it is bought, and otherwise you need a third-party
assessor. Pinning an IPFS file is his example of the predictable case, and it is the case where this
design becomes enforcement rather than evidence: when the buyer knows `H(m)` in advance, the
commitment the contract already checks is the whole guarantee. For an LLM completion, which is what
we demo, it cannot be.

**Demonstrated, not asserted.** Three separate cheats were run against the live testnet escrow — a
seller that reveals a key which passes the on-chain check and does not open the ciphertext, one that
commits to a ciphertext it did not send, and one that commits to plaintext the ciphertext does not
contain. In all three the chain is happy and the seller is paid, and `verify.ts` names the broken
commitment. [The runs](docs/spikes/14-verify.md).

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
- **On-chain reputation (ERC-8004)** is the natural home for the proofs, and a Deadman hold is
  exactly the feedback record such a registry lacks: payee, `H(request)`, the amount, the settlement
  that funded it, and an outcome the network wrote rather than a reviewer. We did not publish into
  it. The measured Sybil share of ERC-8004 feedback is 41.4% / 92.6% / 96.3% on Ethereum / Base /
  BSC and ~98% of its reviews have no proof of payment or task behind them, so adding one good
  record to that set does not make the set good — the contribution would be the evidence
  requirement, which is a protocol argument rather than an integration. The narrower version,
  publishing only the proofs and keying them on the payee address, is sketched in
  [docs/reputation.md](docs/reputation.md).

We do not implement a buyer-side trust or scoring layer. Future ideas that are not part of the
current product or demo are kept in the [roadmap](ROADMAP.md).

### Limits the spikes found

**A hold costs the seller ~1.9 HBAR, so this does not work for micro-payments.** Measured:
`openHold` is 1,668,661 gas and charged **1.77 HBAR**, `claim` about 0.13 more, and ~87% of that is
`scheduleCall`'s own gas floor, which we cannot optimise away. At roughly $0.05/HBAR that is **~$0.09
of protocol cost per hold**. Anything priced under ~2 HBAR loses money on every sale, so Deadman is
viable for API calls worth a dollar or more and **not** for the sub-cent calls x402 is most often
pitched at. [The numbers](docs/deploy.md).

**Only deliberately deposited funds can be swept by the operator.** A settled x402 payment
arrives without executing any contract code, so between settlement and `openHold` it is
attributed to nothing. The adversarial suite found that the owner could sweep a buyer's money out
of that window; `sweepReserve` is now bounded by a separately tracked operating float, and
settled-but-unarmed money can only leave via `attributeOrphanedPayment`, which credits the payer.
[The finding](docs/spikes/15-adversarial.md).

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

The server is **deployed** at the URL in the table above, from one Render blueprint that also
serves the board: Dockerfile, health check, a least-privilege seller key and a token-gated admin
endpoint, all in place and verified. See [docs/deploy.md](docs/deploy.md). The agent signs through a
Privy server wallet, so no private key exists on any machine of ours.

Still to build: HCS receipts.

A file-by-file walkthrough of the whole codebase is in [docs/CODEMAP.md](docs/CODEMAP.md).

Start with
[`docs/SESSION-01.md`](docs/SESSION-01.md) for what was verified and what was not; the individual
reports and their raw mirror-node evidence are in [`docs/spikes/`](docs/spikes/).

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

After a purchase, `npm run verify <holdId>` re-checks every commitment against the chain and
`npm run reputation` scores the provider it came from.

Set `ESCROW_ADDRESS` in `.env` from the deploy output. The escrow needs an operating float: it pays
every armed refund's execution gas from its own balance, and `openHold` refuses to open a hold it
could not afford to refund.

## AI use

Parts of this repo are agent-written. Per ETHGlobal's attribution requirement, the plan for each
work package is written to [`docs/plans/`](docs/plans/) and committed **before** the implementation
it describes, and each plan names the model and states what a human reviewed and changed.
