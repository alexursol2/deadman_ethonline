# Plan 03b — measure the units of `scheduleCall`'s `value` parameter

**Implementing agent:** Claude Opus 5 (Claude Code). **Requested by:** Alex, 2026-09-07.
Committed before the implementation it describes. Numbered `03b` so `04` stays free for HoldEscrow.

## The gap

`scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes callData)`.

Every spike so far passed `value = 0`. The session-01 report inferred tinybars from "a weibar amount
cannot fit in `uint64`". That is sound reasoning and it is **not a measurement**, and `refund()`
moves real money on this parameter. Session 01 already produced one unit bug that reasoning would
not have caught — `address(this).balance` reads tinybars while `eth_getBalance` reads weibars — so
the standing assumption in this codebase is that HBAR units must be measured where they are used.

## Method

Arm a schedule that carries a **non-zero** value, let it fire unattended, and measure what actually
lands.

`VALUE_PARAM = 300_000_000` (3e8). Chosen so the two hypotheses cannot be confused:

| If `value` is | 3e8 means | Observable |
|---|---|---|
| **tinybars** | 3 HBAR | recipient gains exactly 3 HBAR |
| **weibars** | 0.0000000003 HBAR = 0.03 tinybar | sub-tinybar; recipient gains **nothing**, or the call fails |

No third reading is plausible, and the outcomes are orders of magnitude apart rather than adjacent.

New pieces:

- `ValueSink.sol` — a recipient with `land(bytes32 tag) payable` that records `msg.value` as the EVM
  reports it, its own `address(this).balance`, and a call counter. Recording `msg.value` also tells
  us its units inside a *scheduled* execution, which is a second thing we have never measured.
- `SpikeSchedule.armWithValue(to, delaySeconds, gasLimit, value, callData)` — same capacity probe,
  jitter, and both-halves return assertion as `arm()`, with the value parameter threaded through and
  the balance floor raised to `MIN_BALANCE_TINYBAR + value`.

Measured on three independent surfaces, because one of them being wrong is the entire point:

1. sink balance via `eth_getBalance` (weibars, from outside)
2. sink balance via `address(this).balance` (tinybars, from inside the EVM)
3. `msg.value` as recorded inside the scheduled call
4. the escrow contract's balance delta, which must mirror the sink's gain plus execution gas
5. the mirror node's record of the scheduled transaction

## Pass conditions

- The schedule executes unattended (`executed_timestamp` present, `signatures: []`) — otherwise we
  have measured nothing.
- The sink's balance increases by **exactly 3 HBAR** as read in tinybars.
- The paying contract's balance decreases by 3 HBAR plus execution gas.

## If it is not tinybars

**Stop and tell Alex before anything else**, per the instruction. It changes `refund()`: the amount
written into the schedule at `openHold` would need converting, and a `uint64` could not express
holds above ~18.4 HBAR if the unit were anything finer than tinybars — which would cap the product.

## Also worth capturing while a non-zero value is in flight

Whether a value-carrying scheduled call needs **more gas** than the 150,000 we have used for
value-free calls. If it does, `openHold` has to request more for the refund, and that number feeds
directly into the HoldEscrow plan being written today.
