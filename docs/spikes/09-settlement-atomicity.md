# Spike 9 — can the x402 settlement arm a hold atomically?

**Verdict: NO. Atomicity is not available.** Run 2026-09-08.

This is the most consequential finding in the project so far, and it changes one sentence of the
pitch. **It does not change the mechanism.** Read the "what survives" section before reacting to the
"what breaks" section.

---

## Part A — the settlement cannot BE a contract call

`@x402/hedera@2.25.0`, read rather than guessed.

The exact scheme's client builds one thing:

```js
const transaction = await this.signer.createPartiallySignedTransferTransaction(paymentRequirements);
```

Across the whole package there are **105 references to `TransferTransaction` and zero to
`ContractExecuteTransaction`**. No `setFunction`, no `setContractId`, nothing that could carry
calldata.

And the facilitator does not merely fail to support it — it explicitly rejects it:

```js
const isTransferTransaction = transaction instanceof import_sdk.TransferTransaction;
...
hasNonTransferOperations: !isTransferTransaction,
...
if (inspected.hasNonTransferOperations) {
  return { isValid: false, invalidReason: "invalid_exact_hedera_payload_contains_non_transfer_ops", payer: "" };
}
```

A payment payload that is anything but a pure transfer is rejected at verification, by name. There is
no configuration that changes this; it is the scheme.

## Part B — and a HAPI transfer to a contract does not run its code

If the settlement must be a transfer, the fallback would be for the escrow to *be* the recipient and
open the hold from inside `receive()`. On the EVM that works. Hedera settles through HAPI, which is
not the EVM, so it was measured.

Sink `0xB85688ca6D3317E371bF6E18b5A62903d65F535b` = `0.0.10418229`, freshly deployed.

| | Method | `receiveCalls` | Balance | `receive()` |
|---|---|---|---|---|
| **Control** | EVM value transfer, 1 HBAR, via JSON-RPC | 0 → **1** | 0 → 1 HBAR | **ran** |
| **Subject** | HAPI `CryptoTransfer`, 2 HBAR, via consensus node | 1 → **1** | 1 → 3 HBAR | **did not run** |

HAPI transfer status `SUCCESS`, transaction `0.0.10393158@1788853069.294141229`, credited exactly
`200000000` tinybar.

**The money arrives. The code does not run.** The control is what makes that a finding rather than a
broken counter — the same contract, the same function, executed on the EVM path seconds earlier.

Evidence: [`spike9-result.json`](spike9-result.json).

---

## What breaks

The brief says:

> The payment settles into a hold instead of to the seller. **In the same transaction**, the hold
> books its own refund with the Hedera network, sixty seconds out.

**The emphasised part is not achievable through x402 on Hedera.** The settlement is a
`CryptoTransfer`; it cannot call `openHold`, and it cannot trigger `receive()`. There will be a gap
between "money moved" and "refund armed", spanning one transaction.

This must be corrected in the README, in the video's description of the mechanism, and in plan 04 §0.
Not softened — corrected. The brief is explicit that volunteering limits is rewarded and hiding them
is not, and a judge who reads `@x402/hedera` will find this in ten minutes.

## What survives, and it is the part that matters

**The one-liner is untouched:**

> Every x402 escrow needs someone to push a button. Ours is the only one where the protocol pushes it.

That sentence is about the **refund**, and the refund is exactly as keeper-free as spikes 1 through 8
established. The network still executes it unattended, with `signatures: []`, and nobody — including
us — can cancel it. What moved is the *arming* step, not the *firing* step, and every competitor in
the comparison table has the same arming step plus a keeper we do not have.

The novelty claim also survives in its precise form: **a contract arms its own refund from inside the
EVM.** It just does so one transaction after the money lands, rather than in the same one.

## Recommended design: escrow-as-`payTo`

Because Part B showed the transfer **does** credit a contract account successfully, the escrow can
still be the x402 `payTo`. That is the difference between an awkward limitation and a fatal one.

```
1. Agent pays.  x402 payTo = the ESCROW's account.
   The CryptoTransfer credits the escrow directly. The seller never holds the money.
2. Server calls openHold(...), which arms the refund against the already-credited balance.
```

`openHold` becomes non-payable and instead attributes funds that are already present:

```
unattributed = address(this).balance - totalLocked - totalWithdrawable - reserve
require(unattributed >= amountTinybar)
```

The escrow's surplus balance is the pool of settled-but-unarmed payments, and `openHold` draws from
it. Simple accounting, no oracle, no proof-of-transfer.

### Why the gap is much smaller than it looks

**The seller cannot get paid without a hold existing.** `claim()` pays from a hold; there is no other
path out of the contract to the payee. So a server that takes the money and skips `openHold` gets
nothing — the funds sit in the escrow's unattributed pool, out of the seller's reach.

The incentive is therefore aligned rather than merely hoped for. The residual failure is a server
that **crashes** between settling and arming, which leaves the buyer's money in the escrow rather
than with the seller. That is a materially better failure than the one Deadman exists to fix, and it
is one we can honestly describe.

### What the gap still costs, stated plainly

- **Unattributed funds need a recovery path.** A payment that is never armed has no on-chain record
  of who paid it — the contract sees a balance, not a payer. Recovery needs an operator-attributed
  sweep, and that is a "someone must act" path. It must be disclosed.
- **In permissionless mode, a hostile server could open a hold against another buyer's unattributed
  funds.** The allowlist we already ship (plan 04 §Q6) closes this; removing the allowlist later
  requires solving attribution properly, which is now a documented prerequisite rather than a
  nice-to-have.

## The one thing still unmeasured

**Will Blocky402 accept a contract's account id as `payTo`?** The package only requires `payTo` to
match the `0.0.N` entity-id shape and to pass the facilitator's `resolveAccount`, and there is no
contract-type restriction in the validation code we can read. But `resolveAccount` is implemented by
the facilitator's own signer, which is not public.

Spike 9 proves the **on-chain** half works: a HAPI transfer to a contract account succeeds and
credits it. Whether Blocky402's resolver permits it needs a real payment payload through `/verify`,
which is the next piece of work and belongs with the resource server rather than with the contract.

**If it refuses**, the fallback is a plain account as `payTo` with the server forwarding to the
escrow — which reintroduces exactly the seller-holds-the-money window we just avoided, and would be
worth raising with Hedera as a track-level problem, since it would make a genuine escrow impossible
to build on their own x402 stack.

## For Tuesday

Worth Hedera's attention as a gap in their own stack, not just ours: **x402 on Hedera cannot settle
into a contract call**, so no escrow, vault, or streaming product can take payment atomically. Every
such design on this rail has a settle-then-arm window. That seems like something the AI & Agentic
Payments track would want to know about, and we can hand them the exact line in their reference
implementation that causes it.
