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

**Next** — Igor reviews plan 04. No contract code until he has. The x402 settlement atomicity
question (plan 04 section 8.1) is now the only spike left before `openHold`, and it is the
highest-risk unknown in the design.

**Blocked** — nothing of ours. Two partner-side items in the check-in.

**Blocked** — nothing.

**Open questions carried forward**
- The jitter fallback has still never executed. Testnet is uncongested. Needs a mocked HSS.
- Claim and refund landing in the same second: a `HoldEscrow` concern for the adversarial tests.

---

## 2026-09-06 — Igor (reviewer and adversary)

Monday design review scheduled. Nothing to review yet beyond `docs/plans/01-spikes.md`.

---

## 2026-09-06 — Frontend

Not started.

---

## 2026-09-06 — Media

Build log starts today.
