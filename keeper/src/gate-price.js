/**
 * $SWEEP dollar-peg price + mode (phase 2 of the demand gate).
 *
 * Off-chain only. Pulls priceUsd + liquidity.usd for $SWEEP from DexScreener (the same
 * source the evaluator already uses), keeps a MEDIAN over a rolling window so a single
 * manipulated print cannot move the bar, and selects the mode:
 *   - `fixed`: pool too thin to price -> the gate uses the bootstrap fixed token count.
 *   - `peg`:   pool deep enough -> entry threshold = ceil($target / smoothed price).
 * Retention is token-based and lives in entitlement.js, so nothing here ever revokes access.
 */
import { config } from "./config.js";

const WEI = 10n ** 18n;

let samples = [];        // rolling buffer of { usd, liq, ts }
let mode = "fixed";      // "fixed" | "peg"
let smoothedUsd = 0;
let smoothedLiqUsd = 0;

function median(nums) {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** One DexScreener sample for $SWEEP: the deepest RH-chain pair. Null on any failure. */
async function fetchSample() {
  const addr = config.gate.sweep;
  if (!addr) return null;
  const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  const pairs = (data.pairs || []).filter(
    (p) => (p.chainId || "").toLowerCase() === "robinhood"
  );
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0];
  const usd = parseFloat(p.priceUsd);
  const liq = parseFloat(p.liquidity?.usd ?? 0);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return { usd, liq: Number.isFinite(liq) ? liq : 0, ts: Date.now() };
}

/**
 * Refresh the smoothed price + mode. Called on a timer from index.js. Never throws.
 * In `fixed` config mode this is a no-op; `auto` uses the liquidity floor; `peg` forces
 * the peg whenever a positive price exists.
 */
export async function refreshGatePrice() {
  if (!config.gate.enabled || config.gate.mode === "fixed") { mode = "fixed"; return; }

  let sample = null;
  try { sample = await fetchSample(); } catch { sample = null; }
  if (sample) samples.push(sample);

  const now = Date.now();
  const windowMs = config.gate.priceWindowMin * 60_000;
  samples = samples.filter((s) => now - s.ts <= windowMs).slice(-config.gate.priceSamples);

  if (samples.length === 0) { mode = "fixed"; smoothedUsd = 0; return; }

  smoothedUsd = median(samples.map((s) => s.usd));
  smoothedLiqUsd = median(samples.map((s) => s.liq));

  if (config.gate.mode === "peg") {
    mode = smoothedUsd > 0 ? "peg" : "fixed";
  } else { // auto
    mode = smoothedUsd > 0 && smoothedLiqUsd >= config.gate.liqFloorUsd ? "peg" : "fixed";
  }
}

/**
 * Current entry threshold in wei.
 *   fixed -> config.gate.minHold (bootstrap whole-token count)
 *   peg   -> ceil($targetUsd / smoothed price), in whole tokens, as wei
 */
export function getEntryTokensWei() {
  if (mode !== "peg" || smoothedUsd <= 0) return config.gate.minHold;
  const tokens = Math.ceil(config.gate.targetUsd / smoothedUsd);
  return BigInt(tokens) * WEI;
}

export function getPriceStats() {
  return {
    mode,
    smoothedUsd,
    liquidityUsd: smoothedLiqUsd,
    samples: samples.length,
    entryTokens: (getEntryTokensWei() / WEI).toString(),
  };
}
