# Spike 1 — does a scheduled call fire unattended on current testnet?

**Verdict: YES. All four conditions met.** Run 2026-09-06.

| | |
|---|---|
| Schedule | **`0.0.10395748`** — [HashScan](https://hashscan.io/testnet/schedule/0.0.10395748) |
| Contract | `0x47A1a21fb01CCbd00a729937a352dB3986E1CA2c` — [HashScan](https://hashscan.io/testnet/contract/0x47A1a21fb01CCbd00a729937a352dB3986E1CA2c) |
| Arming tx | [`0x2bfc0250…c91656`](https://hashscan.io/testnet/transaction/0x2bfc0250d126a8be610c55846f78eb7a1f5b09516bcabddc3be98eebedc91656) |
| Target second | `1788719349` |
| Executed | `1788719349.003729824` — **4 ms into its target second** |

## Pass conditions — all four, no partial credit

| Condition | Expected | Actual | |
|---|---|---|---|
| `executed_timestamp` present | non-null | `1788719349.003729824` | PASS |
| `signatures` empty | `[]` | `[]` | PASS |
| `wait_for_expiry` | `true` | `true` | PASS |
| `pingCount` on chain | `1` | `1` | PASS |

Nobody signed it. No transaction was submitted by us, by a keeper, or by anyone else between arming
and execution. The network ran it because the second arrived. That is the entire pitch, and it holds
on current testnet.

Raw mirror record: [`spike1-schedule.json`](spike1-schedule.json). Full result:
[`spike1-result.json`](spike1-result.json).

## The answer we needed for `HoldEscrow`

```
lastPingSender  0x47A1a21fb01CCbd00a729937a352dB3986E1CA2c
```

**The network executes the scheduled call as the scheduling contract itself.** `msg.sender` inside a
network-executed call is the contract's own address, not a system account, not the original arming
EOA, not the zero address.

This was undocumented and it decides a real design question: `refund()` **can** be gated on
`msg.sender == address(this)`. We do not have to leave the refund path open to the world and defend
it with state checks alone. Worth confirming once more against a second schedule before we rely on
it, but the first observation is unambiguous.

`lastPingTimestamp` came back as `1788719347`, two seconds *before* the target second — so the
`block.timestamp` visible inside a scheduled execution is the enclosing block's consensus time, not
the schedule's expiry second. Do not use `block.timestamp` inside a scheduled call to reason about
which deadline fired; carry the deadline in the calldata.

## Randomness — amendment 1 answered

Both sources probed twice, in different blocks, inside real transactions:

| Block | `block.prevrandao` | `0x169` `getPseudorandomSeed()` |
|---|---|---|
| 40190164 | `0xcf52f9a2…ee9f8d4d` | `0xcf52f9a2…ee9f8d4d` |
| 40190169 | `0x6f7021e3…82063013` | `0x6f7021e3…82063013` |

**Both are usable, and they are the same value.** Non-zero, and different across blocks. On Hedera
`block.prevrandao` is wired to the same source as the HIP-351 PRNG, so HIP-1215's reference pattern
and Hedera's own documented PRNG do not disagree after all — they are two names for one thing.

Practical consequence: `HoldEscrow` should read `block.prevrandao` rather than calling `0x169`.
Identical entropy, no system-contract call, cheaper. The spike contract prefers `0x169` and recorded
`seedSource: prng-0x169`; that preference should be inverted before the escrow ships.

This was worth measuring rather than assuming. A constant or zero `prevrandao` would have been worse
than no jitter at all — every contract using the reference pattern would derive identical offsets and
stampede the same second while appearing to scatter.

## What this result does NOT establish

**The capacity/jitter fallback never ran.** `probesUsed` was `0`: testnet is uncongested, the
first-choice second was free, and `_findAvailableSecond` returned on its first check. The exponential
backoff, the jitter, and the minute/hour boundary skip are **untested code on the critical path** and
are not reported as verified. Unit tests against a mocked HSS are Igor's Wednesday review, and even
those test our assumptions rather than a saturated network.

One data point that bears on it, from the direct probe (`scripts/diag-hss.cjs`):

```
hasScheduleCapacity(now +    1, 150000) -> false
hasScheduleCapacity(now +   30, 150000) -> true
hasScheduleCapacity(now +   61, 150000) -> true
hasScheduleCapacity(now + 3600, 150000) -> true
```

`now + 1` returns **false**. HIP-1215 states a one-second minimum delay, but by the time the call is
evaluated the second is no longer strictly in the future. So the effective floor is above one second.
Our 60-second refund window is nowhere near it, but anything that tries to schedule "as soon as
possible" needs to know, and a `false` here means "invalid expiry" just as readily as "saturated" —
the HIP says the same code covers both.

## Two failures on the way here, both worth keeping

Neither was a HIP-1215 problem. Both are recorded because both would have cost a day later.

**1. `address(this).balance` is in tinybars, not weibars.** First arm reverted with
`InsufficientBalance(2000000000, 5000000000000000000)` on a contract holding 20 HBAR. Inside the EVM
a balance reads in tinybars (1e8/HBAR); over JSON-RPC `eth_getBalance` reads in weibars (1e18/HBAR).
Exactly 1e10 apart. Solidity's `ether` literal is 1e18, so `balance >= 5 ether` can never pass in a
Hedera contract. Reproducible via `scripts/units-probe.cjs`; evidence in
[`units-probe.json`](units-probe.json).

It failed loudly, which was luck. The mirror image — a weibar amount checked against a tinybar
threshold — passes trivially and would put an underfunded contract into the demo with the refund
silently not firing. That is failure mode 3 from the brief, and it arrives disguised as a passing
test.

**2. `scheduleCall` needs ~1.45M gas of its own.** Second arm reverted with
`HssCallReverted("scheduleCall", "")` having burned 1,480,769 of a 1,500,000-gas transaction. Binary
search (`scripts/gas-probe.cjs`, evidence in [`gas-probe.json`](gas-probe.json)) puts the floor
between **1,445,312 and 1,468,750**, independent of the gas limit requested for the scheduled call
itself. EIP-150 forwards only 63/64 of remaining gas, so a 1.5M transaction hands the precompile
~1.457M and lands inside the failure band. We missed by about one percent.

**This qualifies HIP-1215's "never reverts".** That guarantee covers *business* failures — a
saturated second returns `SCHEDULE_EXPIRY_IS_BUSY` as a code. Starved of gas, `scheduleCall` reverts
with **empty returndata** and consumes everything forwarded to it. Two failure modes that are
indistinguishable from outside the call, and only one of them is documented. A contract that follows
the HIP's advice and checks only the returned code will read a gas-starvation revert as a contract
bug.

Consequence for `HoldEscrow`: **`openHold` cannot be a cheap transaction.** The x402 settlement that
opens a hold has to carry several million gas, and running it near the floor fails in the least
diagnosable way available. This belongs in the Tuesday session and in the README's limits section.
