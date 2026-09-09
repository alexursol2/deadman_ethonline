# Spike 16 — Privy server wallets on Hedera

**Question.** Can the paying agent's key live in Privy instead of in `.env`, and can a Privy spend
policy bound what that agent is able to spend?

**Answer.** Yes to the first, and **no to the second on this rail** — and the reason is specific
enough to be worth reporting to Privy rather than worked around quietly.

Run end to end against the public deployment: hold 4, schedule `0.0.10433614`, paid, key revealed,
plaintext decrypted, **with no private key on the machine at any point.**

---

## 1. The obvious path works, and it is not the one we need

`walletApi.ethereum.sendTransaction` with `caip2: "eip155:296"` succeeds. Privy signs *and*
broadcasts to Hedera testnet, a chain it does not advertise support for. Verified on the mirror
node rather than trusting the returned hash:
[`0xab4eb68d…`](https://hashscan.io/testnet/transaction/0xab4eb68df56e4e1f75c2e4f5449614d914aafb98e9843c546b7e7bd73d06abdb)
— `SUCCESS`, 1 HBAR, 21,000 gas.

We expected this to fail and had a fallback ready (sign at Privy, broadcast through HashIO
ourselves). It was not needed.

**But it is the wrong shape for x402.** The exact-Hedera scheme does not pay with an EVM
transaction. `agent/src/index.ts` builds a `@hashgraph/sdk` `TransferTransaction`, because that is
the only thing the Blocky402 facilitator accepts (spike 7). So Privy's EVM methods, working or not,
cannot make the payment.

## 2. The bridge: `secp256k1Sign`

`walletApi.ethereum.secp256k1Sign({ walletId, hash })` returns a raw signature over an arbitrary
32-byte hash with no EIP-191 prefixing. Hedera's ECDSA scheme signs `keccak256(bodyBytes)` and wants
64 bytes of `r||s`. That lines up exactly:

```ts
client.setOperatorWith(accountId, publicKey, async (bytes) => {
  const r = await privy.walletApi.ethereum.secp256k1Sign({ walletId, hash: keccak256(bytes) });
  return getBytes(r.signature).slice(0, 64);   // drop the recovery byte, Hedera rejects it
});
```

One wrinkle: **Privy does not return the wallet's public key**, and Hedera needs it to attach a
signature. Recover it from a signature over a known hash, then check the recovered key derives the
wallet's own address — otherwise every signature is silently attributed to the wrong account. That
check is in `agent/src/signer.ts` and it is not decorative.

Result: `0.0.10433495@1788937103.351208459`, status `SUCCESS`. A Hedera-native transfer signed
entirely by Privy.

## 3. Policies are default-deny

The first policy was written as a DENY rule — *deny transfers over 6 HBAR*. It refused **everything**,
including the 1 HBAR transfer it was supposed to permit, and also refused `secp256k1Sign`.

Attaching a policy switches the wallet to deny-by-default. Rules must be written as ALLOWs. Nothing
in the type signatures says so, and a DENY-only policy is silently a brick.

## 4. The finding: a spend cap and x402 are mutually exclusive here

| policy rules | 1 HBAR EVM | 10 HBAR EVM | Hedera transfer via `secp256k1Sign` |
| --- | --- | --- | --- |
| `[ALLOW eth_sendTransaction WHERE value <= 6 HBAR]` | ALLOWED | DENIED | **DENIED** |
| `+ [ALLOW *]` | ALLOWED | **ALLOWED** | SUCCESS |

`PolicyMethod` is `eth_signTransaction | eth_sendTransaction | eth_signTypedData_v4 |
eth_sign7702Authorization | signAndSendTransaction | signTransaction | exportPrivateKey | *`. There
is **no entry for raw secp256k1 signing**. So the only rule that permits the signature x402 needs is
the wildcard — and the wildcard also permits the over-cap transfer the cap was there to stop.

Verified rather than inferred: 10 HBAR went through under a 6 HBAR cap,
[`0x33a948f5…`](https://hashscan.io/testnet/transaction/0x33a948f5df35a7d053726db65da43db2c8357881583b27f1f0e0023e8cf2de1b).

> One earlier reading of that same cell came back `DENIED` with *"Nonce too low"* — the relay
> complaining, not the policy engine refusing. Re-run with a `pending` nonce before it counted. It
> would have been an easy false result, and in the direction that flattered us.

**So the shipped policy is a single `ALLOW *` rule whose name states the limitation**, because the
dashboard is where the next person looks. We are not leaving a 6 HBAR cap sitting next to a wildcard
that voids it; that would look like protection while providing none.

### What we would need from Privy

A policy method covering raw signing, or condition support for Hedera-native transaction bodies.
Either one turns "custodied wallet" into "custodied *and bounded* wallet" on this rail.

## 5. What this actually buys, stated honestly

- **Real:** the agent's key does not exist on the machine. Signing is an authenticated API call. Kill
  the agent host and the key is unaffected; it was never there.
- **Real:** the wallet is revocable and auditable from outside the process holding it.
- **Not real:** the spend cap. Measured, not assumed, and the measurement is above.

## 6. Costs

| thing | measured |
| --- | --- |
| create wallet | instant, no chain interaction |
| fund a NEW address (creates the Hedera account) | **607,854 gas** — and it fails outright at a transfer's 21,000 limit |
| top up an existing account | 21,000 gas |
| Hedera transfer signed via Privy | ~2 extra round trips to Privy per transaction |

## 7. Files

- `agent/src/signer.ts` — the local-or-Privy signer behind one interface
- `agent/src/privy-wallet.ts` — create or show the wallet
- `agent/src/privy-fund.ts` — fund it, with the account-creation gas limit handled
- `agent/src/privy-hedera-spike.ts` — the `secp256k1Sign` bridge, proven
- `agent/src/privy-policy-spike.ts` — the policy matrix in section 4
- `agent/src/privy-wildcard-retest.ts` — the re-test of the one cell that came back inconclusive
- `agent/src/privy-apply-policy.ts` — puts the wallet into its final, honest policy state
