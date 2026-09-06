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

**Open questions carried forward**
- `% 3600 == 0` in the boundary skip is a subset of `% 60 == 0` and can never fire independently.
  Did Alex mean a band around the hour?
- The jitter fallback and the mirror-node backoff are both untested — neither path ever executed.

---

## 2026-09-06 — Igor (reviewer and adversary)

Monday design review scheduled. Nothing to review yet beyond `docs/plans/01-spikes.md`.

---

## 2026-09-06 — Frontend

Not started.

---

## 2026-09-06 — Media

Build log starts today.
