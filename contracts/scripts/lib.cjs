/**
 * Shared helpers for the spike scripts.
 *
 * Everything that talks to the mirror node goes through here, because the mirror
 * node is eventually consistent and a naive read produces false negatives that
 * look exactly like design failures.
 */
const fs = require("fs");
const path = require("path");

const MIRROR = (process.env.MIRROR_NODE_URL || "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
const HASHSCAN = (process.env.HASHSCAN_BASE || "https://hashscan.io/testnet").replace(/\/$/, "");
const EVIDENCE_DIR = path.resolve(__dirname, "../../docs/spikes");

/** Long-zero EVM address -> Hedera entity id. 0x...016b -> 0.0.363 */
function toEntityId(address) {
  return `0.0.${BigInt(address).toString()}`;
}

const scheduleLink = (entityId) => `${HASHSCAN}/schedule/${entityId}`;
const contractLink = (address) => `${HASHSCAN}/contract/${address}`;
const txLink = (hash) => `${HASHSCAN}/transaction/${hash}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * UNITS. Measured on testnet, not assumed — see scripts/units-probe.cjs.
 *   address(this).balance  (EVM, inside a contract) -> TINYBARS, 1e8 per HBAR
 *   eth_getBalance         (JSON-RPC, from outside) -> WEIBARS,  1e18 per HBAR
 * The same account reads 1e10x larger over JSON-RPC. Never compare one to the
 * other; convert first. Every variable below is named for its unit.
 */
const WEIBAR_PER_TINYBAR = 10n ** 10n;
const TINYBAR_PER_HBAR = 10n ** 8n;
const weibarToTinybar = (w) => BigInt(w) / WEIBAR_PER_TINYBAR;
const tinybarToHbar = (t) => Number(BigInt(t)) / 1e8;
const fmtTinybar = (t) => `${tinybarToHbar(t)} HBAR (${BigInt(t).toString()} tinybar)`;

/**
 * GET the mirror node with retry and backoff.
 *
 * Review amendment 3: the mirror node is eventually consistent, so a 404 on the
 * first read after a write means "not yet", not "absent". Only a 404 that
 * survives every attempt counts as absent. `attemptsUsed` comes back with the
 * answer because if reads routinely need two attempts, the live board's
 * countdown UI needs to know that.
 *
 * @returns {{ok: boolean, status: number, body: any, attemptsUsed: number, waitedMs: number}}
 */
async function mirrorGet(urlPath, { attempts = 3, delaysMs = [2000, 4000, 8000], label = "" } = {}) {
  const url = `${MIRROR}${urlPath.startsWith("/") ? urlPath : `/${urlPath}`}`;
  let last = { ok: false, status: 0, body: null };
  let waitedMs = 0;

  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const wait = delaysMs[i - 1] ?? delaysMs[delaysMs.length - 1];
      process.stdout.write(`    mirror ${label || urlPath}: attempt ${i} gave ${last.status}, waiting ${wait}ms\n`);
      await sleep(wait);
      waitedMs += wait;
    }
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      last = { ok: res.ok, status: res.status, body };
      if (res.ok) return { ...last, attemptsUsed: i + 1, waitedMs, url };
    } catch (err) {
      last = { ok: false, status: -1, body: String(err) };
    }
  }
  return { ...last, attemptsUsed: attempts, waitedMs, url };
}

/**
 * GET the mirror node until a PREDICATE holds, not merely until HTTP succeeds.
 *
 * The original mirrorGet retried only on a failed request, which turned out to
 * be half of amendment 3. A 200 carrying STALE data is the other half, and it is
 * the dangerous one: spike 5a read `deleted: false` immediately after a delete
 * that had returned code 22, and only settled to `deleted: true` seconds later.
 * Retrying on HTTP status alone would have recorded that as a failed delete.
 *
 * Both directions of assertion use this same primitive:
 *   confirming a change  -> settled === true means the change landed
 *   confirming stability -> settled === false after the full window means it
 *                           never happened, which is the result you wanted
 *
 * @returns {{settled: boolean, record: any, attemptsUsed: number, waitedMs: number}}
 */
async function mirrorGetUntil(urlPath, predicate, { attempts = 5, delaysMs = [1500, 3000, 5000, 8000], label = "" } = {}) {
  let record = null;
  let waitedMs = 0;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const wait = delaysMs[i - 1] ?? delaysMs[delaysMs.length - 1];
      await sleep(wait);
      waitedMs += wait;
    }
    const res = await mirrorGet(urlPath, { attempts: 2, label });
    if (res.ok) {
      record = res.body;
      if (predicate(record)) {
        return { settled: true, record, attemptsUsed: i + 1, waitedMs };
      }
    }
  }
  return { settled: false, record, attemptsUsed: attempts, waitedMs };
}

/** Write an evidence file to docs/spikes/ and say where it went. */
function saveEvidence(name, data) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`  evidence -> docs/spikes/${name}`);
  return file;
}

function readEvidence(name) {
  const file = path.join(EVIDENCE_DIR, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** Find one decoded event in a receipt, or null. */
function findEvent(contract, receipt, eventName) {
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed && parsed.name === eventName) return parsed;
    } catch {
      /* not one of ours */
    }
  }
  return null;
}

function findAllEvents(contract, receipt, eventName) {
  const out = [];
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed && parsed.name === eventName) out.push(parsed);
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

/** BigInt-safe JSON. Ethers hands back BigInt everywhere. */
const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

const SEED_SOURCE = { 0: "none", 1: "prng-0x169", 2: "prevrandao", 3: "local-keccak-fallback" };

/** Print a pass/fail table and return whether every condition held. */
function report(title, conditions) {
  console.log(`\n  ${title}`);
  console.log(`  ${"-".repeat(72)}`);
  let allPassed = true;
  for (const c of conditions) {
    if (!c.pass) allPassed = false;
    console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.name}`);
    console.log(`         expected: ${c.expected}`);
    console.log(`         actual:   ${c.actual}`);
  }
  console.log(`  ${"-".repeat(72)}`);
  console.log(`  ${allPassed ? "ALL CONDITIONS MET" : "*** NOT ALL CONDITIONS MET ***"}\n`);
  return allPassed;
}

module.exports = {
  MIRROR,
  HASHSCAN,
  toEntityId,
  WEIBAR_PER_TINYBAR,
  TINYBAR_PER_HBAR,
  weibarToTinybar,
  tinybarToHbar,
  fmtTinybar,
  scheduleLink,
  contractLink,
  txLink,
  sleep,
  mirrorGet,
  mirrorGetUntil,
  saveEvidence,
  readEvidence,
  findEvent,
  findAllEvents,
  jsonSafe,
  SEED_SOURCE,
  report,
};
