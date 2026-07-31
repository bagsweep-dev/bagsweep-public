/**
 * $REAP demand-gate tests. Uses a minimal fake provider so ethers.Contract reads
 * (owner(), balanceOf()) resolve without a live RPC, and a mocked fetch for the price feed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Gate env MUST be set before config.js is imported (it reads process.env at load).
const STORE = path.join(os.tmpdir(), `bagsweep-gate-${process.pid}.json`);
try { fs.rmSync(STORE, { force: true }); } catch {}
process.env.GATE_ENABLED = "1";
process.env.REAP_ADDR = "0x1111111111111111111111111111111111111111";
process.env.REAP_MIN_HOLD = "250000";
process.env.GATE_STORE_PATH = STORE;
process.env.GATE_TARGET_USD = "25";
process.env.GATE_LIQ_FLOOR_USD = "8000";
process.env.GATE_PRICE_SAMPLES = "1"; // deterministic: bar tracks the latest sample

const { config } = await import("../src/config.js");
const gatePrice = await import("../src/gate-price.js");
const { initEntitlement, isEntitled, getGateStats } = await import("../src/entitlement.js");

const TOK = (n) => BigInt(n) * (10n ** 18n);
const OWNER  = "0x2222222222222222222222222222222222222222";
const OWNER2 = "0x3333333333333333333333333333333333333333";
const OWNER3 = "0x4444444444444444444444444444444444444444";
const SEL_OWNER = "0x8da5cb5b"; // owner()
const SEL_BAL   = "0x70a08231"; // balanceOf(address)

function fakeProvider(balances, ownerFor = OWNER) {
  return {
    getNetwork: async () => ({ chainId: 4663n }),
    call: async (tx) => {
      const sel = (tx.data || "0x").slice(0, 10);
      if (sel === SEL_OWNER) return "0x000000000000000000000000" + ownerFor.slice(2);
      if (sel === SEL_BAL) {
        const addr = "0x" + tx.data.slice(34).toLowerCase();
        const bal = balances[addr] ?? 0n;
        return "0x" + bal.toString(16).padStart(64, "0");
      }
      return "0x";
    },
  };
}

function mockFetch(priceUsd, liqUsd) {
  globalThis.fetch = async () => ({
    json: async () => ({ pairs: [{ chainId: "robinhood", priceUsd: String(priceUsd), liquidity: { usd: liqUsd } }] }),
  });
}

// ── fixed / bootstrap mode (no price feed) ──
test("gate: REAP_MIN_HOLD parses whole tokens to wei", () => {
  assert.equal(config.gate.minHold, TOK(250000));
});

test("gate: owner holding >= threshold is entitled (owner() looked up)", async () => {
  const p = fakeProvider({ [OWNER.toLowerCase()]: TOK(300000) });
  initEntitlement(p);
  assert.equal(await isEntitled("0xacc0000000000000000000000000000000000001", p), true);
});

test("gate: owner holding < threshold is NOT entitled", async () => {
  const p = fakeProvider({ [OWNER.toLowerCase()]: TOK(100000) });
  initEntitlement(p);
  assert.equal(await isEntitled("0xacc0000000000000000000000000000000000002", p, OWNER), false);
});

test("gate: exactly at threshold is entitled (>=)", async () => {
  const p = fakeProvider({ [OWNER.toLowerCase()]: TOK(250000) });
  initEntitlement(p);
  assert.equal(await isEntitled("0xacc0000000000000000000000000000000000003", p, OWNER), true);
});

test("gate: read error fails OPEN by default (never deny a paying user)", async () => {
  const boom = { getNetwork: async () => ({ chainId: 4663n }), call: async () => { throw new Error("rpc down"); } };
  initEntitlement(boom);
  assert.equal(await isEntitled("0xacc0000000000000000000000000000000000004", boom, OWNER), true);
});

// ── phase 2: dollar-peg entry + token-hold retention ──
test("peg: entry bar sizes to ceil($target / price)", async () => {
  mockFetch(0.001, 50000);
  await gatePrice.refreshGatePrice();
  assert.equal(gatePrice.getEntryTokensWei(), TOK(25000)); // $25 / $0.001 = 25,000
  assert.equal(getGateStats().mode, "peg");
});

test("peg: owner holding >= bar qualifies and is snapshotted", async () => {
  mockFetch(0.001, 50000);
  await gatePrice.refreshGatePrice();
  const p = fakeProvider({ [OWNER2.toLowerCase()]: TOK(30000) }, OWNER2);
  initEntitlement(p);
  assert.equal(await isEntitled("0xacc0000000000000000000000000000000000010", p, OWNER2), true);
});

test("peg: retention holds on a price drop (bar rises) while newcomers face the higher bar", async () => {
  mockFetch(0.0005, 50000); // price halved -> bar doubles to 50,000
  await gatePrice.refreshGatePrice();
  assert.equal(gatePrice.getEntryTokensWei(), TOK(50000));
  const p = fakeProvider({ [OWNER2.toLowerCase()]: TOK(30000), [OWNER3.toLowerCase()]: TOK(30000) }, OWNER2);
  initEntitlement(p); // reloads store; OWNER2 was snapshotted at the 25,000 bar
  // OWNER2 holds 30,000 >= its 25,000 snapshot -> retained even though the live bar is now 50,000
  assert.equal(await isEntitled("0xacc0000000000000000000000000000000000011", p, OWNER2), true);
  // OWNER3 (new) holds 30,000 < 50,000 bar -> not entitled
  assert.equal(await isEntitled("0xacc0000000000000000000000000000000000012", p, OWNER3), false);
});

test("cleanup temp store", () => {
  try { fs.rmSync(STORE, { force: true }); } catch {}
  assert.ok(true);
});
