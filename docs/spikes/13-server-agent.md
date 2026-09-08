# The x402 resource server and the paying agent

**Three scenarios run against the live testnet escrow, all three behaving as designed.**
2026-09-08. Escrow `0xc5241034C7c060361B0223B3c6d77d0A4bC8Ef09` = `0.0.10419881`.

| Scenario | Hold | Schedule | Outcome |
|---|---|---|---|
| Seller delivers | 8 | [`0.0.10420568`](https://hashscan.io/testnet/schedule/0.0.10420568) | `deleted: true`, never executed → **CLAIMED**, agent decrypted |
| Seller goes dark | 9 | [`0.0.10420577`](https://hashscan.io/testnet/schedule/0.0.10420577) | executed `1788866129`, `signatures: []` → **REFUNDED** |
| **Server killed mid-flight** | 11 | [`0.0.10420624`](https://hashscan.io/testnet/schedule/0.0.10420624) | executed `1788866377`, `signatures: []` → **REFUNDED** |

All three holds ended with `amountTinybar: 0` — every hold paid out exactly once.

## The flow, as built

```
1. agent GET /premium              -> 402 with payment requirements, payTo = THE ESCROW
2. agent signs a transfer, retries with X-PAYMENT
3. server verifies via Blocky402   -> isValid
4. server does the work, encrypts it with a fresh key k
5. server settles into the escrow  -> the money is in the escrow, never in the seller's hands
6. server calls openHold           -> refund armed, H(k) H(C) H(m) H(request) committed
7. server answers with C           -> the agent has the ciphertext and NOT the key
8. server calls claim(holdId, k)   -> k becomes public, the seller is paid
9. agent reads k from the event, decrypts
```

Step 8 is the only step that can be skipped, and skipping it is what the whole design is about.

## Scenario 1 — the seller delivers

```
402: 0.5 HBAR to 0.0.10419881 (the escrow)
paid. hold 8, schedule 0.0.10420568
got 319 bytes of ciphertext, and no key
H(C) matches the commitment: true
seller revealed the key on-chain. H(k) matches: true
decrypted:
    { "query": "what is the airspeed velocity of an unladen swallow", ... }
```

The agent checked `H(C)` against the on-chain commitment **before** it had any key — so it knew the
seller had committed to the exact bytes it was handed, and only later found out whether the key
opened them. The schedule shows `deleted: true, executed_timestamp: null`: the refund was cancelled
rather than raced.

## Scenario 2 — the seller goes dark

`POST /admin/dark {"on":true}` flips the server at runtime, so it can be done on camera without a
restart. It then does everything except reveal the key.

```
paid. hold 9, schedule 0.0.10420577
H(C) matches the commitment: true
the seller never revealed the key.
the NETWORK refunded us. We did nothing. Balance 2 HBAR -> 2 HBAR
```

## Scenario 3 — the server is killed while holding the key

This is the demo, and it is a stronger claim than scenario 2: the seller was **alive, willing, and
about to reveal**. `SELLER_CLAIM_DELAY_SECONDS=40` opens the window; the process was killed inside it.

Server log, up to the moment it died:

```
payment verified from 0.0.10420404
settled 0.0.7162784@1788866307.418172063 -> escrow 0.0.10419881
hold 11 armed for 1788866377, schedule 0.0.10420624
holding the key for 40s — kill me now and the refund still lands
                                                    <- process killed here
```

Then, with nothing of ours running:

```
the seller never revealed the key.
the NETWORK refunded us. We did nothing. Balance 2 HBAR -> 2 HBAR
```

Schedule `0.0.10420624`: executed `1788866377.020796208`, `signatures: []`.

**The first attempt at this test was invalid and is worth recording.** Stopping the background task
killed the wrapper shell but not the node child, so the previous server — which was still in dark
mode — kept the port, and the new server failed to bind. The refund fired because of the dark flag,
not the kill, and the run proved nothing. Freeing the port properly and asserting `dark: false` on
`/health` before starting is what made the second attempt mean something.

## Two implementation notes a reviewer will ask about

**Why not `@x402/express`?** Its `paymentMiddleware` settles *after* the handler's response body is
finalised. We need `openHold` sequenced between settlement and the reply, because the reply carries
the `holdId` the agent watches. So the server drives `@x402/core`'s official `HTTPFacilitatorClient`
directly and keeps Express for HTTP — same facilitator, same wire format, explicit ordering.

**Why does the agent poll REST instead of subscribing to events?** `eth_getLogs` fails on HashIO for
this contract with `could not coalesce error` on every block range tried, so `queryFilter` cannot be
used. The agent reads the same logs from the mirror node instead. A follow-on trap: the mirror's
`topic0`/`topic1` query parameters only work alongside a timestamp range — supplied alone they
silently return nothing, which reads exactly like "the event has not happened yet". The agent fetches
a page and filters client-side.

## `H(request)` has to include the settlement id

An early version hashed only the method and URL. Two agents asking the same question would then
produce the same `H(request)`, and the second `openHold` would revert with `RequestAlreadyHeld` — the
replay guard firing on an honest request. It now hashes `METHOD url | settled:<txId>`, which is
unique per payment and binds the hold to the payment that funded it.

## What is still missing

- **Not a public deployment.** This ran on localhost against testnet. The finalist track needs a real
  URL, and the brief wants one up early rather than on the last day.
- **The agent is a one-shot loop**, not the continuous traffic the demo needs. `AGENT_ROUNDS` exists;
  it has only been run at 1.
- **No `verify.ts`.** The four commitments are being written to the log and the agent checks `H(C)`
  and `H(k)` inline, but the standalone buyer-side tool that catches a lying seller does not exist.
- **The lying-seller path is unexercised.** The agent has the branch for "revealed key does not
  decrypt the ciphertext" and nothing has ever made it run.
- **No HCS receipts, no live board, no Privy.**
