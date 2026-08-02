// Price + classification sources: DexScreener (both chains), Coingecko (native, daily history),
// Scallar (Robinhood Chain stock-token registry).

import { jfetch, withRetry, chunk, TTLCache, dayKey } from "./util.js";

const cache = new TTLCache();

// DexScreener chainId -> GeckoTerminal network id, for the price fallback below.
// Only chains GeckoTerminal covers; RH shares the "robinhood" id on both.
const GECKOTERMINAL_NETWORK = { robinhood: "robinhood" };

// DexScreener batch: up to 30 addresses per call. Returns map lowercased-address -> best pair.
export async function dexPrices(chainId, addresses) {
  const out = new Map();
  const missing = [];
  for (const a of addresses) {
    const key = `ds:${chainId}:${a.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit !== undefined) out.set(a.toLowerCase(), hit);
    else missing.push(a);
  }
  for (const group of chunk(missing, 30)) {
    let pairs = [];
    try {
      pairs = await withRetry(() => jfetch(`https://api.dexscreener.com/tokens/v1/${chainId}/${group.join(",")}`));
      if (!Array.isArray(pairs)) pairs = [];
    } catch { pairs = []; }
    const best = new Map();
    for (const p of pairs) {
      const base = p.baseToken?.address?.toLowerCase();
      if (!base) continue;
      const liq = p.liquidity?.usd || 0;
      const prev = best.get(base);
      if (!prev || liq > prev.liquidityUsd) {
        best.set(base, {
          priceUsd: parseFloat(p.priceUsd) || null,
          liquidityUsd: liq,
          symbol: p.baseToken.symbol || null,
          name: p.baseToken.name || null,
          dex: p.dexId || null,
          pairUrl: p.url || null,
          priceChange24h: p.priceChange?.h24 ?? null,
        });
      }
    }
    for (const a of group) {
      const val = best.get(a.toLowerCase()) ?? null;
      cache.set(`ds:${chainId}:${a.toLowerCase()}`, val, 60_000);
      out.set(a.toLowerCase(), val);
    }
  }

  // Fallback: for a chain GeckoTerminal covers, backfill any token DexScreener could not
  // price (belt-and-suspenders for when DexScreener is flaky or a pool is only indexed on
  // GeckoTerminal). Best-effort, cached, and only fires for the gaps.
  const gtNet = GECKOTERMINAL_NETWORK[chainId];
  if (gtNet) {
    const gaps = addresses.filter((a) => {
      const v = out.get(a.toLowerCase());
      return !v || v.priceUsd == null;
    });
    if (gaps.length) {
      const gt = await geckoTerminalPrices(gtNet, gaps);
      for (const a of gaps) {
        const g = gt.get(a.toLowerCase());
        const val = g && g.priceUsd != null ? g : out.get(a.toLowerCase());
        cache.set(`ds:${chainId}:${a.toLowerCase()}`, val, 60_000);
        out.set(a.toLowerCase(), val);
      }
    }
  }
  return out;
}

// GeckoTerminal price fallback for a network DexScreener missed. Fills priceUsd for up to
// 30 addresses per call; the entry shape matches dexPrices so callers need no change.
async function geckoTerminalPrices(network, addresses) {
  const out = new Map();
  for (const group of chunk(addresses, 30)) {
    let data = [];
    try {
      const body = await withRetry(() =>
        jfetch(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/multi/${group.join(",")}`)
      );
      data = Array.isArray(body?.data) ? body.data : [];
    } catch { data = []; }
    for (const t of data) {
      const a = (t.attributes?.address || "").toLowerCase();
      if (!a) continue;
      out.set(a, {
        priceUsd: parseFloat(t.attributes?.price_usd) || null,
        liquidityUsd: 0,
        symbol: t.attributes?.symbol || null,
        name: t.attributes?.name || null,
        dex: "geckoterminal",
        pairUrl: null,
        priceChange24h: null,
      });
    }
  }
  return out;
}

// Current native prices (ETH, SOL) in USD.
export async function nativePrices() {
  const hit = cache.get("cg:simple");
  if (hit) return hit;
  try {
    const body = await withRetry(() => jfetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana&vs_currencies=usd"));
    const val = { ethereum: body.ethereum?.usd ?? null, solana: body.solana?.usd ?? null };
    cache.set("cg:simple", val, 60_000);
    return val;
  } catch {
    return { ethereum: null, solana: null };
  }
}

// Daily close history for a native asset: map "yyyy-mm-dd" -> USD price. One API call, cached 6h.
export async function nativeHistory(coingeckoId) {
  const key = `cg:hist:${coingeckoId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const body = await withRetry(() => jfetch(`https://api.coingecko.com/api/v3/coins/${coingeckoId}/market_chart?vs_currency=usd&days=365&interval=daily`));
    const map = new Map();
    for (const [ms, price] of body.prices || []) map.set(dayKey(ms), price);
    cache.set(key, map, 6 * 3600_000);
    return map;
  } catch {
    return new Map();
  }
}

export async function priceOnDay(coingeckoId, tsSec) {
  const hist = await nativeHistory(coingeckoId);
  const hit = hist.get(dayKey(tsSec));
  if (hit) return hit;
  const cur = await nativePrices();
  return coingeckoId === "ethereum" ? cur.ethereum : cur.solana;
}

// Scallar registry of RH stock tokens. Map lowercased-address -> {symbol, name, priceUsd, uiMultiplierFloat}.
export async function stockTokens() {
  const hit = cache.get("scallar:tokens");
  if (hit) return hit;
  try {
    const body = await withRetry(() => jfetch("https://api.scallar.finance/v1/tokens"));
    const list = Array.isArray(body?.tokens) ? body.tokens : Array.isArray(body) ? body : [];
    const map = new Map();
    for (const t of list) {
      if (!t.address) continue;
      map.set(t.address.toLowerCase(), {
        symbol: t.symbol ?? null,
        name: t.name ?? null,
        priceUsd: parseFloat(t.price ?? t.priceUsd ?? t.lastPrice) || null,
        uiMultiplierFloat: t.uiMultiplierFloat ?? 1,
      });
    }
    cache.set("scallar:tokens", map, 10 * 60_000);
    return map;
  } catch {
    return new Map(); // stock classification degrades gracefully
  }
}
