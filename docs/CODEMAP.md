# Code map — the single project reference

Every file, what it does and why it is shaped that way, plus the plan, the dates and the open gaps.
Written for Igor's review and for a judge reading the repo cold.

**This absorbed `docs/PROGRESS.md`, which is deleted.** Two documents describing one project drift,
and that one already had: it still listed `HoldEscrow.sol`, `/server` and `/agent` as "not started"
and `value`-in-tinybars as "inferred, not measured", after all four were done. Its unique content —
the day plan, the priority order, the dates and the Hedera list — is below, with the stale parts
corrected rather than copied. The original remains in git history at `5db2c03`.

### Live right now

| | |
|---|---|
| x402 endpoint | https://deadman-server.onrender.com |
| live board | https://deadman-board.onrender.com |
| escrow | `0.0.10426758` = `0x1f928BF2261979A818Ade961f3b6d8aC1AAbe860` |
| seller | `0xEDde92344632132aA349Ac02838fb8c80a44931c` — allowlisted opener, **not** the owner |
| agent wallet | `0.0.10433495` = `0x7118a1522588fa585Ae7DBfb085c5793D57DA0c1` — a **Privy** server wallet; no key on any machine of ours |

Both services come from one Render blueprint (`render.yaml`). The API is a Docker web service and
sleeps after 15 minutes idle on the free tier; the board is a static site and does not. **Measured
cold start: 52.5 seconds** — it does not shorten a hold, because the deadline is armed after the
instance is up, but it will wreck a take. Warm `/health` before filming.

### Where things live

| | |
|---|---|
| [`README.md`](../README.md) | The pitch, the limits, how to run it. The front door for a judge. |
| [`ROADMAP.md`](../ROADMAP.md) | Future ideas only. Nothing in it is claimed as implemented. |
| [`STATUS.md`](../STATUS.md) | Append-only daily log, one section per person. Where *progress* goes. |
| **this file** | The code, the plan, the dates, the open gaps. |
| [`docs/video-script.md`](video-script.md) | The 2–4 minute script, and the pre-flight list that matters more than the words. |
| [`docs/plans/`](plans/) | Seven plans, each committed **before** its implementation. |
| [`docs/spikes/`](spikes/) | Fifteen reports with the raw mirror-node JSON behind every number. |
| [`docs/deploy.md`](deploy.md) | Deployment, secrets, and what a hold actually costs. |
| [`docs/checkins/`](checkins/) | ETHGlobal check-in text. |
| [`docs/SESSION-01.md`](SESSION-01.md) | The spike session write-up. |

**Roughly 1,580 lines of Solidity, 3,000 of scripts, 790 of TypeScript services, 360 of tests**, plus
fifteen spike reports with the raw mirror-node JSON behind every number quoted anywhere.

The single most useful thing to know: **almost every unusual decision in this codebase traces to a
measurement, and the measurement is cited at the line that depends on it.** Hedera's EVM differs from
the one you expect in ways that are silent rather than loud, and this repo is mostly a record of
finding that out.

---

## `/contracts` — the chain side

### `contracts/HoldEscrow.sol` — 784 lines, the product

The escrow. An x402 payment settles into it, `openHold` arms a HIP-1215 scheduled call to `refund()`,
and `claim()` pays the seller and deletes that schedule. If nobody acts, the network refunds.

The header carries a constraint list `C1`–`C12`, each with the spike that established it, and each is
referenced again at the line it governs. The ones that shape the code:

| Function | The thing that is not obvious |
|---|---|
| `openHold` | **Not payable.** x402 settles with a HAPI transfer that cannot call a contract and does not run `receive()`, so the money is already here and this *attributes* it: `free = balance − totalLocked − totalWithdrawable`. |
| `claim` | Reverts unless `deleteSchedule` returns **22**. A rejected delete is a silent no-op with transaction status SUCCESS — discard that code and the hold pays out twice. |
| `refund` | **Cannot revert after its state transition.** A scheduled execution cannot be un-fired, so a revert strands the hold forever. Bounded 30k payout stipend, credit-on-failure, no `require` after the CAS. |
| `_transition` | One compare-and-set, before any external call. `OPEN` is only ever written to a fresh monotonic id, so `CLAIMED`/`REFUNDED` are terminal by construction rather than convention. |
| `_findAvailableSecond` | HIP-1215's own backoff, seeded from `prevrandao` (measured identical to the `0x169` PRNG on Hedera), skipping minute boundaries. |
| `_requiredReserveTinybar` | Scales with `openHoldCount`. A flat floor would let the hundredth armed refund silently fail to fire. |
| `_consume` | The one place a hold's money is retired. Zeroing the amount here is a second line of defence behind the CAS — and the adversarial suite proved removing the CAS alone is not enough to double-pay. |
| `sweepReserve` | Bounded by `operatingFloatTinybar`, which only deliberate deposits increase. A settled payment arrives without executing code, so it can never be swept. |
| `_reconcileFloat` | Clamps that float down to reality. Refund gas leaves the balance unobserved, and an overstated float would re-open the hole it closed. |

`REFUND_GAS = 250_000` is 2.0x the measured worst case of 122,847 — not the estimate it replaced.

### `contracts/SpikeSchedule.sol` — 549 lines, throwaway

The de-risking rig. Raw `call`s to `0x16b` so returndata survives into an event, both halves of every
return asserted, `probeRandomness()`, `deleteThenRevert()` and `alwaysReverts()` for spikes 7 and 8.
Kept because the spike reports cite it.

### `contracts/ValueSink.sol`, `contracts/Attacker.sol` — 112 lines

Measurement instruments. The sink records `msg.value` and its own balance in one event, which is what
made the tinybar/weibar question answerable. The attacker is an unrelated contract that tries to
delete somebody else's schedule.

### `contracts/test/MockHSS.sol` — 135 lines

A stand-in Schedule Service planted at `0x16b` with `hardhat_setCode`. It exists to reach three
things the real network will not give us: a **saturated second**, a **zero schedule address returned
with code 22**, and a **refused delete**. Every default is expressed as "zero storage means healthy",
because `setCode` plants code without running a constructor.

### `contracts/test/Mutants.sol` — the deliberately broken builds

Five subclasses of `HoldEscrow`, one guard removed each, so every adversarial test can be shown to
fail before it is trusted to pass. `NoCasCheck`, `NoCasNoZero`, `IgnoresDeleteCode`, `PushOrRevert`,
`FlatReserve`, plus a `NoReceiver` payee. Never deployed.

### `test/HoldEscrow.test.cjs` and `test/adversarial.test.cjs` — 53 tests

Includes the only coverage the capacity/jitter path has, and the mutation-tested adversarial suite
([write-up](spikes/15-adversarial.md)), which found a real sweep vulnerability. Explicitly does
**not** prove Hedera's unit semantics — locally balances are wei — and 4.1 is a same-block test of
the compare-and-set, not a race against Hedera's scheduler.

### `scripts/` — 2,900 lines

`lib.cjs` is the shared spine: mirror-node access with `mirrorGetUntil(path, predicate)`, which polls
until a *condition* holds rather than until a request succeeds. That distinction cost a false result
once and the comment explains why.

| | |
|---|---|
| `verify-selectors.mjs` | Step zero. Recomputes every `0x16b` selector and refuses to let a deploy proceed on a mismatch. |
| `deploy-escrow.cjs`, `deploy.cjs` | Deploy and fund. Asserts the float landed rather than assuming. |
| `provision-seller.cjs` | Generates a least-privilege seller key, allowlists it, asserts it is **not** the owner. |
| `spike1`…`spike10b` | One script per spike, each with its own control. |
| `units-probe`, `gas-probe`, `measure-gas`, `measure-refund-worstcase` | The measurements the contract's constants come from. |
| `e2e-settle-open-refund.cjs` | Settle → openHold → unattended refund, as one sequence. |

---

## `/server` — the x402 resource server

**`src/index.ts` (346)** — the seven-step flow: 402 → verify → work → encrypt → settle → `openHold` →
answer → `claim`. Two deviations documented at the call site:

- **Not `@x402/express`.** Its middleware settles *after* the response body is finalised, and
  `openHold` must sit between settlement and the reply because the reply carries the `holdId`. Uses
  `@x402/core`'s official `HTTPFacilitatorClient` directly.
- **`/admin/dark` is token-gated and fails closed** when `ADMIN_TOKEN` is unset.

Demo switches: `DEMO_DARK`, `SELLER_CLAIM_DELAY_SECONDS` (the window to kill the process in), and
`SELLER_CHEAT` (`wrong-key` / `wrong-cipher` / `wrong-plain`) so the lying-seller path is exercisable
rather than theoretical.

**`src/shared.ts` (200)** — the escrow ABI, mirror access, the commitment scheme and AES-256-GCM.
Shared with the agent deliberately: a disagreement about how `H(C)` is computed would look exactly
like a lying seller. Also loads `.env` from the repo root, because `dotenv/config` resolves against
the working directory and silently found nothing.

**`Dockerfile`, `../render.yaml`** — the blueprint behind the two live services above. One `render.yaml`
produces both: the API as a Docker web service and the board as a static site.

---

## `/agent` — the paying client

**`src/index.ts` (221)** — pays, then watches. It checks `H(C)` against the on-chain commitment
*before it has any key*, then waits for either outcome. Neither outcome requires it to act.

It reads events from the **mirror node**, not `eth_getLogs`, which fails on HashIO for this contract
on every range tried. Second trap in the same area: the mirror's `topic0`/`topic1` filters only work
alongside a timestamp range and silently return nothing otherwise — so it filters client-side.

**`src/signer.ts`** — where the agent's key lives, behind one interface with two backends. `local`
reads `AGENT_PRIVATE_KEY`; `privy` holds no key at all and signs by API call. Set `PRIVY_WALLET_ID`
to pick the second. The non-obvious part is that x402 on Hedera pays with a native
`TransferTransaction`, so Privy's EVM signing methods are the wrong shape and the bridge is raw
`secp256k1Sign` over `keccak256(bodyBytes)`. It also recovers the wallet's public key from a
signature — Privy does not return one, Hedera needs it — and refuses to continue unless that key
derives the wallet's own address.

**`src/privy-*.ts`** — provisioning and the evidence behind [spike 16](spikes/16-privy.md).
`privy-wallet.ts` creates or shows the wallet, `privy-fund.ts` funds it (a new address needs a gas
limit far above 21,000; creation is charged 607,854), `privy-hedera-spike.ts` proves the signing
bridge, `privy-policy-spike.ts` runs the policy matrix, `privy-wildcard-retest.ts` re-runs the one
cell that first came back inconclusive, and `privy-apply-policy.ts` sets the final policy.

**`src/verify.ts` (221)** — the buyer's proof tool. The contract enforces one of the four commitments
and cannot decrypt, so it cannot know whether the key it accepted opens the ciphertext. This reads
the authoritative commitments from `HoldOpened`, the key from `Claimed`, and names the broken
element. Proven against three real cheats where the chain was happy and the seller was paid.

---

## `/web` — the live board

**`index.html`** — one file, no build, no framework, no backend.

It reads the Hedera mirror node **directly from the browser** and never calls our resource server.
That is the single most important thing about it: the demo shuts our own infrastructure down, and a
board that went down with it would destroy its own evidence. Served as a Render static site, which
on the free tier does not sleep — so it stays up while the API sleeps, which happens to be exactly
the picture the demo wants.

Built around the trap [spike 8](spikes/08-scheduled-revert.md) found: a network-executed call does
**not** appear under `/contracts/{address}/results`. Reading the refund from there would show it
never happened. The path is schedule record → `executed_timestamp` → `/transactions?timestamp=`, and
the refund line renders `signatures: []` because that field is the product.

Event data is decoded by slicing fixed-width hex words rather than bundling ethers — every field
needed is a static 32-byte word. The decoding was validated against live logs in node before being
written into the page.

## `/docs`

`plans/` (seven, each committed **before** its implementation, per the ETHGlobal attribution rule),
`spikes/` (fifteen reports plus raw JSON), `deploy.md`, `checkins/01.md`, `SESSION-01.md`.

`docs/reviews/` is **empty** — Igor has not reviewed plan 04 or `HoldEscrow.sol`, and both were
written after the gate Alex set.

---

## What is built, and what is not

**Working, publicly deployed:** the contract, the resource server, the agent, `verify.ts`, the live
board, and the whole path from a real x402 payment through Blocky402 to a network-executed refund
with `signatures: []`. Verified against the public host, not only locally.

**Privy, working:** the agent's key does not exist locally. It is a Privy server wallet, and the
x402 payment — a Hedera-native `TransferTransaction`, not an EVM one — is signed through Privy's raw
`secp256k1Sign`. Proven end to end against the public host (hold 4, schedule `0.0.10433614`). The
spend policy is the honest half: **it cannot bind this rail**, because raw signing has no
`PolicyMethod` and the wildcard that permits it also voids the cap. Measured, tabulated and reported
in [spike 16](spikes/16-privy.md) rather than papered over.

**Not built in the current scoped deliverable:** HCS receipts and the demo video. Ideas outside
that scope live in the [roadmap](../ROADMAP.md) and are not implementation claims.

**Not yet run:** the kill test against the *public* host. It needs someone to hit **Suspend** in the
Render dashboard while a hold is armed and the seller is willing — a dashboard action, so it is the
one scenario that cannot be driven from here.

**Known limits, all in the README:** a hold costs the seller ~1.9 HBAR so this does not work for
micro-payments; the refund is armed one transaction *after* the money lands, not atomically; the
saturated-second path has never run on a real network; and we guarantee delivery, not correctness.

---

## The plan

| Day | Alex | Igor | Frontend | Media |
|---|---|---|---|---|
| **Mon 8** | ~~`HoldEscrow.sol`~~ **done** — plus server, agent, verify.ts, all working on testnet | **Design review — NOT done.** `docs/reviews/` is empty | ~~Privy wallet on chain 296, alias activation~~ **done Wed** | Storyboard, README first screen |
| **Tue 9** | ~~x402 server through Blocky402~~ **done**, fee-payer gate check confirmed | Start adversarial tests | Board shell, first hold rendering | 30-second cut, tested on an outsider |
| **Wed 10** | ~~First real paid request end to end~~ **done Monday**; ~~the public deploy~~ **done** | **Contract review**, plus the mocked HSS (mock exists, 28 tests) | ~~Privy spend policy on the agent~~ **attempted, and it cannot bind this rail — [spike 16](spikes/16-privy.md)** | Draft both partner write-ups against the rubrics |
| **Thu 11** | HCS receipts on every state change | Finish adversarial tests, commit them | Countdown timers, mirror links, infra status panel | Rough cut |
| **Fri 12** | **Feature freeze.** Clean-clone test. Both `FEEDBACK.md` files | **Whole-repo review from a clean clone** | Polish, mobile, empty states | Cut to 4 minutes, **test upload** |
| **Sat 13** | Limits, hygiene gate, AI plan files. **Submit tonight** | Rehearse the shutdown demo three times cold | Final deploy, verify from a phone | Final video rendered and uploaded |

**Wednesday's milestone landed on Monday.** One real paid request through the deployed escrow
qualifies us for the track on its own, and it is done — though it went straight to the facilitator
rather than through a *public* endpoint, so the deploy still matters.

### Priority order if time runs out

1. ~~Blocky402 works, one real paid request end to end~~ **done**
2. ~~Escrow holds the payment and the scheduled refund fires unattended~~ **done**
3. ~~Key-reveal claim that cancels the pending schedule~~ **done**
4. Privy wallet plus spend policy
5. HCS receipts
6. Live board with countdowns
7. Volume — hundreds of holds rather than a handful

**Friday evening:** decide on Bazantic as the third partner, only if the escrow works, a refund has
fired unattended, and the video is cut. The first two are already true.

## Dates

| When | What |
|---|---|
| Tue 8 Sept | Feedback Session #1. Attend with the spike results and one specific question |
| Thu 10 Sept | Feedback Session #2 |
| TBC | Check-in #1 and #2 on the hacker dashboard. Do not write "all good" — text ready in [`checkins/01.md`](checkins/01.md) |
| **Sun 13 Sept, 12:00 ET** | **Submissions due.** Non-negotiable, never extended. We submit Saturday night |
| Mon 14 Sept, 12:00–14:00 ET | Finalist judging call, 7 minutes live, if we opt in. Missing it disqualifies us |
| Wed 16 Sept, 12:00 ET | Closing ceremony |

## Still open, and named

| Gap | Why |
|---|---|
| **No public deployment** | The single qualification gate still unmet. `render.yaml` has never been applied; it needs a hosting account. |
| Igor's review | Superseded — Alex is doing the review work himself, and the adversarial suite (plan 09) is the first half of it. |
| The saturated-second path has never run on a real network | Testnet is uncongested. The minute-boundary skip *has* fired on testnet; the congestion branch has only the mocked HSS. |
| Claim and refund in the same second | Both paths work in isolation; nothing has forced a collision. Belongs in the adversarial tests. |
| No public deployment | Prepared — Dockerfile, blueprint, least-privilege key, admin auth. Needs a hosting account. |
| One observation each, uncongested testnet | Open by nature. Rehearse the demo cold three times. |

## For the Hedera session

1. A rejected `deleteSchedule` returns transaction SUCCESS. The official `payments-scheduler`
   template ships a helper that discards the code and clears its bookkeeping regardless.
2. `scheduleCall` reverts with **empty returndata** when starved of gas, which contradicts how the
   HIP's "never reverts" reads. Floor ~1.45M.
3. The delete authorisation model is undocumented. We established it empirically: the admin key is
   the creating contract's ContractID, read off the schedule record.
4. `hasScheduleCapacity(now + 1)` returns false despite the HIP stating a one-second minimum, and
   false means "invalid expiry" and "saturated" indistinguishably.
5. **x402 on Hedera cannot settle into a contract call**, so no escrow or vault on that rail can
   take payment atomically. We can hand them the exact line in their reference implementation.
6. Network-executed calls do **not** appear in `/contracts/{address}/results` on the mirror node —
   a refund that fired and reverted is invisible where a dashboard would look.

One question for Luke: is the saturated-second path exercisable against testnet at all, or is a
mocked HSS the only way we test it before mainnet?
