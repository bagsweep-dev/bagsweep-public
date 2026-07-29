// Keeper route-selection unit tests. Run: `npm test` (node --test, no deps).
// The router helpers take injected quote/feeFor so the logic is testable off-chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { usdgForStockLeg, quoteStockLeg, selectBestRoute, profitCappedAmount, auditFeeTier } from "../src/router.js";

const USDG = "0x" + "1".repeat(40);
const STOCK = "0x" + "2".repeat(40);
const MEME = "0x" + "a".repeat(40);
const HUB = "0x" + "c".repeat(40);

test("usdgForStockLeg mirrors the executor's split", () => {
  assert.equal(usdgForStockLeg(100n, 1), 100n);   // STOCKS routes all
  assert.equal(usdgForStockLeg(100n, 2), 50n);    // SPLIT even -> half
  assert.equal(usdgForStockLeg(101n, 2), 51n);    // SPLIT odd  -> ceil half (executor: 101 - 101/2)
  assert.equal(usdgForStockLeg(100n, 0), 0n);     // USDG_YIELD routes none
});

test("quoteStockLeg quotes the direct USDG->stock hop with the configured fee", async () => {
  const feeFor = async (a, b) => (a === USDG && b === STOCK ? 3000 : 0);
  // 1 USDG (6dp) -> 1 stock (18dp): out = in * 1e12
  const quote = async (_path, amt) => amt * 10n ** 12n;
  const res = await quoteStockLeg(100_000000n, { usdg: USDG, stockTarget: STOCK, feeFor, quote });
  assert.ok(res, "expected a route");
  assert.equal(res.fee, 3000);
  assert.equal(res.stockSpotQuote, 100_000000n * 10n ** 12n);
});

test("quoteStockLeg returns null when the direct pool has no configured fee", async () => {
  const res = await quoteStockLeg(100n, { usdg: USDG, stockTarget: STOCK, feeFor: async () => 0, quote: async () => 5n });
  assert.equal(res, null);
});

test("quoteStockLeg returns null on zero amount or missing target", async () => {
  const feeFor = async () => 3000, quote = async () => 5n;
  assert.equal(await quoteStockLeg(0n, { usdg: USDG, stockTarget: STOCK, feeFor, quote }), null);
  assert.equal(await quoteStockLeg(100n, { usdg: USDG, stockTarget: "", feeFor, quote }), null);
});

test("quoteStockLeg returns null when the quoter reverts", async () => {
  const res = await quoteStockLeg(100n, {
    usdg: USDG, stockTarget: STOCK, feeFor: async () => 3000,
    quote: async () => { throw new Error("no pool"); },
  });
  assert.equal(res, null);
});

test("selectBestRoute picks the deepest of direct vs via-hub", async () => {
  const feeFor = async () => 500;
  // the via-hub candidate (path contains HUB) quotes deeper than the direct one
  const quote = async (path) => (path.toLowerCase().includes(HUB.slice(2).toLowerCase()) ? 200n : 100n);
  const best = await selectBestRoute({ tokenIn: MEME, usdg: USDG, hubs: [HUB], amountIn: 1n, feeFor, quote });
  assert.deepEqual(best.path, [MEME, HUB, USDG]);
  assert.equal(best.amountOut, 200n);
});

test("selectBestRoute returns null when no pool has a fee", async () => {
  const best = await selectBestRoute({ tokenIn: MEME, usdg: USDG, hubs: [HUB], amountIn: 1n, feeFor: async () => 0, quote: async () => 1n });
  assert.equal(best, null);
});

test("profitCappedAmount caps the sweep at unrealized profit (protects principal)", () => {
  const balance = 1000n * 10n ** 18n;
  const pctCap = 100n * 10n ** 18n; // 10% of balance
  // big gain: profit is 33% of value, exceeds pctCap -> sweep the full pctCap
  assert.equal(profitCappedAmount(pctCap, balance, { valueUsd: 150, unrealizedUsd: 50, basis: "full" }), pctCap);
  // small gain: profit is 5% of value, below pctCap -> sweep only the profit portion
  assert.equal(profitCappedAmount(pctCap, balance, { valueUsd: 150, unrealizedUsd: 7.5, basis: "full" }), 50n * 10n ** 18n);
});

test("profitCappedAmount sweeps nothing without visible basis or gain", () => {
  const balance = 1000n * 10n ** 18n, pctCap = 100n * 10n ** 18n;
  assert.equal(profitCappedAmount(pctCap, balance, undefined), 0n);                                          // untracked token
  assert.equal(profitCappedAmount(pctCap, balance, { valueUsd: 150, unrealizedUsd: 50, basis: "none" }), 0n); // no cost basis
  assert.equal(profitCappedAmount(pctCap, balance, { valueUsd: 150, unrealizedUsd: 0, basis: "full" }), 0n);  // no gain
  assert.equal(profitCappedAmount(pctCap, balance, { valueUsd: null, unrealizedUsd: 50, basis: "partial" }), 0n); // unpriced
});

const TIERS = [100, 500, 3000, 10000];

test("auditFeeTier flags a configured tier that isn't the deepest", async () => {
  const outByFee = { 100: 90n, 500: 130n, 3000: 100n, 10000: 80n };
  const res = await auditFeeTier({ configuredFee: 3000, tiers: TIERS, quoteTier: async (f) => outByFee[f] });
  assert.equal(res.degraded, true);
  assert.equal(res.bestFee, 500);
  assert.equal(res.configuredOut, 100n);
});

test("auditFeeTier does not flag when the configured tier is the deepest", async () => {
  const outByFee = { 100: 90n, 500: 130n, 3000: 100n, 10000: 80n };
  const res = await auditFeeTier({ configuredFee: 500, tiers: TIERS, quoteTier: async (f) => outByFee[f] });
  assert.equal(res.degraded, false);
  assert.equal(res.bestFee, 500);
});

test("auditFeeTier ignores a sub-threshold edge (minEdgeBps)", async () => {
  // best (500=101) is only 1% better than configured (3000=100); default minEdgeBps=100 -> not flagged (needs > 1%)
  const res = await auditFeeTier({ configuredFee: 3000, tiers: [500, 3000], quoteTier: async (f) => ({ 500: 101n, 3000: 100n }[f]) });
  assert.equal(res.degraded, false);
});

test("auditFeeTier flags when the configured pool is empty but another tier has liquidity", async () => {
  const res = await auditFeeTier({ configuredFee: 3000, tiers: [500, 3000], quoteTier: async (f) => ({ 500: 100n, 3000: 0n }[f]) });
  assert.equal(res.degraded, true);
  assert.equal(res.bestFee, 500);
});

test("auditFeeTier treats a reverting tier as zero output", async () => {
  const res = await auditFeeTier({
    configuredFee: 500, tiers: [500, 3000],
    quoteTier: async (f) => { if (f === 3000) throw new Error("no pool"); return 120n; },
  });
  assert.equal(res.degraded, false);
  assert.equal(res.bestFee, 500);
});
