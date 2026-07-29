require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.DEPLOYER_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RH_RPC = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const RH_TESTNET_RPC = process.env.RH_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 4663,
      forking: { url: RH_RPC, enabled: false },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 4663,
    },
    // Robinhood Chain Mainnet (chain ID 4663)
    robinhood: {
      url: RH_RPC,
      chainId: 4663,
      accounts: [PRIVATE_KEY],
      gasPrice: "auto",
    },
    // Robinhood Chain Testnet (chain ID 46630)
    "robinhood-testnet": {
      url: RH_TESTNET_RPC,
      chainId: 46630,
      accounts: [PRIVATE_KEY],
      gasPrice: "auto",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
