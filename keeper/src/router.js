/**
 * BagSweep Keeper — Route Selection
 * Chooses the best meme -> USDG route (direct, or via a hub) by quoting each
 * candidate through a Uniswap V3 Quoter and picking the deepest output. Fee tiers
 * come from the SweepRouterV3Adapter's config (feeFor), so the quote matches what
 * the adapter will actually execute.
 *
 * `quote` and `feeFor` are injected so the selection logic is unit-testable without
 * a live chain; the evaluator wires the on-chain implementations.
 */
import { ethers } from "ethers";

/**
 * Encode a Uniswap V3 path: token0 ++ fee0 ++ token1 ++ fee1 ++ ... ++ tokenN.
 * @param {string[]} tokens
 * @param {number[]} fees   length = tokens.length - 1
 */
export function encodeV3Path(tokens, fees) {
  const types = [], values = [];
  for (let i = 0; i < tokens.length; i++) {
    types.push("address"); values.push(tokens[i]);
    if (i < fees.length) { types.push("uint24"); values.push(fees[i]); }
  }
  return ethers.solidityPacked(types, values);
}

/**
 * Pick the best meme -> USDG route among: direct, and via each hub.
 * @param {object} p
 * @param {string}   p.tokenIn
 * @param {string}   p.usdg
 * @param {string[]} p.hubs
 * @param {bigint}   p.amountIn
 * @param {(a:string,b:string)=>Promise<number|bigint>} p.feeFor  fee tier, 0 = no pool
 * @param {(v3Path:string,amountIn:bigint)=>Promise<bigint>} p.quote  expected out; 0/throw = no route
 * @returns {Promise<{path:string[], fees:number[], amountOut:bigint}|null>}
 */
export async function selectBestRoute({ tokenIn, usdg, hubs, amountIn, feeFor, quote }) {
  const candidates = [[tokenIn, usdg], ...hubs.map((h) => [tokenIn, h, usdg])];

  // Evaluate every candidate concurrently (L-3): resolve each hop's fee in parallel, then
  // quote. A candidate with any unconfigured hop or a reverting quote drops to null.
  const results = await Promise.all(candidates.map(async (tokens) => {
    const rawFees = await Promise.all(tokens.slice(0, -1).map((_, i) => feeFor(tokens[i], tokens[i + 1])));
    const fees = rawFees.map(Number);
    if (fees.some((f) => !f)) return null; // an unconfigured pool on this path
    try {
      const out = BigInt(await quote(encodeV3Path(tokens, fees), amountIn));
      return out > 0n ? { path: tokens, fees, amountOut: out } : null;
    } catch { return null; } // no pool / quoter revert
  }));

  let best = null;
  for (const r of results) if (r && (!best || r.amountOut > best.amountOut)) best = r;
  return best;
}

/**
 * USDG (6dp, post-fee) routed to the stock leg for a destination. Mirrors the frozen
 * executor's split exactly: STOCKS (dest 1) routes all of it; SPLIT_50_50 (dest 2)
 * routes the ceil-half (the executor computes `usdgAmount - usdgAmount / 2`);
 * USDG_YIELD (dest 0) routes none.
 * @param {bigint} estUsdgTotal
 * @param {number} dest  0=USDG_YIELD, 1=STOCKS, 2=SPLIT_50_50
 * @returns {bigint}
 */
export function usdgForStockLeg(estUsdgTotal, dest) {
  if (dest === 1) return estUsdgTotal;
  if (dest === 2) return estUsdgTotal - estUsdgTotal / 2n;
  return 0n;
}

/**
 * Quote the executor's USDG -> stock leg. The frozen executor swaps on a DIRECT
 * [USDG, stockTarget] path through its own stockRouter, so this quotes exactly that
 * single hop (no hub) and returns the declared stock output used to derive the floor.
 * Null when the direct pool has no configured fee or the quote is empty — the caller
 * then skips the plan rather than sign a doomed op.
 * @param {bigint} usdgForStock
 * @param {object} p
 * @param {string} p.usdg
 * @param {string} p.stockTarget
 * @param {(a:string,b:string)=>Promise<number|bigint>} p.feeFor
 * @param {(v3Path:string,amountIn:bigint)=>Promise<bigint>} p.quote
 * @returns {Promise<{fee:number, stockSpotQuote:bigint}|null>}
 */
export async function quoteStockLeg(usdgForStock, { usdg, stockTarget, feeFor, quote }) {
  if (!stockTarget || usdgForStock <= 0n) return null;
  const fee = Number(await feeFor(usdg, stockTarget));
  if (!fee) return null; // no direct USDG/stock pool -> the executor's direct hop can't route
  let out = 0n;
  try { out = BigInt(await quote(encodeV3Path([usdg, stockTarget], [fee]), usdgForStock)); }
  catch { return null; }
  if (out <= 0n) return null;
  return { fee, stockSpotQuote: out };
}

/**
 * PROFITS-mode sweep size: cap the POSITION amount (`pctCap`) at the position's
 * unrealized profit expressed in token base units, so principal is never swept. The
 * on-chain pct cap still bounds it either way. Returns 0n when there's no usable cost
 * basis or no gain (basis "none", no price, or non-positive unrealized), which the
 * caller treats as "skip this token" — never sweeping principal under a PROFITS label.
 * @param {bigint} pctCap   balance * pct / 10000 (the on-chain cap)
 * @param {bigint} balance  token balance in base units
 * @param {{unrealizedUsd:number, valueUsd:number, basis:string}|undefined} pos  rhPnl position
 * @returns {bigint}
 */
export function profitCappedAmount(pctCap, balance, pos) {
  if (!pos || pos.basis === "none") return 0n;
  const { unrealizedUsd, valueUsd } = pos;
  if (!(valueUsd > 0) || !(unrealizedUsd > 0)) return 0n;
  // profit as a share of current value; selling this fraction of the balance realizes
  // roughly the unrealized gain. Clamp to 1 (a position can't be >100% profit).
  const fraction = Math.min(1, unrealizedUsd / valueUsd);
  const profitBase = (balance * BigInt(Math.floor(fraction * 1_000_000))) / 1_000_000n;
  return profitBase < pctCap ? profitBase : pctCap;
}

/**
 * Cross-tier fee sanity check for one pool (H-2 residual). The adapter stores a SINGLE
 * fee tier per pair; a mis-set setPoolFee silently routes through a shallow tier. Given
 * the configured tier and a quoter for each candidate tier, flag when a different tier
 * would return materially more (> minEdgeBps better) for the same probe input.
 * @param {object} p
 * @param {number} p.configuredFee   the adapter's configured tier (0 = unset)
 * @param {number[]} p.tiers         candidate tiers to probe, e.g. [100, 500, 3000, 10000]
 * @param {(fee:number)=>Promise<bigint>} p.quoteTier  output at a tier (0/throw = no pool)
 * @param {number} [p.minEdgeBps=100]  how much better the best tier must be to flag (default 1%)
 * @returns {Promise<{configuredFee:number, configuredOut:bigint, bestFee:number, bestOut:bigint, degraded:boolean}>}
 */
export async function auditFeeTier({ configuredFee, tiers, quoteTier, minEdgeBps = 100 }) {
  const outs = await Promise.all(tiers.map(async (fee) => {
    try { return { fee, out: BigInt(await quoteTier(fee)) }; } catch { return { fee, out: 0n }; }
  }));
  let best = { fee: 0, out: 0n };
  for (const o of outs) if (o.out > best.out) best = o;
  const configured = outs.find((o) => o.fee === configuredFee) ?? { fee: configuredFee, out: 0n };
  // Flag only when another tier beats the configured one by MORE than minEdgeBps (so a
  // negligible edge from quote noise doesn't spam warnings). configuredOut 0 => flag if
  // any tier returns anything (the configured pool is empty/wrong).
  const degraded = best.out > 0n && best.fee !== configuredFee &&
    (best.out - configured.out) * 10000n > configured.out * BigInt(minEdgeBps);
  return { configuredFee, configuredOut: configured.out, bestFee: best.fee, bestOut: best.out, degraded };
}
