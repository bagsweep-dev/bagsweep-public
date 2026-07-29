// Solana adapter.
// Balances: api.mainnet-beta (getTokenAccountsByOwner is tolerated there, blocked on PublicNode).
// History: PublicNode (fast getSignaturesForAddress/getTransaction, generous limits).
// Prices: DexScreener batch. Native/history pricing: Coingecko.

import { solRpc, pool, TTLCache, bigToFloat } from "./util.js";
import { dexPrices, nativePrices, priceOnDay } from "./prices.js";

const BALANCE_RPC = process.env.SOL_BALANCE_RPC_URL || "https://api.mainnet-beta.solana.com";
const HISTORY_RPC = process.env.SOL_RPC_URL || "https://solana-rpc.publicnode.com";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Map([
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"],
]);
// Heuristic majors filter (symbol + liquidity floor) so blue chips don't count as meme exposure.
const MAJOR_SYMBOLS = new Set(["WETH", "WBTC", "CBBTC", "EURC", "USDS", "PYUSD", "USDY", "MSOL", "JITOSOL", "BSOL", "JUPSOL", "INF", "JLP", "WSOL", "JTO", "PYTH", "RAY", "JUP", "W", "RENDER"]);
const isXStock = (sym, liq) => /^[A-Za-z]{1,6}x$/.test(sym || "") && /[A-Z]/.test(sym[0]) && (liq || 0) > 50_000;

const MAX_SIGS = 300;      // signatures fetched
const MAX_PNL_TXS = 120;   // transactions parsed for cost basis

const pfCache = new TTLCache();

export async function solPortfolio(address) {
  const cached = pfCache.get("pf:" + address);
  if (cached) return cached;
  const notes = [];

  const [legacy, t22, lamports, natives] = await Promise.all([
    solRpc(BALANCE_RPC, "getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }]),
    solRpc(BALANCE_RPC, "getTokenAccountsByOwner", [address, { programId: TOKEN_2022 }, { encoding: "jsonParsed" }]).catch(() => ({ value: [] })),
    solRpc(HISTORY_RPC, "getBalance", [address]).then((r) => r.value).catch(() => null),
    nativePrices(),
  ]);

  // aggregate balances per mint
  const byMint = new Map();
  for (const acc of [...(legacy?.value || []), ...(t22?.value || [])]) {
    const info = acc.account?.data?.parsed?.info;
    if (!info) continue;
    const amt = info.tokenAmount?.uiAmount ?? 0;
    if (!amt) continue;
    byMint.set(info.mint, (byMint.get(info.mint) ?? 0) + amt);
  }

  const mints = [...byMint.keys()];
  const ds = await dexPrices("solana", mints);
  const solPx = natives.solana;

  const positions = [];
  for (const [mint, amount] of byMint) {
    const pair = ds.get(mint.toLowerCase()) ?? ds.get(mint) ?? null;
    let cls = "meme", priceUsd = null, priceSource = null;
    if (STABLES.has(mint)) { cls = "stable"; priceUsd = 1; priceSource = "peg"; }
    else if (mint === WSOL) { cls = "native"; priceUsd = solPx; priceSource = "coingecko"; }
    else if (pair?.priceUsd) {
      priceUsd = pair.priceUsd; priceSource = "dexscreener";
      const symU = (pair.symbol || "").toUpperCase();
      if (isXStock(pair.symbol, pair.liquidityUsd)) cls = "stock"; // Backed xStocks convention: NVDAx, SPYx
      else if (MAJOR_SYMBOLS.has(symU) && (pair.liquidityUsd || 0) > 250_000) cls = "major";
    }
    positions.push({
      id: mint, symbol: STABLES.get(mint) || pair?.symbol || mint.slice(0, 6), name: pair?.name || null,
      class: cls, amount, priceUsd, valueUsd: priceUsd !== null ? amount * priceUsd : null,
      priceSource, liquidityUsd: pair?.liquidityUsd ?? null, priceChange24h: pair?.priceChange24h ?? null,
    });
  }

  const nativeAmt = lamports !== null ? lamports / 1e9 : null;
  const native = { symbol: "SOL", amount: nativeAmt, priceUsd: solPx, valueUsd: nativeAmt !== null && solPx !== null ? nativeAmt * solPx : null };

  positions.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const unpriced = positions.filter((p) => p.valueUsd === null).length;
  if (unpriced) notes.push(`${unpriced} token(s) have no DEX price (dust or unlisted) and are excluded from totals.`);
  const sum = (cls) => positions.filter((p) => p.class === cls && p.valueUsd).reduce((s, p) => s + p.valueUsd, 0);

  const result = {
    chain: "solana", address, native, positions,
    totals: {
      memeUsd: sum("meme"),
      stableUsd: sum("stable"),
      stockUsd: sum("stock"),
      majorUsd: sum("major"),
      nativeUsd: (native.valueUsd || 0) + sum("native"),
      totalUsd: (native.valueUsd || 0) + positions.reduce((s, p) => s + (p.valueUsd || 0), 0),
    },
    meta: { tokenCount: mints.length, txCount: null, notes },
  };
  pfCache.set("pf:" + address, result, 60_000);
  return result;
}

export async function solPnl(address, portfolio) {
  const pf = portfolio || await solPortfolio(address);
  const notes = [];
  const memeMints = new Set(pf.positions.filter((p) => p.class === "meme").map((p) => p.id));
  const held = new Map(pf.positions.map((p) => [p.id, p]));

  const sigs = (await solRpc(HISTORY_RPC, "getSignaturesForAddress", [address, { limit: MAX_SIGS }]))
    .filter((s) => !s.err);
  let toParse = sigs.slice(0, MAX_PNL_TXS);
  if (sigs.length > MAX_PNL_TXS) notes.push(`Cost basis computed from the newest ${MAX_PNL_TXS} of ${sigs.length}+ transactions.`);

  const txs = await pool(toParse, (s) =>
    solRpc(HISTORY_RPC, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]),
  4);

  // per-tx wallet deltas -> average-cost accounting, oldest first
  const events = [];
  for (const tx of txs) {
    if (!tx?.meta) continue;
    const keys = tx.transaction?.message?.accountKeys || [];
    const idx = keys.findIndex((k) => k.pubkey === address);
    if (idx < 0) continue;
    const solDelta = ((tx.meta.postBalances?.[idx] ?? 0) - (tx.meta.preBalances?.[idx] ?? 0)) / 1e9;

    const tokDelta = new Map();
    const tally = (list, sign) => {
      for (const b of list || []) {
        if (b.owner !== address) continue;
        const amt = b.uiTokenAmount?.uiAmount ?? 0;
        tokDelta.set(b.mint, (tokDelta.get(b.mint) ?? 0) + sign * amt);
      }
    };
    tally(tx.meta.preTokenBalances, -1);
    tally(tx.meta.postTokenBalances, +1);
    events.push({ ts: tx.blockTime || 0, solDelta, tokDelta });
  }
  events.sort((a, b) => a.ts - b.ts);

  const acct = new Map();
  const getA = (m) => { if (!acct.has(m)) acct.set(m, { qty: 0, costUsd: 0, realizedUsd: 0, buys: 0, sells: 0, unknownIn: 0 }); return acct.get(m); };

  for (const ev of events) {
    const solDay = await priceOnDay("solana", ev.ts || Math.floor(Date.now() / 1000));
    let stableFlow = 0, wsolFlow = 0;
    for (const [m, d] of ev.tokDelta) {
      if (STABLES.has(m)) stableFlow += d;
      if (m === WSOL) wsolFlow += d;
    }
    const solFlow = ev.solDelta + wsolFlow;
    const spentUsd = Math.max(0, -stableFlow) + Math.max(0, -solFlow) * (solDay || 0);
    const receivedUsd = Math.max(0, stableFlow) + Math.max(0, solFlow) * (solDay || 0);

    const memeDeltas = [...ev.tokDelta].filter(([m]) => memeMints.has(m) || (!STABLES.has(m) && m !== WSOL));
    const buys = memeDeltas.filter(([, d]) => d > 1e-9);
    const sells = memeDeltas.filter(([, d]) => d < -1e-9);

    if (buys.length) {
      const per = spentUsd / buys.length;
      for (const [m, d] of buys) {
        const a = getA(m);
        if (spentUsd > 0.000001) { a.qty += d; a.costUsd += per; a.buys++; }
        else { a.qty += d; a.unknownIn += d; }
      }
    }
    if (sells.length) {
      const per = receivedUsd / sells.length;
      const isTransfer = receivedUsd < 0.000001; // outbound transfer, not a sale: no realized impact
      for (const [m, d] of sells) {
        const a = getA(m);
        const amt = -d;
        const avg = a.qty > 0 ? a.costUsd / a.qty : 0;
        const costOut = avg * Math.min(amt, a.qty);
        if (!isTransfer) { a.realizedUsd += per - costOut; a.sells++; }
        a.costUsd = Math.max(0, a.costUsd - costOut);
        a.qty = Math.max(0, a.qty - amt);
      }
    }
  }

  const positions = [];
  for (const [m, a] of acct) {
    const live = held.get(m);
    const price = live?.priceUsd ?? null;
    const qty = live?.amount ?? 0;
    // basis only covers the quantity we actually saw acquired with a visible spend;
    // holdings from before the parse window or from transfers get no basis claim
    let basis = a.costUsd > 0 ? "full" : "none";
    if (a.unknownIn > 0 || qty > a.qty * 1.02 + 1e-9) basis = a.costUsd > 0 ? "partial" : "none";
    const portion = Math.min(qty, a.qty);
    const unrealizedUsd = price !== null && basis !== "none" && a.qty > 0
      ? portion * price - a.costUsd * (portion / a.qty)
      : null;
    positions.push({
      id: m, symbol: live?.symbol || m.slice(0, 6),
      qty, valueUsd: price !== null ? qty * price : null,
      costUsd: a.costUsd, avgCostUsd: a.qty > 0 ? a.costUsd / a.qty : null,
      realizedUsd: a.realizedUsd, unrealizedUsd,
      basis, buys: a.buys, sells: a.sells,
    });
  }
  positions.sort((x, y) => (y.valueUsd ?? -1) - (x.valueUsd ?? -1));

  return {
    chain: "solana", address, positions,
    totals: {
      costUsd: positions.reduce((s, p) => s + p.costUsd, 0),
      valueUsd: positions.reduce((s, p) => s + (p.valueUsd || 0), 0),
      realizedUsd: positions.reduce((s, p) => s + p.realizedUsd, 0),
      unrealizedUsd: positions.reduce((s, p) => s + (p.unrealizedUsd || 0), 0),
    },
    meta: { txsParsed: events.length, txsTotal: sigs.length, notes },
  };
}
