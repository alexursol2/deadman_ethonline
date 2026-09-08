# Plan 07 — can the x402 settlement call `openHold` atomically?

**Implementing agent:** Claude Opus 5 (Claude Code). **Requested by:** Alex, 2026-09-08.
Committed before the live measurement. Raised as [plan 04](04-holdescrow.md) §8.1, the
highest-risk unknown in the design.

## Why this is the one that matters

The pitch says the payment settles **into a hold** and, *in the same transaction*, the hold books its
own refund. If settlement cannot call `openHold`, that sentence is not true as written, and the
design has a window between "money moved" and "refund armed" that nothing covers.

## Part A — what transaction does the scheme actually build? (package read)

Authoritative and free: read `@x402/hedera` rather than guess. Determine whether the exact scheme's
payment payload can be a contract call, or only a value transfer.

Checks:
1. Which Hedera transaction types the package constructs.
2. What the client-side signer produces for a payment payload.
3. Whether the facilitator's verification accepts anything other than a transfer.

## Part B — does a HAPI `CryptoTransfer` to a contract run its code? (live measurement)

This decides the fallback. If Part A says the settlement is a pure transfer, the next question is
whether the escrow can still be the x402 `payTo`: on the EVM a value transfer to a contract invokes
`receive()`, but a Hedera **HAPI** `CryptoTransfer` is not an EVM transaction and may simply credit
the account without executing anything.

The two answers lead to different designs, so it gets measured rather than assumed:

- **`receive()` runs** — the escrow can be the `payTo` and open the hold from inside `receive()`.
  Atomicity is recoverable, albeit with calldata-free arguments.
- **`receive()` does not run** — the transfer only credits the balance. The hold must be armed by a
  separate transaction, and the design has to defend the gap rather than deny it.

Method, with its own control:

1. Add a `receiveCalls` counter and event to `ValueSink.receive()`, so "did it run" is observable.
2. Deploy it fresh.
3. **Control:** an ordinary EVM value transfer via JSON-RPC. `receiveCalls` must increment — this
   proves the counter works and the contract is reachable.
4. **Subject:** a HAPI `CryptoTransfer` built with `@hashgraph/sdk`, targeting the contract's
   **account id**, submitted through a consensus node rather than the JSON-RPC relay.
5. Compare `receiveCalls` and the balance across both.

The control is what separates "HAPI transfers do not execute code" from "our counter never worked".

## What each outcome means for plan 04

| Part A | Part B | Consequence |
|---|---|---|
| Contract call allowed | — | Nothing changes. Plan 04 stands as written. |
| Transfer only | `receive()` runs | Escrow is the `payTo`; hold opens inside `receive()`. Atomic, but arguments must arrive some other way. |
| Transfer only | `receive()` does not run | **Atomicity is not available.** Plan 04 §0 and the pitch's "same transaction" claim both need rewriting, and the design needs an explicit answer for the unarmed window. |

If it is the third row, the options to weigh are:

- **(a) Server-settles-then-opens.** The resource server is the `payTo`, receives the money, and
  calls `openHold` with its own funds. **Worst option:** between the two, the seller is holding the
  buyer's money with no escrow at all — precisely the gap Deadman exists to close.
- **(f) Escrow-as-`payTo`, hold armed separately.** The x402 `payTo` is the escrow contract, so the
  transfer credits the escrow directly and the seller never holds the funds. `openHold` becomes a
  bookkeeping call that arms a refund against an already-credited balance. The window becomes "money
  in escrow, not yet armed" rather than "money with the seller", which is a far smaller claim to
  defend and needs a buyer-side recovery path for funds that are never armed.

**Expected recommendation is (f)**, but it depends on Part B and on whether the facilitator will
resolve a contract's account as a `payTo`. Both go in the report.

## Honesty requirement

If atomicity is not available, that goes in the README's limits section and in the video's
description of the mechanism, in the same words we would have used for a good result. The brief is
explicit that volunteering limits is rewarded and hiding them is not, and "in the same transaction"
is currently a load-bearing sentence in the pitch.
