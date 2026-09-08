# The adversarial suite — and the bug it found

**53 tests passing. One real vulnerability found and fixed. One claim I was about to make that turned
out to be false.** 2026-09-08, plan 09.

Every guard is tested twice: once against a mutant from `contracts/test/Mutants.sol` with that guard
removed, where the attack **must succeed**, and once against the real contract, where it **must
fail**. A mutant that survives is reported as a failure of the test, not a pass of the code.

That discipline earned its keep twice in one session.

---

## The vulnerability: a sweep could take a buyer's settled payment

`free = balance − totalLocked − totalWithdrawable` is an **attribution, not a lock**. Alex named the
window in the brief and the test confirmed it:

```
it("THE WINDOW: settled-but-unarmed funds are sweepable")   ← passed, i.e. the attack worked
```

An x402 settlement arrives as a HAPI `CryptoTransfer`, which credits the contract **without running
its code** (C12). So between settlement and `openHold`, a buyer's money sits on the balance
attributed to nothing — and `free` counted it, so `sweepReserve` could take it. The owner could
empty a buyer's payment out of that window, deliberately or by accident.

### The fix

Track deliberate deposits separately. `operatingFloatTinybar` increases only in `fund()` and
`receive()` — both of which require code execution — and `sweepReserve` may never exceed it. Money
that arrived without executing code is not sweepable at any price; the only way it leaves is
`attributeOrphanedPayment`, which credits the **payer**.

```
it("settled-but-unarmed funds CANNOT be swept")                       → ExceedsOperatingFloat
it("a sweep cannot exceed the deliberate float even when the balance is large")
it("the orphan path, not the sweep, is how settled-but-unarmed money gets out")
```

### The second bug, inside the fix

Verifying on testnet showed the float had drifted **above** the balance:

```
balance         2,494,993,684
operatingFloat  2,500,000,000
```

The contract pays scheduled-refund gas from its own balance (C6) and cannot observe that spend, so
the float only ever grows while the balance shrinks. An overstated float re-opens the exact hole the
float was added to close: after enough refunds, a sweep could reach a settled payment again, up to
the gas already spent.

`_reconcileFloat()` clamps the float down to `free`. It can only ever lower it, so it cannot create
sweeping room. It runs at the end of `openHold` — where the just-settled payment has already moved
into `totalLocked`, making `free` a tight figure — and again before any sweep.

**Residual, stated rather than hidden:** if a settlement is sitting unarmed at the moment of the
clamp, `free` still counts it and the clamp is loose by that much. Bounded by unattributed settled
money, which the orphan path exists to handle.

---

## The claim that was false

The test was written to assert *"the compare-and-set is what stops a double payout"*. Against
`NoCasCheck` — the CAS removed — the contract **still paid out only once**.

Two other guards catch it independently: the second entry reads `amountTinybar` as `0` and pays
nothing, and `openHoldCount -= 1` underflows and reverts. So the sentence the test was going to
justify is not true on its own.

`NoCasNoZero` removes both, and only then does one hold pay twice. Both mutants are kept:

| Mutant | Result |
|---|---|
| `NoCasCheck` — CAS removed | still pays **once** — defence in depth |
| `NoCasNoZero` — CAS *and* zeroing removed | pays **twice** — the real double payout |
| real contract | pays **once**, loser reverts |

Had the test been written to confirm rather than to break, it would have gone green and the repo
would carry a claim about the CAS that overstates what the CAS does. That is the whole argument for
the mutation rule.

Extracting `_consume()` — the four lines that zero the amount and drop both running totals — was
needed to give the mutant a seam, and it also collapsed three identical copies in `claim`, `refund`
and `rescue` into one.

---

## What the suite covers

| § | Test | Mutant it must beat |
|---|---|---|
| 4.1 | claim and refund in the **same block**, both orders | `NoCasCheck`, `NoCasNoZero` |
| 4.2 | a sweep cannot touch an open hold, a settled payment, or the scaled reserve | `FlatReserve` |
| 4.3 | `refund` credits instead of reverting for three hostile payers | `PushOrRevert` |
| 4.4 | a refused `deleteSchedule` cannot produce a double payout | `IgnoresDeleteCode` |
| 4.6 | `openHold` before settlement is refused; funds cannot back two holds | — |

The three hostile payers in 4.3 are: reverts immediately, consumes all its gas, and a contract with
neither `receive` nor `fallback`. All three land in the credit fallback with the hold `REFUNDED`;
against `PushOrRevert` all three leave it stranded `OPEN`.

## What it does not cover, and will not claim to

**4.1 is not a race against Hedera's scheduler.** It uses Hardhat's block control to put both
transactions in one block, which is a faithful test of the compare-and-set and nothing more. On a
real network consensus ordering decides the winner, and we cannot force that collision.

**4.5, the capacity-saturation branch, has still never run on a real network.** Testnet is
uncongested; the mock is the only coverage. Unchanged, and the README already says so.

---

## Redeployed

The fix required a new deployment. The live escrow is now
**`0x1f928BF2261979A818Ade961f3b6d8aC1AAbe860`** = **`0.0.10426758`**, seller re-allowlisted, and the
full settle → `openHold` → unattended refund verified against it: hold 1, schedule
[`0.0.10426770`](https://hashscan.io/testnet/schedule/0.0.10426770), executed `1788897169.005366766`
with `signatures: []`, buyer exactly whole.

The previous escrow `0xc5241034…` carries the sweep vulnerability and must not be used.
