# Deploying the resource server

**Status: prepared, not deployed.** Everything up to the account step is done and verified. The
remaining step needs a hosting account, which I do not have — see "What is blocked" at the bottom.

## What a hold actually costs — read this before setting a price

Measured on testnet, from
[a real `openHold`](https://hashscan.io/testnet/transaction/0xfab4c55649525231553e766614286987bacf65fc1a3768122e5e6b2cd6a7a7b9):

```
openHold   1,668,661 gas   charged 176,878,066 tinybar = 1.7688 HBAR   <- the seller pays this
claim        123,038 gas                                ~0.13 HBAR     <- the seller pays this
refund        46,744 gas (happy) / 122,847 (worst)      0.05–0.12 HBAR <- the ESCROW pays this
```

**A hold costs the seller about 1.9 HBAR whether it ends in a claim or a refund.** About 87% of that
is `scheduleCall`'s own ~1.45M gas floor — the HIP-1215 primitive itself, which we cannot optimise
away.

So:

- **Anything priced at or below ~2 HBAR loses money on every sale.** The 0.5 HBAR used in early
  testing was a loss-making demo; the price is now **5 HBAR**, leaving ~3.1 HBAR of margin.
- At roughly $0.05/HBAR that is **~$0.09 of protocol cost per hold**. Deadman is viable for API calls
  worth a dollar or more and **is not viable for micro-payments**, which is the segment x402 is most
  often pitched at.

That is a real limit, it is in the README, and it belongs in the Hedera write-up rather than being
left for a judge to compute. It is also the strongest argument for the fraud-proof extension: a
challenge window would reuse the same schedule rather than adding a second one.

## Two things that had to change before this could be public

**1. A dedicated seller key.** The operator key OWNS the escrow — `sweepReserve`, `setConfig`,
`setOwner`, `attributeOrphanedPayment`. Shipping it to a host means a compromised host owns the
escrow. `scripts/provision-seller.cjs` generates a separate wallet, funds it, allowlists it as an
opener, and asserts it is **not** the owner:

```
seller  0xEDde92344632132aA349Ac02838fb8c80a44931c
isOpener: true
isOwner : false
```

Its blast radius is "can open and claim holds", not "can take the float".

**2. `/admin/dark` is token-gated.** It was open. On a public URL an open version is a denial of
service on our own demo — anyone could stop the seller revealing keys. It now requires
`X-Admin-Token`, and when `ADMIN_TOKEN` is unset the endpoint is **disabled** rather than left open,
because failing closed is the only safe default for something that ships to a host.

Verified: `401` with no token, `401` with a wrong token, `200` with the right one.

## Deploy it

`render.yaml` at the repo root is a Render blueprint. Docker, so it moves to Fly or Railway without
changes — `server/Dockerfile` is the portable artefact.

1. render.com → **New** → **Blueprint** → pick `alexursol2/deadman_ethonline`
2. Set the three secrets in the dashboard (they are `sync: false` so they are never in git):

   | Secret | Value |
   |---|---|
   | `ESCROW_ADDRESS` | `0xc5241034C7c060361B0223B3c6d77d0A4bC8Ef09` |
   | `SELLER_PRIVATE_KEY` | copy from `.env` — **not** `HEDERA_OPERATOR_KEY` |
   | `ADMIN_TOKEN` | any long random string |

3. Deploy. `healthCheckPath` is `/health`, so Render will not route traffic to a broken build.
4. Point the agent at it: `RESOURCE_URL=https://<your-service>.onrender.com/premium`

**Render's free tier sleeps after 15 minutes of inactivity** and takes ~30s to wake. For the demo,
either take a paid instance or hit `/health` shortly before filming. A cold start during the video
would look exactly like the failure we are claiming to survive, which is the worst possible
confusion to introduce.

## Keeping it funded

The seller pays ~1.9 HBAR per hold and starts with 40 HBAR, so **roughly 22 holds**. The escrow
separately needs a float for refund execution and refuses to open a hold it could not afford to
refund — `/health` reports `escrowFreeTinybar` and the server warns at boot when it is below the
reserve.

Top both up before the demo. Running dry mid-recording produces a revert that reads like a contract
bug.

## What is blocked

**The deploy itself.** There are no cloud CLIs installed on this machine and no cloud credentials —
only `gh`, scoped to `repo`, `workflow`, `gist` and `read:org`. Creating a Render/Fly/Railway service
requires signing in to an account, which is Alex's to do.

Everything else is done: Dockerfile, blueprint, health check, least-privilege key, admin auth,
economic pricing, and a verified end-to-end run against the deployed escrow using the seller key.
