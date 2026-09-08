# Plan 02 — can a third party delete someone else's schedule?

**Implementing agent:** Claude Opus 5 (Claude Code). **Requested by:** Alex, 2026-09-06, after
Spike 2 passed. Committed before implementation per the ETHGlobal AI-attribution requirement.

## The question

Spike 2 proved the contract that *created* a schedule can delete it. It did not test whether anyone
else can. HIP-1215 documents the call surface — *"A contract or EOA may also attempt to delete a
scheduled transaction"* — and says nothing about authorisation.

**If an unrelated party can delete our booked refund, the guarantee is gone.** An attacker cancels
the schedule, the seller never reveals, and the buyer's money sits in the hold with nothing left to
release it. That is strictly worse than the designs we criticise in the README, because those at
least fail loudly: ours would look armed right up until the second it does not fire.

This is a denial-of-service test against our own contract on testnet.

## Matrix

One victim schedule, armed by `SpikeSchedule` far enough out to survive the whole sequence.
Four attackers tried in order, stopping at the first success — a successful delete consumes the
schedule, so each cell needs the previous one to have failed.

| | via `0x16b` `deleteSchedule(address)` | via redirect `deleteSchedule()` |
|---|---|---|
| **unrelated EOA** (fresh key, not the deployer) | 3a | 3b |
| **unrelated contract** (`Attacker.sol`) | 3c | 3d |

Both dimensions matter and they are different questions. If authorisation keys off the *payer
account*, an attacker contract deployed by our own operator would pass 3c while a stranger's would
not — so the EOA must be a genuinely fresh account, not our deployer. If it keys off the *calling
contract address*, 3c is the real test and 3a tells us little.

**Pass = every cell FAILS.** This is the one spike where success is bad news.

## Method

1. Deploy `Attacker.sol`: a minimal contract with non-reverting `tryHss(address)` and
   `tryRedirect(address)` that emit the raw `int64` and returndata. Same raw-call discipline as
   `SpikeSchedule` — we want the response code, not an opaque revert.
2. Generate a fresh EOA, fund it with ~15 HBAR from the operator. On Hedera a transfer to an unknown
   EVM address creates a hollow account, completed by its first signed transaction.
3. `SpikeSchedule.arm(600, …)` — 10 minutes, comfortably longer than the sequence takes.
4. Control read on the mirror node, with the usual backoff, confirming the schedule exists,
   `deleted: false`, `executed_timestamp: null`. Same reasoning as Spike 2: without it a
   "still alive" result is meaningless.
5. Run 3a → 3b → 3c → 3d, re-reading the mirror after each. Stop at the first `deleted: true`.
6. Clean up: the victim contract deletes whatever survives, so we do not leave a schedule to fire.

Gas: 4,000,000 on every attempt. `deleteSchedule` is a system-contract call and starving it produces
an empty-returndata revert that would read as "not authorised" when it is really "not enough gas" —
the exact confusion that cost us two runs on Spike 1. A cell only counts as a genuine authorisation
failure if it returns a *code*.

## What each outcome means

- **All four fail** — the refund guarantee holds against third parties. Record the response codes;
  they tell us whether authorisation is by admin key, by creating contract, or by payer.
- **3a or 3b succeeds** — anyone with a funded testnet account can cancel any schedule. Critical.
  Stop, report immediately, and the design needs a rethink before `refund()` is written.
- **3c or 3d succeeds but the EOA cells fail** — contract callers are privileged in a way EOAs are
  not. Narrower, still serious, and it constrains what else may be deployed alongside the escrow.

Either way the result goes in the README's limits section and to the Hedera feedback session,
because an undocumented authorisation model on the delete path is worth raising regardless of which
way it falls.
