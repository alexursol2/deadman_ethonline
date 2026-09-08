/**
 * Diagnostic: talk to the Schedule Service at 0x16b directly, from the EOA,
 * bypassing our contract entirely.
 *
 * Run when arm() fails, to separate "our contract is wrong" from "HSS does not
 * behave the way HIP-1215 says". Costs nothing for the eth_call probes.
 */
const { ethers } = require("hardhat");
const { readEvidence } = require("./lib.cjs");

const HSS = "0x000000000000000000000000000000000000016b";
const IFACE = new ethers.Interface([
  "function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes callData) returns (int64, address)",
  "function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) view returns (bool)",
]);

async function main() {
  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;
  const target = process.env.SPIKE_CONTRACT_ADDRESS || readEvidence("deploy.json")?.contract;

  const code = await provider.getCode(HSS);
  console.log(`\n  0x16b code length      ${(code.length - 2) / 2} bytes  (${code.slice(0, 20)}...)`);

  const block = await provider.getBlock("latest");
  const now = block.timestamp;
  console.log(`  latest block ts        ${now}`);

  // --- 1. hasScheduleCapacity, several offsets -------------------------------
  console.log(`\n  hasScheduleCapacity(now + N, 150000):`);
  for (const n of [1, 30, 61, 120, 3600]) {
    const data = IFACE.encodeFunctionData("hasScheduleCapacity", [now + n, 150_000]);
    try {
      const raw = await provider.call({ to: HSS, data });
      const [ok] = IFACE.decodeFunctionResult("hasScheduleCapacity", raw);
      console.log(`    now+${String(n).padStart(4)}  -> ${ok}   raw ${raw}`);
    } catch (e) {
      console.log(`    now+${String(n).padStart(4)}  -> THREW ${e.shortMessage || e.message}`);
    }
  }

  // --- 2. scheduleCall via eth_call, from the EOA ----------------------------
  //     eth_call will not create anything, but it tells us whether the call
  //     shape is accepted and what code comes back.
  const inner = new ethers.Interface(["function ping(bytes32)"]).encodeFunctionData("ping", [
    ethers.encodeBytes32String("diag"),
  ]);
  const scheduleData = IFACE.encodeFunctionData("scheduleCall", [target, now + 61, 150_000, 0, inner]);

  console.log(`\n  scheduleCall calldata  ${scheduleData.slice(0, 74)}...`);
  console.log(`  (to=${target}, expiry=now+61, gasLimit=150000, value=0)`);

  console.log(`\n  eth_call from EOA -> 0x16b:`);
  for (const gas of [200_000, 1_000_000, 4_000_000, 10_000_000]) {
    try {
      const raw = await provider.call({ to: HSS, data: scheduleData, from: signer.address, gasLimit: gas });
      if (raw === "0x") {
        console.log(`    gas ${String(gas).padStart(9)}  -> empty returndata`);
        continue;
      }
      const [rc, addr] = IFACE.decodeFunctionResult("scheduleCall", raw);
      console.log(`    gas ${String(gas).padStart(9)}  -> code ${rc}  address ${addr}`);
    } catch (e) {
      console.log(`    gas ${String(gas).padStart(9)}  -> THREW ${(e.shortMessage || e.message).slice(0, 120)}`);
    }
  }

  // --- 3. real transaction from the EOA, generous gas ------------------------
  if (process.env.DIAG_SEND === "1") {
    console.log(`\n  sending a REAL scheduleCall from the EOA with 8,000,000 gas...`);
    try {
      const tx = await signer.sendTransaction({ to: HSS, data: scheduleData, gasLimit: 8_000_000 });
      const receipt = await tx.wait();
      console.log(`    tx ${tx.hash}  status ${receipt.status}  gasUsed ${receipt.gasUsed}`);
      console.log(`    https://hashscan.io/testnet/transaction/${tx.hash}`);
    } catch (e) {
      console.log(`    THREW ${(e.shortMessage || e.message).slice(0, 200)}`);
      if (e.receipt) console.log(`    gasUsed ${e.receipt.gasUsed} status ${e.receipt.status} hash ${e.receipt.hash}`);
    }
  } else {
    console.log(`\n  (set DIAG_SEND=1 to also send a real scheduleCall from the EOA)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
