# End to end — x402 settle → openHold → network-executed refund

**All eight conditions met. The buyer paid, the seller stayed silent, and the buyer got their money
back with nobody acting.** Run 2026-09-08.

Everything before this was proven in halves: [spike 10](10-payto-contract.md) settled a real x402
payment into a contract, [spike 11](11-escrow-gas.md) opened and refunded a hold funded by a plain
transfer. This is them joined up, which is the actual product.

| | |
|---|---|
| Escrow | `0xc5241034C7c060361B0223B3c6d77d0A4bC8Ef09` = **`0.0.10419881`** (the x402 `payTo`) |
| Buyer | `0xdE744e48…` = `0.0.10420243`, a wallet created minutes earlier |
| Settlement | [`0.0.7162784-1788864119-121509010`](https://hashscan.io/testnet/transaction/0.0.7162784-1788864119-121509010) via Blocky402 |
| Hold | `holdId 4`, schedule [`0.0.10420245`](https://hashscan.io/testnet/schedule/0.0.10420245) |
| Refund | executed `1788864174.018234916`, **`signatures: []`** |

Evidence: [`e2e-settle-open-refund.json`](e2e-settle-open-refund.json).

## The sequence

```
1. a fresh agent wallet                     0.0.10420243, 3 HBAR
2. it pays 0.5 HBAR through Blocky402       /verify 200 isValid, /settle 200 success
   the escrow is credited                   free 22.95 -> 23.45 HBAR, exactly 50,000,000 tinybar
   the escrow's code does NOT run           (C12 — this is why openHold attributes rather than receives)
3. the server opens a hold over those funds holdId 4, armed for 1788864174, 1,668,661 gas
4. THE SELLER STAYS SILENT                  nothing is submitted by anyone for 54 seconds
5. the network executes the refund          46,744 gas of 250,000, signatures []
   the buyer is whole                       3 -> 2.5 -> 3 HBAR
```

| Condition | Result |
|---|---|
| `/settle` succeeded through Blocky402 | ✅ |
| the escrow was credited by the settlement | ✅ exactly 50,000,000 tinybar |
| `openHold` armed a refund over those funds | ✅ |
| the network executed it with **nobody acting** | ✅ `signatures: []` |
| the hold is `REFUNDED` | ✅ |
| the settlement debited the buyer | ✅ −0.5 HBAR |
| the refund put it back | ✅ +0.5 HBAR |
| **the buyer is exactly whole** | ✅ 3 HBAR → 3 HBAR |

## The assertion that was wrong the first time

The first run failed one check: "the buyer got their money back — expected +50,000,000, actual 0".

The contract was right and the test was wrong. `buyerStart` was sampled *before* the payment, so the
start-to-end delta of zero was the success condition, not a failure — the buyer paid 0.5 and got 0.5
back. The fix was to sample the balance after settlement too, and assert all three: that the
settlement debited them, that the refund put it back, and that they end exactly where they began.

Worth recording because it is the same failure mode as the warm-contract gas measurement in
[spike 11](11-escrow-gas.md): a measurement that is true and does not mean what it appears to.

## What this establishes

**The escrow-as-`payTo` design works in practice, not just in principle.** The seller never held the
buyer's money at any point. The settlement credited the escrow directly, and the only route out of
the escrow to the seller is `claim()`, which needs a key the seller never revealed.

**The refund is genuinely unattended.** Between `openHold` and the refund, no transaction was
submitted by the buyer, the seller, our scripts, or anyone else. `signatures: []` on the schedule
record is the network's own statement of that.

**The disclosed window behaved as described.** Between step 2 and step 3 the money sat in the escrow,
settled but unarmed. That gap is real and it is in the README. What it is *not* is a gap where the
seller holds the money.

**Gas held at the measured figures.** `openHold` 1,668,661 (against 1,668,649 in spike 11), refund
46,744 — identical to the spike 11 happy path. The 250,000 limit is unchanged and comfortable.

## What is still not done

- **This did not go through our own x402 resource server.** The payment payload was built and posted
  to the facilitator directly. The Hedera track requires a live x402-gated service and an agent that
  consumes it, so `@x402/express`, the 402 challenge, and the agent client are all still to be built.
  **This proves the payment rail and the escrow; it does not yet satisfy the track requirement.**
- **The claim path was not exercised in this sequence.** It works standalone
  ([spike 11](11-escrow-gas.md)) but has not been run against a settled payment.
- **One run, uncongested network, both parties ours.**
- **`verify.ts`** — the buyer-side tool that catches a lying seller — does not exist yet. The four
  commitments are being written into the log by `openHold`, so the data is there; nothing reads it.
