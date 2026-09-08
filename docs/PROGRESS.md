# Deadman — progress and plan

**Updated 2026-09-06.** Submission deadline **Sunday 13 September, 12:00 PM ET** (18:00 Vienna).
We submit Saturday night. Sunday morning is buffer only.

Partners: **Hedera** (AI & Agentic Payments) and **Privy**. Third slot held open, decision Friday.

---

## Where we are

Session 01 is complete and merged to `spike/hip-1215` (PR #1). **21 commits.** Purpose was to verify
three undocumented assumptions before building on them. It grew to five spikes because two of the
first three raised questions cheaper to answer now than on Saturday.

**All three original assumptions hold. The design does not change.**

| | Question | Verdict |
|---|---|---|
| 1 | Does a scheduled call fire unattended on current testnet? | **Yes.** 4 ms into its target second, `signatures: []` |
| 2 | Can a contract cancel its own pending schedule? | **Yes.** Code 22, stayed dead past expiry |
| 3 | Is the Blocky402 facilitator alive? | **Yes.** But the scaffold does not point at it |
| 4 | Can a third party delete our schedule? | **No.** All four attack cells refused |
| 5 | Do the caveats survive scrutiny? | Four closed, three named and still open |

Every number has committed JSON behind it and a HashScan link. Reports in `docs/spikes/`.

### What is in the repo

```
contracts/contracts/   SpikeSchedule.sol, Attacker.sol
contracts/scripts/     verify-selectors, deploy, spike1-arm, spike1-verify, spike2,
                       spike2-confirm, spike4-third-party-delete, spike5-close-caveats,
                       units-probe, gas-probe, diag-hss, lib
docs/plans/            01-spikes, 02-third-party-delete, 03-close-caveats
docs/spikes/           five reports plus raw mirror JSON for every claim
docs/SESSION-01.md     full write-up
```

Plans are committed **before** the implementation they describe, per ETHGlobal's AI-attribution
requirement.

**Not started, deliberately:** `HoldEscrow.sol`, `/server`, `/agent`, `/web`.

---

## What the spikes changed about how we build

Six findings that constrain `HoldEscrow`. These are measurements, not opinions.

**1. The network executes a scheduled call as the scheduling contract itself.** `msg.sender` is the
contract's own address, so `refund()` can be gated on `msg.sender == address(this)`.

**2. `block.timestamp` inside a scheduled execution is the enclosing block's consensus time, not the
expiry second.** Deadlines must travel in the calldata.

**3. A rejected `deleteSchedule` is a silent no-op.** Transaction status is SUCCESS with no revert;
the refusal exists only in the return code. A contract that discards it believes it cancelled a
refund that is still armed, the seller gets paid, the refund fires anyway, and **the hold pays out
twice**. Hedera's own `payments-scheduler` template ships both the checked and unchecked pattern in
one file.

**4. `scheduleCall` needs ~1.45M gas of its own and it does revert.** Empty returndata when starved.
Floor measured between 1,445,312 and 1,468,750, independent of the gas requested for the scheduled
call. **`openHold` cannot be a cheap transaction.**

**5. HBAR balance inside the EVM is tinybars (1e8), not weibars (1e18).** A condition like
`balance >= 5 ether` can never pass in a Hedera contract. Ours failed loudly, which was luck; the
mirror image passes trivially and puts an underfunded contract into the demo with the refund
silently not firing.

**6. Only the creating contract can delete its own schedule.** The deploying EOA cannot, verified
separately. Worth saying in the pitch: once a hold is open, **we** cannot cancel the buyer's refund
either. There is no operator override to be compelled into using.

Two smaller ones: `block.prevrandao` and the `0x169` PRNG return identical values on Hedera, so read
`prevrandao` and skip the system call. And activating a fresh Hedera account needs ~2M gas, which is
exactly the Privy alias-activation gotcha.

### The one that costs us the track if missed

The `x402-pay-per-use` scaffold defaults to a **self-hosted facilitator on `localhost:4020`**.
Blocky402 appears once in the whole template, in `RUNBOOK.md`, as an optional fallback. Following the
happy path settles through our own facilitator and **fails the track gate with every test passing and
nothing erroring.**

One variable fixes it: `FACILITATOR_URL=https://api.testnet.blocky402.com`. It is a **gate check**,
and the paid-request milestone does not count as met unless the settle transaction shows fee payer
`0.0.7162784` on HashScan.

---

## Plan

| Day | Alex | Igor | Frontend | Media |
|---|---|---|---|---|
| **Mon 8** | `HoldEscrow.sol`: `openHold`, `claim(holdId, k)`, `refund(holdId)`, four commitments | **Design review before implementation** | Privy wallet on chain 296, alias activation | Storyboard, README first screen |
| **Tue 9** | x402 resource server through Blocky402, gate check on fee payer | Start adversarial tests | Board shell, first hold rendering | 30-second cut, tested on an outsider |
| **Wed 10** | **First real paid request through the deployed escrow, end to end** | **Contract review** plus mocked HSS for the jitter fallback | Privy spend policy live on the agent; agent client | Draft both partner write-ups against the rubrics |
| **Thu 11** | HCS receipts on every state change; dark-service flag | Finish adversarial tests, commit them | Countdown timers, mirror-node links, infra status panel | Rough cut |
| **Fri 12** | **Feature freeze.** Clean-clone test. Both `FEEDBACK.md` files | **Whole-repo review from a clean clone** | Polish, mobile, empty states | Cut to 4 minutes, **test upload** |
| **Sat 13** | Limits section, hygiene gate, AI plan files. **Submit tonight** | Rehearse shutdown demo three times cold | Final deploy, verify from a phone | Final video rendered and uploaded |

**Wednesday is the milestone that matters.** One real paid request through the deployed escrow
qualifies us for the track on its own. Everything after is upside, so if it slips we cut scope rather
than pushing it later.

**Friday evening:** decide on Bazantic as the third partner. Only if the escrow works, a refund has
fired unattended, and the video is cut.

### Priority order if time runs out

1. Blocky402 works, one real paid request end to end
2. Escrow holds the payment and the scheduled refund fires unattended
3. Key-reveal claim that cancels the pending schedule
4. Privy wallet plus spend policy
5. HCS receipts
6. Live board with countdowns
7. Volume, hundreds of holds rather than a handful

---

## Still open, and named

| Gap | Why |
|---|---|
| The jitter fallback has never executed | Testnet is uncongested, `probesUsed` was 0 on every run. Untested code on the critical path. Needs a mocked HSS, Igor, Wednesday. |
| Claim and refund in the same second | A `HoldEscrow` concern, not a spike. Belongs in the adversarial tests. |
| One observation each, uncongested testnet | Open by nature. Rehearse the demo cold three times. |
| `value` in tinybars is inferred, not measured | Both spikes passed zero. A weibar amount cannot fit in `uint64`, so tinybars is near-certain, but `refund()` moves real money. Pin before Wednesday. |

All four are in the README's "Limits we are not hiding", alongside the scope limit itself: **we
guarantee delivery, not correctness.** A seller can encrypt garbage, reveal the correct key, and get
paid. ZKCP and optimistic fraud proofs are documented as the known solutions and why they did not fit
six days.

---

## Dates

| When | What |
|---|---|
| Tue 8 Sept | Project Feedback Session #1. Alex attends with the spike results and one specific question |
| Thu 10 Sept | Project Feedback Session #2 |
| TBC | Project Check-in #1 and #2 on the hacker dashboard. Do not write "all good", name any partner-side blocker |
| **Sun 13 Sept, 12:00 ET** | **Submissions due.** Non-negotiable, never extended |
| Mon 14 Sept, 12:00–14:00 ET | Finalist judging call, 7 minutes live, if we opt in. Missing it disqualifies us |
| Wed 16 Sept, 12:00 ET | Closing ceremony |

---

## For Tuesday's Hedera session

Four things worth a Hedera engineer's attention:

1. A rejected `deleteSchedule` returns transaction SUCCESS. The official `payments-scheduler`
   template ships a helper that discards the code and clears its own bookkeeping regardless.
2. `scheduleCall` reverts with empty returndata when starved of gas, which contradicts how the HIP's
   "never reverts" reads. Floor is ~1.45M.
3. The delete authorisation model is undocumented. We established it empirically: the admin key is
   the creating contract's ContractID. It belongs in the HIP.
4. `hasScheduleCapacity(now + 1)` returns false despite the HIP stating a one-second minimum. False
   means "invalid expiry" and "saturated" indistinguishably.

One question for Luke: is the jitter fallback exercisable against testnet at all, or is a mocked HSS
the only way we test it before mainnet?
