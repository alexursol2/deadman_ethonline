# Plan 06 — if a scheduled call's execution reverts, is the schedule consumed?

**Implementing agent:** Claude Opus 5 (Claude Code). **Requested by:** Alex, 2026-09-08.
Committed before implementation. Raised as [plan 04](04-holdescrow.md) §8.6 by
[spike 7](../spikes/07-delete-atomicity.md).

## The question

Plan 04 §Q4 rests on one sentence: *"the schedule is consumed by its execution, and there is no
second schedule."* That is why `refund()` must never revert after the CAS — a revert would leave the
hold stranded with nothing armed.

**It has never been measured.** Spike 7 established that a `deleteSchedule` unwinds with an ordinary
transaction, but said nothing about this: there the delete was in a normal transaction, not inside a
scheduled execution.

The two possible answers pull in opposite directions:

| If a reverting scheduled execution... | Then §Q4's no-revert rule is... |
|---|---|
| still counts as executed and the schedule is spent | **critical**, exactly as written. A reverting `refund()` strands the hold permanently. |
| leaves the schedule armed to retry | insurance against a state that cannot occur, and some of the machinery is dead weight |

Either way we should know which contract we are writing before we write it. This is the last
unmeasured assumption underneath the refund path.

## Method

Two schedules, armed within seconds of each other, both 90 s out.

- **S_revert** — a scheduled call to `alwaysReverts(bytes32)`, which does nothing but
  `revert DeliberateRevert()`.
- **S_ok** — a scheduled call to `ping(bytes32)`, the same target spikes 1 and 6 used.

**S_ok is the control and it is not optional.** Without it, "S_revert never executed" is
indistinguishable from "the network was not executing scheduled calls in that window at all" — a
stalled node, a congested second, a testnet hiccup. S_ok executing in the same window proves the
mechanism was working, so anything S_revert did or did not do is about the revert.

Sequence:

1. Read the contract's balance (tinybars) and `pingCount`.
2. Arm S_ok, then S_revert. Control-read both on the mirror: present, `deleted: false`,
   `executed_timestamp: null`.
3. Wait past both expiry seconds plus a margin.
4. Read both schedule records, polling on a predicate rather than once.
5. Read the contract's balance and `pingCount` again.
6. Keep watching S_revert for a further period, to see whether it retries later rather than never.

## What we are measuring

| Observation | Reading |
|---|---|
| `executed_timestamp` on S_revert | **present** → consumed despite reverting. **null** → not consumed. |
| `deleted` on S_revert | should stay `false`; a schedule is not "deleted" by executing |
| `pingCount` | must increment exactly once — S_ok ran, S_revert did not touch it |
| contract balance delta | did the contract pay gas for an execution that reverted? |
| the reverting execution's own record | if it exists on the mirror, its result should be `CONTRACT_REVERT_EXECUTED` |

The balance delta is worth having on its own: if the network charges the contract for failed
scheduled executions, an attacker who can make `refund()` revert can drain the operating balance one
hold at a time, which changes the §Q6 griefing analysis.

## Cleanup

If S_revert is still armed at the end it gets deleted, so nothing is left to fire into a later run.

## Outcomes

- **Consumed** (expected): plan 04 §Q4 stands unchanged, and it stops being an assumption. The
  no-revert-after-CAS rule gets a measured justification, which is what Igor needs to enforce it.
- **Not consumed**: §Q4 gets simpler and the `rescue()` backstop may be unnecessary. That would be a
  material simplification and it is worth thirty minutes to find out.
- Either way this is a HIP-1215 behaviour that is not documented, and it goes on the Tuesday list.
