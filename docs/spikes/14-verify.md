# `verify.ts` — catching a lying seller, demonstrated

**Four scenarios run against the live escrow. The tool names the broken commitment every time.**
2026-09-08. Escrow `0xc5241034C7c060361B0223B3c6d77d0A4bC8Ef09` = `0.0.10419881`.

| Seller | Hold | On-chain outcome | `verify.ts` verdict |
|---|---|---|---|
| honest | 13 | CLAIMED, seller paid | everything holds up |
| `wrong-key` | 14 | **CLAIMED, seller paid** | **the revealed key does not open the ciphertext** |
| `wrong-cipher` | 15 | CLAIMED, seller paid | H(C) — committed to a ciphertext it did not send |
| `wrong-plain` | 16 | CLAIMED, seller paid | H(m) — it opened, to different plaintext than committed |

**In all four the chain is happy and the seller is paid.** That is the point. The contract enforces
exactly one of the four commitments — `keccak256(k)` against the committed `H(k)` — and it cannot
decrypt, so it cannot know whether the key it accepted opens the buyer's ciphertext.

## The cheat the design exists for

`SELLER_CHEAT=wrong-key`: encrypt `C` with `k1`, commit and reveal `k2`.

```
[ OK  ] the seller's HTTP response matches what it committed on-chain
[ OK  ] H(request) — this hold answers OUR request
[ OK  ] H(C) — the seller committed to the ciphertext it sent us
[ OK  ] H(k) — the revealed key matches its commitment
         enforced on-chain by claim(); consistent
[FAIL ] the revealed key OPENS the ciphertext
         the key was accepted on-chain and does NOT decrypt what we were given
[  –  ] H(m) — cannot check; it did not open

VERDICT: THE SELLER CHEATED. 1 commitment broken.
```

Five checks pass, including the only one the contract makes. `claim()` accepted the key, deleted the
schedule, and paid the seller. Everything on-chain is consistent — and the buyer provably cannot read
what it bought.

This is the argument for four commitments rather than one, and it is now demonstrated rather than
asserted.

## What each cheat proves

**`wrong-cipher`** — the seller commits `H(C')` and sends `C`. `verify` reports:

```
committed 0xc38a60876d2a969a… but we hold bytes hashing to 0xdce0479729d04f88…
```

The revealed key still decrypts the ciphertext we hold, so a naive buyer sees a working purchase.
What it cannot do is prove *which* bytes the seller stood behind — and now it can.

**`wrong-plain`** — everything opens, but the recovered plaintext is not what was committed:

```
committed 0x76d4ab955eba0bf0… but it decrypts to something hashing to 0xe58c2bb1b362ad34…
```

## The check that is not about cryptography

`verify.ts` also compares the commitments the seller returned **over HTTP** against the ones actually
in the `HoldOpened` log. A seller could report honest-looking commitments in its response while
committing something else on-chain; the log is what counts, and the HTTP claim is not evidence. It
passed in all four runs — including the three where the seller was lying in other ways, which is
worth knowing: these cheats are on-chain lies, not response-body lies.

## What it deliberately does not catch

**Garbage.** A seller can encrypt nonsense, commit to the hash of that nonsense, reveal the right
key, and pass every check here. `verify.ts` proves the seller delivered *the thing it committed to*,
not that the thing is any good.

That limit is on the first screen of the README and it is the honest boundary of the design. Closing
it needs ZKCP or an optimistic fraud-proof window, and the fraud-proof route is the documented next
step precisely because the challenge window would be a second HIP-1215 schedule — the same primitive,
not a new keeper.

## Running it

The agent writes a receipt per purchase to `agent/receipts/hold-<id>.json`, carrying the ciphertext
it was actually handed. Then:

```bash
cd agent && npm run verify 14
```

Exit code 1 when a commitment is broken, so it drops into CI or a shell script without parsing.

It reads everything else — the commitments, the key, the hold's status — from the chain via the
mirror node. The receipt supplies only what the chain cannot know: the bytes the buyer received.

## Incidental confirmation

The `wrong-plain` run initially failed to purchase at all:

```
payment rejected (402): insufficient_balance: payer has 200000000 tinybars, needs 500000000
```

That is Blocky402's preflight refusing a payment the agent could not fund, before any work was done.
Not what the run was testing, but a useful sighting of the facilitator's own validation.
