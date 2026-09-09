/**
 * Where the agent's key lives.
 *
 * Two backends, chosen by env, behind one interface:
 *
 *   local  — an ECDSA key in .env. Fine for development, and it is what every
 *            x402 agent demo does. The key is on the machine.
 *   privy  — a Privy server wallet. NO key exists locally. Signing is an
 *            authenticated API call, and the wallet can carry a policy.
 *
 * The bridge that makes the Privy path possible on Hedera is secp256k1Sign: a
 * raw signature over a 32-byte hash with no EIP-191 prefixing. x402 on Hedera
 * pays with a @hashgraph/sdk TransferTransaction, not an EVM transaction, so
 * Privy's ordinary EVM signing methods are the wrong shape. Hedera's ECDSA
 * scheme signs keccak256 of the transaction body and wants 64 bytes of r||s,
 * which is exactly what the raw primitive returns.
 *
 * Set PRIVY_WALLET_ID to use Privy. See docs/spikes/16-privy.md for what the
 * spend policy can and cannot bind — the short version is that on this rail it
 * cannot bind the payment.
 */
import { ethers } from "ethers";
import { PrivateKey, PublicKey, type Transaction } from "@hashgraph/sdk";

export type AgentSigner = {
  kind: "local" | "privy";
  address: string;
  /** Sign an already-frozen Hedera transaction in place. */
  sign(tx: Transaction): Promise<Transaction>;
  /** Present only on the Privy path — the SDK needs it to build a Client. */
  publicKey?: PublicKey;
  rawSign?: (bytes: Uint8Array) => Promise<Uint8Array>;
};

async function privySigner(): Promise<AgentSigner> {
  const { PrivyClient } = await import("@privy-io/server-auth");
  const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, PRIVY_WALLET_ID } = process.env;
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
    throw new Error("PRIVY_WALLET_ID is set but PRIVY_APP_ID / PRIVY_APP_SECRET are not.");
  }
  const privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET, {
    walletApi: PRIVY_AUTHORIZATION_KEY ? { authorizationPrivateKey: PRIVY_AUTHORIZATION_KEY } : undefined,
  });

  const rawSign = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const r: any = await (privy as any).walletApi.ethereum.secp256k1Sign({
      walletId: PRIVY_WALLET_ID!,
      hash: ethers.keccak256(bytes) as `0x${string}`,
    });
    // r||s. The trailing recovery byte is an EVM concern; Hedera rejects it.
    return ethers.getBytes(r.signature).slice(0, 64);
  };

  // Privy does not return the public key, and Hedera needs it to attach a
  // signature. Recover it from a signature over a known hash, then verify the
  // recovered key derives the wallet's own address — otherwise every signature
  // below would be attributed to the wrong account.
  const wallet: any = await (privy as any).walletApi.getWallet({ id: PRIVY_WALLET_ID });
  const probe = ethers.keccak256(ethers.toUtf8Bytes("deadman-privy-pubkey-probe"));
  const pr: any = await (privy as any).walletApi.ethereum.secp256k1Sign({
    walletId: PRIVY_WALLET_ID!, hash: probe as `0x${string}`,
  });
  const uncompressed = ethers.SigningKey.recoverPublicKey(probe, pr.signature);
  const address = ethers.getAddress(wallet.address);
  if (ethers.computeAddress(uncompressed) !== address) {
    throw new Error("Privy: the recovered public key does not belong to this wallet.");
  }
  const publicKey = PublicKey.fromStringECDSA(ethers.SigningKey.computePublicKey(uncompressed, true).slice(2));

  return {
    kind: "privy",
    address,
    publicKey,
    rawSign,
    sign: (tx: Transaction) => tx.signWith(publicKey, rawSign),
  };
}

function localSigner(key: string): AgentSigner {
  const w = new ethers.Wallet(key.startsWith("0x") ? key : `0x${key}`);
  const hederaKey = PrivateKey.fromStringECDSA(w.privateKey.slice(2));
  return {
    kind: "local",
    address: w.address,
    sign: (tx: Transaction) => tx.sign(hederaKey),
  };
}

export async function createSigner(): Promise<AgentSigner> {
  if (process.env.PRIVY_WALLET_ID) return privySigner();
  const key = (process.env.AGENT_PRIVATE_KEY || process.env.HEDERA_OPERATOR_KEY || "").trim();
  if (!key) {
    throw new Error(
      "No signer. Set PRIVY_WALLET_ID for a Privy server wallet, or AGENT_PRIVATE_KEY for a local key.",
    );
  }
  return localSigner(key);
}
