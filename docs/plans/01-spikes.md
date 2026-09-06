# Plan 01 — De-risking spikes (HIP-1215 + Blocky402)

**Implementing agent:** Claude Opus 5 (Claude Code).
**Reviewed and amended by:** Alex, 2026-09-06, five amendments — see §A.
**Status:** APPROVED. Feedback Session #1 is Tue 8 Sept.

## AI attribution (required by ETHGlobal)

Drafted by Claude Opus 5 running in Claude Code, from the team brief (`deadman-team-brief-v2.md`)
supplied by Alex. Alex reviewed the draft and returned five amendments, all of which are folded into
the body below and recorded verbatim in §A so the review is visible rather than implied. This file
is committed before the implementation it describes. Files the agent authors during the spike phase
are listed in §9.

---

## A. Alex's amendments to the draft (recorded verbatim)

1. **Do not assume `block.prevrandao` works on Hedera.** Hedera's system contract docs document a
   PRNG contract at `0x169` (HIP-351, `getPseudorandomSeed`) and never mention PREVRANDAO, while
   HIP-1215's own `findAvailableSecond` pattern uses prevrandao-derived jitter. Add
   `probeRandomness()` returning both `block.prevrandao` and the `0x169` result, log both, and report
   which is usable. This is a finding either way and I want it for the Hedera feedback session on
   Tuesday.
2. **Change the jitter skip** from `candidate % 10 == 0` to `candidate % 60 == 0` and
   `candidate % 3600 == 0`. Clustering happens on minute and hour boundaries.
3. **Mirror node is eventually consistent.** The Spike 2 control GET immediately after arming needs
   retry with backoff, 3 attempts, before you conclude the schedule does not exist. A false alarm
   there would look like a design failure.
4. **Move selector verification against the HIP text to step zero**, before deploy, and put it in the
   commit sequence. Wrong selectors on a system contract fail silently.
5. **Note explicitly in the Spike 1 result** that the capacity/jitter fallback path never executed
   because testnet is uncongested, so it is untested code on the critical path. Do not report it as
   verified.

Amendment 1 is answered directly by §4.1 (both sources probed and reported). Amendment 4 is already
executed — see §B, which is why §6 changed shape before any code was written.

---

## B. Step zero, done: selectors verified against HIP-1215

Source: `hiero-improvement-proposals` on GitHub, `HIP/hip-1215.md`, status **Final**, release
**v0.68.0**, `updated: 2026-04-19`. Not `hips.hedera.com`. Raw copy committed at
`docs/spikes/hip-1215.raw.md` so the text we built against is pinned even if the HIP moves.

Every selector independently recomputed as `keccak256(signature)[0:4]` and matched against the HIP's
own table:

| Selector | Signature | In brief? | Matches HIP |
|---|---|---|---|
| `0x6f5bfde8` | `scheduleCall(address,uint256,uint256,uint64,bytes)` → `(int64,address)` | yes | ✅ |
| `0xdfb4a999` | `hasScheduleCapacity(uint256,uint256)` view → `bool` | yes | ✅ |
| `0x72d42394` | `deleteSchedule(address)` → `int64` | yes | ✅ |
| `0xe6599c18` | `scheduleCallWithPayer(address,address,uint256,uint256,uint64,bytes)` | **no** | ✅ |
| `0x105772b2` | `executeCallOnPayerSignature(address,address,uint256,uint256,uint64,bytes)` | **no** | ✅ |
| `0xc61dea85` | `deleteSchedule()` — **redirect, called on the schedule address itself** | **no** | ✅ |
| `0xd83bf9a1` | `getPseudorandomSeed()` — PRNG at `0x169`, HIP-351 | n/a | for §4.1 |

**The three selectors in the brief are correct.** Two findings the brief does not carry:

**B.1 — There are two delete paths, not one.** HIP-1215, verbatim: a contract may delete via
`deleteSchedule(address)` on `0x16b`, and *"A contract or EOA may also attempt to delete a scheduled
transaction at address `0x00...abcd` by calling a 'redirect' `deleteSchedule()` function at that
address."* That second path is `0xc61dea85`, called **on the schedule address**, with no arguments.

This changes Spike 2 from a single yes/no into a 2×2, and it materially improves our odds: if the
`0x16b` path is authorisation-gated in a way that excludes the contract, the redirect path may not
be. Spike 2 now tests both (§6). Note the HIP says *"a contract or EOA may attempt"* — attempt, not
succeed. It documents the call surface, **not the authorisation rule**. Who is permitted to delete
still is not written down anywhere, which is exactly why this spike exists.

**B.2 — `scheduleCallWithPayer` exists**, and with it a payer whose key must sign before the call can
execute. We must **not** use it for the refund: it reintroduces a signature dependency and would
quietly falsify the one-liner. Recorded here so nobody reaches for it later thinking it looks handy.

Two more constraints worth pinning from the HIP text:

- `hasScheduleCapacity` returns `false` for an invalid expiry (not after current consensus second, or
  beyond the horizon) — indistinguishable from "saturated". A `false` therefore does **not** prove
  congestion, and Spike 1 must not report it as such.
- A zero `to` address returns `INVALID_CONTRACT_ID`. Scheduling a contract *create* is out of scope.
- The HIP's guarantee: `hasScheduleCapacity(expiry, limit) == true` implies a subsequent valid
  `scheduleCall` at that second also succeeds. Our capacity check leans on this, so if Spike 1 ever
  sees `true` followed by a non-22 code, that is a HIP-level bug report, not our bug.

---

## 0. Scope of this session

**Not building features.** No `HoldEscrow.sol`. Three assumptions get verified, the repo skeleton
gets stood up, and each result gets reported plainly — including failures.

| # | Assumption under test | If false |
|---|---|---|
| 1 | A HIP-1215 scheduled call fires unattended on current testnet | The whole pitch dies. Escalate same day. |
| 2 | A contract can delete a schedule it created | Design becomes "refund always fires, seller re-collects". **Stop and tell Alex immediately.** |
| 3 | Blocky402 facilitator is alive and the scaffold points at it | Track qualification at risk; Hedera Discord question Monday. |

Success is three plain answers with linkable evidence, not three green ticks.

## 1. Where the work lands

`D:\WhiteBIT\deadman_ethonline` → `https://github.com/alexursol2/deadman_ethonline`.

```
/contracts    Hardhat project. Spike contract now, HoldEscrow later.
/server /agent /web     .gitkeep this session
/docs         plans/, reviews/, spikes/ (raw evidence: JSON dumps, tx hashes, pinned HIP text)
README.md     one-liner + "Limits we are not hiding"
STATUS.md     one section per person
.gitignore    .env, node_modules, artifacts, cache, *.key   (commit #1, before any key existed)
.env.example  required vars, no values
```

## 2. Prerequisite

A funded **ECDSA** Hedera testnet account. ED25519 has no EVM alias and will not work. Key goes in
`.env` by Alex's own hand, never into chat. `git check-ignore -v .env` output pasted as proof before
the key exists.

Blocked on the key: Spikes 1 and 2. Not blocked: skeleton, step zero, contract, scripts, Spike 3.

## 3. Toolchain

**Hardhat 2.22 + ethers v6, not Foundry.** Hedera's docs, the `scaffold-hbar` templates and every
HIP-1215 example are Hardhat; `forge` is not on PATH here; Foundry's gas estimation against HashIO is
noise we do not need this week.

- Solidity **0.8.24**, `evmVersion: "cancun"`. Fall back to `"shanghai"` on an opcode failure and
  record it — a real finding either way.
- Explicit `gas` on every transaction. `eth_estimateGas` on HashIO under-quotes.
- Mirror node REST for assertions, HashScan links for humans.

## 4. The spike contract

`contracts/contracts/SpikeSchedule.sol`, serving Spikes 1 and 2.

```
address constant HSS  = address(0x16b);   // Schedule Service, entity 0.0.363
address constant PRNG = address(0x169);   // HIP-351 PRNG, entity 0.0.361
```

**Calls go out as low-level `call` with hand-built calldata, not through a Solidity interface**, and
the full `returndata` is emitted in an event even when decoding fails. A system contract returning
something unexpected should be diagnosable from the mirror node, not arrive as an opaque revert.

State the scheduled call mutates — recording *who* the caller is, because the HIP does not say and
`refund()` will need to know:

```solidity
uint256 public pingCount;
uint256 public lastPingTimestamp;   // block.timestamp inside the scheduled execution
address public lastPingSender;      // msg.sender of a network-executed call  <-- unknown, worth learning
bytes32 public lastTag;
```

`ping(bytes32 tag)` is **unrestricted on purpose**. Gating it on `msg.sender == address(this)` when
the network might execute it as something else would fail the call and teach us nothing. Record now,
restrict in `HoldEscrow` once we know.

### 4.1 `probeRandomness()` — amendment 1

Returns **both** sources in one call, and neither is trusted in advance:

```solidity
function probeRandomness() external returns (bytes32 prevrandao, bytes32 prngSeed, bool prngOk);
```

- `prevrandao` = `bytes32(block.prevrandao)`, read directly.
- `prngSeed` = raw `call` to `0x169` with `0xd83bf9a1` (`getPseudorandomSeed()`), `prngOk` = call
  success **and** 32 bytes returned.

Called once from a script and once from inside `arm()`, with both values in the `Armed` event, so we
see them in a real scheduling transaction and not only in a `staticcall`.

**What counts as usable, decided before we look at the numbers** (otherwise we will rationalise
whatever we get): a source is usable if it is non-zero and differs across two calls in different
blocks. A constant or zero `prevrandao` is the failure mode that matters — jitter seeded from a
constant makes every contract pick the *same* "random" second, which is worse than no jitter,
because it converts a scatter pattern into a stampede while looking like it works.

**Selection rule in `arm()`:** prefer `0x169` when `prngOk`, else `prevrandao`, else
`keccak256(block.timestamp, address(this), pingCount)` as a last resort with the seed source recorded
in the event. `HoldEscrow` will hard-code whichever source the spike proves, rather than falling
back silently. Both values go in the Tuesday report either way.

### 4.2 `arm(uint256 delaySeconds, uint256 gasLimit, bytes32 tag)`

1. **Balance assert first.** `require(address(this).balance >= minBalance)`. The contract pays gas at
   execution from its own balance; short balance means a silent no-refund on camera.
2. **Capacity check plus jitter**, following the HIP's own `findAvailableSecond` — exponential
   backoff `baseDelay = 1 << i`, jitter `= uint16(keccak256(seed, i)) % baseDelay`,
   `candidate = expiry + baseDelay + jitter` — with two changes: the seed comes from §4.1 rather than
   assuming prevrandao, and **candidates where `candidate % 60 == 0` or `candidate % 3600 == 0` are
   skipped (amendment 2)**, since clustering happens on minute and hour boundaries, not decimal ones.
   Bounded at 8 probes, then revert with a distinct error so saturation is *loud*.
3. **Assert both halves of the return.** `scheduleCall` never reverts. `require(code == 22)` **and**
   `require(scheduleAddress != address(0))`. `SCHEDULE_EXPIRY_IS_BUSY` is a zero address with a
   non-22 code and would otherwise sail straight through.

Emits `Armed(tag, scheduleAddress, expirySecond, code, probesUsed, seedSource, prevrandao, prngSeed)`.
`probesUsed` is what amendment 5 is measured against.

### 4.3 Cancel — both paths (see §B.1)

- `cancelViaHss(address scheduleAddress)` → `0x72d42394` on `0x16b`.
- `cancelViaRedirect(address scheduleAddress)` → `0xc61dea85` on the schedule address itself.

Both have `try*` variants returning the raw `int64` and `returndata` instead of reverting, so Spike 2
reports the actual failure code rather than "it reverted".

### 4.4 Deploy and funding

`scripts/deploy.ts` deploys, sends **20 HBAR**, asserts the balance landed. Deliberate overkill for
two 150k-gas scheduled calls; running dry mid-spike costs an hour of wall clock we do not have.

## 5. Spike 1 — does it fire unattended?

`scripts/spike1-arm.ts`

1. Balance check, printed.
2. `probeRandomness()` twice, two blocks apart. Record both sources.
3. `arm(60, 150_000, "spike1")`. Print `scheduleAddress`, expiry second, tx hash, `probesUsed`.
4. Long-zero address → entity id (last 8 bytes as `uint64` → `0.0.N`), print the HashScan link.
5. Everything to `docs/spikes/spike1-armed.json`.

`scripts/spike1-verify.ts` at T+90s

6. `pingCount()` — expect 1. Print `lastPingSender`, `lastPingTimestamp`.
7. `GET {mirror}/api/v1/schedules/0.0.N` → raw JSON to `docs/spikes/spike1-schedule.json`.

**Pass conditions, all four, no partial credit:**

- `executed_timestamp` present and non-null
- `signatures: []`
- `wait_for_expiry: true`
- `pingCount == 1` on chain

Also recorded: `executed_timestamp - expiry_second` in ms (the brief quotes 168 ms on a prior
schedule; reproducing that is a good line for the video), and `lastPingSender`.

**Amendment 5 — mandatory caveat in the result.** Testnet is uncongested, so `hasScheduleCapacity`
will almost certainly return `true` on the first probe and `probesUsed` will be 0. The
capacity/jitter fallback therefore **never executes** and is **untested code sitting on the critical
path**. The result writes this out explicitly and does not report jitter as verified. Its unit-test
coverage is Igor's Wednesday review, and even that is a test against our own assumptions, not against
a saturated network. Stated as a limitation in the README, not discovered by a judge.

**Note on `value`:** both spikes pass `value = 0`, sidestepping the tinybar-vs-weibar question on that
`uint64`. `HoldEscrow` moves real money, so that unit gets pinned against the HIP before `refund()`
is written. Flagged now so it does not surprise us Wednesday.

## 6. Spike 2 — can the contract cancel its own schedule? (the one that changes the design)

Now a matrix, because of §B.1. Each cell is one armed schedule, since a successful delete consumes it.

| | via `0x16b` `deleteSchedule(address)` | via redirect `deleteSchedule()` on the schedule |
|---|---|---|
| **called by the contract that armed it** | 2a — the happy path | 2c |
| **called by the operator EOA** | 2b — diagnostic only | 2d |

**2a is the only cell that has to pass.** 2c is the fallback that could rescue the design. 2b and 2d
run only if both contract-side cells fail, and they exist to distinguish "nobody can delete" from
"only an external signer can delete" — a different product in each case.

`scripts/spike2.ts`

1. `arm(300, 150_000, "spike2a")` → `scheduleAddress`, entity `0.0.M`. Snapshot `pingCount`.
2. **Control GET** `/api/v1/schedules/0.0.M`, confirming it exists with `deleted: false`,
   `executed_timestamp: null`. Without this control, "never executed" proves nothing — the schedule
   might never have been created.
   **Amendment 3: 3 attempts with backoff (2s, 4s, 8s) before concluding it is absent.** The mirror
   node is eventually consistent and a cold read here would look exactly like a design failure. Only
   a 404 that survives all three attempts counts as absent, and the result records how many attempts
   it actually took — if it routinely needs two, that is a number the live board's countdown UI needs
   to know about.
3. `tryCancelViaHss(scheduleAddress)`. Capture the `int64` and raw `returndata` **even on failure**.
4. Re-GET (same retry policy) — expect `deleted: true`.
5. Wait past expiry + 60s. `pingCount` unchanged, `executed_timestamp` still null.

Pass for 2a = code 22 **and** `deleted: true` **and** the ping never lands. All three.

**If 2a fails**, `scripts/spike2.ts` continues automatically into 2c with a freshly armed schedule,
because that is a second contract-side path and it either saves the design or does not. **2b and 2d
are diagnostics I run only after both 2a and 2c have failed**, and then I stop.

**If both contract-side cells fail I stop and tell Alex immediately** with: the failure codes and raw
returndata from 2a and 2c, the mirror records, and whether the EOA cells worked — enough to choose
between "refund always fires, seller re-collects" and an alternative in one round trip, not two.

## 7. Spike 3 — is the facilitator alive?

1. `curl -sS -i https://api.testnet.blocky402.com/supported` — **raw** response, headers and body,
   verbatim. No summarising a facilitator into "looks fine".
2. Probe whatever `/supported` advertises (likely `/verify`, `/settle`) for **existence only** —
   unauthenticated GET, no payment payloads, nothing that could read as attempting to use the service.
3. `npm create scaffold-hbar@latest` into the scratchpad, **not** the repo; **"x402 pay per use"**
   template. It is interactive — if it cannot be driven non-interactively I hand Alex one command
   rather than guessing at prompt answers.
4. `grep -ri "blocky402\|facilitator"`, read the config, answer the question as asked: **default or
   needs configuring** — and if the latter, exactly which file and which variable.
5. Skim the **"on-chain cron jobs"** template for its HIP-1215 usage. Free third-party cross-check on
   our `0x16b` calling convention, now that we have the HIP table to check it against.

Nothing from scaffold-hbar is copied into the repo this session.

## 8. Reference discipline

- HIP-1215 read only from `hiero-improvement-proposals`. `hips.hedera.com` is a stale June 2025 build
  with wrong function names. The version we built against is pinned at `docs/spikes/hip-1215.raw.md`.
- Selectors verified before deploy (§B). Done.
- Every artifact — mirror JSON, tx hashes, schedule IDs — lands in `docs/spikes/` and is committed.
  IDs to the receipts channel the moment they exist.

## 9. Commit sequence

Small and logical. Real history is scored; one squash is a flag.

1. ✅ `chore: init repo skeleton, gitignore, env example`
2. `docs: add spike plan 01, amended after review` — **this file**
3. `docs: verify HSS selectors against HIP-1215` — **step zero, amendment 4**: pinned HIP text,
   the recompute script, and the §B findings
4. `chore: hardhat project for hedera testnet`
5. `feat(contracts): SpikeSchedule with capacity check, jitter and return assertions`
6. `feat(contracts): probe both randomness sources` — amendment 1
7. `feat(scripts): deploy and fund spike contract`
8. `feat(scripts): spike 1 arm + mirror-node verify`
9. `feat(scripts): spike 2 self-cancel, both delete paths`
10. `docs: spike 1 result` — raw mirror JSON, with the amendment-5 caveat
11. `docs: spike 2 result` — raw mirror JSON
12. `docs: spike 3 facilitator + scaffold findings`
13. `docs: README limits section; STATUS.md`

Branch `spike/hip-1215` → PR into `main`. No squash-merge, no direct pushes to `main`.

## 10. Timebox and abort conditions

| Step | Budget | If it blows the budget |
|---|---|---|
| Skeleton + step zero | 40 min | — |
| Hardhat + contract | 40 min | — |
| Spike 3 (no key needed) | 30 min | Report partial; it is a curl and a template read |
| Deploy + fund | 30 min | HashIO flakiness → one retry, then report the RPC as a risk |
| Spike 1 | 20 min incl. wait | Nothing by T+120s → pull the mirror record, report as-is |
| Spike 2 | 40 min incl. waits | 2a and 2c both fail → **stop, report, do not improvise** |

If Spike 1 is inconclusive rather than clearly pass or fail, that is itself the finding for Feedback
Session #1. An honest "we could not reproduce it unattended" is a better question for Luke than a
fabricated green tick.

## 11. What I report back

Per spike: **what I ran**, **what came back verbatim**, **pass or fail against the stated
conditions**, and **what it means for the design**. Failures reported as plainly as passes. No spike
marked green on a partial condition, and the amendment-5 caveat travels with the Spike 1 result
wherever it is quoted.
