# Resource server

The x402-gated endpoint. Sells a result, settles the payment **into the escrow rather than to
itself**, arms the refund, and only then reveals the decryption key.

```
GET /premium?q=...     the gated resource
GET /health            status, including whether the seller is currently dark
POST /admin/dark       { "on": true } — stop revealing keys, without a restart
```

## Running it

Needs a deployed `HoldEscrow` and a `.env` at the repo root (see `.env.example`).

```bash
cd server && npm install && npm start
```

The escrow must hold an operating float — it pays every armed refund's execution gas out of its own
balance. `/health` reports `escrowFreeTinybar`, and the server warns at boot if it is below the
reserve, because `openHold` will revert rather than under-fund a promise.

## The sequence, and why it is in this order

```
1. no X-PAYMENT            -> 402 with requirements. payTo is the ESCROW's entity id.
2. X-PAYMENT present       -> verify with the facilitator BEFORE doing any work
3. do the work, encrypt it with a fresh 32-byte key k
4. settle                  -> money lands in the escrow; we never hold it
5. openHold                -> refund armed, committing H(k) H(C) H(m) H(request)
6. respond with C          -> the buyer has the ciphertext and not the key
7. claim(holdId, k)        -> k is public in the Claimed event, we get paid
```

Verification happens before the work so we do not compute for free. Settlement happens after the
work so the buyer does not pay for a crash. `openHold` happens immediately after settlement because
that gap is the one window in the design where the money is unprotected — it is one transaction wide
and it is disclosed in the top-level README.

## Two things that look like mistakes and are not

**`openHold` is not payable and the server sends no value with it.** The x402 settlement is a HAPI
`CryptoTransfer`: it cannot call a contract, and crediting a contract does not run its `receive()`.
So by the time `openHold` is called the money is already in the escrow, and `openHold` attributes it
rather than receiving it. Measured in [spike 9](../docs/spikes/09-settlement-atomicity.md).

**This does not use `@x402/express`.** Its `paymentMiddleware` settles *after* the handler's response
body is finalised, and we need `openHold` sequenced between settlement and the reply because the
reply carries the `holdId` the agent watches. The server drives `@x402/core`'s official
`HTTPFacilitatorClient` directly instead — same facilitator, same wire format, explicit ordering.

## The demo switch

`DEMO_DARK=1`, or `POST /admin/dark {"on":true}` at runtime, makes the seller take the payment, arm
the refund, hand over the ciphertext, and then never reveal the key.

`SELLER_CLAIM_DELAY_SECONDS=40` is stronger and is what the video should use: the seller is alive and
fully intends to reveal, and you kill the process inside that window. The refund still lands, which
proves it needs no server rather than merely no willingness.
[The recorded run](../docs/spikes/13-server-agent.md).
