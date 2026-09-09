# Paying agent

Buys from the x402 endpoint and, crucially, **never has to act to protect itself**.

```bash
cd agent && npm install && npm start
```

Needs `AGENT_PRIVATE_KEY` in the repo-root `.env` — an ECDSA key whose Hedera account already
exists. Creating one needs a gas LIMIT far above a transfer's 21,000 or it fails outright; the gas
actually charged is 607,854 (measured, spike 16). Paying an address Hedera
has never seen also creates it.

## What it does

```
1. GET /premium                        -> 402 with payment requirements
2. sign a partially-signed transfer     (the facilitator pays the network fee)
3. retry with X-PAYMENT                -> ciphertext + holdId, and no key
4. check H(C) against the commitment    BEFORE it has any key
5. watch for Claimed(holdId)           -> the key, then decrypt
   or  Refunded(holdId)                -> the network already gave the money back
```

Step 5 is the point. There is no dispute API to call, no receipt to submit, no timeout to claim
against. If the seller never reveals, the agent's money comes back on its own and the agent finds
out by looking, not by acting.

Step 4 matters too: the agent verifies the seller committed to the exact ciphertext it was handed
*before* it knows whether the key works. If the key later fails to decrypt, that is a provable lie
about a specific element rather than an argument.

## Why it polls the mirror node instead of subscribing

`eth_getLogs` fails on HashIO for this contract — `could not coalesce error` on every block range
tried — so `queryFilter` is unusable and the agent reads the same logs from the mirror node.

Second trap in the same area: the mirror's `topic0`/`topic1` query parameters only work alongside a
timestamp range. Supplied on their own they return an empty list, which is indistinguishable from
"the event has not happened yet". The agent fetches a page of logs and filters client-side.

Both are recorded in [the write-up](../docs/spikes/13-server-agent.md).

## Settings

| | |
|---|---|
| `RESOURCE_URL` | endpoint to buy from |
| `AGENT_QUERY` | what to ask |
| `AGENT_ROUNDS` | how many purchases to make |
| `AGENT_PRIVATE_KEY` | the agent's own ECDSA key |
| `ESCROW_ADDRESS` | so it can watch its own holds |

## What it is not, yet

A one-shot loop, not the continuous traffic the demo needs — `AGENT_ROUNDS` exists and has only ever
been run at 1. And it has no Privy wallet or spend policy; that is the frontend's piece.
