/**
 * BagSweep Keeper — Evaluator
 * For each active policy, determines if a sweep should trigger.
 * Checks token balances, applies PnL logic, and builds SweepPlans.
 */
import { ethers } from "ethers";
import { config } from "./config.js";
import { getProvider, getActivePolicies, isOnCooldown } from "./monitor.js";
import { selectBestRoute, usdgForStockLeg, quoteStockLeg, profitCappedAmount, encodeV3Path, auditFeeTier } from "./router.js";
import { rhPnl } from "../../lib/rh.js";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// Known meme token addresses to monitor (extend as needed)
// These are discovered from DexScreener's RH Chain pairs
const KNOWN_MEME_TOKENS = [
  // Add known RH Chain meme tokens here
  // The evaluator will also check any tokens in the policy whitelist
];

/**
 * @typedef {Object} SweepPlan
 * @property {string} account - SmartAccount address
 * @property {Array} swaps - Array of { tokenIn, amountIn, spotQuote, router, swapData }
 * @property {number} dest - 0=USDG_YIELD, 1=STOCKS, 2=SPLIT
 * @property {string} stockTarget - target stock token address (if dest=1 or 2)
 * @property {number} estimatedOutputUsd - rough estimate of total output
 */

/**
 * Evaluate all active policies and return an array of SweepPlans.
 * @returns {Promise<SweepPlan[]>}
 */
export async function evaluateAll() {
  if (!config.sweepRouter) {
    console.warn("[evaluator] no sanctioned DEX router (set SWEEP_ROUTER or deployed.sweepRouter); skipping — sweeps would revert RouterNotSanctioned");
    return [];
  }
  // L-1 (v2 audit): on mainnet, require a real V3 Quoter. Without one the enforced
  // slippage floor derives from a single DexScreener pair (unaudited, possibly shallow),
  // acceptable for the testnet mock but not for real funds. Refuse to route.
  if (config.chainId === 4663 && !config.quoter) {
    console.warn("[evaluator] mainnet (chain 4663) requires a V3 Quoter (set QUOTER_ADDR); refusing to route on a DexScreener-only floor — skipping");
    return [];
  }
  const policies = getActivePolicies();
  const provider = getProvider();
  const plans = [];

  for (const [account, { policy }] of policies) {
    // Skip accounts on cooldown
    if (isOnCooldown(account)) continue;

    try {
      const plan = await evaluateAccount(account, policy, provider);
      if (plan) {
        plans.push(plan);
      }
    } catch (err) {
      console.error(`[evaluator] Error evaluating ${account}:`, err.message);
    }
  }

  return plans;
}

/**
 * Evaluate a single account's policy against its on-chain balances.
 */
async function evaluateAccount(account, policy, provider) {
  // Determine which tokens to check
  const tokensToCheck = policy.tokenWhitelist.length > 0
    ? policy.tokenWhitelist
    : KNOWN_MEME_TOKENS;

  if (tokensToCheck.length === 0) {
    // No tokens to monitor — skip
    return null;
  }

  const swaps = [];
  let totalValueUsd = 0;

  // PROFITS mode caps each token's sweep at its unrealized profit, so reconstruct the
  // account's cost basis ONCE here (POSITION mode needs none). Cached per account.
  const pnlByToken = policy.mode === 1 ? await getAccountPnl(account) : null;

  // Evaluate all tokens concurrently (balance + price per token), then collect.
  const tokenResults = await Promise.all(tokensToCheck.map(async (tokenAddr) => {
    try {
      const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
      const [balance, decimals] = await Promise.all([
        token.balanceOf(account),
        token.decimals(),
      ]);
      if (balance === 0n) return null;

      const priceUsd = await getTokenPriceUsd(tokenAddr);
      if (!priceUsd) return null;

      const humanBalance = parseFloat(ethers.formatUnits(balance, decimals));
      const valueUsd = humanBalance * priceUsd;
      if (valueUsd < (policy.minUsd / 1e6)) return null; // minUsd in 6-dp USDG scale

      // POSITION sweeps pct% of the current balance (the on-chain cap). PROFITS caps
      // that at the token's unrealized profit (in token units) so principal is never
      // swept; 0 = no visible cost basis or no gain -> skip this token. (v2 audit M-5)
      const pctCap = balance * BigInt(policy.pct) / 10000n;
      const sweepAmount = policy.mode === 1
        ? profitCappedAmount(pctCap, balance, pnlByToken?.get(tokenAddr.toLowerCase()))
        : pctCap;
      if (sweepAmount === 0n) return null;

      const sweepValueUsd = parseFloat(ethers.formatUnits(sweepAmount, decimals)) * priceUsd;
      if (sweepValueUsd < config.minSweepUsd) return null;

      // Choose the route + spot quote. With a V3 Quoter configured, select the
      // deepest route and use its REAL on-chain output; otherwise the single
      // configured route + the DexScreener-derived quote. The enforced output floor
      // is the user policy applied to this quote: spotQuote * (10000 - slip)/10000.
      const slipBps = Number(policy.maxSlippageBps ?? config.maxSlippageBps ?? 500);
      const router = config.sweepRouter;
      let spotQuote, swapData;
      if (config.quoter && config.sweepRouter) {
        const route = await selectRouteOnchain(tokenAddr, sweepAmount, provider);
        if (!route) return null; // no routable path with the configured pools
        spotQuote = route.amountOut;
        swapData = encodeSwapExactTokens(route.path, sweepAmount, (spotQuote * BigInt(10000 - slipBps)) / 10000n);
      } else {
        spotQuote = BigInt(Math.floor(sweepValueUsd * 1e6));
        swapData = buildSwapCalldata(tokenAddr, sweepAmount, (spotQuote * BigInt(10000 - slipBps)) / 10000n).swapData;
      }

      return {
        swap: { tokenIn: tokenAddr, amountIn: sweepAmount.toString(), spotQuote: spotQuote.toString(), router, swapData },
        sweepValueUsd,
      };
    } catch (err) {
      console.error(`[evaluator] Token ${tokenAddr} check failed:`, err.message);
      return null;
    }
  }));

  for (const r of tokenResults) {
    if (!r) continue;
    swaps.push(r.swap);
    totalValueUsd += r.sweepValueUsd;
  }

  if (swaps.length === 0) return null;

  // Build the STOCKS / SPLIT_50_50 leg (v2 audit H-1). The frozen executor swaps
  // USDG -> stockTarget on a DIRECT path via its own stockRouter and enforces a floor
  // derived from stockSpotQuote, so the keeper must (a) name a sanctioned stockTarget
  // and (b) declare a real quote. If we can't, skip loudly so no op is signed that would
  // revert StockNotSanctioned / SlippageFloorRequired and burn sponsored gas.
  let stockTarget = ethers.ZeroAddress;
  let stockSpotQuote = 0n;
  if (policy.dest > 0) {
    if (!config.stockTarget) {
      console.warn(`[evaluator] ${account}: dest=${policy.dest} (STOCKS/SPLIT) but STOCK_TARGET unset — skipping`);
      return null;
    }
    const estUsdgTotal = swaps.reduce((a, s) => a + BigInt(s.spotQuote), 0n);
    const usdgForStock = usdgForStockLeg(estUsdgTotal, policy.dest);
    stockTarget = config.stockTarget;
    stockSpotQuote = await quoteStockOut(usdgForStock, provider);
    if (stockSpotQuote <= 0n) {
      console.warn(`[evaluator] ${account}: could not quote USDG->stock (${stockTarget}) — skipping`);
      return null;
    }
  }

  return {
    account,
    swaps,
    dest: policy.dest,
    stockTarget,
    stockSpotQuote: stockSpotQuote.toString(),
    estimatedOutputUsd: totalValueUsd,
  };
}

/**
 * Quote the USDG -> stock output for the stock leg. Primary path (audit-specified): the
 * V3 Quoter + the adapter's configured direct USDG/stock fee. Fallback (testnet / no
 * quoter): a market-price estimate from the stock's USD price + decimals, mirroring the
 * meme leg's DexScreener fallback. Returns 0n when neither can produce a quote.
 */
async function quoteStockOut(usdgForStock, provider) {
  if (usdgForStock <= 0n) return 0n;
  if (config.quoter && config.sweepRouter) {
    const adapter = new ethers.Contract(config.sweepRouter, ADAPTER_ABI, provider);
    const quoter = new ethers.Contract(config.quoter, QUOTER_ABI, provider);
    const res = await quoteStockLeg(usdgForStock, {
      usdg: config.usdg,
      stockTarget: config.stockTarget,
      feeFor: (a, b) => adapter.feeFor(a, b),
      quote: async (p, amt) => (await quoter.quoteExactInput.staticCall(p, amt))[0],
    });
    return res ? res.stockSpotQuote : 0n;
  }
  // Fallback: market price of the stock (override / DexScreener) + its decimals.
  const price = await getTokenPriceUsd(config.stockTarget);
  if (!price) return 0n;
  const stock = new ethers.Contract(config.stockTarget, ERC20_ABI, provider);
  const dec = Number(await stock.decimals());
  const stockUnits = Number(ethers.formatUnits(usdgForStock, 6)) / price;
  if (!(stockUnits > 0)) return 0n;
  return ethers.parseUnits(stockUnits.toFixed(Math.min(dec, 18)), dec);
}

/**
 * Get the USD price of a token via DexScreener.
 */
const priceCache = new Map();
const PRICE_TTL = 60_000; // 1 min
const PRICE_CACHE_MAX = 500; // bound the cache; the TTL only staleness-checks on read, never deletes (v2 audit L-2)

async function getTokenPriceUsd(tokenAddr) {
  const override = config.priceOverrides[tokenAddr.toLowerCase()];
  if (override != null && !Number.isNaN(override)) return override;

  const cached = priceCache.get(tokenAddr);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.price;

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.pairs && data.pairs.length > 0) {
      const price = parseFloat(data.pairs[0].priceUsd);
      if (priceCache.size >= PRICE_CACHE_MAX) priceCache.delete(priceCache.keys().next().value);
      priceCache.set(tokenAddr, { price, ts: Date.now() });
      return price;
    }
  } catch {
    // ignore
  }
  return null;
}

// PROFITS mode needs per-token unrealized profit. rhPnl reconstructs average cost basis
// from the account's on-chain transfer/swap history (over the same RH_RPC_URL the keeper
// uses, so it follows whatever chain the keeper targets). It's heavy, so cache the
// per-account result; on failure return an empty map so PROFITS safely sweeps nothing
// that cycle rather than sweeping principal.
const pnlCache = new Map(); // account(lower) -> { map, ts }
const PNL_TTL = 5 * 60_000;
const PNL_CACHE_MAX = 200;

async function getAccountPnl(account) {
  const key = account.toLowerCase();
  const hit = pnlCache.get(key);
  if (hit && Date.now() - hit.ts < PNL_TTL) return hit.map;
  const map = new Map();
  try {
    const pnl = await rhPnl(account);
    for (const p of pnl.positions) map.set(p.id.toLowerCase(), p);
  } catch (err) {
    console.error(`[evaluator] cost-basis (PnL) for ${account} failed:`, err.message);
  }
  if (pnlCache.size >= PNL_CACHE_MAX) pnlCache.delete(pnlCache.keys().next().value);
  pnlCache.set(key, { map, ts: Date.now() });
  return map;
}

const SWAP_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) external returns (uint256[] amounts)",
]);
const QUOTER_ABI = ["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] a, uint32[] b, uint256 c)"];
const ADAPTER_ABI = ["function feeFor(address a, address b) view returns (uint24)"];

/**
 * Encode the executor-facing swapExactTokensForTokens call for a token path. The
 * output MUST land on the executor (the C1 self-routed-swap check) and the path
 * MUST end in USDG.
 */
function encodeSwapExactTokens(path, amountIn, minOut) {
  return SWAP_IFACE.encodeFunctionData("swapExactTokensForTokens", [
    amountIn, minOut, path, config.executor, Math.floor(Date.now() / 1000) + 300,
  ]);
}

/**
 * Build DEX swap calldata for a SINGLE configured route: [tokenIn, ...sweepHubs,
 * USDG] through config.sweepRouter (MockSwapRouter on testnet, SweepRouterV3Adapter
 * on mainnet). Used as the fallback when no V3 Quoter is configured.
 */
export function buildSwapCalldata(tokenIn, amountIn, minAmountOut) {
  const path = [tokenIn, ...config.sweepHubs, config.usdg];
  return { router: config.sweepRouter, swapData: encodeSwapExactTokens(path, amountIn, minAmountOut) };
}

/**
 * On-chain route selection: quote the candidate routes (direct + via each hub)
 * through the V3 Quoter, using the adapter's configured fee tiers, and return the
 * deepest { path, amountOut }. Null if no route is quotable.
 */
async function selectRouteOnchain(tokenIn, amountIn, provider) {
  const quoter = new ethers.Contract(config.quoter, QUOTER_ABI, provider);
  const adapter = new ethers.Contract(config.sweepRouter, ADAPTER_ABI, provider);
  return selectBestRoute({
    tokenIn,
    usdg: config.usdg,
    hubs: config.sweepHubs,
    amountIn,
    feeFor: (a, b) => adapter.feeFor(a, b),
    quote: async (v3Path, amt) => (await quoter.quoteExactInput.staticCall(v3Path, amt))[0],
  });
}

/**
 * H-2 residual (v2 audit): cross-tier fee sanity check. The adapter stores ONE fee tier
 * per pair; a mis-set setPoolFee silently routes through a shallow tier (bounded by the
 * user slippage floor, but degrades every affected route). This quotes each pair the
 * keeper routes through at all standard tiers and warns when the configured tier isn't
 * the deepest. Read-only, monitoring only: it NEVER gates a sweep. No-op without a quoter
 * + adapter (e.g. the testnet mock).
 */
export async function auditRouteFees(provider = getProvider()) {
  if (!config.quoter || !config.sweepRouter) return [];
  const adapter = new ethers.Contract(config.sweepRouter, ADAPTER_ABI, provider);
  const quoter = new ethers.Contract(config.quoter, QUOTER_ABI, provider);
  const STD_TIERS = [100, 500, 3000, 10000];

  // The unordered pairs the keeper routes through: hub<->USDG, USDG<->stock, and each
  // active policy's whitelisted memes against USDG and every hub.
  const pairs = new Map();
  const addPair = (a, b) => {
    if (!a || !b || a.toLowerCase() === b.toLowerCase()) return;
    const k = [a.toLowerCase(), b.toLowerCase()].sort().join("-");
    if (!pairs.has(k)) pairs.set(k, [a, b]);
  };
  for (const hub of config.sweepHubs) addPair(hub, config.usdg);
  if (config.stockTarget) addPair(config.usdg, config.stockTarget);
  for (const [, { policy }] of getActivePolicies()) {
    for (const meme of policy.tokenWhitelist) {
      addPair(meme, config.usdg);
      for (const hub of config.sweepHubs) addPair(meme, hub);
    }
  }

  const decimalsOf = makeDecimalsCache(provider);
  const findings = [];
  for (const [a, b] of pairs.values()) {
    let configuredFee = 0;
    try { configuredFee = Number(await adapter.feeFor(a, b)); } catch { continue; }
    if (!configuredFee) continue; // not configured; selectBestRoute already skips this hop

    const amountIn = 10n ** BigInt(await decimalsOf(a)); // 1 whole token of `a` as the probe
    const tiers = [...new Set([...STD_TIERS, configuredFee])];
    const res = await auditFeeTier({
      configuredFee,
      tiers,
      quoteTier: async (fee) => (await quoter.quoteExactInput.staticCall(encodeV3Path([a, b], [fee]), amountIn))[0],
    });
    if (res.degraded) {
      const detail = res.configuredOut > 0n
        ? `+${Number(((res.bestOut - res.configuredOut) * 10000n) / res.configuredOut)}bps deeper`
        : "output where the configured tier gives none";
      console.warn(`[feeaudit] ${a}->${b}: configured fee ${res.configuredFee} is not the deepest tier (tier ${res.bestFee}: ${detail}). Review adapter.setPoolFee via the timelock.`);
      findings.push({ pair: [a, b], ...res });
    }
  }
  if (findings.length === 0) console.log(`[feeaudit] ${pairs.size} configured pair(s) checked; all on the deepest tier`);
  return findings;
}

function makeDecimalsCache(provider) {
  const cache = new Map();
  return async (token) => {
    const k = token.toLowerCase();
    if (cache.has(k)) return cache.get(k);
    let d = 18;
    try { d = Number(await new ethers.Contract(token, ERC20_ABI, provider).decimals()); } catch { /* default 18 */ }
    cache.set(k, d);
    return d;
  };
}

/**
 * Get a summary of the evaluator's current state.
 */
export function getEvaluatorStats() {
  return {
    activePolicies: getActivePolicies().size,
    priceCacheEntries: priceCache.size,
    // L-5 (v2 audit): if 0, accounts with an empty policy whitelist are silently never
    // swept — surface it so operators notice instead of assuming coverage.
    knownMemeTokens: KNOWN_MEME_TOKENS.length,
    lastEvalTs: Date.now(),
  };
}
