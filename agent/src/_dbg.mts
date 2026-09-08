import { ethers } from "ethers";
import { ESCROW_ABI, RPC } from "../server/src/shared.js";
const p = new ethers.JsonRpcProvider(RPC, { chainId: 296, name: "h" });
const c = new ethers.Contract(process.env.ESCROW_ADDRESS, ESCROW_ABI, p);
const latest = await p.getBlockNumber();
console.log("latest block", latest);
for (const from of [latest - 200, latest - 1000]) {
  try {
    const logs = await c.queryFilter(c.filters.Claimed(), from, "latest");
    console.log(`queryFilter Claimed from ${from}: ${logs.length} logs`);
    for (const l of logs.slice(-3)) console.log("   holdId", l.args.holdId.toString(), "k", l.args.k.slice(0,18)+"...");
  } catch (e) { console.log(`from ${from}: THREW ${e.shortMessage || e.message}`); }
}
try {
  const filtered = await c.queryFilter(c.filters.Claimed(5n), latest - 200, "latest");
  console.log("filtered by holdId 5n:", filtered.length);
} catch (e) { console.log("filtered THREW", e.shortMessage || e.message); }
try {
  const filteredStr = await c.queryFilter(c.filters.Claimed("5"), latest - 200, "latest");
  console.log("filtered by holdId '5':", filteredStr.length);
} catch (e) { console.log("filteredStr THREW", e.shortMessage || e.message); }
