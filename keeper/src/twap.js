/**
 * BagSweep Keeper — TWAP manipulation gate
 *
 * WHY THIS EXISTS. The enforced output floor is `spotQuote * (10000 - slip)/10000`, where
 * `spotQuote` is a QuoterV2 read of the *current* pool state. That protects against drift
 * between quote and execution, but it inherits its own reference price: if an attacker dumps
 * a thin meme pool, the quote comes back depressed, the floor is computed FROM the depressed
 * number, and the sweep sells cheap while passing its own floor. The floor cannot catch a
 * manipulation it was derived from.
 *
 * A Uniswap V3 TWAP is the independent second opinion. This module answers one question —
 * "is this pool currently in a state we should act on at all?" — and never prices anything.
 * Execution still uses the Quoter floor. Decoupling them matters: sizing the floor off a TWAP
 * would revert every sweep in a genuinely falling market (TWAP sits above spot on the way
 * down), turning a safety guard into a liveness failure. Gate on the TWAP, execute on the
 * quote, and every failure mode is "skip and retry next cycle" rather than "sell cheap".
 *
 * Three checks, all of which must pass (the pattern Lien.fi uses on the same chain):
 *   1. cardinality — at cardinality 1 there is no TWAP at all and one swap sets the price.
 *   2. age        — the pool must be able to look back the full window; blocks
 *                   launch-a-token-then-sweep-against-it (observe() reverts OLD if it can't).
 *   3. divergence — a fast and a slow window must agree within a cap, AND spot must not sit
 *                   below the slow window by more than that cap. The first catches a pool
 *                   mid-move in either direction; the second is the specific dump-then-harvest
 *                   case above.
 *
 * VERIFIED ON RH MAINNET 2026-08-09: real launchpad pools DO carry observation buffers
 * (WOOF/aeWETH and MANCER/aeWETH both at cardinality 1400, observe(3600) OK), so this gate is
 * usable today. Others sit at 1 (MANCER/STONKBROKER reverts OLD; SWEPT/WETH is a degenerate
 * single observation). Hence `minCardinality` is configurable and the default mode is "warn".
 *
 * ROLLOUT. Default mode is "warn": every check runs and logs, nothing is ever gated. That is a
 * strict no-op against today's behaviour, safe to ship inside the go-live freeze. Flip
 * TWAP_GATE_MODE=enforce once the logs show the thresholds match reality for the tokens
 * actually being swept.
 *
 * Reads only. No contract change, so nothing here touches the audited/frozen bytecode.
 */
import { ethers } from "ethers";
import { config } from "./config.js";

const V3_FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128)",
  "function token0() view returns (address)",
];

// Pool address and token0 are immutable for a given (tokenA, tokenB, fee), so resolve once.
const poolCache = new Map(); // key -> { pool, token0 } | { pool: null }
const POOL_CACHE_MAX = 500;

/**
 * Arithmetic mean tick over `windowSec`, matching Uniswap's OracleLibrary.consult:
 * BigInt division truncates toward zero, so a negative delta that doesn't divide evenly
 * must be floored down by one to stay consistent with the on-chain library.
 * @param {bigint[]} tickCumulatives  [at now-window, at now]
 * @param {number} windowSec
 * @returns {bigint} mean tick
 */
export function meanTickFrom(tickCumulatives, windowSec) {
  const delta = tickCumulatives[1] - tickCumulatives[0];
  const w = BigInt(windowSec);
  let mean = delta / w;
  if (delta < 0n && delta % w !== 0n) mean -= 1n;
  return mean;
}

/**
 * A tick is a 1.0001x price step, so a tick difference is ~1bp per tick over the small
 * deviations this gate cares about (100 ticks = 1.005%, i.e. ~100bps). Close enough for a
 * threshold check, and deliberately the cheap approximation rather than pow/log math.
 * @param {bigint} tickA
 * @param {bigint} tickB
 * @returns {number} absolute deviation in basis points
 */
export function tickDeltaBps(tickA, tickB) {
  const d = tickA > tickB ? tickA - tickB : tickB - tickA;
  return Number(d);
}

/**
 * Resolve the V3 pool for a hop and cache it with its token0 ordering.
 * @returns {Promise<{pool: string, token0: string}|null>}
 */
async function resolvePool(tokenA, tokenB, fee, provider) {
  const key = `${tokenA.toLowerCase()}-${tokenB.toLowerCase()}-${fee}`;
  const hit = poolCache.get(key);
  if (hit !== undefined) return hit;

  let entry = null;
  try {
    const factory = new ethers.Contract(config.v3Factory, V3_FACTORY_ABI, provider);
    const pool = await factory.getPool(tokenA, tokenB, fee);
    if (pool && pool !== ethers.ZeroAddress) {
      const token0 = await new ethers.Contract(pool, V3_POOL_ABI, provider).token0();
      entry = { pool, token0: token0.toLowerCase() };
    }
  } catch {
    return null; // caller treats an unresolvable pool as "cannot evaluate", not as a failure
  }
  if (poolCache.size >= POOL_CACHE_MAX) poolCache.delete(poolCache.keys().next().value);
  poolCache.set(key, entry);
  return entry;
}

/**
 * Run the TWAP gate for one hop (the meme leg of a sweep route).
 *
 * Only the FIRST hop is gated. Hub legs (aeWETH -> USDG) are orders of magnitude deeper than
 * a meme pool and are not the manipulable surface; gating them would add RPC cost and false
 * negatives for no safety gain.
 *
 * @param {object} p
 * @param {string} p.tokenIn   token being sold (the meme)
 * @param {string} p.tokenOut  the other side of the first hop
 * @param {number} p.fee       fee tier of that hop
 * @param {import("ethers").Provider} p.provider
 * @returns {Promise<{ok: boolean, gated: boolean, reason: string, detail: object}>}
 *          `ok` is what the caller acts on (always true in "warn"/"off"); `gated` is whether
 *          the checks actually failed, so warn mode can log honestly without blocking.
 */
export async function checkTwapGate({ tokenIn, tokenOut, fee, provider }) {
  const g = config.twapGate;
  const pass = (reason, detail = {}) => ({ ok: true, gated: false, reason, detail });
  // A failure returns ok:false ONLY in enforce mode; otherwise it reports and lets the sweep
  // through, so enabling this module can never be a regression against current behaviour.
  const fail = (reason, detail = {}) => ({ ok: g.mode !== "enforce", gated: true, reason, detail });

  if (g.mode === "off") return pass("gate off");
  if (!config.v3Factory) return pass("no V3_FACTORY_ADDR configured");

  const resolved = await resolvePool(tokenIn, tokenOut, fee, provider);
  // Fail-open on an unresolvable pool, mirroring the on-chain cooldown pre-check: a read
  // problem must never wedge an account. The Quoter already refused routes with no pool, so
  // reaching here with none means an RPC/config issue, not a manipulated market.
  if (!resolved) return pass("pool unresolved (read error) — proceeding on the quote floor");

  const { pool, token0 } = resolved;
  const poolC = new ethers.Contract(pool, V3_POOL_ABI, provider);

  let slot0;
  try {
    slot0 = await poolC.slot0();
  } catch (err) {
    return pass(`slot0 read failed (${err.message?.slice(0, 40)}) — proceeding`);
  }

  // 1. Cardinality. Below the minimum there is no meaningful TWAP to compare against.
  const cardinality = Number(slot0.observationCardinality);
  if (cardinality < g.minCardinality) {
    return fail("no TWAP: observation cardinality too low", {
      pool, cardinality, required: g.minCardinality,
      hint: "increaseObservationCardinalityNext() is permissionless — provisioning this pool would enable the gate",
    });
  }

  // 2. Age. observe() reverts OLD when the buffer cannot reach back the full window, which is
  // exactly the brand-new-pool case we want to refuse to sweep against.
  let slowTick, fastTick;
  try {
    const [slowObs, fastObs] = await Promise.all([
      poolC.observe([g.slowWindowSec, 0]),
      poolC.observe([g.fastWindowSec, 0]),
    ]);
    slowTick = meanTickFrom(slowObs[0], g.slowWindowSec);
    fastTick = meanTickFrom(fastObs[0], g.fastWindowSec);
  } catch (err) {
    const msg = err.message || "";
    if (/OLD/i.test(msg)) {
      return fail("pool too young for the TWAP window", {
        pool, slowWindowSec: g.slowWindowSec,
      });
    }
    return pass(`observe() failed (${msg.slice(0, 40)}) — proceeding`);
  }

  // 3a. Fast vs slow divergence — the pool is mid-move (pump or dump) in either direction.
  const windowSpreadBps = tickDeltaBps(fastTick, slowTick);
  if (windowSpreadBps > g.maxDeviationBps) {
    return fail("fast/slow TWAP divergence over cap (pool mid-move)", {
      pool, windowSpreadBps, cap: g.maxDeviationBps,
      fastTick: fastTick.toString(), slowTick: slowTick.toString(),
    });
  }

  // 3b. Spot below the slow TWAP — the dump-then-harvest case the quote floor cannot see.
  // Direction depends on token ordering: the tick measures token1-per-token0, so tokenIn's
  // price rises with tick when it is token0 and falls with tick when it is token1.
  const spotTick = BigInt(slot0.tick);
  const inIsToken0 = tokenIn.toLowerCase() === token0;
  const deficitTicks = inIsToken0 ? slowTick - spotTick : spotTick - slowTick;
  const spotBelowTwapBps = deficitTicks > 0n ? Number(deficitTicks) : 0;
  if (spotBelowTwapBps > g.maxDeviationBps) {
    return fail("spot below TWAP over cap (possible dump-then-harvest)", {
      pool, spotBelowTwapBps, cap: g.maxDeviationBps,
      spotTick: spotTick.toString(), slowTick: slowTick.toString(),
    });
  }

  return pass("ok", { pool, cardinality, windowSpreadBps, spotBelowTwapBps });
}
