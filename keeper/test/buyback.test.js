// Buyback eligibility/sizing unit tests. Run: `npm test` (node --test, no deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planBuyback } from "../src/buyback.js";

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
