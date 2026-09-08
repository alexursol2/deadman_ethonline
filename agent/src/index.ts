/**
 * Deadman — the paying agent.
 *
 * A loop that buys from an x402-gated endpoint and, crucially, NEVER HAS TO ACT
 * to protect itself:
 *
 *   1. GET /premium                       -> 402 with payment requirements
 *   2. sign a transfer to the payTo        (the escrow, not the seller)
 *   3. retry with X-PAYMENT                -> ciphertext + holdId, but no key
 *   4. watch the chain for Claimed(holdId) -> the key, and decrypt
 *   5. if the seller stays silent          -> Refunded(holdId) lands on its own
 *
 * Step 5 is the point. The agent does not poll a dispute API, submit a receipt,
 * or ask anyone for its money back. It watches, and if nothing arrives the
 * network has already given the money back.
 */
import { ethers } from "ethers";
import { AccountId, Hbar, PrivateKey, TransactionId, TransferTransaction } from "@hashgraph/sdk";
// shared.js loads .env from the repo root, and does so before this module body runs.
import {
  ESCROW_ABI,
  HOLD_STATUS,
  decrypt,
  entityIdOf,
  hashBytes,
  hbar,
  mirror,
  contractLogs,
  asTopic,
  TOPIC,
  RPC,
  sleep,
  weibarToTinybar,
} from "../../server/src/shared.js";

const ENDPOINT = process.env.RESOURCE_URL || "http://localhost:4021/premium";
const QUERY = process.env.AGENT_QUERY || "what is the airspeed velocity of an unladen swallow";
const ROUNDS = Number(process.env.AGENT_ROUNDS || 1);
const KEY = (process.env.AGENT_PRIVATE_KEY || process.env.HEDERA_OPERATOR_KEY || "").trim();
const NODE_ACCOUNTS = [AccountId.fromString("0.0.3")];

if (!KEY) throw new Error("Set AGENT_PRIVATE_KEY (an ECDSA hex key for the agent's wallet).");

const provider = new ethers.JsonRpcProvider(RPC, { chainId: 296, name: "hedera-testnet" });
const wallet = new ethers.Wallet(KEY.startsWith("0x") ? KEY : `0x${KEY}`, provider);
const hederaKey = PrivateKey.fromStringECDSA(wallet.privateKey.slice(2));

/** Build the partially-signed transfer the exact-Hedera scheme expects. */
async function buildPayment(reqs: any, myAccountId: string) {
  const signed = await new TransferTransaction()
    // Fee delegation: the transaction id belongs to the FACILITATOR, which pays
    // the network fee. We only sign to authorise the debit from our account.
    .setTransactionId(TransactionId.generate(AccountId.fromString(reqs.extra.feePayer)))
    .setNodeAccountIds(NODE_ACCOUNTS)
    .addHbarTransfer(AccountId.fromString(myAccountId), Hbar.fromTinybars(-Number(reqs.amount)))
    .addHbarTransfer(AccountId.fromString(reqs.payTo), Hbar.fromTinybars(Number(reqs.amount)))
    .freeze()
    .sign(hederaKey);

  const payload = {
    x402Version: 2,
    accepted: reqs,
    payload: { transaction: Buffer.from(signed.toBytes()).toString("base64") },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/**
 * Wait for the seller to reveal the key, or for the network to refund us.
 *
 * Polls the MIRROR NODE rather than eth_getLogs: HashIO rejects getLogs for this
 * contract on every range we tried. Both outcomes are watched because exactly
 * one will happen and we do not get to choose which — and note that the refund
 * needs nothing from us. We are watching out of curiosity, not necessity.
 */
async function awaitOutcome(escrow: ethers.Contract, escrowAddress: string, holdId: string, armedDeadline: number) {
  const holdTopic = asTopic(holdId);
  const deadlineMs = (armedDeadline + 90) * 1000;

  while (Date.now() < deadlineMs) {
    const [claimed, refunded] = await Promise.all([
      contractLogs(escrowAddress, { topic0: TOPIC.Claimed, topic1: holdTopic }, 5),
      contractLogs(escrowAddress, { topic0: TOPIC.Refunded, topic1: holdTopic }, 5),
    ]);
    // Claimed's only non-indexed field is k, so the log data IS the key.
    if (claimed.length) return { kind: "claimed" as const, k: claimed[0].data as string };
    if (refunded.length) return { kind: "refunded" as const, k: null };

    // Belt and braces: logs can lag the mirror, contract state cannot.
    const h = await escrow.getHold(holdId).catch(() => null);
    if (h && Number(h.status) === 3) return { kind: "refunded" as const, k: null };
    if (h && Number(h.status) === 2) {
      // Claimed on-chain but the log has not surfaced yet. Wait for it — the key
      // only exists in that event.
      await sleep(3000);
      const late = await contractLogs(escrowAddress, { topic0: TOPIC.Claimed, topic1: holdTopic }, 5);
      if (late.length) return { kind: "claimed" as const, k: late[0].data as string };
    }

    const left = Math.max(0, Math.round((deadlineMs - Date.now()) / 1000));
    process.stdout.write(`    waiting… hold ${holdId}, ${left}s left   `);
    await sleep(3000);
  }
  return { kind: "timeout" as const, k: null };
}

async function oneRound(round: number, escrow: ethers.Contract, escrowAddress: string, myAccountId: string) {
  console.log(`\n  ── round ${round} ──────────────────────────────────────────`);
  const url = `${ENDPOINT}?q=${encodeURIComponent(QUERY)}`;

  /* 1. the 402 */
  const challenge = await fetch(url);
  if (challenge.status !== 402) {
    console.log(`  expected 402, got ${challenge.status}: ${await challenge.text()}`);
    return false;
  }
  const { accepts } = (await challenge.json()) as any;
  const reqs = accepts[0];
  console.log(`  402: ${hbar(BigInt(reqs.amount))} to ${reqs.payTo} (the escrow)`);

  /* 2 + 3. pay and retry */
  const before = weibarToTinybar(await provider.getBalance(wallet.address));
  const xPayment = await buildPayment(reqs, myAccountId);
  const paid = await fetch(url, { headers: { "X-PAYMENT": xPayment } });
  if (!paid.ok) {
    console.log(`  payment rejected (${paid.status}): ${await paid.text()}`);
    return false;
  }
  const body = (await paid.json()) as any;
  console.log(`  paid. hold ${body.holdId}, schedule ${body.scheduleEntityId}`);
  console.log(`  got ${ethers.getBytes(body.ciphertext).length} bytes of ciphertext, and no key`);

  /* the buyer's own check: the ciphertext we were handed must be the one committed */
  const hCipherLocal = hashBytes(ethers.getBytes(body.ciphertext));
  const cipherMatches = hCipherLocal === body.commitments.hCipher;
  console.log(`  H(C) matches the commitment: ${cipherMatches}`);
  if (!cipherMatches) console.log(`    *** the seller committed to a DIFFERENT ciphertext ***`);

  /* 4 + 5. one of these happens, and neither needs us to act */
  const outcome = await awaitOutcome(escrow, escrowAddress, body.holdId, body.armedDeadline);
  process.stdout.write("\r".padEnd(72) + "\r");

  if (outcome.kind === "claimed") {
    const k = ethers.getBytes(outcome.k!);
    const keyMatches = hashBytes(k) === body.commitments.hKey;
    console.log(`  seller revealed the key on-chain. H(k) matches: ${keyMatches}`);
    try {
      const plaintext = decrypt(body.ciphertext, k);
      console.log(`  decrypted:\n${plaintext.split("\n").map((l: string) => `      ${l}`).join("\n")}`);
    } catch {
      // Paid, key revealed, and it does not open the ciphertext. This is the
      // cheat the four commitments exist to make provable.
      console.log(`  *** the revealed key does NOT decrypt the ciphertext we were given ***`);
      console.log(`  *** we paid for nothing, and the commitments prove which part was a lie ***`);
    }
  } else if (outcome.kind === "refunded") {
    const after = weibarToTinybar(await provider.getBalance(wallet.address));
    console.log(`  the seller never revealed the key.`);
    console.log(`  the NETWORK refunded us. We did nothing. Balance ${hbar(before)} -> ${hbar(after)}`);
  } else {
    const h = await escrow.getHold(body.holdId);
    console.log(`  gave up watching. Hold is ${HOLD_STATUS[Number(h.status)]}.`);
  }
  return true;
}

async function main() {
  const escrowAddress = process.env.ESCROW_ADDRESS || "";
  const escrow = new ethers.Contract(escrowAddress, ESCROW_ABI, provider);
  const info = await mirror<any>(`/api/v1/accounts/${wallet.address}`);
  const myAccountId = info?.account;
  if (!myAccountId) {
    throw new Error(
      `The agent wallet ${wallet.address} has no Hedera account yet. Send it HBAR first ` +
        `(with ~2,000,000 gas — creating an account costs far more than a transfer).`,
    );
  }

  console.log(`\n  Deadman agent`);
  console.log(`  ────────────────────────────────────────────────`);
  console.log(`  wallet   ${wallet.address}  =  ${myAccountId}`);
  console.log(`  balance  ${hbar(weibarToTinybar(await provider.getBalance(wallet.address)))}`);
  console.log(`  endpoint ${ENDPOINT}`);
  console.log(`  escrow   ${await entityIdOf(escrowAddress)}`);

  for (let i = 1; i <= ROUNDS; i++) {
    const ok = await oneRound(i, escrow, escrowAddress, myAccountId);
    if (!ok) break;
    if (i < ROUNDS) await sleep(2000);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
