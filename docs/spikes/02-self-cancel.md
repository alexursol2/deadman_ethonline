# Spike 2 — can a contract cancel its own pending schedule?

**Verdict: YES, on the happy path (2a).** Run 2026-09-06.

This was risk #2 from the brief and the one that would have changed the product. It does not.

| | |
|---|---|
| Schedule | **`0.0.10395764`** — [HashScan](https://hashscan.io/testnet/schedule/0.0.10395764) |
| Expiry second | `1788719685` |
| Cancel tx | [`0xc6994e61…ebb441`](https://hashscan.io/testnet/transaction/0xc6994e61fcbdfdc6ded06136416da3dc28c067d3cb361b2d8ecfdc54e3ebb441) |
| Path | 2a — `deleteSchedule(address)` on `0x16b`, called **by the contract that armed it** |
| Response | `callOk=true`, `code=22` (`SUCCESS`), returndata `0x…16` |

## Sequence and pass conditions

```
armed 0.0.10395764, expiring 1788719685
control read   -> exists, deleted=false, executed_timestamp=null   (1 attempt)
tryCancelViaHss -> callOk=true  code=22
re-read        -> deleted=true,  executed_timestamp=null           (1 attempt)
+60s past expiry:
               -> deleted=true,  executed_timestamp=null
               -> pingCount 1 before, 1 after
```

| Condition | Expected | Actual | |
|---|---|---|---|
| A contract-side delete returned SUCCESS | code 22 | 22 | PASS |
| Mirror shows `deleted: true` | true | true | PASS |
| Still `deleted: true` past the expiry second | true | true | PASS |
| `executed_timestamp` never populated | null | null | PASS |
| `pingCount` unchanged | 1 | 1 | PASS |

**The control read is what makes this mean anything.** Before cancelling, the schedule was confirmed
present on the mirror node with `deleted: false` and `executed_timestamp: null`. Without that, "it
never executed" would be equally consistent with "it was never created", and we would have concluded
the happy path works on the strength of a schedule that never existed.

Evidence: [`spike2-confirm.json`](spike2-confirm.json),
[`spike2-final-schedule.json`](spike2-final-schedule.json),
[`spike2-console.log`](spike2-console.log).

## What this means for the design

The happy path in the brief survives intact:

> Seller delivers, reveals the key, gets paid, and the booked refund is cancelled.

`claim()` can call `deleteSchedule(scheduleAddress)` on `0x16b` directly and treat anything other
than `22` as a failure. No external signer, no keeper, no fallback product. Combined with Spike 1's
result — the network executes the scheduled call as the scheduling contract itself — both halves of
the mechanism are now confirmed on live testnet rather than inferred from the HIP.

## What this result does NOT establish

**The redirect path (2c) was never exercised.** `deleteSchedule()` (`0xc61dea85`) called on the
schedule address is implemented in `SpikeSchedule` and tested by nothing, because 2a passed and the
script correctly stopped. Same for the EOA diagnostics 2b and 2d. We know one door opens; we have
not tried the others. That is the right outcome for a spike and the wrong thing to describe as
"both paths verified".

**The mirror-node backoff never fired.** Every read in this spike succeeded on the **first attempt**,
including the control read taken immediately after arming — so amendment 3's retry-with-backoff is,
like the jitter fallback, untested code. It cost nothing to add and it removes a false-negative mode
that would have looked exactly like a design failure, so it stays. But testnet's mirror node was
promptly consistent today, and the live board should not assume that.

**One cancel, one schedule, one moment.** This is a single observation on an uncongested testnet. It
does not establish behaviour under load, nor the race the brief calls out — claim and refund landing
in the same second, where exactly one must win. That race is a `HoldEscrow` concern and belongs in
Igor's Wednesday adversarial tests, not here.

## Open question for the escrow

Deletion succeeded when called by the contract that created the schedule. We did **not** test whether
an unrelated contract or a third-party EOA can delete someone else's schedule. If it can, that is a
denial-of-service on the refund guarantee: an attacker deletes the booked refund and the buyer's
money sits in the hold with nothing to release it.

Cheap to test, and it should be tested before `refund()` is written — it is the difference between
"the network will refund you" and "the network will refund you unless somebody cancels it first".
Added to the Wednesday review list.
