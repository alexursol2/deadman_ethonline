/**
 * Units probe — what does an HBAR balance actually look like, and where?
 *
 * Written after the first arm() on testnet reverted with
 *   InsufficientBalance(2000000000, 5000000000000000000)
 * on a contract holding 20 HBAR. 2e9 is 20 HBAR in TINYBARS; 5e18 is 5 HBAR in
 * WEIBARS. The assert was comparing two different units.
 *
 * Hedera exposes HBAR at two scales and which one you get depends on where you
 * are standing:
 *   inside the EVM, address(this).balance  -> tinybars, 1e8 per HBAR
 *   outside, eth_getBalance over JSON-RPC  -> weibars,  1e18 per HBAR
 *
 * Solidity's `ether` literal is 1e18, so `balance >= 5 ether` in a contract can
 * never pass. That direction fails loudly. The reverse — a weibar quantity
 * checked against a tinybar threshold — passes trivially, and would put an
 * underfunded contract into the demo with the refund silently not firing.
 *
 * Run this against any deployed SpikeSchedule to reconfirm on a new network or
 * after a services upgrade:
 *   npx hardhat run scripts/units-probe.cjs --network hederaTestnet
 */
const { ethers } = require("hardhat");
const { readEvidence, saveEvidence, jsonSafe, WEIBAR_PER_TINYBAR } = require("./lib.cjs");

async function main() {
  const address = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;
  if (!address) throw new Error("No contract address. Deploy first.");
  const contract = await ethers.getContractAt("SpikeSchedule", address);

  const insideEvm = await contract.balanceTinybar(); // address(this).balance
  const overRpc = await ethers.provider.getBalance(address); // eth_getBalance
  const ratio = overRpc / insideEvm;

  console.log(`\n  contract                ${address}`);
  console.log(`  address(this).balance   ${insideEvm}`);
  console.log(`  eth_getBalance          ${overRpc}`);
  console.log(`  ratio                   ${ratio}  (expected ${WEIBAR_PER_TINYBAR})`);
  console.log(`\n  reading the EVM value as tinybars  -> ${Number(insideEvm) / 1e8} HBAR`);
  console.log(`  reading the RPC value as weibars   -> ${Number(overRpc) / 1e18} HBAR`);
  console.log(
    `\n  ${ratio === WEIBAR_PER_TINYBAR ? "CONFIRMED" : "*** UNEXPECTED ***"}: ` +
      `EVM balance is tinybars, JSON-RPC balance is weibars, 1e10 apart.\n`,
  );

  saveEvidence(
    "units-probe.json",
    jsonSafe({
      contract: address,
      addressThisBalance_tinybar: insideEvm,
      ethGetBalance_weibar: overRpc,
      ratio,
      expectedRatio: WEIBAR_PER_TINYBAR,
      confirmed: ratio === WEIBAR_PER_TINYBAR,
      hbarFromEvmValue: Number(insideEvm) / 1e8,
      hbarFromRpcValue: Number(overRpc) / 1e18,
      probedAt: new Date().toISOString(),
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
