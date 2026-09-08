# Spike 8 — does a reverting scheduled execution consume its schedule?

**Verdict: YES. CONSUMED.** A scheduled call that reverts still spends its schedule. Run 2026-09-08.

Plan 04 §Q4 rested on this sentence: *"the schedule is consumed by its execution, and there is no
second schedule."* It is now measured rather than assumed, and it holds. **`refund()`'s
no-revert-after-CAS rule is a hard safety requirement, not a stylistic preference.**

## The two schedules

Both armed together, 90 s out, from contract `0x9c472433663620c172C59CeeAe318A63E2428966`
(`0.0.10418058`).

| | Schedule | Target | `executed_timestamp` | Result |
|---|---|---|---|---|
| **s-ok** (control) | [`0.0.10418063`](https://hashscan.io/testnet/schedule/0.0.10418063) | `ping()` | `1788852189.031647998` | `SUCCESS` |
| **s-revert** (subject) | [`0.0.10418065`](https://hashscan.io/testnet/schedule/0.0.10418065) | `alwaysReverts()` | `1788852195.029877208` | `CONTRACT_REVERT_EXECUTED` |

`pingCount` went `0 → 1`: the control ran, the subject did not touch state. `s-revert` still shows
`deleted: false` and, after a further **60 seconds of watching, did not retry**. Its
`executed_timestamp` is set and stays set.

**The control is what makes this interpretable.** Without a schedule that succeeded in the same
window, "s-revert never re-executed" would be equally consistent with the network not running
scheduled calls at all. s-ok proves the mechanism was live, six seconds earlier.

Evidence: [`spike8-result.json`](spike8-result.json).

## What "consumed" means concretely

The schedule fires exactly once. The inner call reverting unwinds the EVM work — no state change, no
`pingCount` increment — but it does **not** un-fire the execution. The schedule is spent, it is not
re-queued, and nothing brings it back.

This is the precise complement to [spike 7](07-delete-atomicity.md), and the pair is the whole
picture:

| | |
|---|---|
| A revert in an **ordinary** transaction | unwinds a `deleteSchedule` — the schedule comes back ([spike 7](07-delete-atomicity.md)) |
| A revert **inside a scheduled execution** | does **not** unwind the execution — the schedule is gone (here) |

So `claim()` may safely revert after deleting, and `refund()` may not safely revert at all. That
asymmetry is now measured on both sides rather than reasoned about on either.

## The contract is charged for failed executions

Per-execution fees, both debited from the contract `0.0.10418058`:

```
SUCCESS                    11,780,055 tinybar = 0.1178 HBAR
CONTRACT_REVERT_EXECUTED    2,265,165 tinybar = 0.0227 HBAR
                           ─────────────────
                           14,045,220 tinybar   matches the balance delta exactly
```

A reverting scheduled execution still costs the contract money — about **0.023 HBAR** here, roughly
a fifth of a successful one, because the revert unwinds early and consumes little gas.

**For plan 04 §Q6 this is good news and it is now quantified.** An attacker who could force
`refund()` to revert would burn ~0.023 HBAR of the contract's balance per hold, against a
**0.5 HBAR** deposit they paid to open it. The griefing economics stay inverted by more than an order
of magnitude. Had the numbers gone the other way, the deposit would have needed re-sizing.

It also confirms C8 again from a third angle: 11,780,055 tinybar at ~105 tinybar/gas is ~112,000 gas
against a **150,000** limit, and the revert cost ~21,600 gas. The network charges for gas **used**,
not the limit requested. Requesting `REFUND_GAS = 400,000` therefore costs nothing extra at
execution, which is exactly why plan 04 §Q7 rounds up.

## The finding nobody was looking for: failed refunds are invisible where you would look

**Neither scheduled execution appears in `/api/v1/contracts/{address}/results`.** Not the successful
one, not the reverting one. That endpoint returned four entries, all of them the *arming*
transactions:

```
1788852106.398279104   gas 1,471,292     <- arming
1788852099.067398886   gas 1,488,344     <- arming
1788852084.482344418   gas    22,663
1788852081.593766769   gas 1,379,683     <- arming
contains 1788852189 (the successful execution):  false
contains 1788852195 (the reverting execution):   false
```

Both executions are on the mirror node, but only via a different endpoint:

```
GET /api/v1/transactions?timestamp=1788852195.029877208
  CONTRACTCALL | result: CONTRACT_REVERT_EXECUTED | scheduled: true
```

**This is an operational trap for the live board and for monitoring.** The obvious way to ask "did
our refunds fire?" is to list the contract's results, and network-executed calls are not there. A
refund that fired and reverted would look identical to a refund that never fired at all — silent, in
the one place a dashboard would look.

The correct path is: schedule record → `executed_timestamp` → `GET /api/v1/transactions?timestamp=`
→ read `result`. Three hops, and it should be written into the live board and the monitoring runbook
before the demo, not discovered during it.

## One observation not to over-read

Both scheduled executions carry a transaction ID whose payer account is **`0.0.7314364`** — neither
our contract (`0.0.10418058`) nor our operator (`0.0.10393158`). Meanwhile the schedule record's
`payer_account_id` is the contract, and the contract is what was actually debited.

So the fee payer and the transaction-ID account differ on a network-executed call. We have not
established what `0.0.7314364` is and are not guessing; recorded because anyone correlating
transaction IDs to accounts will trip over it, and it is a reasonable question for Tuesday.

## Consequences for plan 04

- **§Q4 stands, fully.** `refund()` must not be able to revert after the CAS: bounded payout stipend,
  credit-on-failure, no `require` after the state write. Now backed by measurement.
- **The `rescue()` backstop keeps its justification.** A stranded hold is reachable if `refund()` ever
  reverts wholesale, because the schedule is genuinely gone.
- **§Q6's deposit sizing is confirmed** with real numbers rather than a guess.
- **New work item, not previously on the list:** monitoring must read scheduled executions through
  the transactions endpoint. Belongs with the live board.
