# Spike 10 — will Blocky402 pay into a contract?

**Verdict: YES, verified and settled end to end.** Run 2026-09-08.
**Escrow-as-`payTo` is viable, and spike 9's recommended design is unblocked.**

This was the highest remaining risk after [spike 9](09-settlement-atomicity.md): the settlement
cannot call `openHold`, so the design depends on the escrow being the x402 `payTo`. If the
facilitator refused contract destinations, that fallback died too and the seller would have had to
hold the buyer's money — the exact gap this project exists to close.

---

## 10a — `/verify`, with a control

| | `payTo` | HTTP | Response |
|---|---|---|---|
| **Control** — plain account | `0.0.10393158` | 200 | `{"isValid":true,"payer":"0.0.10418440"}` |
| **Subject** — contract | `0.0.10418229` | 200 | `{"isValid":true,"payer":"0.0.10418440"}` |

The control matters: a rejection of the subject would otherwise be equally explainable by a
malformed payload. The control passing proves the payload shape is right, so the subject's `isValid`
is about the destination and nothing else.

Payloads were real: a partially-signed `TransferTransaction` with the transaction ID belonging to
Blocky402's advertised fee payer `0.0.7162784` and the buyer's signature authorising the debit —
the fee-delegation shape `@x402/hedera` expects.

## 10b — `/settle`, the real thing

`/verify` checks policy. `/settle` submits. Those can differ, and finding that out on demo day would
be the worst possible moment, so the payment was actually settled.

```
POST /verify  ->  200  {"isValid":true,"payer":"0.0.10418449"}
POST /settle  ->  200  {"success":true,
                        "transaction":"0.0.7162784@1788854559.596024460",
                        "network":"hedera:testnet","payer":"0.0.10418449"}
```

On chain, [`0.0.7162784-1788854559-596024460`](https://hashscan.io/testnet/transaction/0.0.7162784-1788854559-596024460):

```
CRYPTOTRANSFER  SUCCESS  1788854567.577748523   fee 248,716 tinybar
    0.0.10418229  +10,000,000      <- the CONTRACT
    0.0.10418449  -10,000,000      <- the buyer
```

**A real x402 payment, settled through Blocky402, landing in a contract.** 0.1 HBAR, buyer to
escrow, no intermediary holding it.

Evidence: [`spike10-result.json`](spike10-result.json), [`spike10b-result.json`](spike10b-result.json).

### Three details worth keeping

**The transaction ID account is `0.0.7162784`** — Blocky402's advertised fee payer, and the fee of
248,716 tinybar was charged to it, not to the buyer. Fee delegation works exactly as the `/supported`
response claims. This is also **the artefact that proves track qualification**: the Hedera track
requires settlement through Blocky402, and a settle transaction whose fee payer is `0.0.7162784` is
what demonstrates it. Every hold we open in the demo should have one of these behind it.

**`receive()` did not run — on the real settlement path.** `receiveCalls` stayed at 1 across the
settlement. Spike 9 established this with a hand-built HAPI transfer; this confirms it through
Blocky402's own submission, which is the version that actually matters. The escrow will be credited
without executing, exactly as the design now assumes.

**A `CRYPTOUPDATEACCOUNT` immediately precedes the transfer**, at `...522` against the transfer's
`...523`. That is the buyer's hollow account being completed by its first signed transaction — a
fresh Privy wallet's first payment will do the same thing, so it is worth recognising rather than
mistaking for something going wrong.

---

## What this settles

| Question | Answer |
|---|---|
| Can the settlement call `openHold`? | **No** — [spike 9](09-settlement-atomicity.md) |
| Can the escrow be the `payTo`? | **Yes**, verified and settled |
| Does the escrow get credited? | **Yes**, exactly the requested amount |
| Does crediting run contract code? | **No**, confirmed twice on two paths |

So the design stands as spike 9 recommended: the x402 `payTo` is the escrow, the seller never holds
the money, and `openHold` is a non-payable call that arms a refund against already-credited funds.

Plan 04 §8.8 is answered. **Nothing now blocks writing `HoldEscrow.sol`** except Igor's re-review of
the §8.1 correction, which changed `openHold`'s signature.

## Scope note

Spike 10a called `/verify` only. Spike 10b deliberately went further and **settled a real payment**,
because verify-passing-but-settle-failing was a live possibility and the whole point of this exercise
is to stop discovering those late. 0.1 testnet HBAR, from a throwaway buyer we funded, into a
contract we own, both ends ours. It doubles as a rehearsal of the track's "at least one real paid
request end to end" requirement, though that one must run through our own resource server to count.

## Still not proven

- **Through our own x402 resource server.** This exercised the facilitator directly. The
  `@x402/express` server path, the 402 challenge, and the agent client are all still to be built,
  and the track requires the request to go through them.
- **With a hold attached.** This settled into a bare `ValueSink`, not into `HoldEscrow` with an
  `openHold` following it. The two-step sequence is designed but not yet demonstrated.
- **Repeatedly, or under load.** One settlement, one moment.
