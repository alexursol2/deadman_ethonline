# Plan 09 — the adversarial tests

**Implementing agent:** Claude Opus 5 (Claude Code). **Requested by:** Alex, session 04 §4.
Committed before the tests it describes.

Section 1 (public deploy) is blocked on a hosting account and section 2 is gated behind it. Section 4
is not gated, and it is the work nobody has run. Starting here.

## The rule that shapes all of this

> Every test in section 4 must fail first against a deliberately broken version before it counts.

A test written by the person who wrote the code, against the code they wrote, tends to encode the
same assumption twice. The only way out is to prove each test can fail: break the guard, watch the
test go red, restore it, watch it go green. A guard nobody has ever seen fail is a guard nobody has
tested.

## How the mutants work

Four internal functions in `HoldEscrow` become `virtual`, and `contracts/test/Mutants.sol` subclasses
it with each guard individually removed:

| Mutant | Guard removed | The test that must catch it |
|---|---|---|
| `NoCasCheck` | `_transition` stops verifying the current status | claim and refund both pay |
| `IgnoresDeleteCode` | `_deleteSchedule` discards the response code | double payout on a refused delete |
| `PushOrRevert` | `_payOrCredit` reverts instead of crediting | `refund` strands the hold |
| `FlatReserve` | `_requiredReserveTinybar` ignores `openHoldCount` | the Nth refund is unfundable |

`virtual` on an internal function costs nothing at runtime and does not change the deployed
behaviour. It is a testing seam, and the alternative — copying 784 lines four times — would test
copies rather than the contract.

Each test runs the identical assertions against both the real contract and its mutant, and asserts
**red on the mutant, green on the real one**. A mutant that passes means the test proves nothing, and
that is itself a failure the suite reports.

## The tests

### 4.1 Claim and refund in the same second — the one that would embarrass us on stage

Carried since session 01 and never tested, because on a real network we cannot choose the ordering.
Locally we can: `evm_setAutomine(false)`, queue `claim` and `refund` into the **same block**, mine.

- Exactly one may pay. `amountTinybar` must reach 0 exactly once.
- The loser must revert on the CAS, not merely fail to transfer.
- Run it both orders — claim first, refund first — because the winner is whichever the block orders
  first and we do not get to pick.
- Against `NoCasCheck` both must pay, i.e. the hold pays out twice. If that mutant survives, the CAS
  is not what is protecting us.

### 4.2 A sweep must never reach an open hold

`free = balance − totalLocked − totalWithdrawable` is an attribution, not a lock.

- With a hold OPEN, `sweepReserve` of the full balance must revert.
- Against `FlatReserve`, a sweep that leaves armed refunds unfundable must be caught.
- **And the case Alex named specifically:** the window between settlement crediting the contract and
  `openHold` running. In that window a buyer's money is on the balance and attributed to nothing.
  `free` counts it. **I expect `sweepReserve` can take it, and if so that is a real finding, not a
  test to write around.** Test it, and if it confirms, fix the contract in the same session and say
  so plainly.

### 4.3 `refund` cannot revert after its state transition

Spike 8 established the schedule is spent by executing, so a revert here strands the hold forever.
Three hostile payers, all must land in the credit fallback with the hold REFUNDED:

- reverts immediately (cheap)
- consumes all the gas it is given
- a contract with neither `receive` nor `fallback`

Against `PushOrRevert` each must leave the hold OPEN with its schedule spent — the stranded state.

### 4.4 Double payout via a refused `deleteSchedule`

Spike 4: a rejected delete returns transaction SUCCESS and reports refusal only in the return code.

- Mock returns 7. Real contract: `claim` reverts, hold stays OPEN, refund still fires.
- `IgnoresDeleteCode`: `claim` succeeds and pays the payee, then the refund fires and pays the payer.
  **Assert the contract paid out twice** — that is the bug the guard exists for, demonstrated.

### 4.5 The capacity-saturation branch

No test. It has never run on a real network and the mock is the only coverage. The README says so
already; this plan re-checks the wording rather than adding coverage we do not have.

### 4.6 Reordering the seven-step server flow

Alex wants the `@x402/express` argument to be a test rather than a paragraph. Each reordering must
break something specific and named:

| Reordering | What breaks |
|---|---|
| settle before verify | we take money for a payment that would have failed validation |
| `openHold` before settle | `Underfunded` — the money is not there yet |
| respond before `openHold` | the buyer holds ciphertext with no armed refund |
| `claim` before responding | the key is public before the buyer has the ciphertext |

The first two are contract-level and testable directly. The last two are ordering properties of the
server and are asserted against the server's own flow.

## What this does not cover

Anything needing a real network: the same-second race as it would actually occur under consensus
ordering, and capacity saturation. Local block control is a faithful model of the CAS but it is not
Hedera's scheduler, and the write-up must say so rather than implying we raced the real thing.
