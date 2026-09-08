# HoldEscrow on testnet — full lifecycle, and REFUND_GAS measured

**`REFUND_GAS` 400,000 → 250,000, derived from measurement.** Run 2026-09-08.

| | |
|---|---|
| Contract | **`0xc5241034C7c060361B0223B3c6d77d0A4bC8Ef09`** = **`0.0.10419881`** |
| | [HashScan](https://hashscan.io/testnet/contract/0xc5241034C7c060361B0223B3c6d77d0A4bC8Ef09) |
| x402 `payTo` | `0.0.10419881` — the entity id, per [spike 10](10-payto-contract.md) |

Both lifecycles ran end to end on the real network:

- **Refunded unattended** — [`0.0.10419883`](https://hashscan.io/testnet/schedule/0.0.10419883), executed
  `1788862404.005427208`, `signatures: []`, hold status `REFUNDED`. Nobody acted.
- **Claimed** — [`0.0.10419891`](https://hashscan.io/testnet/schedule/0.0.10419891), key revealed,
  payee paid, schedule `deleted: true`, hold status `CLAIMED`.

Evidence: [`escrow-deploy.json`](escrow-deploy.json), [`gas-measurements.json`](gas-measurements.json),
[`gas-worstcase-reject.json`](gas-worstcase-reject.json), [`gas-worstcase-burn.json`](gas-worstcase-burn.json).

## Measurements

| Operation | Gas | Notes |
|---|---|---|
| `openHold` | **1,668,649** | dominated by `scheduleCall`'s own ~1.45M floor (C4) |
| `claim` | **123,038** | includes the `deleteSchedule` call |
| `refund` — happy path | **46,744** | payer is an EOA that accepts the push |
| `refund` — payer reverts cheaply | **90,805** | credit-on-failure branch runs |
| `refund` — payer burns the stipend | **105,747** | on a contract with warm storage |
| **`refund` — the real maximum** | **122,847** | the same, on a **fresh** contract |

`REFUND_GAS = 250,000` is **2.0x** the real maximum.

## The measurement that nearly went wrong

The first "worst case" came back as **105,747** and that number was wrong — or rather, it was true
and not the maximum.

That run reused a contract whose `totalWithdrawableTinybar` was already non-zero from an earlier
test, so the credit-fallback's second `SSTORE` was a warm non-zero→non-zero write at 2,900 gas
instead of a cold zero→non-zero at 22,100. Re-running on a freshly deployed contract, where both
fallback slots are cold, cost **17,100 more**: 122,847.

**A worst case measured on a warm contract is not the worst case.** Had `REFUND_GAS` been sized off
105,747 with a tight multiplier, the first real credit-on-failure refund in production — the one on
a fresh deployment, which is exactly the demo — would have had less headroom than the number
promised. This is the third time in this project that a measurement beat an estimate, and the second
time a *second* measurement beat the first one.

## Why 250,000 and not 400,000

400,000 was plan 04 §Q7's pre-implementation estimate: EVM gas-schedule line items added on top of
spike 6's measured ~132,000, giving ~195,000 worst case, doubled. **It was a good estimate** — 195,000
against a real 122,847 maximum, within the margin it was claiming. But it was arithmetic, and
arithmetic is what the tinybar bug and the `scheduleCall` gas floor both sailed straight through.

Why round up at all: C8, the network charges for gas **used**, so unused headroom is free at
execution. Confirmed again here — the refund that used 46,744 of 250,000 was charged 4,954,864
tinybars, the same as when the limit was 400,000.

Why not round up further: the requested limit is an input to `hasScheduleCapacity`, so an inflated
figure makes a second look saturated sooner than it really is. Under congestion that turns free
headroom into failed holds.

## `openHold` costs 1.67M gas, and that is a fact the server has to know

Not a normal EVM transaction cost. The `scheduleCall` precompile's ~1.45M floor (C4) dominates
everything the escrow itself does, and EIP-150 forwards only 63/64, so the transaction needs
comfortably more than the call. We send 5,000,000; below ~1.8M it will fail, and it fails with
**empty returndata**, which reads like a contract bug rather than a gas problem.

This belongs in the resource server's config and in the README, not in a comment.

## The jitter fallback ran on testnet — partly

One `openHold` reported **`probesUsed: 1`**. The requested deadline was `1788861900`, which is
`% 60 == 0`, so the minute-boundary skip fired and the hold armed at `1788861901` instead.

So the **boundary-skip branch has now executed on the real network**, which it never had before. The
**capacity-saturation branch still has not** — `hasScheduleCapacity` has returned true on every
probe, because testnet is uncongested. That half remains covered only by the mocked unit tests, and
the README still says so.

It is also a small vindication of the design decision to store the *armed* deadline rather than the
requested one: the hold's stored deadline was 1788861901, the scheduled calldata carried 1788861901,
and `refund()`'s equality check matched. A contract that stored the requested deadline would have
had its own refund rejected as stale.

## What is still not proven

- **The claim/refund race in the same second.** Both paths work in isolation; nothing has forced
  them to collide.
- **`rescue()` on testnet.** It needs a 24-hour grace period to elapse, so only the unit tests cover
  it.
- **A hold opened from a real x402 settlement.** [Spike 10](10-payto-contract.md) settled into a bare
  sink; these holds were funded by an ordinary EVM transfer. The two halves are proven separately
  and have not yet been run as one sequence.
- **Repeat runs.** Four holds, one afternoon, uncongested network.
