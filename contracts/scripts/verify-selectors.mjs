/**
 * Step zero: verify every Hedera system-contract selector we are about to call.
 *
 * A wrong selector on a system contract does not revert helpfully — it silently does
 * nothing, or hits a different function. So we recompute keccak256(signature)[0:4]
 * ourselves and assert it against the table published in HIP-1215, rather than
 * trusting a selector copied out of a doc.
 *
 * Source of truth: hiero-improvement-proposals/HIP/hip-1215.md (status Final, v0.68.0).
 * NOT hips.hedera.com — that page is a stale June 2025 build with wrong function names.
 * A pinned copy of the text we verified against lives at docs/spikes/hip-1215.raw.md.
 *
 *   node scripts/verify-selectors.mjs
 *
 * Exits non-zero on any mismatch. Run before every deploy.
 */
import { id } from "ethers";

// [expected selector, signature, where it is documented, do we call it]
const TABLE = [
  ["0x6f5bfde8", "scheduleCall(address,uint256,uint256,uint64,bytes)",                        "HIP-1215 HSS table", "yes — arm()"],
  ["0xdfb4a999", "hasScheduleCapacity(uint256,uint256)",                                      "HIP-1215 HSS table", "yes — capacity probe"],
  ["0x72d42394", "deleteSchedule(address)",                                                   "HIP-1215 HSS table", "yes — cancel path A"],
  ["0xc61dea85", "deleteSchedule()",                                                          "HIP-1215 redirect",  "yes — cancel path B"],
  ["0xd83bf9a1", "getPseudorandomSeed()",                                                     "HIP-351 PRNG 0x169", "yes — probeRandomness()"],
  ["0xe6599c18", "scheduleCallWithPayer(address,address,uint256,uint256,uint64,bytes)",       "HIP-1215 HSS table", "NO — adds a signature dependency, see plan B.2"],
  ["0x105772b2", "executeCallOnPayerSignature(address,address,uint256,uint256,uint64,bytes)", "HIP-1215 HSS table", "NO — same reason"],
];

const ADDRESSES = {
  HSS: { evm: "0x000000000000000000000000000000000000016b", entity: "0.0.363", what: "Schedule Service" },
  PRNG: { evm: "0x0000000000000000000000000000000000000169", entity: "0.0.361", what: "PRNG (HIP-351)" },
};

let failed = 0;
console.log("selector    computed    signature");
console.log("-".repeat(100));
for (const [expected, sig, source, used] of TABLE) {
  const computed = id(sig).slice(0, 10);
  const ok = computed === expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"}  ${expected}  ${computed}  ${sig}\n        ${source} | called by us: ${used}`);
}

console.log("-".repeat(100));
for (const [k, v] of Object.entries(ADDRESSES)) {
  console.log(`${k.padEnd(5)} ${v.evm}  =  ${v.entity}  (${v.what})`);
}

// Long-zero <-> entity id, used everywhere downstream to turn a returned schedule
// address into something the mirror node and HashScan will accept.
const toEntityId = (addr) => `0.0.${BigInt(addr)}`;
console.log("\nlong-zero -> entity id sanity check:");
console.log(`  ${ADDRESSES.HSS.evm} -> ${toEntityId(ADDRESSES.HSS.evm)} (expect 0.0.363)`);
if (toEntityId(ADDRESSES.HSS.evm) !== "0.0.363") failed++;

if (failed) {
  console.error(`\n${failed} MISMATCH(ES). Do not deploy.`);
  process.exit(1);
}
console.log("\nAll selectors match HIP-1215. Safe to deploy.");
