// Buyback eligibility/sizing unit tests. Run: `npm test` (node --test, no deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planBuyback, planBuybackSwap } from "../src/buyback.js";

// 1000 USDG (6dp) balance, 20% cap, 1h cooldown last fired at t=1000, $10 min.
const base = {
  usdgBalance: 1000_000000n, maxSpendBps: 2000, cooldown: 3600,
  lastBuyback: 1000, now: 5000, minBuybackUsd6: 10_000000n, sweepTokenSet: true,
};

test("planBuyback: eligible past cooldown, sized to the on-chain cap (20%)", () => {
  const p = planBuyback(base);
  assert.equal(p.eligible, true);
  assert.equal(p.usdgAmount, (1000_000000n * 2000n) / 10000n); // 200 USDG
});

test("planBuyback: skips pre-launch (sweep token unset)", () => {
  assert.equal(planBuyback({ ...base, sweepTokenSet: false }).eligible, false);
});

test("planBuyback: skips during the cooldown window", () => {
  assert.equal(planBuyback({ ...base, now: base.lastBuyback + 100 }).eligible, false); // 100 < 3600
});

test("planBuyback: fires exactly when the cooldown elapses", () => {
  assert.equal(planBuyback({ ...base, now: base.lastBuyback + base.cooldown }).eligible, true);
});

test("planBuyback: skips when the spendable amount is below the minimum", () => {
  // 20% of 40 USDG = 8 < 10 min
  assert.equal(planBuyback({ ...base, usdgBalance: 40_000000n }).eligible, false);
});

// ── buyback swap routing (multi-hop USDG -> WETH -> $SWEPT) ──
const USDG = "0x" + "1".repeat(40);
const WETH = "0x" + "2".repeat(40);
const SWEPT = "0x" + "3".repeat(40);
const pair = (a, b) => new Set([a, b]);

test("planBuybackSwap: routes USDG -> WETH -> $SWEPT when there is no direct USDG/$SWEPT pool", async () => {
  // the real launch case: $SWEPT pairs with WETH, so there is no direct USDG/$SWEPT pool
  const feeFor = async (a, b) => {
    const p = pair(a, b);
    if (p.has(USDG) && p.has(SWEPT)) return 0;
    if (p.has(USDG) && p.has(WETH)) return 500;
    if (p.has(WETH) && p.has(SWEPT)) return 3000;
    return 0;
  };
  const swap = await planBuybackSwap({
    usdg: USDG, sweepToken: SWEPT, hubs: [WETH], amountIn: 200_000000n, slippageBps: 300,
    feeFor, quote: async () => 1000n,
  });
  assert.deepEqual(swap.path, [USDG, WETH, SWEPT]);
  assert.deepEqual(swap.fees, [500, 3000]);
  assert.equal(swap.minOut, (1000n * 9700n) / 10000n); // 3% slippage floor
});

test("planBuybackSwap: uses the direct pool when one exists", async () => {
  const feeFor = async (a, b) => (pair(a, b).has(USDG) && pair(a, b).has(SWEPT)) ? 500 : 0;
  const swap = await planBuybackSwap({
    usdg: USDG, sweepToken: SWEPT, hubs: [WETH], amountIn: 1n, slippageBps: 300,
    feeFor, quote: async () => 1000n,
  });
  assert.deepEqual(swap.path, [USDG, SWEPT]);
  assert.deepEqual(swap.fees, [500]);
});

test("planBuybackSwap: null when neither a direct pool nor a hub route exists", async () => {
  const swap = await planBuybackSwap({
    usdg: USDG, sweepToken: SWEPT, hubs: [WETH], amountIn: 1n, slippageBps: 300,
    feeFor: async () => 0, quote: async () => 0n,
  });
  assert.equal(swap, null);
});
