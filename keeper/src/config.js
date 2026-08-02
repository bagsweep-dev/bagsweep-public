/**
 * BagSweep Keeper — Configuration
 * Loads contract addresses and RPC settings from environment variables
 * with fallbacks to the deployed-addresses.json file.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// Load deployed addresses if available
const addrPath = join(ROOT, "deployed-addresses.json");
const deployed = existsSync(addrPath) ? JSON.parse(readFileSync(addrPath, "utf8")) : {};

export const config = {
  // ── Network ──
  rpcUrl:     process.env.RH_RPC_URL      || "https://rpc.mainnet.chain.robinhood.com",
  chainId:    parseInt(process.env.CHAIN_ID || deployed.chainId || "4663"),

  // ── Contract Addresses ──
  registry:   process.env.REGISTRY_ADDR  || deployed.registry   || "",
  executor:   process.env.EXECUTOR_ADDR  || deployed.executor   || "",
  factory:    process.env.FACTORY_ADDR   || deployed.factory    || "",
  entryPoint: process.env.ENTRY_POINT    || deployed.entryPoint || "",
  usdg:       process.env.USDG_ADDR      || deployed.usdg       || "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  // Owner-sanctioned DEX router the keeper routes meme->USDG swaps through. MUST be
  // sanctioned on the executor (executor.setSanctionedRouter) or sweeps revert.
  // On mainnet this is the SweepRouterV3Adapter (V2 interface over Uniswap V3).
  sweepRouter: process.env.SWEEP_ROUTER  || deployed.sweepRouter || "",
  // Intermediate hub tokens for multi-hop routing (meme -> hub -> USDG). RH memes
  // pair with WETH / tokenized stocks, not USDG directly, so mainnet routes via a
  // hub. Empty = direct [meme, USDG] (fits the fixed-rate testnet mock router).
  // JSON array of addresses in SWEEP_HUBS.
  sweepHubs: (() => {
    try { return JSON.parse(process.env.SWEEP_HUBS || "[]").map(String); }
    catch { return []; }
  })(),
  // Uniswap V3 Quoter (QuoterV2) for route SELECTION: quote each candidate route
  // and pick the deepest. Unset = use the single configured route (sweepHubs) with
  // the DexScreener-derived quote. QUOTER_ADDR.
  quoter: process.env.QUOTER_ADDR || deployed.quoter || "",
  // Sanctioned stock token bought for STOCKS / SPLIT_50_50 policies. The policy has
  // no per-account stock field (dest is just YIELD/STOCKS/SPLIT), so the keeper picks
  // the target here; it MUST be executor.setSanctionedStock'd or the sweep reverts
  // StockNotSanctioned. Unset = STOCKS/SPLIT policies are skipped. STOCK_TARGET.
  stockTarget: process.env.STOCK_TARGET || deployed.stockTarget || "",

  // ── Keeper Identity ──
  keeperKey:  process.env.KEEPER_KEY      || "",  // private key (hex)
  keeperAddr: process.env.KEEPER_ADDRESS  || deployed.keeper   || "",

  // ── Bundler ──
  bundlerUrl: process.env.BUNDLER_URL     || "http://localhost:4337",
  paymaster:  process.env.PAYMASTER_ADDR  || "",

  // ── Sponsor signer ──
  // Private key that authorizes paymaster sponsorship. The verifying paymaster
  // sponsors ONLY ops signed by this key, so keep the rate-limiting decision here.
  // Defaults to the keeper key (the keeper is the deploy-time default sponsor).
  sponsorKey: process.env.SPONSOR_KEY     || process.env.KEEPER_KEY || "",

  // ── Intervals ──
  pollIntervalMs:    parseInt(process.env.POLL_INTERVAL_MS    || "60000"),   // 60s
  evalIntervalMs:    parseInt(process.env.EVAL_INTERVAL_MS    || "120000"),  // 2 min
  sweepCooldownMs:   parseInt(process.env.SWEEP_COOLDOWN_MS   || "300000"),  // 5 min
  auditIntervalMs:   parseInt(process.env.AUDIT_INTERVAL_MS   || "1800000"), // 30 min: cross-tier fee sanity check

  // ── Buyback-and-burn (SweepBuyback: swap accumulated USDG fees into $SWEPT, burn) ──
  // $SWEPT is read from buyback.sweepToken() on-chain (launchpad-created), so no token
  // address is configured here. OFF until launch: set BUYBACK_ENABLED=1 + BUYBACK_ADDR.
  buyback:            process.env.BUYBACK_ADDR         || deployed.buyback || "",
  buybackEnabled:     process.env.BUYBACK_ENABLED === "1",
  buybackIntervalMs:  parseInt(process.env.BUYBACK_INTERVAL_MS || "600000"),  // 10 min (cooldown-gated on-chain)
  buybackSlippageBps: parseInt(process.env.BUYBACK_SLIPPAGE_BPS || "300"),    // 3%
  minBuybackUsd6:     BigInt(Math.floor(parseFloat(process.env.MIN_BUYBACK_USD || "10") * 1e6)), // min USDG (6dp) to bother

  // ── $SWEPT demand gate (off-chain sponsor entitlement) ──
  // OFF by default (GATE_ENABLED unset => all keeper sweeps sponsored, current behaviour).
  // When ON, the paymaster sponsor-signer sponsors a gasless sweep ONLY if the account's
  // OWNER holds >= `minHold` $SWEPT. A non-entitled account is denied NOTHING on-chain: it
  // keeps the ungated self-exit (SmartAccount.ownerExecute); the keeper just does not
  // automate a gasless sweep for it. Bootstrap uses a FIXED whole-token threshold (the
  // SWEPT/WETH pool is too thin to price a dollar-peg yet); the smoothed-price peg +
  // retention snapshot land later.
  gate: {
    enabled:    process.env.GATE_ENABLED === "1",
    sweep:       process.env.SWEEP_ADDR || deployed.sweep || "",
    minHold: (() => {
      if (process.env.SWEEP_MIN_HOLD_WEI) return BigInt(process.env.SWEEP_MIN_HOLD_WEI);
      return BigInt(process.env.SWEEP_MIN_HOLD || "0") * (10n ** 18n); // whole-token threshold -> wei
    })(),
    cacheTtlMs: parseInt(process.env.GATE_CACHE_TTL_MS || "60000"),   // per-account entitlement cache
    failOpen:   process.env.GATE_FAIL_OPEN !== "0",  // on a balance-read error, sponsor anyway (don't deny a paying user)
    // ── phase 2: dollar-peg entry + token-hold retention ──
    mode:           process.env.GATE_MODE || "auto",                 // auto | fixed | peg  (auto = liquidity floor decides)
    targetUsd:      parseFloat(process.env.GATE_TARGET_USD || "25"),
    liqFloorUsd:    parseFloat(process.env.GATE_LIQ_FLOOR_USD || "8000"),
    priceWindowMin: parseInt(process.env.GATE_PRICE_WINDOW_MIN || "60"),
    priceSamples:   parseInt(process.env.GATE_PRICE_SAMPLES || "12"),
    refreshMs:      parseInt(process.env.GATE_PRICE_REFRESH_MS || "300000"), // 5 min price refresh
    storePath:      process.env.GATE_STORE_PATH || join(__dirname, "..", "entitlements.json"),
  },

  // ── Thresholds ──
  minSweepUsd:       parseFloat(process.env.MIN_SWEEP_USD     || "5"),       // $5 min sweep
  maxSlippageBps:    parseInt(process.env.MAX_SLIPPAGE_BPS    || "300"),     // 3%

  // ── UserOp gas limits ──
  // Configurable fallbacks (were hardcoded; v2 audit L-6). When an
  // eth_estimateUserOperationGas-capable bundler is available, wire real estimates into
  // the pre-sign draft — RH has no such bundler yet (see BUNDLER_RUNBOOK). Nitro adds an
  // L1-data gas component, so preVerification may need bumping per chain via env.
  gas: {
    verification:    BigInt(process.env.GAS_VERIFICATION_LIMIT || "200000"),
    call:            BigInt(process.env.GAS_CALL_LIMIT         || "500000"),
    preVerification: BigInt(process.env.GAS_PREVERIFICATION    || "50000"),
    pmVerification:  BigInt(process.env.GAS_PM_VERIFICATION    || "100000"),
    pmPostOp:        BigInt(process.env.GAS_PM_POSTOP          || "50000"),
  },

  // ── Price overrides ──
  // Token address (lowercased) -> USD price. Lets the keeper price tokens not on
  // DexScreener (e.g. testnet mocks) or override a source. JSON in PRICE_OVERRIDES.
  priceOverrides: (() => {
    try {
      const raw = JSON.parse(process.env.PRICE_OVERRIDES || "{}");
      const out = {};
      for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = Number(v);
      return out;
    } catch { return {}; }
  })(),

  // ── Logging ──
  logLevel:   process.env.LOG_LEVEL || "info",
};

/**
 * Validate that required config values are present.
 */
export function validateConfig() {
  const errors = [];
  if (!config.registry)       errors.push("REGISTRY_ADDR not set");
  if (!config.executor)       errors.push("EXECUTOR_ADDR not set");
  if (!config.factory)        errors.push("FACTORY_ADDR not set");
  if (!config.entryPoint)     errors.push("ENTRY_POINT not set");
  if (!config.keeperKey)      errors.push("KEEPER_KEY not set");
  return errors;
}
