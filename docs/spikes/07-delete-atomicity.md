# Spike 7 — is a successful `deleteSchedule` rolled back when the transaction reverts?

**Verdict: YES. It is atomic. The deletion is rolled back with the transaction.** Run 2026-09-08.

| | |
|---|---|
| Schedule | **[`0.0.10418012`](https://hashscan.io/testnet/schedule/0.0.10418012)** |
| Contract | `0xb0658012ee9dACD62BBEc5A11060B5Ff4674f29e` |
| `deleteThenRevert` tx | [`0x68d96af6…8183ea`](https://hashscan.io/testnet/transaction/0x68d96af698be9d2ddea823f6c2756294d4827f27658b6ef3c24f9dbbc68183ea) |
| Transaction result | `CONTRACT_REVERT_EXECUTED` |
| Revert reason | `0x84921ad7` = **`DeliberateRevert()`** |

## Why the revert reason is the measurement

`deleteThenRevert` deletes the schedule, **requires the delete returned 22**, and only then reverts
on purpose. So the error selector tells us which branch we reached:

- `0x84921ad7` `DeliberateRevert()` — the delete was **accepted**, and we then blew up the
  transaction. This is the case we needed.
- `0xe9aa2cd2` `HssNotSuccess(...)` — the delete was refused and the run would prove nothing.

We got `DeliberateRevert()`. The delete succeeded before the revert.

## Result

```
delete returned 22, transaction then reverted
poll mirror 17.5s   ->  deleted = false     <- the schedule is still there
positive control    ->  code 22, deleted = true
```

After the reverted transaction, the schedule was **still alive**. Deleting it again for real then
returned `22` and it went away.

**That second delete is the load-bearing part of the test.** Without it, "the schedule is still
alive" would be equally consistent with "our delete call was malformed and never worked at all", and
we would have reported atomicity we never actually tested. The schedule was genuinely deletable; the
first deletion was genuinely undone.

Evidence: [`spike7-result.json`](spike7-result.json), [`spike7-schedule.json`](spike7-schedule.json).

## What this means

**HIP-1215 system-contract effects participate in EVM revert semantics.** A `deleteSchedule` is not
a side effect that escapes the transaction; it unwinds like an `SSTORE`. The EVM intuition was
correct — and it was worth thirty minutes to stop calling it an intuition.

### For `HoldEscrow.claim()` — the constraint relaxes

[Plan 04 §Q5](../plans/04-holdescrow.md) ordered `claim` so that nothing revertible could follow the
delete, justified by "we are not sure what happens if something does". We are now sure. If the payout
to the seller reverts, the whole transaction unwinds, the schedule comes back, and the hold returns
to `OPEN` with its refund still armed. That is a safe landing: the seller can retry, or the refund
fires and the buyer is made whole.

So the constraint is no longer load-bearing on the claim path. It stays in the plan as a
recommendation rather than a requirement, and Igor gets the choice — **see the recommendation below.**

### For `HoldEscrow.refund()` — the constraint stands, and for a different reason

The asymmetry matters and it survives this result. `refund()` is executed **by the schedule itself**.
By the time its body runs, the schedule has already fired. A revert inside `refund()` unwinds the
EVM work, but it cannot un-fire the execution that invoked it. There is no schedule left to come
back to.

So **`refund()` must still never revert after the CAS**, and that rule keeps its full force. Spike 7
changes nothing about it.

## Recommendation for plan 04

Keep credit-on-failure on **both** payout paths, and downgrade the claim-path ordering rule from a
safety requirement to a preference. Reasoning:

- On `refund()` it is mandatory and unchanged.
- On `claim()` it is now optional, but it costs one branch and it means a seller whose payout address
  misbehaves still ends up with their money rather than watching the refund fire. Reverting the claim
  is *safe*; crediting is *kinder*, and the code is already there.
- Having both paths shaped identically is easier for Igor to review than two payout idioms with a
  subtle justification for the difference.

**Against:** a `claim` that cannot fail is a `claim` that reports success to a seller whose money is
sitting in `withdrawable` rather than in their wallet. If we prefer loud failure on that path, revert
instead — the atomicity result makes that choice available now, which it was not yesterday.

## The question this one raises

**If a scheduled call's execution reverts, is the schedule consumed anyway?**

Plan 04 §Q4 assumes yes — that a reverting `refund()` leaves the schedule fired and the hold
stranded, which is why the no-revert rule exists. That assumption has not been measured, and spike 7
does not test it: here the delete happened in an ordinary transaction, not inside a scheduled
execution.

The two possible answers point in different directions. If a reverting scheduled execution still
counts as executed, §Q4's rule is critical exactly as written. If instead the schedule survives to
retry, some of §Q4's machinery is insurance against a state that cannot occur.

Cheap to test — schedule a call to a function that always reverts, then read `executed_timestamp` —
and it is the last unmeasured assumption underneath the refund path. Proposed as spike 8, and it
should run before `refund()` is written.

## For Tuesday

Worth telling Hedera that this is undocumented. HIP-1215 says nothing about how system-contract
effects interact with EVM revert semantics, and a builder who guesses the other way will write a
`claim` that strands funds. The answer is the reassuring one, which makes it cheap to document and
easy to overlook.
