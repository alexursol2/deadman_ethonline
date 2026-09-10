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
let claimDelaySeconds = Number(process.env.SELLER_CLAIM_DELAY_SECONDS || 0);

/**
 * Do not submit a claim with less than this many seconds left on the hold.
 *
 * A claim that cannot reach consensus before the armed second buys nothing: the
 * schedule fires, deleteSchedule comes back non-22, and the whole claim reverts
 * (C3) — we pay gas to lose a race we could already see we had lost. Two to four
 * seconds is a normal Hedera round trip, so five is the smallest honest margin.
 *
 * This is prudence, NOT safety. The arbiter stays the deleteSchedule return
 * code; a wrong clock here costs a claim we could have made, never a double
 * payout. Set to 0 to reproduce the old always-try behaviour.
 */
const CLAIM_MARGIN_SECONDS = Number(process.env.SELLER_CLAIM_MARGIN_SECONDS || 5);

/**
 * Deliberate dishonesty, for demonstrating verify.ts. "none" in normal operation.
 *
 * A tool that has never caught anything is an assertion, not a tool. These make
 * the seller lie in each of the ways the four commitments exist to detect:
 *
 *   wrong-key     encrypt with k1, commit and reveal k2. Passes claim()'s
 *                 on-chain H(k) check and never opens the buyer's ciphertext.
 *                 THE cheat the design is built around.
 *   wrong-cipher  commit H(C') for a ciphertext we did not send.
 *   wrong-plain   commit H(m') for plaintext the ciphertext does not contain.
 */
const CHEAT = (process.env.SELLER_CHEAT || "none") as "none" | "wrong-key" | "wrong-cipher" | "wrong-plain";
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || "";

/**
 * The seller's signing key.
 *
 * SELLER_PRIVATE_KEY, not the operator key, whenever this runs anywhere public.
 * The operator is the escrow's OWNER: it can sweepReserve, setConfig, setOwner
 * and attributeOrphanedPayment. A hosted seller needs none of that — it only
 * has to be an allowlisted opener, so a compromised host cannot drain the float
 * or hand the contract to someone else.
 *
 * Falls back to the operator key for local development, where they are the same
 * account anyway.
 */
const KEY = (process.env.SELLER_PRIVATE_KEY || process.env.HEDERA_OPERATOR_KEY || "").trim();

/**
 * Shared secret for /admin/dark. Required when the server is reachable publicly:
 * without it, anyone who can reach the URL can stop our seller from revealing
 * keys, which is a denial of service on our own demo.
 */
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

if (!ESCROW_ADDRESS) throw new Error("Set ESCROW_ADDRESS to the deployed HoldEscrow.");
if (!KEY) throw new Error("Set SELLER_PRIVATE_KEY — the seller signs openHold and claim.");

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
    cheat: CHEAT,
    holdDeadlineSeconds: HOLD_DEADLINE_SECONDS,
    claimDelaySeconds,
    claimMarginSeconds: CLAIM_MARGIN_SECONDS,
    escrowFreeTinybar: free,
  });
});

/**
 * Flip the server dark on camera without restarting it.
 *
 * Token-gated: on a public URL this endpoint is a denial of service on our own
 * demo if anyone can call it. When ADMIN_TOKEN is unset the endpoint is refused
 * outright rather than left open — failing closed is the only safe default for
 * something that ships to a host.
 */
app.post("/admin/dark", (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN is not set; /admin/dark is disabled" });
  }
  if (req.header("X-Admin-Token") !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "bad or missing X-Admin-Token" });
  }
  if (req.body?.on !== undefined) dark = Boolean(req.body.on);
  // Runtime-settable so the kill demo does not need a redeploy per attempt. The
  // window is the whole point of that test: the seller has to be alive and
  // INTENDING to reveal when the host is suspended, or all it proves is
  // unwillingness — which the dark flag already covers.
  if (req.body?.claimDelaySeconds !== undefined) {
    claimDelaySeconds = Math.max(0, Math.min(300, Number(req.body.claimDelaySeconds) || 0));
  }
  console.log(`\n  *** dark=${dark}  claimDelay=${claimDelaySeconds}s ***\n`);
  res.json({ dark, claimDelaySeconds });
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

    // The key actually revealed later. Under "wrong-key" it is NOT the key the
    // ciphertext was encrypted with — and claim() still accepts it, because the
    // contract only ever checks H(revealed) against H(committed).
    const revealKey = CHEAT === "wrong-key" ? newKey() : k;

    const commitments = {
      hKey: hashBytes(revealKey),
      hCipher:
        CHEAT === "wrong-cipher"
          ? hashUtf8("a ciphertext we never sent")
          : hashBytes(ethers.getBytes(ciphertext)),
      hPlain: CHEAT === "wrong-plain" ? hashUtf8("plaintext we never produced") : hashUtf8(plaintext),
      hRequest: requestHash("GET", req.originalUrl, settleTxId),
    };
    if (CHEAT !== "none") console.log(`  *** CHEATING: ${CHEAT} ***`);
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
    if (claimDelaySeconds > 0) {
      console.log(`  holding the key for ${claimDelaySeconds}s — kill me now and the refund still lands`);
      await new Promise((r) => setTimeout(r, claimDelaySeconds * 1000));
    }
    // Deliberately measured against armedDeadline — the second the network
    // actually booked, which the jitter probe may have moved — not the one we
    // asked for. Local wall clock is fine for a hint; block.timestamp would not
    // be, it lags the consensus second by up to ~2s (C2).
    const secondsLeft = armedDeadline - Math.floor(Date.now() / 1000);
    if (secondsLeft < CLAIM_MARGIN_SECONDS) {
      console.log(
        `  NOT claiming hold ${holdId}: ${secondsLeft}s left, under the ${CLAIM_MARGIN_SECONDS}s margin.` +
          ` The refund fires at ${armedDeadline} and the buyer gets their money back.`,
      );
      return;
    }

    try {
      const claimTx = await escrow.claim(holdId, ethers.hexlify(revealKey), { gasLimit: 3_000_000 });
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
  console.log(`  DEMO_DARK    ${dark}   claimDelay ${claimDelaySeconds}s   claimMargin ${CLAIM_MARGIN_SECONDS}s`);
  if (CHEAT !== "none") console.log(`  SELLER_CHEAT ${CHEAT}  <- this seller is lying on purpose`);
  if (free < needed) console.log(`  WARNING: below the operating reserve; openHold will revert.`);

  app.listen(PORT, () => console.log(`\n  listening on :${PORT}   GET /premium?q=hello\n`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
