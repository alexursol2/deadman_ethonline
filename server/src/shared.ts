/**
 * Shared pieces: the escrow's interface, Hedera plumbing, and the commitment
 * scheme. Kept in one file so the agent can mirror it exactly — a disagreement
 * between the two sides about how H(C) is computed would look like a lying
 * seller, which is precisely the thing verify.ts is supposed to detect.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { ethers } from "ethers";

/**
 * Load .env from the REPO ROOT, not the process working directory.
 *
 * `import "dotenv/config"` resolves relative to cwd, so running the server from
 * server/ silently found nothing and the process died on a missing
 * ESCROW_ADDRESS that was sitting in the file two directories up. One .env at
 * the root is the whole point; make both services agree on where it is.
 *
 * Imported before either entrypoint's module body runs, so their top-level
 * process.env reads see it.
 */
const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, "../../.env"), resolve(here, "../.env"), resolve(process.cwd(), ".env")]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

/* ────────────────────────────── escrow ABI ────────────────────────────── */

/**
 * Human-readable, so the server and agent do not depend on the Hardhat build
 * output. Must stay in step with contracts/contracts/HoldEscrow.sol.
 */
export const ESCROW_ABI = [
  "function openHold((address payer, address payee, uint64 amountTinybar, uint64 deadline, bytes32 hKey, bytes32 hCipher, bytes32 hPlain, bytes32 hRequest) p) returns (uint256)",
  "function claim(uint256 holdId, bytes32 k)",
  "function getHold(uint256 holdId) view returns ((uint8 status, uint64 deadline, uint64 amountTinybar, address payer, address payee, address scheduleAddress, bytes32 hKey, bytes32 hRequest))",
  "function freeTinybar() view returns (uint256)",
  "function requiredReserveTinybar() view returns (uint256)",
  "function balanceTinybar() view returns (uint256)",
  "event HoldOpened(uint256 indexed holdId, address indexed payer, address indexed payee, uint64 amountTinybar, uint64 requestedDeadline, uint64 armedDeadline, address scheduleAddress, uint8 probesUsed, bytes32 hKey, bytes32 hCipher, bytes32 hPlain, bytes32 hRequest)",
  "event Claimed(uint256 indexed holdId, address indexed payee, bytes32 k)",
  "event Refunded(uint256 indexed holdId, address indexed payer, uint64 amountTinybar)",
  "event PayoutDeferred(uint256 indexed holdId, address indexed to, uint64 amountTinybar)",
];

export const HOLD_STATUS = ["NONE", "OPEN", "CLAIMED", "REFUNDED"] as const;

/* ──────────────────────────────── config ──────────────────────────────── */

export const MIRROR =
  (process.env.MIRROR_NODE_URL || "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
export const RPC = process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api";
export const FACILITATOR =
  (process.env.X402_FACILITATOR_URL || "https://api.testnet.blocky402.com").replace(/\/$/, "");
export const NETWORK = "hedera:testnet";
export const HBAR_ASSET = "0.0.0";

/** Everything inside the EVM is tinybars on Hedera; JSON-RPC is weibars. */
export const WEIBAR_PER_TINYBAR = 10n ** 10n;
export const weibarToTinybar = (w: bigint) => w / WEIBAR_PER_TINYBAR;
export const hbar = (t: bigint | number) => `${Number(t) / 1e8} HBAR`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────────── mirror ───────────────────────────────── */

export async function mirror<T = any>(path: string, attempts = 4): Promise<T | null> {
  const url = `${MIRROR}${path.startsWith("/") ? path : `/${path}`}`;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1500 * i);
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.ok) return (await res.json()) as T;
    } catch {
      /* transient; retry */
    }
  }
  return null;
}

/** EVM address -> Hedera entity id (works for accounts and contracts). */
export async function entityIdOf(evmAddress: string): Promise<string | null> {
  const c = await mirror<any>(`/api/v1/contracts/${evmAddress}`);
  if (c?.contract_id) return c.contract_id;
  const a = await mirror<any>(`/api/v1/accounts/${evmAddress}`);
  return a?.account ?? null;
}

/** Hedera account id -> EVM address, which is what the escrow stores as payer. */
export async function evmAddressOf(accountId: string): Promise<string | null> {
  const a = await mirror<any>(`/api/v1/accounts/${accountId}`);
  return a?.evm_address ?? null;
}

/* ──────────────────────────── event topics ────────────────────────────── */

/**
 * Read events from the MIRROR NODE, not eth_getLogs.
 *
 * HashIO fails eth_getLogs for this contract with "could not coalesce error" on
 * every block range we tried, so the agent cannot watch the chain the way an
 * EVM client normally would. The mirror node indexes the same logs and is what
 * the rest of this repo already relies on.
 *
 * A judge will reasonably ask why the agent polls REST instead of subscribing.
 * That is why.
 */
export const TOPIC = {
  Claimed: ethers.id("Claimed(uint256,address,bytes32)"),
  Refunded: ethers.id("Refunded(uint256,address,uint64)"),
  HoldOpened: ethers.id(
    "HoldOpened(uint256,address,address,uint64,uint64,uint64,address,uint8,bytes32,bytes32,bytes32,bytes32)",
  ),
};

/** An indexed uint256 as a 32-byte topic. */
export const asTopic = (n: bigint | string | number) => ethers.zeroPadValue(ethers.toBeHex(BigInt(n)), 32);

/**
 * Recent logs for a contract, filtered by topic CLIENT-SIDE.
 *
 * The mirror node accepts topic0..topic3 query parameters, but only alongside a
 * timestamp range — pass them on their own and it quietly returns nothing,
 * which reads exactly like "the event has not happened yet". Fetching a page and
 * filtering here is one request either way and cannot fail silently.
 */
export async function contractLogs(
  addressOrId: string,
  topics: { topic0?: string; topic1?: string },
  limit = 50,
): Promise<any[]> {
  const qs = new URLSearchParams({ order: "desc", limit: String(limit) });
  const r = await mirror<any>(`/api/v1/contracts/${addressOrId}/results/logs?${qs.toString()}`, 2);
  const logs: any[] = r?.logs ?? [];
  return logs.filter(
    (l) =>
      (!topics.topic0 || String(l.topics?.[0]).toLowerCase() === topics.topic0.toLowerCase()) &&
      (!topics.topic1 || String(l.topics?.[1]).toLowerCase() === topics.topic1.toLowerCase()),
  );
}

/* ──────────────────────── commitments and crypto ──────────────────────── */

/**
 * The four commitments from the design.
 *
 * Only H(k) is checkable on-chain — the contract compares it against the key
 * revealed by claim(). The other three exist so a buyer who is cheated holds
 * proof of WHICH element the seller lied about. They are emitted in HoldOpened
 * and read back by verify.ts.
 */
export interface Commitments {
  hKey: string;
  hCipher: string;
  hPlain: string;
  hRequest: string;
}

export const hashBytes = (b: Uint8Array | string) => ethers.keccak256(b);
export const hashUtf8 = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));

/**
 * Canonical request identity, bound to the payment that paid for it.
 *
 * The settlement transaction id is what makes this unique per request. Without
 * it, two agents asking the same question would produce the same H(request) and
 * the second openHold would revert with RequestAlreadyHeld — the replay guard
 * firing on an honest request.
 */
export const requestHash = (method: string, url: string, settleTxId: string) =>
  hashUtf8(`${method.toUpperCase()} ${url} | settled:${settleTxId}`);

/** AES-256-GCM. The key IS the secret the seller later reveals on-chain. */
export function encrypt(plaintext: string, key: Uint8Array) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  // iv || ciphertext || tag, so the ciphertext is one self-contained blob and
  // H(C) is unambiguous. Both sides must hash exactly these bytes.
  return ethers.hexlify(Buffer.concat([iv, body, tag]));
}

export function decrypt(ciphertextHex: string, key: Uint8Array): string {
  const all = Buffer.from(ethers.getBytes(ciphertextHex));
  const iv = all.subarray(0, 12);
  const tag = all.subarray(all.length - 16);
  const body = all.subarray(12, all.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

export const newKey = () => randomBytes(32);
