# Spike 3 — is the x402 facilitator alive, and does the scaffold point at it?

**Run:** 2026-09-06 ~17:16 UTC. **Verdict: facilitator ALIVE. Scaffold does NOT point at it —
it needs configuring, one variable.**

## 3.1 `GET https://api.testnet.blocky402.com/supported` — raw

```
HTTP/1.1 200 OK
Server: nginx
Date: Sun, 06 Sep 2026 17:16:00 GMT
Content-Type: application/json; charset=utf-8
Content-Length: 496
Connection: keep-alive
Access-Control-Allow-Origin: *
Strict-Transport-Security: max-age=15552000; includeSubDomains
ETag: W/"1f0-WpCvI6caIqnducqt8on5k3DcDKE"
```

```json
{
  "kinds": [
    { "x402Version": 2, "scheme": "exact", "network": "eip155:80002" },
    { "x402Version": 2, "scheme": "exact", "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "extra": { "feePayer": "7B6Q2MvcJvNcy1A13wHmAzmmdo3L8DVriaXML7bvkojm" } },
    { "x402Version": 2, "scheme": "exact", "network": "hedera:testnet",
      "extra": { "feePayer": "0.0.7162784" } }
  ],
  "extensions": [],
  "signers": {
    "eip155:*": ["0xDCF7D72C2eE049DE4269ac6AAf925F33efdA18de"],
    "solana:*": ["7B6Q2MvcJvNcy1A13wHmAzmmdo3L8DVriaXML7bvkojm"],
    "hedera:*": ["0.0.7162784"]
  }
}
```

**Alive, and it advertises exactly what we need:** `hedera:testnet`, scheme `exact`, with a fee payer
`0.0.7162784`. That `extra.feePayer` is the partially-signed fee-delegation counterparty the brief
mentions — the facilitator co-signs as payer, which is why x402 on Hedera is not an EVM permit.

### Endpoint surface (existence probe only — no payment payloads sent)

| Path | GET | POST `{}` | Reading |
|---|---|---|---|
| `/supported` | 200 | — | the response above |
| `/verify` | 404 | **400** | exists, POST-only, rejected our empty body |
| `/settle` | 404 | **400** | exists, POST-only, rejected our empty body |
| `/health` | **200** | 404 | liveness probe available — use it for the demo status panel |
| `/healthz`, `/version`, `/discovery/resources` | 404 | 404 | absent |

400 rather than 404 on `/verify` and `/settle` is the answer we wanted: the full facilitator surface
is present, and the only thing we sent was `{}`.

**`/health` returning 200 is worth keeping.** The demo kills our own services on camera; the
infrastructure panel needs to show Blocky402 staying *up* while everything of ours goes red, or the
kill looks like we broke the payment rail rather than proving the refund is independent of us.

### Risk this raises

`x402Version: 2`. The client and server libraries must be on the v2 line, not v1. The scaffold pins
`@x402/core ^2.14.0` and `@x402/hedera ^2.13.2`, which match — so we are consistent today, but a
`@x402/*` v1 example copied off the internet mid-week would fail in a way that looks like a
facilitator problem. Pin exact versions in `/server` and `/agent`.

## 3.2 `npm create scaffold-hbar@latest` — the answer to the question asked

Version **0.4.0**. It is interactive, but it has a documented non-interactive mode, so no prompt
guessing was needed:

```bash
npm create scaffold-hbar@latest -- x402-scaffold --ci --yes \
  --template x402-pay-per-use --solidity-framework hardhat --frontend nextjs-app \
  --package-manager npm --skip-install --skip-hedera-skills --network testnet
```

Templates come from branches of `buidler-labs/scaffold-hbar`. Confirmed live:
`templates/x402-pay-per-use`, `templates/payments-scheduler` (labelled **"Onchain Cron Job"**),
plus blank / bridge / cross-chain-dca / hedera-demo / oracles / tokenize-subscriptions.

### Does its facilitator config point at Blocky402 by default? **No.**

The template ships **its own self-hosted facilitator** — `facilitator/` (an Express service wrapping
`@x402/hedera/exact/facilitator`) run via `docker-compose.yml` alongside MinIO, listening on
**`http://localhost:4020`**. That is the default and the whole scaffolded flow assumes it:

```
packages/nextjs/.env.example:20   FACILITATOR_URL=http://localhost:4020
packages/nextjs/services/x402/server.ts:20
    export const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4020";
```

Blocky402 appears **once in the entire template**, in `RUNBOOK.md` under a heading called
*"Optional facilitator fallback"*:

> The default is the **self-hosted** facilitator from `docker-compose.yml`. To use an external
> hosted facilitator instead (e.g. Blocky402 testnet), set `FACILITATOR_URL` in
> `packages/nextjs/.env` — this is not required for local development.

**To configure it: one variable.** `FACILITATOR_URL=https://api.testnet.blocky402.com` in
`packages/nextjs/.env`. Nothing else changes — `X402_NETWORK=hedera:testnet` already matches what
Blocky402 advertises, and the resource server pulls the fee payer from the facilitator's own
`/supported` at init (`server.ts:33-44`), so `0.0.7162784` arrives on its own. We also drop the
`FACILITATOR_ACCOUNT_ID` / `FACILITATOR_PRIVATE_KEY` pair, since we are no longer the payer — one
fewer key in the repo.

### Why this is a finding and not a footnote

The team brief says the template "ships a facilitator folder pre-configured for Hedera testnet."
That is true and misleading in the same breath: it is pre-configured for **our own** facilitator, on
localhost. The Hedera track requires settlement **through Blocky402**, and it is a gate.

Anyone following the template's happy path — including the RUNBOOK's own end-to-end verification and
`npm run x402:buy` — settles through a self-hosted facilitator and **fails the track requirement
while every test passes**. Nothing errors. There is no warning. It is exactly the kind of thing that
gets discovered on Saturday.

So: `FACILITATOR_URL` is a **gate check, not a config detail**. It goes on the integration checklist,
and the paid-request milestone does not count as met unless the settlement is verifiably Blocky402's.
Concretely — the settle transaction should show fee payer `0.0.7162784` on HashScan. That is our
proof, and it belongs in the submission.

## 3.3 Free cross-check: the "Onchain Cron Job" template's HIP-1215 usage

`templates/payments-scheduler` → `packages/foundry/contracts/ScheduledVault.sol`. First third-party
code we have seen calling `0x16b`, and it corroborates our design on the point that matters:

**It cancels its own schedule from inside the contract** (`ScheduledVault.sol:100-107`):

```solidity
function cancelNextSchedule() external onlyOwner {
    address schedule = nextSchedule;
    if (schedule == ZERO_ADDRESS) return;
    nextSchedule = ZERO_ADDRESS;
    int64 rc = HSS.deleteSchedule(schedule);
    if (rc != HSS_SUCCESS) revert ScheduledVault__ScheduleFailed();
}
```

Buidler Labs — who build Hedera's official scaffold — ship self-cancellation as a normal thing a
contract does, and treat `rc != 22` as an error rather than an expected case. **That is encouraging
for Spike 2 but it is not evidence.** A template compiles and ships whether or not the call succeeds
on live testnet, and this is precisely the assumption we refuse to take on trust. Spike 2 still runs.

Other observations:

- `executeScheduled()` is **unrestricted** — no `onlyOwner`, no sender check, on the function HSS
  calls. Independent corroboration of leaving our `ping()` open, and a hint that they did not have a
  documented sender to check against either.
- `value: 0` with the comment `// uint64: no msg.value on scheduled call`. Nobody in the ecosystem is
  demonstrating a non-zero `value`, so **our tinybar-vs-weibar question for `refund()` has no
  reference implementation to copy.** We resolve it ourselves before Wednesday.
- **No jitter and no retry.** `_schedule()` calls `hasScheduleCapacity` once and reverts with
  `NoScheduleCapacity` if it is false. Our jitter path is strictly better than the reference — worth
  a line in the write-up, and it also means nobody else's code will have shaken that path out for us.
- Uses a typed Solidity interface rather than raw calls. We keep raw calls: we want the returndata
  on failure, which is the whole reason our spike can report a code instead of "it reverted".

## Verdict

| Question | Answer |
|---|---|
| Is Blocky402 alive? | **Yes.** 200, `hedera:testnet`, scheme `exact`, fee payer `0.0.7162784`, `/verify` + `/settle` + `/health` present. |
| Does the scaffold point at it by default? | **No.** Defaults to a self-hosted facilitator at `http://localhost:4020`. |
| What does configuring it take? | One variable: `FACILITATOR_URL=https://api.testnet.blocky402.com` in `packages/nextjs/.env`. |

Risk #1 from the brief ("Blocky402 down or changed") is **not** materialised today. It is replaced by
a smaller, sharper one: the default path silently fails the track gate, so the gate needs an explicit
check rather than an assumption.
