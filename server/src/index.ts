/**
 * Deadman — the x402-gated resource server.
 *
 * The flow, which is the whole product:
 *
 *   1. agent calls /premium with no payment            -> 402 with requirements
 *   2. agent retries with X-PAYMENT                    -> we verify it
 *   3. we do the work and encrypt it with a key k
 *   4. we SETTLE the payment into HoldEscrow           -> money in escrow, not ours
 *   5. we openHold, committing H(k) H(C) H(m) H(req)   -> the refund is armed
 *   6. we answer with the ciphertext                   -> agent has C but not k
 *   7. we claim(holdId, k)                             -> k is public, we get paid
 *
 * If step 7 never happens — the server dies, or DEMO_DARK is on — nobody does
 * anything and the network refunds the agent at the deadline.
 *
 * WHY NOT @x402/express: its paymentMiddleware settles AFTER the handler's
 * response body is finalised. We need openHold sequenced between settlement and
 * the reply, because the reply carries the holdId the agent watches. So this
 * drives @x402/core's official HTTPFacilitatorClient directly and keeps Express
 * for HTTP. Same facilitator, same wire format, explicit ordering.
 */
import express from "express";
import { ethers } from "ethers";
import { HTTPFacilitatorClient } from "@x402/core/server";
// shared.js loads .env from the repo root, and does so before this module body runs.
import {
  ESCROW_ABI,
  FACILITATOR,
  HBAR_ASSET,
  NETWORK,
  RPC,
  encrypt,
  entityIdOf,
  evmAddressOf,
  hashBytes,
  hashUtf8,
  hbar,
  newKey,
  requestHash,
  weibarToTinybar,
} from "./shared.js";

const PORT = Number(process.env.PORT || 4021);
const PRICE_TINYBAR = BigInt(process.env.PRICE_TINYBAR || "50000000"); // 0.5 HBAR
const HOLD_DEADLINE_SECONDS = Number(process.env.HOLD_DEADLINE_SECONDS || 60);
/**
 * Seconds to wait before revealing the key. Zero in normal operation.
 *
 * For the demo it opens a window in which the server is alive, has taken the
 * payment, and fully intends to claim — so that killing it proves the refund
 * needs no server, rather than merely no willingness.
 */
const CLAIM_DELAY_SECONDS = Number(process.env.SELLER_CLAIM_DELAY_SECONDS || 0);
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || "";
const KEY = (process.env.HEDERA_OPERATOR_KEY || "").trim();

if (!ESCROW_ADDRESS) throw new Error("Set ESCROW_ADDRESS to the deployed HoldEscrow.");
if (!KEY) throw new Error("Set HEDERA_OPERATOR_KEY — the seller signs openHold and claim.");

const provider = new ethers.JsonRpcProvider(RPC, { chainId: 296, name: "hedera-testnet" });
const seller = new ethers.Wallet(KEY.startsWith("0x") ? KEY : `0x${KEY}`, provider);
const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, seller);
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });

/**
 * The demo switch. When dark, the server does everything EXCEPT reveal the key:
 * it takes the payment, arms the refund, answers with the ciphertext, and then
 * goes silent. That is the failure this project exists to survive, and it is
 * what gets filmed.
 */
let dark = process.env.DEMO_DARK === "1";

let escrowEntityId = "";
let feePayer = "";

/** Payment requirements advertised in the 402. payTo is the ESCROW, not us. */
function requirements() {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_TINYBAR.toString(),
    asset: HBAR_ASSET,
    payTo: escrowEntityId,
    maxTimeoutSeconds: 300,
    extra: { feePayer },
  };
}

/** The "work". A real service would do something useful; the escrow does not care. */
function doTheWork(q: string): string {
  return JSON.stringify(
    {
      query: q,
      answer: `Deadman premium result for ${JSON.stringify(q)}`,
      computedAt: new Date().toISOString(),
      note: "Delivered under a hold whose refund was armed before you read this.",
    },
    null,
    2,
  );
}

const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  let free: string | null = null;
  try {
    free = (await escrow.freeTinybar()).toString();
  } catch {
    /* the chain being unreachable is itself the answer */
  }
  res.json({
    ok: true,
    dark,
    escrow: ESCROW_ADDRESS,
    escrowEntityId,
    facilitator: FACILITATOR,
    priceTinybar: PRICE_TINYBAR.toString(),
    holdDeadlineSeconds: HOLD_DEADLINE_SECONDS,
    escrowFreeTinybar: free,
  });
});

/** Flip the server dark on camera without restarting it. */
app.post("/admin/dark", (req, res) => {
  dark = Boolean(req.body?.on);
  console.log(`\n  *** DEMO_DARK = ${dark} — the seller will ${dark ? "NOT" : ""} reveal the key ***\n`);
  res.json({ dark });
});

app.get("/premium", async (req, res) => {
  const q = String(req.query.q ?? "");
  const header = req.header("X-PAYMENT");

  /* ─────────────────────────── 1. the 402 ─────────────────────────── */
  if (!header) {
    return res.status(402).json({
      x402Version: 2,
      error: "payment required",
      resource: { url: `${req.protocol}://${req.get("host")}${req.originalUrl}`, method: "GET" },
      accepts: [requirements()],
    });
  }

  let paymentPayload: any;
  try {
    paymentPayload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return res.status(400).json({ error: "X-PAYMENT is not base64 JSON" });
  }

  const reqs = requirements();
  try {
    /* ───────────────────── 2. verify before working ───────────────────── */
    const verified = await facilitator.verify(paymentPayload, reqs as any);
    if (!verified?.isValid) {
      return res.status(402).json({ error: "payment invalid", detail: verified });
    }
    const payerAccountId = String(verified.payer);
    console.log(`\n  payment verified from ${payerAccountId}`);

    /* ───────────────────────── 3. do the work ─────────────────────────── */
    const plaintext = doTheWork(q);
    const k = newKey();
    const ciphertext = encrypt(plaintext, k);

    /* ──────────────────── 4. settle INTO the escrow ────────────────────── */
    const settled = await facilitator.settle(paymentPayload, reqs as any);
    const settleTxId = String((settled as any)?.transaction ?? "");
    if (!(settled as any)?.success) {
      return res.status(502).json({ error: "settlement failed", detail: settled });
    }
    console.log(`  settled ${settleTxId} -> escrow ${escrowEntityId}`);

    // The escrow is credited without its code running, so give the mirror and
    // the node a moment before openHold reads address(this).balance.
    await new Promise((r) => setTimeout(r, 4000));

    /* ───────────── 5. arm the refund over the settled funds ───────────── */
    const payerEvm = await evmAddressOf(payerAccountId);
    if (!payerEvm) {
      return res.status(500).json({ error: "could not resolve the payer's EVM address" });
    }

    const commitments = {
      hKey: hashBytes(k),
      hCipher: hashBytes(ethers.getBytes(ciphertext)),
      hPlain: hashUtf8(plaintext),
      hRequest: requestHash("GET", req.originalUrl, settleTxId),
    };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + HOLD_DEADLINE_SECONDS);

    // ~1.67M measured; scheduleCall's own floor dominates. Below ~1.8M this
    // fails with EMPTY returndata, which reads like a contract bug.
    const openTx = await escrow.openHold(
      {
        payer: payerEvm,
        payee: seller.address,
        amountTinybar: PRICE_TINYBAR,
        deadline,
        ...commitments,
      },
      { gasLimit: 5_000_000 },
    );
    const openRc = await openTx.wait();
    const opened = openRc.logs
      .map((l: any) => {
        try {
          return escrow.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: any) => e && e.name === "HoldOpened");
    if (!opened) return res.status(500).json({ error: "openHold produced no HoldOpened event" });

    const holdId = opened.args.holdId.toString();
    const armedDeadline = Number(opened.args.armedDeadline);
    const scheduleEntity = `0.0.${BigInt(opened.args.scheduleAddress).toString()}`;
    console.log(`  hold ${holdId} armed for ${armedDeadline}, schedule ${scheduleEntity}`);

    /* ──────────────── 6. answer with C, but NOT with k ─────────────────── */
    res.json({
      holdId,
      ciphertext,
      commitments,
      escrow: ESCROW_ADDRESS,
      scheduleEntityId: scheduleEntity,
      armedDeadline,
      settleTxId,
      note: "The key is revealed on-chain by claim(). If it never is, the network refunds you.",
    });

    /* ──────────────── 7. reveal the key, unless we are dark ────────────── */
    if (dark) {
      console.log(`  *** DARK: not revealing the key. The refund will fire at ${armedDeadline}. ***`);
      return;
    }
    if (CLAIM_DELAY_SECONDS > 0) {
      console.log(`  holding the key for ${CLAIM_DELAY_SECONDS}s — kill me now and the refund still lands`);
      await new Promise((r) => setTimeout(r, CLAIM_DELAY_SECONDS * 1000));
    }
    try {
      const claimTx = await escrow.claim(holdId, ethers.hexlify(k), { gasLimit: 3_000_000 });
      await claimTx.wait();
      console.log(`  claimed hold ${holdId} — key is now public in the Claimed event`);
    } catch (err: any) {
      // Losing the race to the refund is a legitimate outcome, not a crash: the
      // deleteSchedule return code is the arbiter and it said no.
      console.log(`  claim failed for hold ${holdId}: ${err.shortMessage || err.message}`);
    }
  } catch (err: any) {
    console.error(`  request failed: ${err.stack || err}`);
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
  }
});

async function main() {
  const id = await entityIdOf(ESCROW_ADDRESS);
  if (!id) throw new Error(`Could not resolve an entity id for ${ESCROW_ADDRESS}`);
  escrowEntityId = id;

  const sup: any = await (await fetch(`${FACILITATOR}/supported`)).json();
  feePayer = sup?.kinds?.find((k: any) => k.network === NETWORK)?.extra?.feePayer ?? "";
  if (!feePayer) throw new Error(`${FACILITATOR} does not advertise a ${NETWORK} fee payer`);

  const free = await escrow.freeTinybar();
  const needed = await escrow.requiredReserveTinybar();

  console.log(`\n  Deadman resource server`);
  console.log(`  ────────────────────────────────────────────────`);
  console.log(`  escrow       ${ESCROW_ADDRESS}  =  ${escrowEntityId}   <- x402 payTo`);
  console.log(`  seller       ${seller.address}`);
  console.log(`  facilitator  ${FACILITATOR}  feePayer ${feePayer}`);
  console.log(`  price        ${hbar(PRICE_TINYBAR)}   deadline +${HOLD_DEADLINE_SECONDS}s`);
  console.log(`  escrow free  ${hbar(free)}  (needs ${hbar(needed)})`);
  console.log(`  DEMO_DARK    ${dark}`);
  if (free < needed) console.log(`  WARNING: below the operating reserve; openHold will revert.`);

  app.listen(PORT, () => console.log(`\n  listening on :${PORT}   GET /premium?q=hello\n`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
