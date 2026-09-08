# Plan 04 — `HoldEscrow.sol`

**Implementing agent:** Claude Opus 5 (Claude Code). **For review by:** Igor, 2026-09-08.
**Status:** DRAFT FOR REVIEW. No contract code is written until this is reviewed.
Committed before implementation, per the ETHGlobal AI-attribution requirement.

Every constraint below is measured on Hedera testnet, not assumed. Links go to the spike report and
the committed mirror-node JSON behind each claim.

---

## 0. What this contract is

A hold that arms its own refund.

> **CORRECTED 2026-09-08 by [spike 9](../spikes/09-settlement-atomicity.md).** This section
> originally said the payment settles *into* `openHold` in the same transaction. It cannot.
> `@x402/hedera` settles with a `TransferTransaction` and the facilitator rejects anything else by
> name; a HAPI transfer to a contract credits its balance **without running `receive()`**, measured.
> The x402 `payTo` is the escrow, so the money still never touches the seller — but the refund is
> armed by a **second transaction**, not the settling one. `openHold` is therefore **not payable**
> and attributes already-credited funds. The refund itself is unchanged and still keeper-free.

The x402 `payTo` is the escrow's account, so settlement credits the escrow directly. The server then
calls `openHold`, which books a HIP-1215 scheduled call to `refund()` at `deadline` against those
funds. The seller reveals the key to `claim()`, which pays them and deletes the schedule. If the
seller does nothing, nobody does anything, and the network executes the refund.

**The seller cannot be paid without a hold existing** — `claim()` is the only path to the payee — so
a server that settles and skips `openHold` gets nothing, and the funds stay in the escrow out of its
reach. That is what makes the settle-then-arm window tolerable rather than fatal.

```
openHold(payer, payee, commitments, deadline)  payable
  ├─ solvency assert
  ├─ store hold as OPEN
  └─ 0x16b.scheduleCall(this, deadline, REFUND_GAS, 0, refund(holdId, deadline))

claim(holdId, k)                     refund(holdId, deadline)      <- network only
  ├─ CAS OPEN -> CLAIMED             ├─ CAS OPEN -> REFUNDED
  ├─ keccak256(k) == hKey            ├─ pay payer, credit on failure
  ├─ deleteSchedule, REQUIRE 22      └─ emit
  └─ pay payee, credit on failure
```

**Not in scope for this contract:** the four-commitment verification beyond `H(k)` (it is off-chain,
in `verify.ts`), HCS receipts (separate, hooks onto the events), and anything about correctness of
the delivered content. We guarantee delivery, not correctness, and the README says so first.

---

## 1. Constraints the spikes established

| # | Constraint | Evidence |
|---|---|---|
| C1 | A network-executed call arrives with `msg.sender == the scheduling contract`, even when the target is a different contract | [spike 1](../spikes/01-scheduled-call.md), [spike 6](../spikes/06-value-units.md) |
| C2 | `block.timestamp` inside a scheduled execution is the enclosing block's consensus time, **not** the expiry second | [spike 1](../spikes/01-scheduled-call.md) |
| C3 | A rejected `deleteSchedule` is a **silent no-op** — transaction status SUCCESS, refusal only in the return code | [spike 4](../spikes/04-third-party-delete.md) |
| C4 | `scheduleCall` needs ~1.45M gas of its own; EIP-150 forwards 63/64, so the transaction needs ~1.49M+ before anything else | [spike 1](../spikes/01-scheduled-call.md), [gas-probe.json](../spikes/gas-probe.json) |
| C5 | Everything inside the EVM is **tinybars** (1e8/HBAR): `balance`, `msg.value`, `scheduleCall`'s `value`. Never the `ether` literal | [spike 6](../spikes/06-value-units.md) |
| C6 | The contract pays execution gas from its own balance; `payer_account_id` on the schedule record is the contract | [spike 5c](../spikes/05-caveat-closure.md) |
| C7 | Only the creating contract may delete its schedule; `admin_key` is its ContractID. Not a stranger, not the deployer | [spike 4](../spikes/04-third-party-delete.md), [spike 5b](../spikes/05-caveat-closure.md) |
| C8 | A value-carrying scheduled call consumed ~132,000 gas; the network charges gas **used**, not the limit requested | [spike 6](../spikes/06-value-units.md) |
| C9 | `hasScheduleCapacity` returns false for an invalid expiry as well as a saturated one — the two are indistinguishable | [spike 1](../spikes/01-scheduled-call.md) |

C7 is why this design works at all: nobody can cancel a buyer's refund, including us.

---

## 2. Data model

```solidity
enum Status { NONE, OPEN, CLAIMED, REFUNDED }   // NONE = 0, so a fresh slot is NONE

struct Hold {
    Status  status;          //  1 byte   ─┐
    uint64  deadline;        //  8 bytes   │ one slot
    uint64  amountTinybar;   //  8 bytes   │ C5. uint64 holds 184e9 HBAR, supply is 50e9
    address payee;           // 20 bytes  ─┘ ...  37 bytes, does not fit. See note.
    address payer;
    address scheduleAddress; // returned by scheduleCall; needed by deleteSchedule
    bytes32 hKey;            // the only commitment checked on-chain
    bytes32 hCipher;         // H(C)        stored, never checked here
    bytes32 hPlain;          // H(m)        stored, never checked here
    bytes32 hRequest;        // H(request)  stored; also the replay key
}
```

**Slot note for review:** `status + deadline + amountTinybar + payee` is 37 bytes and does not fit
one 32-byte slot. Options: drop `deadline` to `uint40` (good to year 36812) giving 1+5+8+20 = 34,
still over; or move `payee` to its own slot and pack `status + deadline + amountTinybar` (17 bytes)
together. **Recommendation: pack `status/deadline/amountTinybar` in slot 0, `payer` and `payee` in
their own slots.** The refund path touches `status`, `amountTinybar` and `payer`, so this costs two
warm SLOADs on the hot path, which is the cheap direction.

Storing three commitments the contract never reads costs 3 × 20,000 gas at `openHold`. That is
deliberate and it is the point of the design — they are the buyer's evidence. Alternative is to emit
them in the event only, which is ~10x cheaper and still on-chain in the log. **Open decision, §9.1.**

```solidity
uint256 public nextHoldId;                        // monotonic, so a fresh id is always NONE
mapping(uint256 => Hold) public holds;
mapping(bytes32 => uint256) public holdByRequest;  // H(request) -> holdId, replay block
mapping(address => uint256) public withdrawable;   // tinybars, pull-payment fallback
uint256 public totalLockedTinybar;                 // sum of OPEN hold amounts
uint256 public totalWithdrawableTinybar;           // sum of credited-but-unclaimed
```

---

## 3. Answers to the seven questions

### Q1 — The state machine. How is a second transition impossible, not merely unlikely?

**One compare-and-set, in one place, before any external interaction.**

```solidity
function _transition(uint256 holdId, Status from, Status to) internal returns (Hold storage h) {
    h = holds[holdId];
    if (h.status != from) revert BadState(holdId, h.status, from);
    h.status = to;                    // written BEFORE any external call
}
```

Both `claim` and `refund` begin with this and nothing else touches `status`. Four properties make a
second transition impossible rather than unlikely:

1. **No function writes `OPEN` except `openHold`,** and `openHold` only ever writes to
   `holds[nextHoldId++]`, a slot that is `NONE` by construction. There is no path back to `OPEN`, so
   `CLAIMED` and `REFUNDED` are terminal in the type, not by convention.
2. **The status write precedes every external call.** A reentrant call re-reads `status` and fails
   the CAS. This is what makes it structural rather than a race we hope to win.
3. **`amountTinybar` is zeroed in the same block as the status write**, so even a hypothetical
   second transition would transfer zero.
4. **`holdId` is monotonic**, not a hash of caller-supplied data. There is no collision argument to
   get wrong, and no way to address a hold into existence.

The invariant Igor should try to break: *for any `holdId`, the sum of value paid out over the
contract's lifetime is exactly `amountTinybar` once and never twice or zero.*

`holdByRequest` blocks the separate replay in the brief's table — a seller reusing an old result for
a new request. `openHold` requires `holdByRequest[hRequest] == 0`.

### Q2 — `claim` and `refund` in the same second. Which wins, and what enforces it?

**They cannot actually be simultaneous, and the network arbitrates. `deleteSchedule`'s return code
is the tie-breaker.**

Hedera gives every transaction a consensus timestamp with nanosecond resolution — spike 1's schedule
executed at `1788719349.003729824`. Two transactions in the same *second* are still strictly
ordered. So there is always a first and a second, and the CAS in Q1 makes the second fail. "Same
second" is not the same as "same instant".

Which one is first is not ours to choose, and the design deliberately does not try:

- **Refund executes first.** Status becomes `REFUNDED`, buyer is paid. A `claim` arriving after
  reverts at the CAS. The seller revealed too late and gets nothing — the intended outcome.
- **Claim executes first.** Status becomes `CLAIMED`; `claim` then calls `deleteSchedule` and
  **requires code 22**. If the delete is accepted, the refund will never fire and the seller is paid.
- **Claim executes first but the delete is refused** — the schedule is already executing or
  otherwise past deletion. `claim` **reverts the whole transaction**, including the status write. The
  refund then fires normally and the buyer is refunded.

That third case is why C3 is load-bearing. If `claim` discarded the return code it would report
success, pay the seller, and the refund would fire anyway: **the hold pays out twice.** Hedera's own
`payments-scheduler` template ships a helper that discards exactly this code.

**Deliberate non-decision:** `claim` does **not** check `block.timestamp < deadline`. A local
timestamp check could disagree with the network's own view of whether the schedule is still
deletable, and then we would have two arbiters instead of one. The schedule's deletability *is* the
deadline. **Recommendation: no timestamp gate on `claim`.** Flagged for Igor because it looks like a
missing check and is not one.

**This depends on an unverified assumption — see §8, spike 7.** If a successful `deleteSchedule` is
*not* rolled back when the enclosing transaction later reverts, the ordering in `claim` matters
enormously. The ordering in §3-Q5 is chosen so that nothing can revert after the delete, which makes
the answer safe either way, but the assumption should still be measured.

### Q3 — `openHold` succeeds but `scheduleCall` fails. Everything must revert.

**It does, because the whole thing is one transaction and nothing catches the failure.**

```solidity
(int64 code, address scheduleAddress) = _scheduleRefund(holdId, deadline);
if (code != 22) revert ScheduleFailed(code);
if (scheduleAddress == address(0)) revert ScheduleReturnedZero(code);
```

Both halves asserted, because a saturated second returns a **zero address with a non-22 code and no
revert** — it would otherwise sail straight through. Rules for the implementation:

- **No `try`/`catch` anywhere near the schedule call.** There is no failure here worth continuing
  past. Funds held with no armed refund is the worst state in the system, and it is worth failing the
  buyer's payment to avoid.
- **No `if (ok) {...}` without an `else revert`.** Same trap in a different shape.
- If `_findAvailableSecond` exhausts its probes, it reverts. Per the brief's own table: a fallback
  slot is found, **or the hold never opens**.
- The schedule call is the **last** thing `openHold` does, after all storage writes, so a revert
  cannot leave partial state even under an unexpected re-entry.

Because `openHold` is called in the same transaction as the x402 settlement, a revert here unwinds
the settlement too and the buyer's money never moves. That atomicity is the whole reason the
settlement must call `openHold` rather than merely transferring to it — **see §8, the integration
risk.**

### Q4 — The refund fires but paying the payer reverts. Money stuck forever.

The schedule is consumed by its execution. There is no second schedule. If `refund()` reverts, the
hold is stranded with no armed refund — strictly worse than any other failure in the system.

**The governing rule: `refund()` must not be able to revert after the status transition.**

Three defences, in order:

**(a) Bounded-gas push, credit on failure.** Not a `transfer`, not a bare `call`:

```solidity
(bool ok, ) = payer.call{ value: amount, gas: PAYOUT_STIPEND }("");
if (!ok) {
    withdrawable[payer] += amount;          // pull fallback
    totalWithdrawableTinybar += amount;
    emit PayoutDeferred(holdId, payer, amount);
}
```

`PAYOUT_STIPEND` is bounded (recommend **30,000**) precisely so a hostile or expensive `receive()`
cannot consume the scheduled call's whole gas budget. If it could, the scheduled execution would run
out of gas, revert wholesale, and strand the hold — the bounded stipend is what guarantees we still
have gas left to take the fallback branch and emit.

The pitch survives this. In the normal case the money reaches the buyer with nobody acting. Only when
the buyer's own address refuses payment does collecting become their job, and that is the buyer's
choice of wallet, not a keeper we introduced. **The README must say this** — it is a real, if narrow,
"someone must act" case and hiding it is exactly what the brief forbids.

**(b) No `require` after the CAS.** Every check that can fail happens before the status write. After
it, only arithmetic, a bounded call, and events.

**(c) `rescue(holdId)` — defence in depth.** If a refund execution reverts wholesale anyway (an
out-of-gas we mis-budgeted, a services change), the hold sits `OPEN` past its deadline with no
schedule. `rescue` is callable **by anyone** after `deadline + RESCUE_GRACE` (recommend **24 hours**)
and does exactly what `refund` would have: transition to `REFUNDED` and credit `withdrawable[payer]`.
It never pushes, so it cannot fail for the same reason.

This *is* a "someone must act" path and it must be disclosed. It is a backstop for a state that
should be unreachable, not part of the mechanism — and a stuck hold is worse than an honestly
documented backstop. **Open for Igor: is `rescue` worth the pitch cost?** Recommendation: yes,
include and disclose. Alternative considered and rejected: arming a second, later schedule as the
backstop, which doubles gas cost on every hold to insure against a state we have never observed.

### Q5 — Reentrancy on both payout paths.

Four layers, because one is not enough on a contract holding other people's money:

1. **Checks-Effects-Interactions, strictly.** Status transition, `amountTinybar = 0`,
   `totalLockedTinybar -= amount`, all before any external call. A reentrant `claim` or `refund`
   re-reads `status`, fails the CAS in Q1, and reverts.
2. **`nonReentrant` on `openHold`, `claim`, `refund`, `withdraw`, `rescue`.** Cheap, and it stops
   cross-function reentry (payout → `openHold`) that CEI alone does not address. Note `refund` is
   entered with `msg.sender == address(this)`, which is *not* reentrancy — it is a separate
   transaction — so the guard must be a plain mutex, not a self-call check.
3. **Bounded gas stipend on every push.** 30,000 leaves an attacker too little to do anything
   interesting even if the first two layers failed.
4. **`withdraw()` is CEI too:** zero the balance, then push with the same bounded stipend, and revert
   if it fails — here a revert is safe, because nothing has been consumed.

**Ordering inside `claim`, which matters more than the guards:**

```
1. CAS OPEN -> CLAIMED
2. require keccak256(abi.encodePacked(k)) == hKey
3. zero amount, decrement totalLocked
4. deleteSchedule -> require code == 22            <- can still revert; nothing consumed yet
5. pay payee, bounded stipend, credit on failure   <- CANNOT revert
6. emit Claimed(holdId, k)
```

Step 4 before step 5 is deliberate. If the payout could revert *after* a successful delete, and if
Hedera does not roll a system-contract effect back on revert (**unverified — §8**), the schedule
would be gone and the hold stranded. Putting the only non-revertible operation last removes the
question. The event in step 6 carrying `k` is how the buyer decrypts **without acting**.

### Q6 — Who may call `openHold`, and what stops gas-balance draining?

The attack is real and it targets the core guarantee: the contract pays every scheduled refund's gas
from its own balance (C6). An attacker opens many small holds, each arming a schedule the contract
must fund at execution, drains the balance, and then **legitimate refunds silently do not fire** —
the brief's failure mode 3, weaponised.

**Mechanism: every hold pays for its own refund up front.**

```solidity
require(msg.value_tinybar >= amountTinybar + refundGasDepositTinybar, Underfunded);
require(amountTinybar >= minHoldTinybar, DustHold);
```

`refundGasDeposit` is calibrated from measurement, not guessed: spike 6 observed a value-carrying
scheduled execution cost **0.1389 HBAR**. Recommend **0.5 HBAR** (`50_000_000` tinybar) — roughly 3.5x
headroom for a heavier `refund()` and gas-price movement. Owner-settable with a floor, because the
gas schedule is not ours to control.

Opening a hold then costs the attacker at least `minHold + 0.5 HBAR` and costs us nothing. The
economics invert.

**Solvency invariant, asserted at the end of `openHold`** — this is the minimum-balance assert done
properly, as a solvency check rather than a fixed floor:

```solidity
require(
    address(this).balance >= totalLockedTinybar + totalWithdrawableTinybar + operatingReserveTinybar,
    Insolvent
);
```

`address(this).balance` is tinybars (C5). This asserts the contract can honour every armed refund
plus everything credited but not yet withdrawn, and still has a reserve. **If it cannot, the hold
does not open** — which is the correct direction: refuse new business rather than silently
under-fund an existing promise.

**Access control for the event:** an owner-settable allowlist of resource servers, **on by default**.
The deposit mechanism is what makes permissionless operation *possible*; the allowlist is what we
actually ship this week, because a judge should see the safe configuration and "we can turn this off
once the deposit model is load-tested" is a better story than an untested open door. Both states are
one boolean apart.

**Open for Igor:** the deposit is refunded to nobody — it is consumed as gas whether the hold ends in
`claim` or `refund`. On `claim` the schedule is deleted and the deposit was never spent. Should the
unspent deposit be returned to whoever paid it? **Recommendation: yes, credit it to the payee on
`claim`**, since the seller's diligence saved it. Adds one storage read and one addition. Flagged
because it is a fairness question, not a security one.

### Q7 — How much gas for the scheduled refund, and how was the number derived?

**Recommendation: `REFUND_GAS = 400,000`.**

Derived from the only measurement we have — spike 6, a value-carrying scheduled call that consumed
**~132,000 gas** into a trivial recipient — plus what `refund()` does beyond that:

| Component | Gas | Source |
|---|---|---|
| Scheduled call overhead + value transfer | ~132,000 | measured, [spike 6](../spikes/06-value-units.md) |
| `status` SSTORE, warm non-zero → non-zero | 2,900 | EVM schedule |
| `amountTinybar` SSTORE → zero | 2,900 | same slot, warm |
| `totalLockedTinybar` SSTORE | 2,900 | |
| Payout stipend, bounded | 30,000 | our constant |
| `Refunded` event, ~4 words | ~2,000 | |
| `withdrawable` SSTORE, cold zero → non-zero (fallback branch only) | 22,100 | worst case |
| **Worst-case subtotal** | **~195,000** | |
| Margin | ~2x | |
| **Requested** | **400,000** | |

**Why round up rather than tune down.** Spike 6 established the network charges for gas *used*, not
the limit requested (C8), so over-requesting costs nothing at execution. The failure modes are wildly
asymmetric: over-request and we waste a capacity reservation; under-request and the refund reverts,
the schedule is consumed, and the hold is stranded — the Q4 disaster arriving through the front door.

**The one cost of over-requesting** is capacity: `hasScheduleCapacity(second, gasLimit)` takes the
limit into account, so a larger request makes a given second look full sooner (C9). 400,000 is
chosen to sit well clear of the failure while not being absurd. Not 4,000,000.

**MEASURED 2026-09-08 — `REFUND_GAS` is now 250,000.** See
[the measurement](../spikes/11-escrow-gas.md). Real `refund()` executions on testnet: 46,744 happy
path, 90,805 with a cheap revert, 105,747 with the stipend burned, and **122,847** for that last
case on a *fresh* contract where both credit-fallback slots are cold. 250,000 is 2.0x the maximum.

The estimate above was good — 195,000 predicted against a 122,847 maximum — but the warm/cold
storage difference was worth 17,100 gas and no amount of arithmetic was going to surface it. Note
also that `openHold` measured **1,668,649** gas, so the server's transaction needs ~3M and we send 5M.

---

## 4. `openHold` — the gas problem nobody expects

C4 says `scheduleCall` alone needs ~1.45M gas, and EIP-150 forwards only 63/64 of what remains. So:

```
scheduleCall floor                    ~1,468,750
÷ 63/64                               ~1,492,064   just to make the call
+ capacity probes (up to 8 staticcalls)
+ 6 cold SSTOREs for the Hold struct  ~132,000
+ commitments, events, solvency reads
────────────────────────────────────────────────
openHold transaction gas limit         3,000,000   recommended
```

**Consequence for the server:** the x402 settlement transaction that opens a hold must carry ~3M
gas. This is not a normal EVM transaction cost and it will surprise anyone integrating. It belongs in
the README, in the resource-server config, and in the Hedera write-up. Session 01 lost two runs to
being ~1% under this floor, and the failure mode was a revert with **empty returndata** that reads
like a contract bug.

---

## 5. Deadlines travel in calldata (C2)

The scheduled call is armed as:

```solidity
abi.encodeWithSelector(this.refund.selector, holdId, deadline)
```

and `refund` checks:

```solidity
require(msg.sender == address(this), NotTheNetwork);      // C1
require(deadline == h.deadline, StaleSchedule);           // C2
```

`block.timestamp` inside a scheduled execution is the enclosing block's consensus time, not the
expiry second (C2), so it cannot tell us *which* deadline fired and must not be used for that. The
deadline travels in the calldata and is checked against storage instead.

With monotonic hold ids a stale schedule cannot address a live hold anyway, so this check is
belt-and-braces — but it is two hundred gas and it turns a whole class of "did we re-use an id"
reasoning into an assertion.

`require(msg.sender == address(this))` is a real gate, not a hopeful one: spike 6 confirmed against a
third-party target that a scheduled call's `msg.sender` is the **scheduling** contract. A schedule
armed by an attacker's contract to call our `refund()` arrives with their address and is rejected.

---

## 6. Function-by-function

| Function | Caller | Reverts on |
|---|---|---|
| `openHold(payer, payee, hKey, hCipher, hPlain, hRequest, deadline)` `payable` | allowlisted resource server | underfunded, dust, duplicate `hRequest`, insolvency, deadline out of range, schedule failure |
| `claim(holdId, k)` | anyone with `k` (in practice the seller) | wrong state, `keccak256(k) != hKey`, `deleteSchedule != 22` |
| `refund(holdId, deadline)` | **only `address(this)`** | wrong state, stale deadline, wrong sender. Nothing after the CAS. |
| `rescue(holdId)` | anyone, after `deadline + 24h` | wrong state, too early |
| `withdraw()` | anyone with a credit | zero balance, push failure |
| `fund()` `payable` | anyone | — tops up the operating reserve |
| `sweepReserve(amount)` | owner | would break the solvency invariant |

`claim` being callable by anyone holding `k` is intentional: it is the seller's key, and whoever
submits it, the payee is paid from storage, not from `msg.sender`.

`sweepReserve` must re-assert the solvency invariant. An owner who can withdraw below
`totalLocked + totalWithdrawable` is a rug, and Igor should check that assertion is present and
correct rather than take this sentence for it.

---

## 7. Events

```solidity
event HoldOpened(uint256 indexed holdId, address indexed payer, address indexed payee,
                 uint64 amountTinybar, uint64 deadline, address scheduleAddress,
                 bytes32 hKey, bytes32 hCipher, bytes32 hPlain, bytes32 hRequest);
event Claimed(uint256 indexed holdId, address indexed payee, bytes32 k);   // k: buyer decrypts, no action needed
event Refunded(uint256 indexed holdId, address indexed payer, uint64 amountTinybar);
event PayoutDeferred(uint256 indexed holdId, address indexed to, uint64 amountTinybar);
event Withdrawn(address indexed to, uint256 amountTinybar);
event Rescued(uint256 indexed holdId, address indexed payer, uint64 amountTinybar);
```

`Claimed` carrying `k` is the mechanism by which the buyer never has to act. `HoldOpened` carrying
`scheduleAddress` is what lets the live board link each row to its mirror-node record.

---

## 8. Open questions and risks — the ones that could still change this design

**8.1 — Does the x402 settlement path let us call `openHold` atomically?**
**ANSWERED: no.** [Spike 9](../spikes/09-settlement-atomicity.md). Two independent reasons:
`@x402/hedera` only ever builds a `TransferTransaction` and the facilitator rejects anything else
with `invalid_exact_hedera_payload_contains_non_transfer_ops`; and a HAPI `CryptoTransfer` to a
contract credits its balance **without executing `receive()`** — measured, against an EVM-transfer
control on the same contract that did run it.

Option (b) from the original list is therefore dead as well as option (a) being unattractive. The
design moves to **escrow-as-`payTo`**: the settlement credits the escrow directly, and `openHold`
is a **non-payable** call that attributes already-present funds via
`unattributed = balance - totalLocked - totalWithdrawable - reserve`.

Consequences to carry through the rest of this plan:

- `openHold` loses `msg.value` and gains an `amountTinybar` argument plus the unattributed check.
  §Q6's deposit still applies and must now be paid in the same way.
- §Q3's "everything reverts together" still holds **within `openHold`**, which is what it was
  protecting. It no longer spans the settlement.
- A payment that is never armed leaves unattributed funds with no on-chain record of the payer.
  Needs an operator-attributed sweep, which is a disclosed "someone must act" path.
- The allowlist in §Q6 is now load-bearing, not just prudent: in permissionless mode a hostile
  server could arm a hold against another buyer's unattributed balance. Removing the allowlist
  requires solving attribution first.

**8.8 — Will Blocky402 accept a contract's account id as `payTo`?**
**ANSWERED: yes, verified and settled end to end.** [Spike 10](../spikes/10-payto-contract.md).
`/verify` returned `isValid: true` for a contract destination, against a plain-account control that
also passed. Then `/settle` actually submitted it: transaction
[`0.0.7162784-1788854559-596024460`](https://hashscan.io/testnet/transaction/0.0.7162784-1788854559-596024460),
`CRYPTOTRANSFER SUCCESS`, +10,000,000 tinybar to the contract and -10,000,000 from the buyer, fee
paid by Blocky402's `0.0.7162784`.

**Escrow-as-`payTo` is viable and the design in §0 stands.** Two further confirmations came with it:
`receive()` did not run on the real settlement path either, and the settle transaction's fee payer
being `0.0.7162784` is the concrete artefact that demonstrates track qualification — every demo hold
should have one behind it.

**8.2 — Is a successful `deleteSchedule` rolled back if the enclosing transaction later reverts?**
**ANSWERED: yes, it is atomic.** [Spike 7](../spikes/07-delete-atomicity.md), schedule
`0.0.10418012`. The delete returned 22, the transaction then reverted on purpose, and the schedule
was still alive afterwards; deleting it again for real returned 22, proving it had been genuinely
deletable all along.

Consequences, and they are asymmetric:

- **`claim()`** — the Q5 ordering rule is no longer load-bearing. If the seller payout reverts, the
  whole transaction unwinds, the schedule comes back, and the hold returns to `OPEN` still armed.
  Downgraded from requirement to preference. Recommendation stands to keep credit-on-failure anyway,
  so both payout paths share one shape; **Igor's call**, and reverting is now a legitimate option
  where yesterday it was not.
- **`refund()`** — **unchanged and still mandatory.** `refund()` is executed *by* the schedule. By
  the time its body runs the schedule has already fired, and a revert inside it cannot un-fire the
  execution that invoked it. There is no schedule to come back to.

**8.6 — If a scheduled call's execution reverts, is the schedule consumed anyway?**
**ANSWERED: yes, consumed.** [Spike 8](../spikes/08-scheduled-revert.md). A schedule whose call
reverted shows `executed_timestamp` set, `deleted: false`, and did not retry within a further 60 s.
A control schedule armed alongside it executed successfully six seconds earlier, so the network was
demonstrably running scheduled calls in that window.

**§Q4's no-revert-after-CAS rule is therefore a hard safety requirement, not a preference**, and
`rescue()` keeps its justification because a stranded hold is genuinely reachable.

Two numbers that came with it:

- The contract **is charged for failed executions** — 0.0227 HBAR for the revert against 0.1178 HBAR
  for the success. §Q6's 0.5 HBAR deposit therefore covers a forced-revert griefing attack by more
  than an order of magnitude. Sizing confirmed rather than guessed.
- The network charges gas **used**, not requested, confirmed a third time (~112k used against a 150k
  limit). Requesting `REFUND_GAS = 400,000` costs nothing extra at execution, which is §Q7's
  premise.

**8.7 — Network-executed calls do not appear in `/api/v1/contracts/{address}/results`.** *(new,
found by spike 8)* Neither the successful nor the reverting scheduled execution shows up there —
only the arming transactions do. They are visible via
`GET /api/v1/transactions?timestamp=<executed_timestamp>`, which reports `scheduled: true` and the
real result. A refund that fired and reverted is therefore **invisible in the place a dashboard would
look**, and indistinguishable from one that never fired. The live board and the monitoring runbook
must read schedule record → `executed_timestamp` → transactions endpoint. Not a contract change; a
work item for the frontend, and it needs to exist before the demo rather than be discovered during
it.

**8.3 — The jitter fallback: half closed.** The **minute-boundary skip has now run on testnet**
(`probesUsed: 1`, a deadline landing on `% 60 == 0`, [spike 11](../spikes/11-escrow-gas.md)), and the
whole path including capacity saturation and the give-up branch is covered by unit tests against a
mocked HSS. What has still never happened on the real network is a **capacity-saturated second**,
because testnet is uncongested. That half stays open and stays in the README.

**8.4 — ~~a pre-implementation budget~~ MEASURED.** §Q7, [spike 11](../spikes/11-escrow-gas.md).
`REFUND_GAS = 250,000`, 2.0x the real maximum of 122,847.

**8.5 — Hold amounts above `uint64` tinybars are impossible.** 184 billion HBAR, against a 50 billion
supply. Not a real constraint; recorded so nobody re-derives it.

---

## 9. Decisions I have deliberately left open

**9.1 — Store all four commitments, or store `H(k)` and emit the rest?**
Storing costs 3 × 20,000 gas per hold for data the contract never reads. Emitting puts them in the
log, which is still on-chain and still provable, at roughly a tenth of the cost.
**Recommendation: emit `hCipher`, `hPlain`, `hRequest` in `HoldOpened`; store only `hKey` and
`hRequest`** (`hRequest` is needed in storage for the replay mapping). A buyer proving a seller lied
reads the log, and `verify.ts` reads logs anyway. **Against:** logs are prunable by some
infrastructure and "it is in an event" is a weaker sentence to say to a judge than "it is in storage".
Igor's call.

**9.2 — Should the unspent gas deposit be returned on `claim`?** §Q6. Recommend yes, to the payee.

**9.3 — Is `rescue` worth its cost to the pitch?** §Q4. Recommend yes, with disclosure.

**9.4 — Allowlist on or off at submission?** Recommend on, with the deposit model documented as what
makes removing it possible.

---

## 10. What I want Igor to attack

In priority order, because Wednesday is the review that matters:

1. **The Q2 tie-break.** Is the `deleteSchedule` return code genuinely sufficient as the sole
   arbiter, or is there an ordering where `claim` and the scheduled `refund` both believe they won?
2. **Q4's stranding.** Is bounded-stipend-plus-credit actually non-revertible in every branch? Find
   an input where `refund()` reverts after the CAS.
3. **The solvency invariant.** Find a sequence of `openHold` / `claim` / `refund` / `withdraw` /
   `sweepReserve` that leaves `address(this).balance < totalLocked + totalWithdrawable`.
4. **Q6's economics.** Is `0.5 HBAR` per hold actually enough to make griefing unprofitable, given
   that the attacker also gets their hold amount back at the deadline?
5. **The adversarial table from the brief** — all eleven rows, as real committed test files.

Rows 9 and 10 of that table ("claim and refund land in the same second", "target second saturated")
are the two that the design answers with reasoning rather than with a test, and they are the two
worth writing first.

---

## 11. Implementation order, once reviewed

1. ~~Spike 7 (§8.2)~~ **done — atomic.** ~~Spike 8 (§8.6)~~ **done — consumed.**
   ~~Spike 9 (§8.1)~~ **done — atomicity is not available; design moved to escrow-as-`payTo`.**
   ~~§8.8~~ **done — Blocky402 verifies AND settles into a contract.** Nothing external now blocks
   `HoldEscrow.sol`. The only gate left is Igor re-reviewing this plan against the §8.1 correction,
   which changed `openHold` from payable to fund-attributing.
2. `HoldEscrow.sol` skeleton: state, `openHold`, `claim`, `refund`, no rescue, no withdraw.
3. Unit tests against a mocked HSS, including the jitter path (§8.3).
4. `rescue`, `withdraw`, the solvency invariant.
5. Testnet: one real hold, claimed. One real hold, refunded unattended.
6. Re-measure `REFUND_GAS` (§8.4) and set it from the measurement.
