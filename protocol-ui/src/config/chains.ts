import { defineChain } from "viem";

const chainId = Number(import.meta.env.VITE_CHAIN_ID);
const rpcUrl = import.meta.env.VITE_RPC_URL;

// Robinhood Chain. Testnet = 46630, mainnet = 4663. Driven by env so testnet -> mainnet
// is a config flip, not a code change. Block explorer is Blockscout-based.
export const rhChain = defineChain({
  id: chainId,
  name: chainId === 4663 ? "Robinhood Chain" : "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url:
        chainId === 4663
          ? "https://explorer.chain.robinhood.com"
          : "https://explorer.testnet.chain.robinhood.com",
    },
  },
  testnet: chainId !== 4663,
});

export const IS_MAINNET = chainId === 4663;
