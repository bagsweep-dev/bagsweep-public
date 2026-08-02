/**
 * BagSweep Keeper — $SWEPT demand gate (off-chain sponsor entitlement).
 *
 * The paymaster sponsor-signer sponsors a gasless sweep only for accounts whose OWNER is
 * entitled. Read-only: balances are read from the wallet and never moved or escrowed. This
 * gate ONLY decides whether the keeper sponsors gas; it NEVER gates the self-exit path
 * (SmartAccount.ownerExecute), which the relayer does not touch. Non-entitled accounts keep
 * full self-custody and can always exit.
 *
 * Entitlement is asymmetric:
 *   - ENTRY: a not-yet-entitled owner qualifies by holding >= the current bar. The bar is
 *     `gate-price.getEntryTokensWei()` (bootstrap fixed count, or ceil($target/price) once the
 *     pool is deep enough). The BAR they cross is snapshotted as their qualifyingBalance.
 *   - RETENTION: an entitled owner keeps access while balance >= qualifyingBalance. This is
 *     price-independent: a dip never revokes, only selling below the snapshot does.
 */
import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { config } from "./config.js";
import { getEntryTokensWei, getPriceStats } from "./gate-price.js";

const OWNER_ABI = ["function owner() view returns (address)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

let sweep = null;
const cache = new Map(); // account(lowercased) -> { entitled: bool, ts: number }
const store = new Map(); // owner(lowercased)   -> { qualifyingBalance: bigint, qualifiedAt, lastSeen }

// ── retention store (entitlements.json) ──
function loadStore() {
  store.clear();
  try {
    if (existsSync(config.gate.storePath)) {
      const raw = JSON.parse(readFileSync(config.gate.storePath, "utf8"));
      for (const [k, v] of Object.entries(raw)) {
        store.set(k.toLowerCase(), {
          qualifyingBalance: BigInt(v.qualifyingBalance),
          qualifiedAt: v.qualifiedAt,
          lastSeen: v.lastSeen,
        });
      }
    }
  } catch (e) {
    console.warn(`[gate] could not load ${config.gate.storePath}: ${e.message} (starting empty)`);
  }
}

function saveStore() {
  try {
    const obj = {};
    for (const [k, v] of store.entries()) {
      obj[k] = {
        qualifyingBalance: v.qualifyingBalance.toString(),
        qualifiedAt: v.qualifiedAt,
        lastSeen: v.lastSeen,
      };
    }
    writeFileSync(config.gate.storePath, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn(`[gate] could not write ${config.gate.storePath}: ${e.message}`);
  }
}

/**
 * Wire the gate. No-op (stays fail-open) when disabled or misconfigured.
 */
export function initEntitlement(provider) {
  if (!config.gate.enabled) {
    console.log("[gate] $SWEPT demand gate OFF — all sweeps sponsored");
    return;
  }
  if (!config.gate.sweep || config.gate.minHold <= 0n) {
    console.warn("[gate] GATE_ENABLED but SWEEP_ADDR / SWEEP_MIN_HOLD not set — gate inert (fail-open)");
    return;
  }
  sweep = new ethers.Contract(config.gate.sweep, ERC20_ABI, provider);
  loadStore();
  console.log(
    `[gate] $SWEPT demand gate ON — mode=${config.gate.mode}, target=$${config.gate.targetUsd}, ` +
    `bootstrap floor=${config.gate.minHold / (10n ** 18n)} $SWEPT, ${store.size} qualified in store (${config.gate.sweep})`
  );
}

/**
 * True if the account's OWNER is entitled to sponsorship (retention, then entry).
 * Gate off / misconfigured -> true (backward compatible; never a denial of service).
 *
 * @param {string} account    SmartAccount address
 * @param {object} provider   ethers provider
 * @param {string} [ownerHint] known owner EOA (for undeployed/counterfactual accounts)
 * @returns {Promise<boolean>}
 */
export async function isEntitled(account, provider, ownerHint) {
  if (!config.gate.enabled || !sweep) return true;

  const key = account.toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < config.gate.cacheTtlMs) return hit.entitled;

  let entitled;
  try {
    let owner = ownerHint;
    if (!owner) owner = await new ethers.Contract(account, OWNER_ABI, provider).owner();
    owner = owner.toLowerCase();
    const bal = await sweep.balanceOf(owner);

    const rec = store.get(owner);
    if (rec && bal >= rec.qualifyingBalance) {
      // Retention: still holding what got them in. Price-independent.
      rec.lastSeen = now;
      entitled = true;
    } else {
      // Entry: qualify against the current bar; snapshot the BAR (not the full balance) so
      // buying extra isn't penalised and selling down to the bar keeps access.
      const bar = getEntryTokensWei();
      if (bar > 0n && bal >= bar) {
        store.set(owner, { qualifyingBalance: bar, qualifiedAt: now, lastSeen: now });
        saveStore();
        entitled = true;
      } else {
        entitled = false;
      }
    }
  } catch (err) {
    // Fail-open by default so a transient error never denies a paying user; not cached, retries.
    console.warn(`[gate] entitlement read failed for ${account}: ${err.message} — fail-${config.gate.failOpen ? "open" : "closed"}`);
    return config.gate.failOpen;
  }

  cache.set(key, { entitled, ts: now });
  return entitled;
}

/**
 * Stats for the keeper API layer.
 */
export function getGateStats() {
  const base = {
    enabled: config.gate.enabled && !!sweep,
    qualified: store.size,
  };
  return config.gate.enabled ? { ...base, ...getPriceStats() } : base;
}
