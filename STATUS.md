# STATUS

One section per person, appended daily. Landed / next / blocked.

---

## 2026-09-06 — Alex (contract and payment path)

**Landed**

- Repo skeleton: `/contracts /server /agent /web /docs`, `.gitignore` (`.env` excluded from
  commit #1, before any key existed), `.env.example`.
- `docs/plans/01-spikes.md` — spike plan, written and committed before implementation, reviewed
  and amended by Alex in five places.
- Step-zero selector verification against HIP-1215 (`docs/spikes/00-selectors.md`). All seven
  selectors match. Two findings the brief did not carry: a second delete path (redirect
  `deleteSchedule()` on the schedule address), and `scheduleCallWithPayer` being unusable for us
  because it reintroduces a signature dependency.
- `SpikeSchedule.sol` — compiles clean, cancun. Both cancel paths, randomness probe, boundary skip.
- Deploy and spike runner scripts, with mirror-node retry/backoff.
- **Spike 3 done.** Blocky402 alive; the scaffold template does NOT point at it by default. See
  `docs/spikes/03-facilitator.md`.
- PR #1 opened.

- **Spike 1 PASSED.** Schedule `0.0.10395748` executed unattended, 4ms into its target second.
  `signatures: []`, `wait_for_expiry: true`, `pingCount` incremented. The network runs the call
  as the scheduling contract itself, so `refund()` can be gated on `msg.sender == address(this)`.
- **Spike 2 PASSED.** Schedule `0.0.10395764` cancelled by the contract that armed it, code 22,
  stayed dead past its expiry second. Risk #2 does not materialise; the happy path holds.
- Two bugs found and fixed on the way: EVM balances are tinybars not weibars, and `scheduleCall`
  needs ~1.45M gas of its own and reverts with empty returndata when starved.

**Next** — Igor's Monday design review. Then `HoldEscrow.sol`, which is NOT started.

**Blocked** — nothing.

- **Spike 4 PASSED (the DoS question).** No third party can delete our schedule — unrelated EOA and
  unrelated contract, both delete paths, all four rejected with `INVALID_SIGNATURE`. Deletion is
  gated on the schedule's admin key, which is the creating contract. `refund()` is safe.
  Nastier sub-finding: a rejected delete returns SUCCESS at the transaction level and reports the
  refusal only in the return code. Discard the code and the hold pays out twice.

- **Spike 5 PASSED (caveat closure).** The owner contract can also cancel via the redirect path
  (code 22). The DEPLOYING EOA cannot delete its own contract's schedule — `INVALID_SIGNATURE` on
  both paths, so not even we can cancel a buyer's refund. `admin_key` decoded off the schedule
  record is the creating contract's ContractID: evidence, not inference.
- **Harness bug found and fixed.** Amendment 3's backoff only retried on HTTP errors; a 200 carrying
  stale data recorded a successful delete as a failure. Now polls on a predicate. Spike 4 re-run
  against the fixed harness, because there the staleness biased toward a false PASS.
- `% 3600` boundary check removed — dead code, it could never fire.
- Session summary written: `docs/SESSION-01.md`.

## 2026-09-07 — Alex (contract and payment path)

**Landed**

- **Spike 6 PASSED.** `scheduleCall`'s `value` is **tinybars**, measured not inferred: value 3e8
  landed exactly 3 HBAR at the recipient. No change to `refund()`. Schedule `0.0.10412082`.
- The unit rule is now complete and measured on every surface: everything inside the EVM
  (`balance`, `msg.value` on both normal and scheduled calls, `scheduleCall`'s `value`) is
  tinybars; everything over JSON-RPC is weibars; the boundary converts by exactly 1e10.
- `msg.sender` of a scheduled call confirmed against a THIRD-PARTY target — it is the scheduling
  contract, not the target. Spike 1 could not distinguish these because it called itself.
- Execution gas measured: a value-carrying scheduled call consumed ~132k gas / 0.1389 HBAR, and the
  network charges for gas used rather than the limit requested.

## 2026-09-09 — deployment, board, submission material

**Landed**

- **PUBLIC DEPLOYMENT LIVE — the qualification gate is met.** One Render blueprint, two services:
  https://deadman-server.onrender.com (Docker web service) and https://deadman-board.onrender.com
  (static site). `/health` answers publicly with the right escrow, price and seller.
- **Public suite, scenarios A and B** against the deployed host, not localhost:
  - **A, seller delivers** — hold 2, schedule [`0.0.10427065`](https://hashscan.io/testnet/schedule/0.0.10427065), key revealed, agent decrypted, `H(k)` matched.
  - **B, seller goes dark** — hold 3, schedule [`0.0.10427072`](https://hashscan.io/testnet/schedule/0.0.10427072), executed `1788899074.078335550`, `signatures: []`, buyer whole.
- **The live board is built and deployed.** One HTML file, no build, no backend. Reads the mirror
  node directly from the browser so it survives us killing our own server. Renders `signatures: []`
  on the refund line. Decoding validated against live logs in node before it went in the page.
- **Claim delay is runtime-settable** (`POST /admin/dark {on, claimDelaySeconds}`), so the kill test
  no longer needs a redeploy per attempt.
- **Submission material:** `docs/checkins/02.md` (due Friday 05:59, written now), the video script,
  the prior-art table and the public URLs in the README.

**Next** — the kill test on the public host; then HCS receipts if there is room.

**DONE — Privy.** Unblocked once Alex supplied the app id, secret and authorization key. The agent
now signs through a Privy server wallet (`0.0.10433495`) and **no private key exists on the machine**;
a full purchase against the public host ran on it (hold 4, schedule `0.0.10433614`). The embedded-wallet
fallback was not needed.

The spend policy is where the honest reporting is. We could not ship the 6 HBAR cap the plan asked
for, and the reason is structural: x402 on Hedera pays with a native `TransferTransaction`, which
needs raw `secp256k1Sign`, which no `PolicyMethod` covers — so the only rule permitting it is
`ALLOW *`, and that also lets an over-cap transfer through. Verified: 10 HBAR under a 6 HBAR cap.
Two further findings on the way: Privy policies are **default-deny** (a DENY-only policy bricks the
wallet, including the transfers it was meant to permit), and Privy does not return a wallet's public
key, which Hedera needs — it has to be recovered from a signature and checked against the address.
Full matrix in [spike 16](docs/spikes/16-privy.md). The shipped policy is a single `ALLOW *` rule
whose name states the limitation, rather than a cap sitting next to a wildcard that voids it.

**MEASURED — cold start is 52.5 seconds, not the ~30s we had written down.** Three attempts were
wasted first: each was taken inside Render's 15-minute idle window because overlapping background
tasks of mine kept touching the endpoint, so all three read ~300-380 ms and proved nothing. The
service then sat untouched overnight, which gave the clean condition for free:

| request | result |
| --- | --- |
| 1 (cold) | HTTP 200 in **52,533 ms** |
| 2 | HTTP 200 in 320 ms |
| 3 | HTTP 200 in 336 ms |
| 4 | HTTP 200 in 284 ms |

Two findings. `healthCheckPath: /health` does **not** keep a free instance awake — it gates deploys
only, and the overnight sleep disproves the hypothesis. And the wake does **not** eat the refund
window: the deadline is `now + HOLD_DEADLINE_SECONDS`, computed at `server/src/index.ts:258` in the
settlement path, which runs after the instance is up. That answers the question plan 08 asked —
*what does the cold start do to a 60-second deadline?* Nothing. It delays the first request by ~52s
and shortens the hold by zero seconds.

It is still a recording hazard: 52 seconds of apparent nothing on camera reads as the exact failure
we claim to survive. `render.yaml`, `docs/deploy.md` and `docs/video-script.md` corrected in the same
commit — the ~30s figure was Render's documentation, never our observation.

**NEEDS ALEX — the kill test.** Suspending the service is a dashboard action. Sequence: set
`{"on":false,"claimDelaySeconds":45}`, start a purchase, and hit **Suspend** the moment the hold
appears on the board. `on:false` matters — killing an unwilling seller proves nothing the dark flag
does not already cover.

---

## 2026-09-09 — Alex (contract, tests)

**Landed**

- **The adversarial suite (plan 09, session 04 §4). 53 tests passing.** Every guard tested twice:
  once against a mutant with that guard removed, where the attack must succeed, and once against the
  real contract. `contracts/test/Mutants.sol` holds five deliberately broken builds.
- **Found and fixed a real vulnerability.** `sweepReserve` could take a buyer's settled payment in
  the window before `openHold` ran — a settlement credits the contract without executing code, so it
  was attributed to nothing and `free` counted it. Sweeps are now bounded by `operatingFloatTinybar`,
  which only deliberate deposits increase.
- **Second bug inside the fix.** On testnet the float had drifted ABOVE the balance, because refund
  gas leaves the balance unobserved. An overstated float re-opens the same hole. `_reconcileFloat()`
  clamps it down; it can only ever lower the float.
- **A claim that was false.** The test was written to assert the compare-and-set stops a double
  payout. Against `NoCasCheck` the contract still paid once — two other guards catch it. Only
  `NoCasNoZero` produces a real double payout. Both mutants kept; the write-up says so.
- **Redeployed:** `0x1f928BF2261979A818Ade961f3b6d8aC1AAbe860` = `0.0.10426758`. Settle → openHold →
  unattended refund re-verified: hold 1, schedule `0.0.10426770`, `signatures: []`, buyer whole.
  The previous escrow `0xc5241034…` has the sweep bug and must not be used.

**Next** — sections 2, 3, 5, 6 of the session-04 brief.

**BLOCKED — section 1, the public deploy.** No deploy CLI and no cloud credentials on this machine;
creating a Render service needs an account sign-in. Section 2 (`/web`) is gated behind it by the
brief, so both are stalled until someone applies the blueprint. Everything else is prepared:
`render.yaml`, `server/Dockerfile`, least-privilege seller key, token-gated admin endpoint.

---

## 2026-09-08 — Alex (contract and payment path)

**Landed**

- `docs/plans/04-holdescrow.md` written and committed before any contract code. Answers all seven
  of the design questions explicitly; two risks named rather than buried.
- `docs/checkins/01.md` — check-in #1 text, naming two partner-side blockers.
- **Spike 7 PASSED.** A successful `deleteSchedule` IS rolled back when the transaction reverts —
  atomic, schedule `0.0.10418012`, with a positive control proving the schedule was genuinely
  deletable. Relaxes the claim-path ordering rule; `refund()`'s stays mandatory for a different
  reason, since a scheduled execution cannot be un-fired.
- `docs/PROGRESS.md` untracked again — it was swept into a commit by an over-broad `git add`.

- **Spike 8 PASSED.** A reverting scheduled execution DOES consume its schedule — `executed_timestamp`
  set, no retry in 60s, with a success control armed alongside proving the network was live.
  Plan 04 Q4's no-revert rule is now a measured requirement. The contract is charged 0.0227 HBAR for
  a failed execution vs 0.1178 for a success, which confirms the 0.5 HBAR deposit sizing.
- **New work item for the frontend:** network-executed calls do NOT appear in the mirror node's
  `/contracts/{addr}/results`. A refund that fired and reverted is invisible there. Monitoring must
  go schedule record -> `executed_timestamp` -> `/transactions?timestamp=`.

- **Spike 9 — the big one. Atomic settlement is NOT available.** `@x402/hedera` only ever builds a
  `TransferTransaction` and the facilitator rejects anything else by name; a HAPI transfer to a
  contract credits its balance without running `receive()` (measured, with an EVM-transfer control
  on the same contract that did run it). The brief's "in the same transaction" is not achievable.
  **The one-liner is unaffected** — that claim is about the refund firing, which is unchanged.
  Design moves to escrow-as-`payTo`: settlement credits the escrow directly so the seller never
  holds the money, and `openHold` becomes non-payable, attributing already-credited funds.
  README and plan 04 corrected rather than softened.

**Next** — Igor re-reviews plan 04 against the section 8.1 correction, which changes `openHold`'s
signature and makes the allowlist load-bearing. Contract code after that.

- **Spike 10 PASSED, and it settled for real.** Blocky402 `/verify` accepts a contract as `payTo`
  (against a plain-account control that also passed), and `/settle` submitted it: transaction
  `0.0.7162784-1788854559-596024460`, CRYPTOTRANSFER SUCCESS, +0.1 HBAR to the contract, fee paid by
  Blocky402's `0.0.7162784`. Escrow-as-`payTo` is viable and spike 9's design is unblocked.
  `receive()` did not run on the real settlement path either, confirming spike 9 where it counts.
  The settle transaction's fee payer is the artefact that demonstrates track qualification.

- **`HoldEscrow.sol` written**, implementing plan 04 including the section 8.1 correction. Every
  spike constraint is cited inline at the line that depends on it. 28 unit tests passing against a
  mocked Schedule Service at `0x16b`.
- **The jitter fallback is no longer untested.** The mock can saturate seconds, which testnet never
  does, so the exponential-backoff probe loop, the minute-boundary skip and the give-up path all now
  have coverage. That was the oldest open caveat, carried since session 01.
- Also covered by the mock and not by testnet: a saturated second returning a zero address with
  code 22, and a REFUSED `deleteSchedule` — the double-payout guard.

- **HoldEscrow deployed: `0xc5241034C7c060361B0223B3c6d77d0A4bC8Ef09` = `0.0.10419881`.** SUPERSEDED
  on 2026-09-09 — this one has the sweep vulnerability. Live escrow is `0.0.10426758`. Both
  lifecycles proven on the real network — one hold refunded unattended (`signatures: []`), one
  claimed with the schedule deleted.
- **`REFUND_GAS` re-measured: 400,000 -> 250,000.** Real executions: 46,744 happy path, 122,847 worst
  case. The first worst-case run read 105,747 and was wrong — it reused a warm contract, and a fresh
  one costs 17,100 more because both credit-fallback slots are cold.
- `openHold` measured at 1,668,649 gas. The server's transaction needs ~3M; we send 5M.
- The minute-boundary skip fired on testnet for the first time (`probesUsed: 1`). The
  capacity-saturation branch still has never run on a real network.

- **END TO END WORKS.** x402 settle -> openHold -> network-executed refund, run as one sequence on
  testnet. A fresh agent wallet paid 0.5 HBAR through Blocky402 into the escrow, the server armed a
  hold, the seller stayed silent, and the network refunded the buyer 54s later with `signatures: []`.
  Buyer 3 HBAR -> 2.5 -> 3. Settlement `0.0.7162784-1788864119-121509010`, schedule `0.0.10420245`.
  The seller never held the money at any point.
- Gas held at the measured figures: openHold 1,668,661, refund 46,744 of 250,000.

- **Resource server and agent built and working.** Three scenarios against the live escrow:
  seller delivers (hold 8, schedule deleted, agent decrypted, H(k) matched); seller goes dark
  (hold 9, refunded); and **server killed while alive and holding the key** (hold 11, schedule
  `0.0.10420624` executed with `signatures: []`, buyer whole). All three holds paid out exactly once.
- The first kill test was INVALID and is recorded as such — stopping the background task left the
  old dark server on the port, so the refund fired for the wrong reason. Redone properly.
- Not using `@x402/express`: its middleware settles after the response body is finalised, and we
  need `openHold` between settlement and the reply. Uses `@x402/core`'s official client instead.
- `eth_getLogs` fails on HashIO for this contract, so the agent reads events from the mirror node.

- **Deployment prepared, not deployed.** Dockerfile, Render blueprint (`render.yaml`), health check.
  Two things had to change before going public, both done and verified:
  a dedicated SELLER key (`0xEDde9234…`, isOpener true / isOwner false) so a compromised host cannot
  sweep the float or take ownership; and `/admin/dark` token-gated, failing CLOSED when `ADMIN_TOKEN`
  is unset. Verified 401/401/200. A 5 HBAR paid round ran end to end on the seller key.
- **Cost measured, and it changes the pricing.** `openHold` is 1,668,661 gas = **1.77 HBAR charged**,
  `claim` ~0.13 more. ~87% is `scheduleCall`'s own gas floor. Anything under ~2 HBAR loses money per
  sale, so the price moved 0.5 -> 5 HBAR. ~$0.09/hold means Deadman does not work for micro-payments;
  that is now in the README limits.

- **`verify.ts` written, and proven against three real cheats.** The agent now writes a receipt per
  purchase; `npm run verify <holdId>` reads the authoritative commitments from the HoldOpened log,
  the key from Claimed, and names the broken element. Holds 13 (honest), 14 (wrong-key), 15
  (wrong-cipher), 16 (wrong-plain) — in every cheating case the chain is HAPPY and the seller is
  PAID, which is exactly why the tool exists.
- Added `SELLER_CHEAT` modes to the server so the lying-seller path is exercisable rather than
  theoretical. A tool that has never caught anything is an assertion.

**Blocked** — Alex asked for the contract before Igor's review landed, so plan 04 and
`HoldEscrow.sol` both still need that review. `docs/reviews/` is empty.

**Blocked** — nothing of ours. Two partner-side items in the check-in.

**Blocked** — nothing.

**Open questions carried forward**
- The jitter fallback has still never executed. Testnet is uncongested. Needs a mocked HSS.
- Claim and refund landing in the same second: a `HoldEscrow` concern for the adversarial tests.

---

## 2026-09-11 — Alex (merging Igor's review)

**Merged** Igor's PR #4, the claim margin, and PR #5, the roadmap. Both as merge commits so his
authorship stays in the history. #4 typechecked clean before merging.

**Added to #4** the reason it matters beyond gas: `claim()` carries the key in its calldata and a
reverted claim is still a recorded transaction, so a claim that loses the race publishes the key
anyway, and the buyer ends up with both the work and the refund. The margin narrows that window.
It cannot close it.

**Restored** the known-solutions reasoning in the README (ZKCP, dual deposit, optimistic fraud
proofs) that #5 had cut down to bare bullets. That reasoning is what shows a judge we know the
literature, and it should not have been lost in a move.

**Not merged: PR #6**, the reputation MVP. It is 1,496 lines, it rewrites `verify.ts`, which is the
tool behind the three demonstrated cheat runs, and it puts quality judgement behind an external
judge URL. Two days before submission, with no demo payoff. Igor's own view was not to ship it
this week. Left open, not closed.

**Balances at merge.** Escrow free 24.90 HBAR against a 5.00 reserve. Seller 55.50. Agent 25.93.

---

## 2026-09-06 — Igor (reviewer and adversary)

Monday design review scheduled. Nothing to review yet beyond `docs/plans/01-spikes.md`.

---

## 2026-09-10 — Igor (reviewer and adversary)

Reviewed the project and found a real timing bug in the seller: a claim sent within Hedera's two to
four second round trip of the armed deadline loses to the refund. Fixed in PR #4 with a
configurable margin.

Researched the correctness limit: 402Pilot, ERC-8004 feedback gaming, and his own write-up on why
public reputation fails. Argued it belongs in the roadmap as buyer-side and private, not in the
code this week. PR #5, merged. PR #6, a working MVP of the same idea, deliberately not merged.

---

## 2026-09-06 — Frontend

Not started.

---

## 2026-09-06 — Media

Build log starts today.
