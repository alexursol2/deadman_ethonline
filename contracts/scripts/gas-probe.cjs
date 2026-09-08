/**
 * Gas probe — how much gas does the scheduleCall precompile actually need?
 *
 * Written after arm() reverted with HssCallReverted("scheduleCall", "") having
 * burned 1,480,769 of a 1,500,000-gas transaction. HIP-1215 says scheduleCall
 * never reverts. It does not revert on a *business* failure — a saturated second
 * returns a code — but starved of gas it reverts with EMPTY returndata and
 * consumes everything forwarded to it. Two different failure modes that look
 * identical from outside, and only one of them is documented.
 *
 * Binary search via eth_call, so it costs nothing to re-run after a services
 * upgrade changes the gas schedule.
 *
 *   npx hardhat run scripts/gas-probe.cjs --network hederaTestnet
 */
const { ethers } = require("hardhat");
const { readEvidence, saveEvidence, jsonSafe } = require("./lib.cjs");

const HSS = "0x000000000000000000000000000000000000016b";
const IFACE = new ethers.Interface([
  "function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes callData) returns (int64, address)",
]);
const RESOLUTION = 25_000;

async function main() {
  const [signer] = await ethers.getSigners();
  const target = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const inner = new ethers.Interface(["function ping(bytes32)"]).encodeFunctionData("ping", [
    ethers.encodeBytes32String("gasprobe"),
  ]);

  const succeedsAt = async (txGas, scheduledGasLimit, offset) => {
    const data = IFACE.encodeFunctionData("scheduleCall", [target, now + offset, scheduledGasLimit, 0, inner]);
    try {
      const raw = await ethers.provider.call({ to: HSS, data, from: signer.address, gasLimit: txGas });
      return raw !== "0x" && IFACE.decodeFunctionResult("scheduleCall", raw)[0] === 22n;
    } catch {
      return false;
    }
  };

  console.log(`\n  binary search: minimum transaction gas for a successful scheduleCall`);
  let lo = 1_000_000;
  let hi = 4_000_000;
  while (hi - lo > RESOLUTION) {
    const mid = Math.floor((lo + hi) / 2);
    const ok = await succeedsAt(mid, 150_000, 61);
    console.log(`    ${String(mid).padStart(9)} -> ${ok ? "SUCCESS (22)" : "INSUFFICIENT_GAS"}`);
    if (ok) hi = mid;
    else lo = mid;
  }
  console.log(`\n  minimum lies between ${lo} and ${hi}`);

  // Does asking for more gas on the SCHEDULED call cost more up front? If the
  // two were coupled, a long refund would need a bigger settlement transaction.
  console.log(`\n  is the requirement coupled to the scheduled call's own gasLimit?`);
  const coupling = {};
  for (const scheduled of [50_000, 150_000, 500_000]) {
    let first = null;
    for (const g of [1_400_000, 1_500_000, 2_000_000, 3_000_000, 6_000_000]) {
      if (await succeedsAt(g, scheduled, 62)) {
        first = g;
        break;
      }
    }
    coupling[scheduled] = first;
    console.log(`    scheduled gasLimit ${String(scheduled).padStart(7)} -> first tx gas that works: ${first}`);
  }

  console.log(`\n  EIP-150 forwards only 63/64 of remaining gas to a call, so a contract`);
  console.log(`  needs roughly ${Math.ceil((hi / 63) * 64).toLocaleString()} gas on the transaction to hand the`);
  console.log(`  precompile ${hi.toLocaleString()}. That 1/64 is what made the first attempt fail.\n`);

  saveEvidence(
    "gas-probe.json",
    jsonSafe({
      minTxGasLowerBound: lo,
      minTxGasUpperBound: hi,
      resolution: RESOLUTION,
      coupledToScheduledGasLimit: false,
      firstWorkingTxGasByScheduledGasLimit: coupling,
      recommendedTxGas: 5_000_000,
      note:
        "scheduleCall starved of gas reverts with EMPTY returndata and consumes everything " +
        "forwarded. HIP-1215's 'never reverts' covers business failures, which return a code, " +
        "not gas starvation.",
      probedAt: new Date().toISOString(),
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
