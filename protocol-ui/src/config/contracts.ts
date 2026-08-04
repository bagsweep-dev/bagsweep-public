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

// createAccount(address owner, uint256 salt) matches the deployed factory. NOTE: the factory's
// read is getAddress(bytes32 salt, bytes bytecode) (full init code), NOT (owner, salt) — so the
// counterfactual address is computed client-side via CREATE2 in aa.ts, not read here (audit M-1).
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

// The BagSweep custom account. The owner drives everything through ownerExecute (EOA-signed,
// no bundler); the keeper's sponsored sweeps run server-side. setSweepExecutor must be set once
// so the keeper's execute(sweepExecutor, executeSweep) is authorized on-chain.
export const accountAbi = [
  {
    type: "function",
    name: "ownerExecute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dest", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "function",
    name: "setSweepExecutor",
    stateMutability: "nonpayable",
    inputs: [{ name: "_executor", type: "address" }],
    outputs: [],
  },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "keeper", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "sweepExecutor", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

// ── Dashboard reads (step 4): the sweep timeline + the buyback/burn flywheel. ──
// SweepExecuted matches ISweepExecutor.sol exactly (account + tokenIn indexed). Used with
// getLogs({ event: sweepExecutedEvent, args: { account } }) to list an account's harvests.
export const sweepExecutedEvent = {
  type: "event",
  name: "SweepExecuted",
  inputs: [
    { name: "account", type: "address", indexed: true },
    { name: "tokenIn", type: "address", indexed: true },
    { name: "amountIn", type: "uint256", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "dest", type: "uint8", indexed: false },
    { name: "timestamp", type: "uint256", indexed: false },
  ],
} as const;

// minSweepInterval() is the on-chain per-account cooldown (audit M-3), shown on the policy card.
export const executorAbi = [
  { type: "function", name: "minSweepInterval", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

// The fee sink. sweepToken() resolves the live $SWEPT; balanceOf(DEAD) on it is the total burned.
export const buybackAbi = [
  { type: "function", name: "sweepToken", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;
