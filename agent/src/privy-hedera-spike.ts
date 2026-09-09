/**
 * SPIKE: sign a HEDERA-NATIVE transaction with a Privy key.
 *
 * Why this is the real question. The x402 exact-Hedera scheme does NOT pay with
 * an EVM transaction — agent/src/index.ts builds a @hashgraph/sdk
 * TransferTransaction and signs it, because that is the only thing the Blocky402
 * facilitator accepts. So "Privy can send an EVM transaction on chain 296",
 * which we already proved, is NOT enough to put a Privy wallet behind the agent.
 *
 * The bridge is walletApi.ethereum.secp256k1Sign: a raw signature over a 32-byte
 * hash, with no EIP-191 prefixing. Hedera's ECDSA scheme signs keccak256 of the
 * transaction body and wants 64 bytes of r||s, which is exactly that primitive.
 *
 * If this works, the agent's key can live in Privy with no local copy.
 */
import { PrivyClient } from "@privy-io/server-auth";
import { ethers } from "ethers";
import { AccountId, Client, Hbar, PublicKey, TransferTransaction } from "@hashgraph/sdk";
import { RPC, entityIdOf } from "../../server/src/shared.js";

const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, PRIVY_WALLET_ID, PRIVY_WALLET_ADDRESS } = process.env;
const OPERATOR_EVM = "0x130C7B90E7aCE67680AfDd17355BF58812146435";

const privy = new PrivyClient(PRIVY_APP_ID!, PRIVY_APP_SECRET!, {
  walletApi: PRIVY_AUTHORIZATION_KEY ? { authorizationPrivateKey: PRIVY_AUTHORIZATION_KEY } : undefined,
});

/** Hedera ECDSA: keccak256 the body, sign it raw, return 64 bytes of r||s. */
async function privySign(bodyBytes: Uint8Array): Promise<Uint8Array> {
  const hash = ethers.keccak256(bodyBytes);
  const r: any = await privy.walletApi.ethereum.secp256k1Sign({
    walletId: PRIVY_WALLET_ID!,
    hash: hash as `0x${string}`,
  } as any);
  const sig = ethers.getBytes(r.signature);
  // r||s is the first 64 bytes; a trailing recovery byte is an EVM concern and
  // Hedera does not want it.
  return sig.slice(0, 64);
}

async function main() {
  const w: any = await privy.walletApi.getWallet({ id: PRIVY_WALLET_ID! });
  console.log("wallet id     ", w.id);
  console.log("address       ", w.address);

  // Privy does not hand back the public key, and Hedera needs it to attach a
  // signature. Recover it from a signature over a known hash instead, then
  // check the recovered key derives the wallet's own address. If that check
  // fails, every signature below would be for the wrong account.
  const probe = ethers.keccak256(ethers.toUtf8Bytes("deadman-privy-pubkey-probe"));
  const pr: any = await privy.walletApi.ethereum.secp256k1Sign({
    walletId: PRIVY_WALLET_ID!, hash: probe as `0x${string}`,
  } as any);
  console.log("probe sig len ", ethers.getBytes(pr.signature).length, "bytes  encoding:", pr.encoding);
  const uncompressed = ethers.SigningKey.recoverPublicKey(probe, pr.signature);
  const derived = ethers.computeAddress(uncompressed);
  const match = derived.toLowerCase() === String(w.address).toLowerCase();
  console.log("derived addr  ", derived, match ? "MATCHES" : "MISMATCH");
  if (!match) throw new Error("recovered public key does not belong to this wallet");

  const compressed = ethers.SigningKey.computePublicKey(uncompressed, true);
  const hPub = PublicKey.fromStringECDSA(compressed.slice(2));
  console.log("compressed    ", compressed);

  const from = (await entityIdOf(PRIVY_WALLET_ADDRESS!))!;
  const to = (await entityIdOf(OPERATOR_EVM))!;
  console.log(`from          ${from}\nto            ${to}`);

  // The operator's signer IS Privy. No private key exists on this machine.
  const client = Client.forTestnet();
  client.setOperatorWith(AccountId.fromString(from), hPub, privySign);

  const tx = await new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(from), Hbar.fromTinybars(-100_000_000))
    .addHbarTransfer(AccountId.fromString(to), Hbar.fromTinybars(100_000_000))
    .execute(client);

  const receipt = await tx.getReceipt(client);
  console.log(`\n  tx      ${tx.transactionId.toString()}`);
  console.log(`  status  ${receipt.status.toString()}`);
  console.log(receipt.status.toString() === "SUCCESS"
    ? "\nWORKS — a Hedera-native transfer signed entirely by Privy."
    : "\nFAILED");
  client.close();
}

main().catch((e) => { console.error("failed:", e?.message || e); process.exit(1); });
