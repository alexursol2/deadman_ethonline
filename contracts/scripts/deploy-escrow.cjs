/**
 * Deploy HoldEscrow to Hedera testnet and fund its operating float.
 *
 * The float is not optional. This contract pays every armed refund's execution
 * gas from its own balance (C6), and openHold refuses to open a hold that would
 * leave the promised refunds unfundable.
 */
const hre = require("hardhat");
const { ethers } = hre;
const { saveEvidence, contractLink, txLink, jsonSafe, weibarToTinybar, fmtTinybar } = require("./lib.cjs");

const FUND_HBAR = "25.0";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 296n) throw new Error(`Expected chainId 296, got ${net.chainId}`);

  console.log(`\n  deployer ${deployer.address}`);
  console.log(`  balance  ${fmtTinybar(weibarToTinybar(await ethers.provider.getBalance(deployer.address)))}`);

  console.log(`\n  deploying HoldEscrow...`);
  const escrow = await (await ethers.getContractFactory("HoldEscrow")).deploy({ gasLimit: 6_000_000 });
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  const deployTx = escrow.deploymentTransaction();
  console.log(`  address  ${address}`);
  console.log(`  tx       ${txLink(deployTx.hash)}`);
  console.log(`           ${contractLink(address)}`);

  // Simulates a settled x402 payment plus float. On Hedera the real settlement
  // is a HAPI transfer that credits without executing (C12); an EVM transfer
  // credits the same balance, which is all openHold looks at.
  console.log(`\n  funding with ${FUND_HBAR} HBAR...`);
  const fundTx = await deployer.sendTransaction({
    to: address,
    value: ethers.parseEther(FUND_HBAR),
    gasLimit: 400_000,
  });
  await fundTx.wait();

  const bal = await escrow.balanceTinybar();
  const free = await escrow.freeTinybar();
  const required = await escrow.requiredReserveTinybar();
  console.log(`  balance  ${fmtTinybar(bal)}`);
  console.log(`  free     ${fmtTinybar(free)}`);
  console.log(`  reserve required now (0 open holds) ${fmtTinybar(required)}`);

  const cInfo = await (await fetch(`https://testnet.mirrornode.hedera.com/api/v1/contracts/${address}`)).json();

  saveEvidence(
    "escrow-deploy.json",
    jsonSafe({
      contract: address,
      entityId: cInfo.contract_id ?? null,
      hashscan: contractLink(address),
      deployer: deployer.address,
      deployTx: deployTx.hash,
      fundTx: fundTx.hash,
      fundedHbar: FUND_HBAR,
      balanceTinybar: bal,
      freeTinybar: free,
      refundGasConstant: await escrow.REFUND_GAS(),
      refundGasDepositTinybar: await escrow.refundGasDepositTinybar(),
      minOperatingReserveTinybar: await escrow.minOperatingReserveTinybar(),
      deployedAt: new Date().toISOString(),
    }),
  );

  console.log(`\n  ESCROW_ADDRESS=${address}`);
  console.log(`  entity id     ${cInfo.contract_id ?? "?"}   <- this is the x402 payTo\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
