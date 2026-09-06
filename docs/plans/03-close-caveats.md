# Plan 03 — close the caveats the spikes left open

**Implementing agent:** Claude Opus 5 (Claude Code). **Requested by:** Alex, 2026-09-06, after
Spike 4. Committed before implementation, per the ETHGlobal AI-attribution requirement.

Each spike report ended with a "what this does not establish" section. This pass works through those
and either closes them with evidence or states plainly why they stay open. A caveat that can be
closed for the cost of one script should not be sitting in the README on submission day.

## Triage

| # | Caveat | From | Action |
|---|---|---|---|
| 1 | Admin-key rule *inferred* from `INVALID_SIGNATURE`, not read | Spike 4 | **Closed already** — see below |
| 2 | Redirect cancel path `0xc61dea85` never exercised by the owner | Spike 2 | **Test it** (5a) |
| 3 | Never tested whether the *deploying EOA* can delete its contract's schedule | Spike 4 | **Test it** (5b) |
| 4 | Jitter fallback never executed | Spike 1 | Stays open — needs a mock, Wednesday |
| 5 | Mirror-node backoff never fired | Spike 2 | Stays open — cannot force |
| 6 | Claim/refund same-second race | Spike 2 | Stays open — a `HoldEscrow` concern |

### 1 is already closed, by reading rather than testing

The mirror node returns `admin_key` on the schedule record and we never looked at it:

```
admin_key: {"_type":"ProtobufEncoded","key":"0a0518bbc0fa04"}
```

Decoded: `0a` = `Key.contractID`, length 5; `18` = `ContractID.contractNum`, varint `bb c0 fa 04` =
**10395707** — which is the victim contract, `0.0.10395707`. So the admin key on a `scheduleCall`
schedule *is* the creating contract's ContractID. That is direct evidence and it replaces the
inference. The decode goes in a committed script so nobody has to take my word for the varint.

Two more fields worth recording while we are here: `creator_account_id` is the operator EOA that
paid for the arming transaction, and `payer_account_id` is the **contract**, which is the on-chain
confirmation that the contract pays for execution — the brief's failure mode 3.

### 5a — can the owner contract cancel via the redirect path?

Spike 2 stopped at the first success, correctly, which left `0xc61dea85` implemented and unexercised.
It is our fallback if the primary path ever changes, so "we wrote it and never ran it" is not good
enough to keep in the repo.

Arm a schedule, cancel it with `cancelViaRedirect`, assert code 22 and `deleted: true`.

### 5b — can the deploying EOA delete a schedule its own contract created?

This sits between "owner" (proven yes) and "stranger" (proven no). Spike 4 used a *fresh* EOA
precisely so the result could not be confused by our operator's relationship to the contract — which
means our operator's own position is still untested.

Given finding 1, the expected answer is **no**: the admin key is a ContractID, and the deployer's
key is not that contract. Confirming it matters in two directions:

- If it is **no**, that is a *good* property to state out loud. Not even we can cancel a buyer's
  refund. The guarantee is stronger than "we promise not to", and that belongs in the pitch.
- If it is **yes**, we hold a privileged cancel over every hold in the system, and saying "nobody has
  to act" while quietly retaining that power would be the kind of claim that gets a prize withdrawn.

Arm a schedule, have the operator EOA call both delete paths, assert both are refused and the
schedule survives, then clean up via the contract.

## Method

One script, `scripts/spike5-close-caveats.cjs`, run against a freshly deployed contract (the `% 3600`
removal changed the bytecode). Same discipline as before: control read before every attempt, generous
gas so a starved call cannot be mistaken for a refusal, response codes decoded against
`response_code.proto`, evidence written to `docs/spikes/`.

Cleanup is mandatory. Every schedule this script arms is either deleted by the end or explicitly
reported as left alive, so we do not leave stray schedules firing into later runs.

## Also in this pass

- **Remove the `% 3600 == 0` check.** Alex confirmed: it never fires, every hour boundary is already
  a minute boundary. Done before this plan was committed, in the same branch.
- **Write `docs/SESSION-01.md`** — what this session actually did, for the team and for the
  submission's AI-use section.
