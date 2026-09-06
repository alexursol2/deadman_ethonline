# Spike 5 — closing the caveats, and a harness bug that mattered

**All four conditions met.** Run 2026-09-06 against `0x1eC142a5…3B1467` (`0.0.10395953`), the
redeployed contract after the `% 3600` removal.

## The harness bug, first, because it changes how much the earlier results are worth

Amendment 3 said: *"Mirror node is eventually consistent. The Spike 2 control GET immediately after
arming needs retry with backoff... A false alarm there would look like a design failure."*

I implemented that as **retry on a failed HTTP request**. That is half the problem, and the wrong
half. The mirror also returns a perfectly good `200` carrying **stale data**, and no amount of
retrying-on-error catches it.

It bit on the first run of 5a. The redirect delete returned code `22`, and the immediate read said
`deleted: false`. Recorded as a FAIL. Re-read seconds later by hand:

```
0.0.10395956   deleted: true   executed_timestamp: null
```

The delete had worked all along. A single read had turned a passing result into a failing one —
exactly the false alarm the amendment was written to prevent, arriving through the door I left open.

**Fixed** with `mirrorGetUntil(path, predicate)` in `lib.cjs`, which polls until a *condition* holds
rather than until a request succeeds, and reports how long it waited. Both directions of assertion
use the same primitive:

- confirming a change — `settled === true` means it landed
- confirming stability — `settled === false` after the full window means it never happened

**Spike 4 was re-run against the fixed harness**, because there the staleness biases the *dangerous*
way: a successful attack would have shown up as a refusal, a false PASS on a security test. Re-run
with a 17.5-second polling window per cell, all four cells still refused. New schedule
[`0.0.10396004`](https://hashscan.io/testnet/schedule/0.0.10396004), fresh attacker EOA
`0xA3Fd4Ea7…13377E`, fresh attacker contract `0xF2f33ec6…a7De25`. The conclusion stands; now it
stands on evidence that survives a lagging mirror.

Spike 2 did not need re-running: it asserted `deleted: true`, and staleness there produces a false
*failure*, not a false pass. It passed, so it passed.

## 5a — the owner contract CAN cancel via the redirect path

Schedule [`0.0.10395984`](https://hashscan.io/testnet/schedule/0.0.10395984),
[tx](https://hashscan.io/testnet/transaction/0x157d63f46c318edd8001a07e74b3610eda13bdd90dab164f253a546fec2b4d3f).
`callOk=true`, code **22**, `deleted: true`.

Spike 2 stopped at the first success — correctly — which left `0xc61dea85` written and never run.
Now both delete paths are exercised from the owner contract. We have a real fallback rather than an
untested branch, which matters because the redirect form is the one HIP-1215 describes as available
to *"a contract or EOA"* and is therefore the more likely of the two to change behaviour.

## 5b — the deploying EOA CANNOT delete its own contract's schedule

Schedule [`0.0.10395988`](https://hashscan.io/testnet/schedule/0.0.10395988). Both paths, from the
operator key that deployed the contract:

| Path | tx status | `call_result` | code | After 17.5 s of polling |
|---|---|---|---|---|
| `0x16b deleteSchedule(address)` | 1 (SUCCESS) | `0x…07` | 7 | not deleted — **refused** |
| redirect `deleteSchedule()` | 1 (SUCCESS) | `0x…07` | 7 | not deleted — **refused** |

`INVALID_SIGNATURE` again. Deploying the contract buys no privilege over the schedules it creates.

**This is a property worth stating in the pitch, not a footnote.** Once a hold is open, *we* cannot
cancel the buyer's refund either. Not the operator, not the deployer, not a key we hold in a `.env`.
The guarantee is not "nobody has to act" resting on "and we promise not to interfere" — the interfere
option does not exist. Every other design in the README's comparison table has an operator who could,
in principle, be compelled.

## 5c — the authorisation model, read rather than inferred

Spike 4 inferred the rule from a response code. The mirror node states it outright, in a field we had
not looked at:

```
admin_key: { "_type": "ProtobufEncoded", "key": "0a0518b1c2fa04" }
```

Decoded byte by byte — `0a` = `Key.contractID`, wire type 2, length 5; `18` = `ContractID.contractNum`,
varint `b1 c2 fa 04` = **10395953**:

```
admin_key        ContractID 0.0.10395953
victim contract             0.0.10395953    <- identical
creator_account             0.0.10393158    (operator EOA, paid for the arming tx)
payer_account               0.0.10395953    (the CONTRACT, pays at execution)
```

**The admin key on a `scheduleCall` schedule is the creating contract's ContractID.** Direct
evidence. The decoder is committed in `scripts/spike5-close-caveats.cjs` so nobody has to take my
word for the varint.

`payer_account_id` being the contract is the on-chain confirmation of the brief's failure mode 3:
the contract pays at execution, so an empty contract means a refund that silently does not fire.

## Caveat ledger

| Caveat | Status |
|---|---|
| Admin-key rule inferred, not read | **Closed** — 5c, read from the schedule record |
| Redirect cancel path never exercised by the owner | **Closed** — 5a, code 22 |
| Deploying EOA never tested | **Closed** — 5b, refused on both paths |
| Mirror-node staleness could mask a result | **Closed** — harness fixed, spike 4 re-run |
| Jitter fallback never executed | **Open.** Needs a mocked HSS. Wednesday. |
| Claim/refund same-second race | **Open.** A `HoldEscrow` concern, not a spike. |
| One observation, uncongested testnet | **Open by nature.** Rehearse cold three times before the demo. |

Two of the remaining three are `HoldEscrow` work rather than spike work. The jitter fallback is the
only one that is genuinely a gap in what we have built, and it is the one the README names first.
