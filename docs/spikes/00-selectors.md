# Step zero — HSS selector verification

**Run:** `cd contracts && node scripts/verify-selectors.mjs` → exit 0, all seven match.
**Source of truth:** `hiero-improvement-proposals/HIP/hip-1215.md`, status **Final**, release
**v0.68.0**, `updated: 2026-04-19`. Pinned copy: [`hip-1215.raw.md`](hip-1215.raw.md).
**Not** `hips.hedera.com` — stale June 2025 build with wrong function names.

Why this runs before every deploy: a wrong selector on a system contract does not revert helpfully.
It silently does nothing. Every selector below is recomputed as `keccak256(signature)[0:4]` and
asserted against the HIP's own published table, rather than trusted from a doc copy-paste.

| Selector | Signature | We call it |
|---|---|---|
| `0x6f5bfde8` | `scheduleCall(address,uint256,uint256,uint64,bytes)` → `(int64,address)` | yes — `arm()` |
| `0xdfb4a999` | `hasScheduleCapacity(uint256,uint256)` view → `bool` | yes — capacity probe |
| `0x72d42394` | `deleteSchedule(address)` → `int64` | yes — cancel path A |
| `0xc61dea85` | `deleteSchedule()` (redirect, on the schedule address) → `int64` | yes — cancel path B |
| `0xd83bf9a1` | `getPseudorandomSeed()` (PRNG `0x169`, HIP-351) | yes — `probeRandomness()` |
| `0xe6599c18` | `scheduleCallWithPayer(...)` | **no** — see finding 2 |
| `0x105772b2` | `executeCallOnPayerSignature(...)` | **no** — see finding 2 |

Addresses: `0x16b` = `0.0.363` (Schedule Service), `0x169` = `0.0.361` (PRNG).

**The three selectors in the team brief are correct.** Two things the brief does not carry:

## Finding 1 — there are two delete paths, not one

HIP-1215, verbatim:

> A contract or EOA may also attempt to delete a scheduled transaction at address `0x00...abcd` by
> calling a "redirect" `deleteSchedule()` function at that address.

That is `0xc61dea85`, no arguments, called **on the schedule address itself** rather than on `0x16b`.

This matters because it is a second contract-side cancel path. If the `0x16b` path turns out to be
authorisation-gated in a way that excludes the scheduling contract, the redirect path may not be, and
the happy path survives. Spike 2 tests both before concluding anything.

**It does not tell us who is authorised.** "May attempt" is the HIP documenting a call surface, not a
permission rule. Nowhere in HIP-1215 is the authorisation model for deletion written down. That gap
is the entire reason Spike 2 exists, and finding a second door does not tell us either door is
unlocked.

## Finding 2 — `scheduleCallWithPayer` exists, and we must not use it

`scheduleCallWithPayer` and `executeCallOnPayerSignature` let the scheduling contract nominate a
different payer — but then, in the HIP's words, the scheduled call *"can only execute after receiving
enough valid signatures to activate the payer's key."*

That is a signature dependency, which is the exact thing the one-liner claims we removed. Using it
for the refund would quietly falsify the pitch. Recorded here, and marked `NO` in the verification
script, so nobody reaches for it later because the name looks convenient.

## Two constraints pinned from the HIP text

- **`hasScheduleCapacity` returns `false` for an invalid expiry too** — not after the current
  consensus second, or beyond the horizon — and that is indistinguishable from "saturated". A `false`
  therefore does **not** prove congestion, and no spike result may report it as such.
- **Zero `to` address → `INVALID_CONTRACT_ID`.** Scheduling a contract *create* is out of scope for
  the HIP.

And one guarantee we lean on: `hasScheduleCapacity(expiry, limit) == true` implies a subsequent valid
`scheduleCall` at that second also succeeds. If we ever observe `true` followed by a non-22 code, that
is a HIP-level bug report, not our bug — worth saying out loud so we do not spend an afternoon
debugging our own contract for it.
