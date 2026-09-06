/**
 * Deploy SpikeSchedule to Hedera testnet and fund it.
 *
 * The funding is not incidental. The contract pays gas at EXECUTION time out of
 * its own balance, so an underfunded contract produces a schedule that silently
 * never fires — which is indistinguishable from "HIP-1215 does not work" and
 * would send us to the wrong conclusion on the one thing this session exists to
 * establish. 20 HBAR is deliberate overkill for two 150k-gas scheduled calls.
 */
const hre = require("hardhat");
const { ethers } = hre;
const { saveEvidence, contractLink, txLink, jsonSafe, weibarToTinybar, fmtTinybar } = require("./lib.cjs");

const FUND_HBAR = "20.0";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer. Set HEDERA_OPERATOR_KEY in .env (ECDSA hex key).");

  const net = await ethers.provider.getNetwork();
  const deployerBalance = await ethers.provider.getBalance(deployer.address);

  console.log(`\n  network        chainId ${net.chainId}`);
  console.log(`  deployer       ${deployer.address}`);
  console.log(`  balance        ${ethers.formatEther(deployerBalance)} HBAR`);

  if (net.chainId !== 296n) throw new Error(`Expected chainId 296, got ${net.chainId}`);
  if (deployerBalance === 0n) {
    throw new Error("Deployer has zero balance. Fund it at https://portal.hedera.com/faucet");
  }

  console.log(`\n  deploying SpikeSchedule...`);
  const factory = await ethers.getContractFactory("SpikeSchedule");
  const contract = await factory.deploy({ gasLimit: 3_000_000 });
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const deployTx = contract.deploymentTransaction();
  console.log(`  deployed       ${address}`);
  console.log(`  tx             ${deployTx.hash}`);
  console.log(`                 ${txLink(deployTx.hash)}`);
  console.log(`                 ${contractLink(address)}`);

  console.log(`\n  funding with ${FUND_HBAR} HBAR...`);
  const fundTx = await deployer.sendTransaction({
    to: address,
    value: ethers.parseEther(FUND_HBAR),
    gasLimit: 300_000,
  });
  const fundReceipt = await fundTx.wait();
  console.log(`  tx             ${fundTx.hash}  (status ${fundReceipt.status})`);

  // Assert the funding landed, rather than assuming the transfer worked.
  //
  // getBalance is WEIBARS; the contract's floor is TINYBARS. Converting before
  // comparing is the whole point — comparing them raw is what made the first
  // arm() revert on testnet, and the reverse mistake passes silently and puts
  // an underfunded contract into the demo.
  const balanceWeibar = await ethers.provider.getBalance(address);
  const balanceTinybar = weibarToTinybar(balanceWeibar);
  const minTinybar = await contract.MIN_BALANCE_TINYBAR();
  console.log(`
  contract bal   ${fmtTinybar(balanceTinybar)}`);
  console.log(`  arming floor   ${fmtTinybar(minTinybar)}`);

  if (balanceTinybar < minTinybar) {
    throw new Error(
      `Contract holds ${fmtTinybar(balanceTinybar)}, below the arming floor of ` +
        `${fmtTinybar(minTinybar)}. arm() would revert. Fund it before continuing.`,
    );
  }
  console.log(`  OK — above the arming floor.`);

  saveEvidence(
    "deploy.json",
    jsonSafe({
      network: "hedera-testnet",
      chainId: net.chainId,
      contract: address,
      hashscan: contractLink(address),
      deployer: deployer.address,
      deployTx: deployTx.hash,
      fundTx: fundTx.hash,
      fundedHbar: FUND_HBAR,
      contractBalanceWeibar: balanceWeibar,
      contractBalanceTinybar: balanceTinybar,
      minBalanceTinybar: minTinybar,
      evmVersion: hre.config.solidity.compilers?.[0]?.settings?.evmVersion ?? "unknown",
      deployedAt: new Date().toISOString(),
    }),
  );

  console.log(`\n  Set this in .env:\n    SPIKE_CONTRACT_ADDRESS=${address}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
