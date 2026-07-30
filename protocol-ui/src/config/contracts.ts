import type { Address } from "viem";

// Addresses come from env (testnet defaults in .env.example; flip to mainnet at go-live).
const a = (v: string): Address => v as Address;
export const ADDR = {
  entryPoint: a(import.meta.env.VITE_ENTRYPOINT),
  factory: a(import.meta.env.VITE_FACTORY),
  registry: a(import.meta.env.VITE_REGISTRY),
  executor: a(import.meta.env.VITE_EXECUTOR),
  paymaster: a(import.meta.env.VITE_PAYMASTER),
  usdg: a(import.meta.env.VITE_USDG),
  buyback: a(import.meta.env.VITE_BUYBACK),
  testMeme: a(import.meta.env.VITE_TEST_MEME),
} as const;

// Sweep destinations (ISweepPolicy.Destination). MVP authors YIELD only.
export const Destination = { USDG_YIELD: 0, STOCKS: 1, SPLIT_50_50: 2 } as const;
// ISweepPolicy.SweepMode. Confirm values against the contract enum before mainnet.
export const SweepMode = { PROFIT_ONLY: 0, WHOLE_POSITION: 1 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Minimal ABIs: only the functions this UI calls. These are hand-written for the
// scaffold. Before wiring anything you rely on, replace each with the real `abi`
// array from contracts/artifacts/**/<Name>.sol/<Name>.json so signatures can't drift.
// ─────────────────────────────────────────────────────────────────────────────

export const factoryAbi = [
  {
    type: "function",
    name: "createAccount",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ name: "account", type: "address" }],
  },
  {
    type: "function",
    name: "getAddress",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const registryAbi = [
  {
    type: "function",
    name: "setPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pct", type: "uint16" },
      { name: "minUsd", type: "uint128" },
      { name: "mode", type: "uint8" },
      { name: "dest", type: "uint8" },
      { name: "tokenWhitelist", type: "address[]" },
      { name: "maxSlippageBps", type: "uint16" },
    ],
    outputs: [],
  },
  { type: "function", name: "revokePolicy", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "getPolicy",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    // Struct shape verified against the keeper's REGISTRY_ABI (keeper/src/monitor.js).
    outputs: [
      {
        name: "policy",
        type: "tuple",
        components: [
          { name: "pct", type: "uint16" },
          { name: "maxSlippageBps", type: "uint16" },
          { name: "minUsd", type: "uint128" },
          { name: "mode", type: "uint8" },
          { name: "dest", type: "uint8" },
          { name: "tokenWhitelist", type: "address[]" },
          { name: "active", type: "bool" },
          { name: "createdAt", type: "uint256" },
          { name: "updatedAt", type: "uint256" },
        ],
      },
    ],
  },
] as const;

// The BagSweep custom account: exit path is ownerExecute (EOA-signed, no bundler needed).
export const accountAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dest", type: "address" },
      { name: "value", type: "uint256" },
      { name: "func", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "ownerExecute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dest", type: "address" },
      { name: "value", type: "uint256" },
      { name: "func", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;
