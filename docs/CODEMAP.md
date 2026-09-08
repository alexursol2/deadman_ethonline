# Code map

Every file, what it does, and why it is shaped that way. Written for Igor's review and for a judge
reading the repo cold.

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

### `test/HoldEscrow.test.cjs` — 358 lines, 28 tests

Includes the only coverage the capacity/jitter path has. Explicitly does **not** prove Hedera's unit
semantics — locally balances are wei — and says so at the top.

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

**`Dockerfile`, `../render.yaml`** — deployment-ready. Not deployed; that needs a hosting account.

---

## `/agent` — the paying client

**`src/index.ts` (221)** — pays, then watches. It checks `H(C)` against the on-chain commitment
*before it has any key*, then waits for either outcome. Neither outcome requires it to act.

It reads events from the **mirror node**, not `eth_getLogs`, which fails on HashIO for this contract
on every range tried. Second trap in the same area: the mirror's `topic0`/`topic1` filters only work
alongside a timestamp range and silently return nothing otherwise — so it filters client-side.

**`src/verify.ts` (221)** — the buyer's proof tool. The contract enforces one of the four commitments
and cannot decrypt, so it cannot know whether the key it accepted opens the ciphertext. This reads
the authoritative commitments from `HoldOpened`, the key from `Claimed`, and names the broken
element. Proven against three real cheats where the chain was happy and the seller was paid.

---

## `/docs`

`plans/` (seven, each committed **before** its implementation, per the ETHGlobal attribution rule),
`spikes/` (fifteen reports plus raw JSON), `deploy.md`, `checkins/01.md`, `SESSION-01.md`.

`docs/reviews/` is **empty** — Igor has not reviewed plan 04 or `HoldEscrow.sol`, and both were
written after the gate Alex set.

---

## What is built, and what is not

**Working on testnet:** the contract, the resource server, the agent, `verify.ts`, and the whole path
from a real x402 payment through Blocky402 to a network-executed refund with `signatures: []`.

**Not built:** `/web` (live board, Privy), HCS receipts, a public deployment, and the demo video.

**Known limits, all in the README:** a hold costs the seller ~1.9 HBAR so this does not work for
micro-payments; the refund is armed one transaction *after* the money lands, not atomically; the
saturated-second path has never run on a real network; and we guarantee delivery, not correctness.
