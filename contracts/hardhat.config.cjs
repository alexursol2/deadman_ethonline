require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const key = (process.env.HEDERA_OPERATOR_KEY || "").trim();
const accounts = key ? [key.startsWith("0x") ? key : `0x${key}`] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Hedera testnet runs Cancun as of services v0.68. If a deploy fails on an
      // opcode, drop to "shanghai" and record it — that is a finding, not a config tweak.
      evmVersion: "cancun",
    },
  },
  networks: {
    hederaTestnet: {
      url: process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api",
      chainId: 296,
      accounts,
      // eth_estimateGas on HashIO under-quotes and fails in ways that look like
      // contract bugs. Every transaction carries an explicit gas limit instead.
      // Hedera system-contract calls are expensive: scheduleCall alone needs
      // ~1.45M gas. Anything that touches 0x16b sets its own higher limit.
      gas: 5_000_000,
      timeout: 120_000,
    },
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  mocha: { timeout: 600_000 },
};
