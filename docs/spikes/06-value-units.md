# Spike 6 — what unit is `scheduleCall`'s `value` parameter in?

**Verdict: TINYBARS. The session-01 inference was right, and it is now measured.** Run 2026-09-07.

| | |
|---|---|
| Schedule | **[`0.0.10412082`](https://hashscan.io/testnet/schedule/0.0.10412082)** |
| Arming tx | [`0xcddb6cfd…13a6a63`](https://hashscan.io/testnet/transaction/0xcddb6cfdd1f6536c4ae93a0adf5874ace89cbea195abc20f34e633d5713a6a63) |
| Paying contract | `0x275A49bF78E632e8fc0D0A05A1336D57f4541Ed4` |
| Recipient | `ValueSink`, freshly deployed so its delta is unambiguous |
| `value` passed | `300000000` (3e8) |
| Executed | `1788815571.010051208`, `signatures: []` — unattended, as always |

3e8 was chosen so the two hypotheses could not be confused: tinybars means 3 HBAR lands, weibars
means 0.03 tinybar and **nothing** lands. Ten orders of magnitude apart, not adjacent.

## Result

```
sink gained (EVM, tinybars)        300,000,000   = 3 HBAR    <- exactly the value passed
sink gained (eth_getBalance)     3,000,000,000,000,000,000 weibar = 3 HBAR
escrow lost (EVM, tinybars)        313,884,709   = 3.13884709 HBAR
escrow lost minus sink gained       13,884,709   = 0.13884709 HBAR  (execution gas)
```

Exactly 3 HBAR. Both balance surfaces agree once converted. `value` is denominated in tinybars,
same as everything else inside the EVM.

Raw mirror record: [`spike6-schedule.json`](spike6-schedule.json). Full measurement:
[`spike6-result.json`](spike6-result.json).

**No change to `refund()`.** The amount can be written straight into the schedule.

One consequence worth stating: `uint64` in tinybars caps a single scheduled transfer at
~184,467,440,737 HBAR, which is far above the 50 billion HBAR total supply. The parameter's width
is not a product constraint. Had the unit been anything finer, it would have been.

## The complete unit rule, now that both sides are measured

Session 01 found that `address(this).balance` reads tinybars while `eth_getBalance` reads weibars,
and left it there. This spike closes the picture, including a check on the normal (non-scheduled)
call path, because `openHold` will be `payable` and read `msg.value` on exactly that path:

| Read from | Quantity | Unit |
|---|---|---|
| Inside the EVM (Solidity) | `address(this).balance` | **tinybars**, 1e8/HBAR |
| Inside the EVM (Solidity) | `msg.value`, normal call | **tinybars** — sent 2 HBAR, read `200000000` |
| Inside the EVM (Solidity) | `msg.value`, scheduled call | **tinybars** — value 3e8, read `300000000` |
| Inside the EVM (Solidity) | `scheduleCall`'s `value` parameter | **tinybars** |
| JSON-RPC / ethers | `eth_getBalance`, transaction `value` | **weibars**, 1e18/HBAR |

**Everything inside the EVM is tinybars. Everything over JSON-RPC is weibars. The boundary converts,
exactly 1e10.** That is a simple rule and it is now measured on every surface `HoldEscrow` touches,
rather than assumed on any of them.

The practical form: never write an `ether` literal in a Hedera contract, and always convert at the
script boundary. `1 ether` in Solidity is 1e18 — ten billion HBAR, not one.

## `msg.sender` of a scheduled call, confirmed against a third-party target

Spike 1 established that a network-executed call arrives with `msg.sender` equal to the scheduling
contract. But there the call was to the contract *itself*, so sender and target were the same
address and the observation could not distinguish "the scheduling contract" from "the target
contract".

Here the target is a separate contract, and the sink recorded:

```
scheduled call's msg.sender: 0x275A49bF78E632e8fc0D0A05A1336D57f4541Ed4   <- the SCHEDULING contract
```

Not the target, not a system account, not the arming EOA. This is what makes
`require(msg.sender == address(this))` on `refund()` a real gate rather than a hopeful one, and it
is now established without the ambiguity spike 1 left in it.

## Execution gas, measured — the number Task B needs

The scheduled call requested a 250,000 gas limit and the paying contract was charged **13,884,709
tinybars ≈ 0.1389 HBAR**.

At the observed gas price of 1.05e12 weibar (105 tinybar) per gas, that works out to roughly
**132,000 gas actually consumed** for a value-carrying scheduled call into a small recipient. So:

- The network charges for gas **used**, not the limit requested. Over-requesting costs nothing but
  the capacity reservation.
- ~132k is the real cost of a value-carrying scheduled execution. The 150,000 we used for the
  value-free spikes would have been uncomfortably tight for this.
- A refund that also touches escrow storage and emits events will cost more than 132k.

This feeds directly into the `HoldEscrow` gas figure and the minimum-balance assert. It is used in
[`plans/04-holdescrow.md`](../plans/04-holdescrow.md) §7.

## Caveat

One execution, one recipient, one uncongested moment. The recipient is a contract with a cheap
`payable` function; a recipient that reverts or burns gas is a different measurement, and it is
exactly the scenario question 4 of the HoldEscrow plan is about.
