/**
 * BagSweep Keeper — Monitor
 * Watches the SweepPolicyRegistry for PolicySet/PolicyRevoked events
 * and maintains an in-memory list of active policies.
 */
import { ethers } from "ethers";
import { config } from "./config.js";
import { pool } from "../../lib/util.js";

// ── ABIs (minimal, only what we need) ──

const REGISTRY_ABI = [
  "event PolicySet(address indexed account, uint16 pct, uint8 mode, uint8 dest, uint256 timestamp)",
  "event PolicyRevoked(address indexed account, uint256 timestamp)",
  "function getPolicy(address account) view returns (tuple(uint16 pct, uint16 maxSlippageBps, uint128 minUsd, uint8 mode, uint8 dest, address[] tokenWhitelist, bool active, uint256 createdAt, uint256 updatedAt))",
  "function getActiveAccounts() view returns (address[])",
  "function policyCount() view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// ── State ──

let provider;
let registry;
const activePolicies = new Map(); // account → { policy, lastSweepTs }

/**
 * Initialize the monitor: connect to RPC, set up contract instances.
 */
export function initMonitor() {
  provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  registry = new ethers.Contract(config.registry, REGISTRY_ABI, provider);
  console.log(`[monitor] Connected to ${config.rpcUrl} (chain ${config.chainId})`);
  console.log(`[monitor] Registry: ${config.registry}`);
}

/**
 * Backfill existing policies from past events.
 * Called once on startup.
 */
export async function backfillPolicies() {
  console.log("[monitor] Backfilling existing policies...");

  try {
    const activeAccounts = await registry.getActiveAccounts();
    console.log(`[monitor] Found ${activeAccounts.length} accounts with policies`);

    // Fetch policies with bounded concurrency instead of one serial round trip each; a single
    // failed read degrades to null (that account is skipped) rather than aborting the backfill. (audit P-4)
    const policies = await pool(activeAccounts, (account) => registry.getPolicy(account), 25);
    activeAccounts.forEach((account, i) => {
      const policy = policies[i];
      if (policy && policy.active) {
        activePolicies.set(account, {
          policy: normalizePolicy(policy),
          lastSweepTs: 0,
        });
      }
    });
    console.log(`[monitor] Tracking ${activePolicies.size} active policies`);
  } catch (err) {
    console.error("[monitor] Backfill failed:", err.message);
  }
}

/**
 * Poll for new PolicySet / PolicyRevoked events since the last check.
 */
let lastBlock = 0;

export async function pollEvents() {
  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = lastBlock > 0 ? lastBlock + 1 : currentBlock - 100;

    if (fromBlock > currentBlock) return;

    // PolicySet events
    const setEvents = await registry.queryFilter("PolicySet", fromBlock, currentBlock);
    for (const ev of setEvents) {
      const account = ev.args.account;
      const policy = await registry.getPolicy(account);
      if (policy.active) {
        activePolicies.set(account, {
          policy: normalizePolicy(policy),
          lastSweepTs: activePolicies.get(account)?.lastSweepTs || 0,
        });
        console.log(`[monitor] Policy set: ${account} (pct=${policy.pct}, mode=${policy.mode}, dest=${policy.dest})`);
      }
    }

    // PolicyRevoked events
    const revokedEvents = await registry.queryFilter("PolicyRevoked", fromBlock, currentBlock);
    for (const ev of revokedEvents) {
      const account = ev.args.account;
      activePolicies.delete(account);
      console.log(`[monitor] Policy revoked: ${account}`);
    }

    lastBlock = currentBlock;
  } catch (err) {
    console.error("[monitor] Poll error:", err.message);
  }
}

/**
 * Get the current list of active policies.
 */
export function getActivePolicies() {
  return activePolicies;
}

/**
 * Get the ethers provider instance.
 */
export function getProvider() {
  return provider;
}

/**
 * Mark a policy as recently swept (cooldown tracking).
 */
export function markSwept(account) {
  const entry = activePolicies.get(account);
  if (entry) {
    entry.lastSweepTs = Date.now();
  }
}

/**
 * Check if an account is within its sweep cooldown.
 */
export function isOnCooldown(account) {
  const entry = activePolicies.get(account);
  if (!entry) return true;
  return (Date.now() - entry.lastSweepTs) < config.sweepCooldownMs;
}

// ── Helpers ──

function normalizePolicy(raw) {
  return {
    pct:           Number(raw.pct),
    maxSlippageBps: Number(raw.maxSlippageBps),
    minUsd:        Number(raw.minUsd),
    mode:          Number(raw.mode),       // 0=POSITION, 1=PROFITS
    dest:          Number(raw.dest),       // 0=USDG_YIELD, 1=STOCKS, 2=SPLIT
    tokenWhitelist: [...raw.tokenWhitelist],
    active:        raw.active,
    createdAt:     Number(raw.createdAt),
    updatedAt:     Number(raw.updatedAt),
  };
}
