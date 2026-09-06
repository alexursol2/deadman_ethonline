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

**Next** — spikes 1 and 2, the moment the key exists.

**Blocked** — `.env` needs a funded ECDSA testnet key. Everything else is ready and waiting on it.
A sandbox fault wiped the repo directory mid-session, which took the earlier `.env` with it.

---

## 2026-09-06 — Igor (reviewer and adversary)

Monday design review scheduled. Nothing to review yet beyond `docs/plans/01-spikes.md`.

---

## 2026-09-06 — Frontend

Not started.

---

## 2026-09-06 — Media

Build log starts today.
