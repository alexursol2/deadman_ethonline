# Spike 4 — can a third party delete someone else's schedule?

**Verdict: NO. All four cells rejected. The refund guarantee holds.** Run 2026-09-06.

Victim schedule [`0.0.10395872`](https://hashscan.io/testnet/schedule/0.0.10395872), armed by
`SpikeSchedule` at `0x47A1a21f…E1CA2c`, 600 s out. Control read first: present, `deleted: false`,
`executed_timestamp: null`. Attacker EOA `0xb491449A…502fd6` — **freshly generated**, not our
deployer, because if authorisation keyed off the payer account then attacking with our own key would
have passed for the wrong reason. Attacker contract `0x9C37335D…83721d`.

| Cell | Attacker | Path | Result | Schedule after |
|---|---|---|---|---|
| 3a | unrelated EOA | `0x16b` `deleteSchedule(address)` | code **7** | still alive |
| 3b | unrelated EOA | redirect `deleteSchedule()` | code **7** | still alive |
| 3c | unrelated contract | `0x16b` `deleteSchedule(address)` | code **7** | still alive |
| 3d | unrelated contract | redirect `deleteSchedule()` | code **7** | still alive |

Then the victim contract deleted its own schedule on the first try — proving the schedule was
deletable all along and the four refusals were about *who was asking*, not about a schedule that had
somehow become immutable.

Evidence: [`spike4-result.json`](spike4-result.json). Transactions:
[3a](https://hashscan.io/testnet/transaction/0x1cb65f77951786af7b9194ca92812f7ad334f6498212e11d7b01c028cbab3bf7),
[3b](https://hashscan.io/testnet/transaction/0x80a3309ed1788c518623de620b660a692589d3b959adf63a3d5db4a1e7fbec18),
[3c](https://hashscan.io/testnet/transaction/0x89fbb9b064a82b131af8a5d41f6cd586544d002d48b408fdd2be0325dde4a76d),
[3d](https://hashscan.io/testnet/transaction/0xd0459618c3b983bc564137708aa20e97eb60ed07d8e954fbf496b14611c99128).

## The authorisation model, which HIP-1215 does not state

Every refusal returned `7`. Checked against
[`response_code.proto`](https://github.com/hiero-ledger/hiero-consensus-node/blob/main/hapi/hedera-protobuf-java-api/src/main/proto/services/response_code.proto)
rather than recalled: **`INVALID_SIGNATURE = 7`**.

So deletion is gated on the schedule's admin key, and a schedule created by
`scheduleCall` has the creating contract as its admin. The contract's own contract-ID key satisfies
it; nothing else does. Not the deploying EOA, not another contract, not a stranger.

That is the answer we needed. `refund()` cannot be cancelled out from under a buyer.

## The part that will bite someone: rejection is a silent no-op

Look at the EOA rows again:

```
3a  tx status 1 (SUCCESS)  gasUsed 92,850   call_result 0x…07
3b  tx status 1 (SUCCESS)  gasUsed 95,432   call_result 0x…07
```

**The transaction succeeds.** No revert, no error, `result=SUCCESS` on the mirror node. The refusal
exists only in the 32 bytes of return data. A caller who does not decode the return value sees a
perfectly healthy transaction and a schedule that is still armed.

For `HoldEscrow` this is the difference between correct and catastrophic. If `claim()` calls
`deleteSchedule` and ignores the code, the seller gets paid, the contract believes the refund was
cancelled, and then **the refund fires anyway at expiry and pays the buyer too**. The hold pays out
twice. Our contract reverts on anything other than `22`, so we are safe — but only because we treat
the response code as load-bearing.

This is not hypothetical. Hedera's own scaffold template, `templates/payments-scheduler`, has both
shapes in one file. The external entry point checks:

```solidity
int64 rc = HSS.deleteSchedule(schedule);
if (rc != HSS_SUCCESS) revert ScheduledVault__ScheduleFailed();
```

and the internal helper does not:

```solidity
function _cancelPendingSchedule() internal {
    if (nextSchedule != ZERO_ADDRESS) {
        HSS.deleteSchedule(nextSchedule);   // return value discarded
        nextSchedule = ZERO_ADDRESS;        // cleared regardless
    }
}
```

The second one clears its own bookkeeping whether or not the delete was accepted, so the contract
ends up believing it cancelled a schedule that is still armed. Worth raising at the Hedera feedback
session: the failure is silent, the reference implementation demonstrates both the safe and the
unsafe pattern, and the HIP never mentions that a refusal looks like success from an EOA.

## Also learned: activating a fresh account costs real gas

Funding the attacker EOA at `gasLimit: 300_000` reverted, consuming all of it, with no reason
string. A transfer to an address Hedera has never seen also *creates* the account — lazy/hollow
account creation — and that costs far more than an EVM value transfer. At 2,000,000 it went through.

This is the brief's Privy gotcha, precisely: *"a fresh Privy wallet's EVM address needs an activated
Hedera account. Send HBAR to the alias before it can transact."* That activating transfer will fail
the same silent, expensive way if it is sent with a default gas limit. Worth handing to whoever
wires up Privy before they lose an afternoon to it.

## What this does not cover

- One schedule, one moment, an uncongested testnet.
- We tested strangers. We did **not** test whether the *deploying EOA* can delete a schedule its own
  contract created — that sits between "owner" and "stranger" and is a different question. It does
  not block `refund()`, since nothing in the design needs it, but it matters if we ever want an
  operator-side escape hatch.
- Admin-key inheritance is inferred from `INVALID_SIGNATURE`, not read from a spec. The code is
  consistent with a signature check and nothing else we observed contradicts it, but HIP-1215 does
  not document the rule and we should say "consistent with" rather than "is" until Hedera confirms.
