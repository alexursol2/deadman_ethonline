# Session 01 — de-risking spikes

**2026-09-06.** Alex, with Claude Opus 5 (Claude Code) as implementing agent.
Branch `spike/hip-1215` → [PR #1](https://github.com/alexursol2/deadman_ethonline/pull/1).

**Purpose: verify three undocumented assumptions before building on them.** No features. No
`HoldEscrow.sol`. It ended up being five spikes, because two of the first three raised questions
that were cheaper to answer now than on Saturday.

---

## Headline

**All three original assumptions hold. The design does not change.**

| | Question | Verdict |
|---|---|---|
| Spike 1 | Does a scheduled call fire unattended on current testnet? | **YES** — executed 4 ms into its target second, `signatures: []` |
| Spike 2 | Can a contract cancel its own pending schedule? | **YES** — code 22, stayed dead past expiry |
| Spike 3 | Is the x402 facilitator alive? | **YES** — but the scaffold does not point at it |
| Spike 4 | Can a third party delete our schedule? | **NO** — all four attack cells refused |
| Spike 5 | Do the caveats survive scrutiny? | Four closed, three remain open and named |

The one-liner survives contact with the network:

> Every x402 escrow needs someone to push a button. Ours is the only one where the protocol pushes it.

---

## What each spike established

### Spike 1 — [`0.0.10395748`](https://hashscan.io/testnet/schedule/0.0.10395748) · [full report](spikes/01-scheduled-call.md)

`executed_timestamp` present, `signatures: []`, `wait_for_expiry: true`, `pingCount == 1`. All four,
no partial credit. Executed **4 ms** into its target second with no transaction from anyone.

Two answers we did not have going in:

- **The network executes a scheduled call as the scheduling contract itself.** `msg.sender` is the
  contract's own address, so `refund()` can be gated on `msg.sender == address(this)`.
- **`block.prevrandao` and the `0x169` PRNG return identical values on Hedera.** Both usable. The
  HIP's reference pattern and Hedera's documented PRNG are two names for one thing, so `HoldEscrow`
  should read `prevrandao` and skip the system-contract call.

Also: `block.timestamp` inside a scheduled execution is the enclosing block's consensus time, not
the expiry second. Deadlines must travel in the calldata.

### Spike 2 — [`0.0.10395764`](https://hashscan.io/testnet/schedule/0.0.10395764) · [full report](spikes/02-self-cancel.md)

Cancelled by the contract that armed it. Code 22, `deleted: true`, and 60 s past expiry:
`executed_timestamp` still null, `pingCount` unchanged. Risk #2 from the brief does not materialise.

The control read before cancelling is what makes it mean anything — without it, "never executed" is
indistinguishable from "never created".

### Spike 3 — [full report](spikes/03-facilitator.md)

Blocky402 is up: `200` on `/supported`, advertises `hedera:testnet` scheme `exact` with fee payer
`0.0.7162784`; `/verify`, `/settle` and `/health` all present.

**The finding is the scaffold, not the facilitator.** The `x402-pay-per-use` template defaults to a
**self-hosted** facilitator on `localhost:4020`. Blocky402 appears once in the whole template, in
`RUNBOOK.md`, as an optional fallback. Following the template's happy path settles through our own
facilitator and **fails the track gate with every test passing and nothing erroring**.

One variable fixes it — `FACILITATOR_URL=https://api.testnet.blocky402.com` in
`packages/nextjs/.env`. It goes on the integration checklist as a **gate check**, and the paid-request
milestone does not count as met unless the settle transaction shows fee payer `0.0.7162784` on
HashScan.

### Spike 4 — [`0.0.10396004`](https://hashscan.io/testnet/schedule/0.0.10396004) · [full report](spikes/04-third-party-delete.md)

Four attack cells — unrelated EOA and unrelated contract, both delete paths — all refused with
`INVALID_SIGNATURE`. Then the owner contract deleted the same schedule on its first try, proving the
refusals were about *who was asking*.

**The sharper finding: a rejected delete is a silent no-op.** Transaction status SUCCESS, no revert;
the refusal exists only in the return code. A contract that discards it believes it cancelled a
refund that is still armed — seller gets paid, refund fires anyway, **the hold pays out twice**.
Hedera's own `payments-scheduler` template contains both the checked and the unchecked pattern in
one file.

### Spike 5 — [full report](spikes/05-caveat-closure.md)

- **5a** — the owner contract can also cancel via the redirect path `0xc61dea85`. Code 22. Both
  delete paths now exercised.
- **5b** — the **deploying EOA cannot** delete its own contract's schedule. `INVALID_SIGNATURE` on
  both paths. Worth saying in the pitch: once a hold is open, *we* cannot cancel the buyer's refund
  either. There is no operator override to be compelled into using.
- **5c** — the schedule's `admin_key`, decoded from the mirror record, is `ContractID 0.0.10395953`
  — the creating contract. Evidence, not inference. `payer_account_id` is also the contract, which
  is the on-chain confirmation of the brief's failure mode 3.

---

## Bugs found in our own work, and what they cost

Four, all found by the network rather than by review. Each is committed with its reproduction script.

**1. `address(this).balance` is in tinybars, not weibars.** First `arm()` reverted
`InsufficientBalance(2000000000, 5000000000000000000)` on a contract holding 20 HBAR. Inside the EVM
it is 1e8/HBAR; over `eth_getBalance` it is 1e18/HBAR. Solidity's `ether` literal is 1e18, so
`balance >= 5 ether` in a Hedera contract can never pass. Reproduction: `scripts/units-probe.cjs`.

It failed loudly, which was luck — the mirror image passes trivially and puts an underfunded
contract into the demo with the refund silently not firing.

**2. `scheduleCall` needs ~1.45M gas of its own, and it does revert.** Second `arm()` burned
1,480,769 of 1,500,000 and reverted with *empty returndata*. Binary search puts the floor between
1,445,312 and 1,468,750, independent of the gas requested for the scheduled call. EIP-150 forwards
only 63/64, so 1.5M hands the precompile ~1.457M — we missed by about one percent. The HIP's "never
reverts" covers business failures only. Reproduction: `scripts/gas-probe.cjs`.

**Consequence: `openHold` cannot be a cheap transaction.**

**3. Activating a fresh Hedera account needs ~2M gas.** A transfer to an address Hedera has never
seen also creates it. At 300k it reverted having burned the lot, no reason string. This is exactly
the Privy gotcha in the brief — the alias-activation transfer will fail the same way with a default
gas limit.

**4. Our mirror-node backoff only retried on HTTP errors.** Amendment 3 asked for protection against
eventual consistency; I implemented half of it. A `200` carrying stale data slipped straight through
and recorded a *successful* delete as a failure. Fixed with `mirrorGetUntil(path, predicate)`, which
polls on a condition rather than a status code. **Spike 4 was re-run against the fixed harness**,
because there the staleness biased toward a false PASS on a security test.

---

## Review amendments, and how each landed

Alex reviewed the plan before implementation and returned five amendments. All five are recorded
verbatim in [`plans/01-spikes.md`](plans/01-spikes.md) §A.

| | Amendment | Outcome |
|---|---|---|
| 1 | Do not assume `prevrandao`; probe `0x169` too | Both probed, both usable, **identical values** |
| 2 | Skip `% 60` and `% 3600` boundaries, not `% 10` | `% 60` kept; `% 3600` removed as dead — it is a strict subset and never fires |
| 3 | Mirror is eventually consistent; retry with backoff | Right call, and my first implementation was incomplete — see bug 4 |
| 4 | Verify selectors against the HIP as step zero | Done first; found the second delete path and the `scheduleCallWithPayer` trap |
| 5 | Say the jitter fallback is untested; do not claim it | Carried into the report, the JSON evidence and the README |

Amendment 4 paid for itself immediately. Reading HIP-1215 properly surfaced the redirect
`deleteSchedule()` (`0xc61dea85`), which turned Spike 2 from a yes/no into a matrix, and
`scheduleCallWithPayer`, which we must **not** use because it requires a payer signature and would
quietly falsify the one-liner.

Amendment 3 was the most valuable of the five. It was also the one I under-implemented, and it was
the only amendment whose absence would have produced a *wrong recorded result* rather than a missing
one.

---

## Still open, and honest about it

| Gap | Why it is still open |
|---|---|
| **The jitter fallback has never executed** | Testnet is uncongested; `probesUsed` was 0 on every run. Untested code on the critical path. Needs a mocked HSS — Igor, Wednesday. |
| **Claim/refund in the same second** | A `HoldEscrow` concern, not a spike. Belongs in the adversarial tests. |
| **One observation each, uncongested testnet** | Open by nature. Rehearse the demo cold three times. |
| **`value` in tinybars is inferred** | Both spikes passed zero. A weibar amount cannot fit in `uint64`, so tinybars is near-certain — but it is reasoning, not a measurement, and `refund()` moves real money. Pin it before Wednesday. |

All four are in the README's "Limits we are not hiding".

---

## Repo state

16+ commits, small and logical. Plans committed **before** the implementation they describe, per the
organisers' AI-attribution requirement — [`plans/01-spikes.md`](plans/01-spikes.md),
[`plans/02-third-party-delete.md`](plans/02-third-party-delete.md),
[`plans/03-close-caveats.md`](plans/03-close-caveats.md).

```
contracts/contracts/   SpikeSchedule.sol, Attacker.sol
contracts/scripts/     verify-selectors, deploy, spike1-arm, spike1-verify, spike2,
                       spike2-confirm, spike4-third-party-delete, spike5-close-caveats,
                       units-probe, gas-probe, diag-hss, lib
docs/spikes/           five reports + raw mirror JSON for every claim above
```

Every number in every report has a committed JSON file behind it and a HashScan link.

**Not started, as instructed:** `HoldEscrow.sol`, `/server`, `/agent`, `/web`.

---

## For Tuesday's Hedera feedback session

Four things worth a Hedera engineer's attention, in order:

1. **A rejected `deleteSchedule` returns transaction SUCCESS.** The refusal is only in the return
   code, and the official `payments-scheduler` template ships a helper that discards it *and* clears
   its own bookkeeping regardless.
2. **`scheduleCall` reverts with empty returndata when starved of gas**, which contradicts how the
   HIP's "never reverts" reads, and the floor is ~1.45M gas.
3. **The delete authorisation model is undocumented.** We established it empirically — admin key is
   the creating contract's ContractID. It should be in the HIP.
4. **`hasScheduleCapacity(now + 1)` returns false**, though the HIP states a one-second minimum.
   `false` means "invalid expiry" and "saturated" indistinguishably.

And one question for Luke: is the jitter fallback exercisable against testnet at all, or is a mocked
HSS the only way we will ever test it before mainnet?
