# Plan 05 — is a successful `deleteSchedule` rolled back when the transaction reverts?

**Implementing agent:** Claude Opus 5 (Claude Code). **Requested by:** Alex, 2026-09-08.
Committed before implementation. Raised as §8.2 of [plan 04](04-holdescrow.md).

## The question

`claim()` does two irreversible-looking things in one transaction: it deletes the armed refund
schedule, and it pays the seller. If the payout reverts *after* the delete was accepted, does the
schedule come back?

Everything in EVM-land says yes — it is one transaction, and a revert unwinds it. But
`deleteSchedule` is not an EVM state change. It is a call into a Hedera system contract that mutates
**consensus-node state outside the EVM's storage model**, and nothing in HIP-1215 says whether that
mutation participates in EVM revert semantics.

If it does not, the failure is severe and silent: `claim` reverts, the caller sees a failed
transaction and assumes nothing happened, but the refund schedule is **gone**. The hold is `OPEN`
past its deadline with nothing armed. That is plan 04's §Q4 disaster reached through a door we did
not know was open.

## Why measure it when plan 04 already works around it

Plan 04 orders `claim` so that nothing can revert after the delete — the payout uses a bounded
stipend and credits on failure rather than reverting. That makes the answer *not matter* for the
happy path.

Two reasons to measure anyway:

1. **Defensive design around an unknown is not the same as knowing.** The ordering constraint is
   currently justified by "we are not sure", which is a weak reason for a rule Igor has to enforce in
   review. If the delete *is* atomic, the constraint relaxes and the contract gets simpler. If it is
   *not*, the constraint becomes a hard safety requirement with a measured reason behind it, and it
   belongs in the README as a warning to anyone else building on HIP-1215.
2. **It generalises past `claim`.** Any future path that deletes and then does more work — the
   optimistic-fraud-proof extension in the project roadmap re-arms a second schedule — inherits the
   same question.

Thirty minutes, and it converts a design assumption into a fact.

## Method

Add one function to the throwaway spike contract:

```solidity
function deleteThenRevert(address scheduleAddress) external {
    // delete, and require it was ACCEPTED
    if (code != 22) revert HssNotSuccess("deleteSchedule(address)", code);
    revert DeliberateRevert();          // now blow up the transaction
}
```

The two revert reasons are the measurement. Decoding the transaction's `error_message` tells us
which branch we reached:

- `DeliberateRevert()` — the delete returned 22 and was accepted before we reverted. **This is the
  case we want**; anything else means the test did not run.
- `HssNotSuccess(...)` — the delete was refused, and the run tells us nothing about atomicity.

Sequence:

1. Arm a schedule 600 s out.
2. **Control read** — confirm it exists, `deleted: false`, `executed_timestamp: null`. Without this
   a later "it is gone" is indistinguishable from "it was never created".
3. Call `deleteThenRevert`. Confirm the transaction failed **and** that it failed with
   `DeliberateRevert()`, not with the HSS error.
4. Poll the mirror for `deleted === true` over a full window, using the predicate poller — a single
   read here would repeat the session-01 staleness bug in the direction that flatters us.
5. **Positive control, and this is the part that makes the result mean something.** Whatever step 4
   says, call `tryCancelViaHss` on the same schedule for real:
   - If step 4 concluded *rolled back*, this must return **22** and actually delete it. That proves
     the schedule was still live and deletable, so "rolled back" is not a polite way of saying "our
     delete call never worked in the first place".
   - If step 4 concluded *not rolled back*, this must return something **other than 22** — the
     schedule is already gone.

Without step 5, a malformed delete call would produce "schedule still alive" and we would report
atomicity that we never tested.

## Outcomes

| Result | Meaning | Consequence for `HoldEscrow` |
|---|---|---|
| Schedule still alive, and step 5 deletes it with 22 | **Atomic.** The delete is rolled back with the transaction. | Plan 04's `claim` ordering constraint is a nice-to-have. Simpler contract available. |
| Schedule gone, step 5 returns non-22 | **Not atomic.** A system-contract effect survives an EVM revert. | The ordering constraint becomes a hard safety requirement. Goes in the README and to Hedera — it is a footgun for every HIP-1215 user. |
| Step 3 reverted with `HssNotSuccess` | Test did not run. | Fix and re-run; conclude nothing. |

Either way the result goes into plan 04 §8.2, the README limits, and Tuesday's Hedera list — an
undocumented interaction between system-contract effects and EVM revert semantics is worth an
engineer's attention regardless of which way it falls.

## Cleanup

If the schedule survives the whole test it gets deleted at the end, so nothing is left armed to fire
into a later run.
