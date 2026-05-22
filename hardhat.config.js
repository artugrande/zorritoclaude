require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY      = process.env.PRIVATE_KEY      || "0x" + "0".repeat(64);
const CELOSCAN_API_KEY = process.env.CELOSCAN_API_KEY || "";

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // Celo Mainnet
    celo: {
      url: "https://forno.celo.org",
      chainId: 42220,
      accounts: [PRIVATE_KEY],
      gas: 6_000_000,
      gasPrice: 203_000_000_000,
    },
    // Celo Alfajores Testnet
    alfajores: {
      url: "https://alfajores-forno.celo-testnet.org",
      chainId: 44787,
      accounts: [PRIVATE_KEY],
    },
    // Hardhat fork of Celo Mainnet
    hardhat: {
      forking: {
        url: "https://forno.celo.org",
        blockNumber: 66900000,
      },
      chainId: 42220,
      // Use the solidity-coverage magic number to bypass EDR's transactionGasCap enforcement.
      // This allows the Fenwick array constructor (~22M gas) to deploy on a Celo fork (16.7M cap).
      blockGasLimit: 0x1fffffffffffff,
    },
  },

  // ── Celoscan contract verification ──────────────────────────────────────────
  // Celoscan migrated to the Etherscan V2 unified API (api.etherscan.io/v2)
  // The Celoscan API key works as a single etherscan key with chainId routing.
  etherscan: {
    apiKey: CELOSCAN_API_KEY,
    customChains: [
      {
        network: "celo",
        chainId: 42220,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=42220",
          browserURL: "https://celoscan.io",
        },
      },
      {
        network: "alfajores",
        chainId: 44787,
        urls: {
          apiURL:     "https://api.etherscan.io/v2/api?chainid=44787",
          browserURL: "https://alfajores.celoscan.io",
        },
      },
    ],
  },

  sourcify: { enabled: false },
};
