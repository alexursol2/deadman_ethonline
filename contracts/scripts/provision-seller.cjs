/**
 * Provision a dedicated SELLER key for the hosted resource server.
 *
 * Why not just ship the operator key: the operator is the escrow's OWNER. It can
 * sweepReserve, setConfig, setOwner and attributeOrphanedPayment. A server on
 * someone else's infrastructure needs none of that — it only has to be an
 * allowlisted opener. If the host is compromised, the blast radius should be
 * "an attacker can open and claim holds", not "an attacker owns the escrow".
 *
 * Generates a wallet, funds it, allowlists it, and writes SELLER_PRIVATE_KEY
 * into the repo-root .env (which is gitignored).
 *
 *   npx hardhat run scripts/provision-seller.cjs --network hederaTestnet
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { readEvidence, saveEvidence, jsonSafe, fmtTinybar, weibarToTinybar, sleep, txLink } = require("./lib.cjs");

/**
 * openHold costs the seller ~1.77 HBAR per hold — measured, and dominated by
 * scheduleCall's own ~1.45M gas floor. 40 HBAR is roughly 22 holds, which is
 * enough for a demo and a rehearsal but is NOT a production float.
 */
const FUND_HBAR = "40.0";
const ENV_PATH = path.resolve(__dirname, "../../.env");

async function main() {
  const [owner] = await ethers.getSigners();
  const escrowAddress = process.env.ESCROW_ADDRESS || readEvidence("escrow-deploy.json")?.contract;
  const escrow = await ethers.getContractAt("HoldEscrow", escrowAddress, owner);

  const onChainOwner = await escrow.owner();
  if (onChainOwner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`Only the escrow owner can allowlist. Owner is ${onChainOwner}, you are ${owner.address}.`);
  }

  let env = fs.readFileSync(ENV_PATH, "utf8").replace(/\r\n/g, "\n");
  const existing = env.match(/^SELLER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m);
  let seller;
  if (existing) {
    seller = new ethers.Wallet(existing[1], ethers.provider);
    console.log(`\n  reusing the seller already in .env: ${seller.address}`);
  } else {
    seller = ethers.Wallet.createRandom().connect(ethers.provider);
    console.log(`\n  generated a seller wallet: ${seller.address}`);
  }

  const balBefore = weibarToTinybar(await ethers.provider.getBalance(seller.address));
  if (balBefore === 0n) {
    console.log(`  funding it with ${FUND_HBAR} HBAR...`);
    // 2,000,000 gas: paying an address Hedera has never seen also CREATES it.
    const tx = await owner.sendTransaction({
      to: seller.address,
      value: ethers.parseEther(FUND_HBAR),
      gasLimit: 2_000_000,
    });
    await tx.wait();
    await sleep(4000);
    console.log(`  ${txLink(tx.hash)}`);
  }
  const bal = weibarToTinybar(await ethers.provider.getBalance(seller.address));
  console.log(`  seller balance ${fmtTinybar(bal)}  (~${Math.floor(Number(bal) / 1e8 / 1.77)} holds at 1.77 HBAR each)`);

  if (await escrow.isOpener(seller.address)) {
    console.log(`  already allowlisted as an opener`);
  } else {
    console.log(`  allowlisting it as an opener...`);
    const tx = await escrow.setOpener(seller.address, true, { gasLimit: 1_000_000 });
    await tx.wait();
    console.log(`  ${txLink(tx.hash)}`);
  }

  // Least privilege, asserted rather than assumed.
  const isOwner = (await escrow.owner()).toLowerCase() === seller.address.toLowerCase();
  console.log(`\n  seller isOpener: ${await escrow.isOpener(seller.address)}`);
  console.log(`  seller isOwner : ${isOwner}   <- must be false`);
  if (isOwner) throw new Error("The seller is the owner. That defeats the point of a separate key.");

  if (!existing) {
    env = /^SELLER_PRIVATE_KEY=/m.test(env)
      ? env.replace(/^SELLER_PRIVATE_KEY=.*$/m, `SELLER_PRIVATE_KEY=${seller.privateKey}`)
      : `${env}\nSELLER_PRIVATE_KEY=${seller.privateKey}`;
    fs.writeFileSync(ENV_PATH, env);
    console.log(`\n  wrote SELLER_PRIVATE_KEY into .env (gitignored)`);
  }

  saveEvidence(
    "seller.json",
    jsonSafe({
      escrow: escrowAddress,
      sellerAddress: seller.address,
      isOpener: await escrow.isOpener(seller.address),
      isOwner,
      owner: onChainOwner,
      balanceTinybar: bal,
      provisionedAt: new Date().toISOString(),
    }),
  );

  console.log(`\n  For the host's secret store, copy SELLER_PRIVATE_KEY out of .env.`);
  console.log(`  Do NOT put HEDERA_OPERATOR_KEY there — it owns the escrow.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
