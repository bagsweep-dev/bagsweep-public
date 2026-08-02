// Robinhood Chain (4663) adapter.
// Discovery + history: two full-range eth_getLogs (the public RPC allows genesis-to-latest
// address-topic queries). Balances/metadata: batch eth_call. Prices: DexScreener + Scallar.
// All reads are server-side (the RH RPC has a known intermittent CORS double-header bug).

import {
  evmRpc, evmRpcBatch, topicAddress, addrFromTopic, hexToBigInt,
  decodeUint, decodeString, bigToFloat, TTLCache, chunk, jfetch, withRetry,
} from "./util.js";
import { dexPrices, nativePrices, priceOnDay, stockTokens } from "./prices.js";

const RPC = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"; // Paxos Global Dollar, 6 decimals
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"; // aeWETH
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const SEL = { balanceOf: "0x70a08231", decimals: "0x313ce567", symbol: "0x95d89b41", name: "0x06fdde03" };

const MAX_LOGS = 8000;      // newest-first truncation guard for hyperactive wallets
const MAX_PNL_TXS = 150;    // cost-basis transaction cap

const logsCache = new TTLCache();

// RH's public RPC hard-rate-limits the full-genesis eth_getLogs this needs (immediate 429 per
// IP, method-cost based), so transfer history comes from the Blockscout indexer, which is built
// for address history and is not throttled the same way. rpcLogs() stays as a fallback for
// environments where getLogs is permitted (and if the indexer is down).
const BLOCKSCOUT = process.env.RH_BLOCKSCOUT_URL || "https://robinhoodchain.blockscout.com";
const MAX_BS_PAGES = 4; // 50 transfers/page (~newest 200); bounds latency, aligns with MAX_PNL_TXS. Then truncate note.
const BS_RETRY = { tries: 4, baseMs: 400, retryOn: (e) => e.status === 429 || e.status >= 500 || !e.status };

// Newest-first ERC-20 transfer history from Blockscout v2, paginated to a bound. The transfer
// items also carry token metadata (decimals/symbol) and a per-transfer timestamp, so we harvest
// both here and hand them back — that lets the portfolio/PnL avoid the RPC's eth_call and
// getBlockByNumber entirely (see blockscoutBalances / rhPnl).
async function blockscoutLogs(wallet) {
  const parsed = [];
  const tokenInfo = new Map(); // token -> { decimals, symbol, name }
  const blockTime = new Map(); // block -> unix seconds
  let truncated = false;
  let params = null;
  for (let page = 0; page < MAX_BS_PAGES; page++) {
    const qs = new URLSearchParams({ type: "ERC-20", ...(params || {}) }).toString();
    const url = `${BLOCKSCOUT}/api/v2/addresses/${wallet}/token-transfers?${qs}`;
    const data = await withRetry(() => jfetch(url, {}, 20000), BS_RETRY);
    for (const it of data.items || []) {
      if ((it.token_type || it.token?.type) !== "ERC-20") continue; // skip ERC-721/1155
      const token = (it.token?.address_hash || it.token?.address || "").toLowerCase();
      if (!token) continue;
      parsed.push({
        token,
        from: (it.from?.hash || "").toLowerCase(),
        to: (it.to?.hash || "").toLowerCase(),
        value: BigInt(it.total?.value ?? "0"),
        block: Number(it.block_number),
        tx: it.transaction_hash,
      });
      if (!tokenInfo.has(token) && it.token) {
        tokenInfo.set(token, { decimals: Number(it.token.decimals ?? 18), symbol: it.token.symbol || null, name: it.token.name || null });
      }
      if (it.timestamp) blockTime.set(Number(it.block_number), Math.floor(Date.parse(it.timestamp) / 1000));
    }
    if (parsed.length >= MAX_LOGS) { truncated = true; break; }
    if (!data.next_page_params) break;
    if (page === MAX_BS_PAGES - 1) { truncated = true; break; }
    params = data.next_page_params;
  }
  return { logs: parsed.slice(0, MAX_LOGS), truncated, tokenInfo, blockTime };
}

// Current balances + token metadata + native, from the indexer. Blockscout 'value' is the raw
// on-chain balance (ERC-8056 UI multipliers are applied by the caller). Not rate-limited like
// the RPC's eth_call, so this is the primary balance source.
async function blockscoutBalances(wallet) {
  const [tb, ad] = await Promise.all([
    withRetry(() => jfetch(`${BLOCKSCOUT}/api/v2/addresses/${wallet}/token-balances`, {}, 20000), BS_RETRY),
    withRetry(() => jfetch(`${BLOCKSCOUT}/api/v2/addresses/${wallet}`, {}, 20000), BS_RETRY),
  ]);
  const balMap = new Map();  // token -> raw BigInt balance
  const metaMap = new Map(); // token -> { decimals, symbol, name }
  for (const it of Array.isArray(tb) ? tb : (tb.items || [])) {
    if (it.token?.type !== "ERC-20") continue;
    const token = (it.token.address_hash || it.token.address || "").toLowerCase();
    if (!token) continue;
    balMap.set(token, BigInt(it.value ?? "0"));
    metaMap.set(token, { decimals: Number(it.token.decimals ?? 18), symbol: it.token.symbol || null, name: it.token.name || null });
  }
  // Blockscout reports a null/absent coin_balance for receive-only, unindexed addresses
  // (nonce 0, funded but never sent a tx), which would hide a wallet holding only native
  // ETH. The RPC is authoritative for the native balance, so fall back to one cheap
  // eth_getBalance whenever the indexer shows zero.
  let nativeWei = BigInt(ad?.coin_balance ?? "0");
  if (nativeWei === 0n) {
    try {
      const r = await evmRpcBatch(RPC, [{ method: "eth_getBalance", params: [wallet, "latest"] }], 15);
      nativeWei = BigInt(r[0]?.result || "0x0");
    } catch { /* indexer said 0 and RPC is unavailable: keep 0 */ }
  }
  return { nativeWei, balMap, metaMap };
}

// Fallback balances via the RPC's eth_call (only where it isn't rate-limited).
async function rpcBalances(wallet, tokens) {
  const calls = [];
  for (const t of tokens) {
    calls.push({ method: "eth_call", params: [{ to: t, data: SEL.balanceOf + topicAddress(wallet).slice(2) }, "latest"] });
    calls.push({ method: "eth_call", params: [{ to: t, data: SEL.decimals }, "latest"] });
    calls.push({ method: "eth_call", params: [{ to: t, data: SEL.symbol }, "latest"] });
  }
  calls.push({ method: "eth_getBalance", params: [wallet, "latest"] });
  const res = await evmRpcBatch(RPC, calls, 30);
  const balMap = new Map(), metaMap = new Map();
  tokens.forEach((t, i) => {
    balMap.set(t, decodeUint(res[i * 3]?.result) ?? 0n);
    metaMap.set(t, { decimals: Number(decodeUint(res[i * 3 + 1]?.result) ?? 18n), symbol: decodeString(res[i * 3 + 2]?.result) || null, name: null });
  });
  return { nativeWei: hexToBigInt(res[res.length - 1]?.result || "0x0"), balMap, metaMap };
}

// Fallback: two full-genesis eth_getLogs over the RPC. Only works where getLogs isn't blocked.
async function rpcLogs(wallet) {
  const t = topicAddress(wallet);
  const [outRes, inRes] = await evmRpcBatch(RPC, [
    { method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest", topics: [TRANSFER, t] }] },
    { method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest", topics: [TRANSFER, null, t] }] },
  ], 2);
  if (outRes.error) throw new Error("getLogs(out): " + outRes.error.message);
  if (inRes.error) throw new Error("getLogs(in): " + inRes.error.message);
  // ERC-20 Transfer has exactly 3 topics; 4 topics = ERC-721, skip.
  let logs = [...outRes.result, ...inRes.result].filter((l) => l.topics?.length === 3);
  let truncated = false;
  if (logs.length > MAX_LOGS) {
    logs.sort((a, b) => Number(hexToBigInt(b.blockNumber) - hexToBigInt(a.blockNumber)));
    logs = logs.slice(0, MAX_LOGS);
    truncated = true;
  }
  const parsed = logs.map((l) => ({
    token: l.address.toLowerCase(),
    from: addrFromTopic(l.topics[1]),
    to: addrFromTopic(l.topics[2]),
    value: hexToBigInt(l.data),
    block: Number(hexToBigInt(l.blockNumber)),
    tx: l.transactionHash,
  }));
  return { logs: parsed, truncated, tokenInfo: new Map(), blockTime: new Map() };
}

async function walletLogs(address) {
  const key = address.toLowerCase();
  const hit = logsCache.get(key);
  if (hit) return hit;
  let val;
  try {
    val = await blockscoutLogs(key);
  } catch (e) {
    val = await rpcLogs(key); // indexer down -> try the RPC (may itself be rate-limited)
  }
  logsCache.set(key, val, 5 * 60_000);
  return val;
}

export async function rhPortfolio(address) {
  const wallet = address.toLowerCase();
  const notes = [];
  const { logs, truncated, tokenInfo, blockTime } = await walletLogs(wallet);
  if (truncated) notes.push(`History truncated to the newest ${logs.length} transfers.`);

  const txCount = new Set(logs.map((l) => l.tx)).size;

  // Current balances + metadata + native from the indexer (the RPC's eth_call is per-IP
  // rate-limited on this chain); fall back to eth_call only if the indexer is unavailable.
  let nativeWei, balMap, metaMap;
  try {
    ({ nativeWei, balMap, metaMap } = await blockscoutBalances(wallet));
  } catch (e) {
    ({ nativeWei, balMap, metaMap } = await rpcBalances(wallet, [...new Set(logs.map((l) => l.token))]));
  }

  // token universe = everything seen in history plus anything currently held
  const tokens = [...new Set([...logs.map((l) => l.token), ...balMap.keys()])];

  const [stocks, ds, natives] = await Promise.all([
    stockTokens(),
    dexPrices("robinhood", tokens),
    nativePrices(),
  ]);
  const ethPx = natives.ethereum;

  const positions = [];
  const tokenMeta = new Map(); // reused by PnL
  for (const t of tokens) {
    const bal = balMap.get(t) ?? 0n;
    const info = tokenInfo.get(t) || metaMap.get(t) || {};
    const decimals = Number(info.decimals ?? 18);
    const stock = stocks.get(t);
    const pair = ds.get(t);
    const symbol = stock?.symbol || pair?.symbol || info.symbol || t.slice(0, 8);
    let cls = "meme";
    if (t === USDG) cls = "stable";
    else if (t === WETH) cls = "native";
    else if (stock) cls = "stock";
    let priceUsd = null, priceSource = null;
    if (t === USDG) { priceUsd = 1; priceSource = "peg"; }
    else if (t === WETH) { priceUsd = ethPx; priceSource = "coingecko"; }
    else if (pair?.priceUsd) { priceUsd = pair.priceUsd; priceSource = "dexscreener"; }
    else if (stock?.priceUsd) { priceUsd = stock.priceUsd; priceSource = "scallar"; }
    // ERC-8056: display balance = raw * uiMultiplier (multiplier changes emit no Transfer event)
    const mult = cls === "stock" ? (stock?.uiMultiplierFloat ?? 1) : 1;
    const amount = bigToFloat(bal, decimals) * mult;
    tokenMeta.set(t, { token: t, symbol, decimals, cls, priceUsd, amount });
    if (bal === 0n) continue;
    positions.push({
      id: t, symbol, name: stock?.name || pair?.name || info.name || null, decimals,
      class: cls, amount, priceUsd, valueUsd: priceUsd !== null ? amount * priceUsd : null,
      priceSource, liquidityUsd: pair?.liquidityUsd ?? null, priceChange24h: pair?.priceChange24h ?? null,
    });
  }

  const nativeAmt = bigToFloat(nativeWei, 18);
  const native = { symbol: "ETH", amount: nativeAmt, priceUsd: ethPx, valueUsd: ethPx !== null ? nativeAmt * ethPx : null };

  positions.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const sum = (cls) => positions.filter((p) => p.class === cls && p.valueUsd).reduce((s, p) => s + p.valueUsd, 0);
  const unpriced = positions.filter((p) => p.valueUsd === null).length;
  if (unpriced) notes.push(`${unpriced} token(s) have no DEX price (bonding-curve phase or unlisted) and are excluded from totals.`);

  return {
    chain: "robinhood", address: wallet, native, positions,
    totals: {
      memeUsd: sum("meme"),
      stableUsd: sum("stable"),
      stockUsd: sum("stock"),
      majorUsd: sum("major"),
      nativeUsd: (native.valueUsd || 0) + sum("native"),
      totalUsd: (native.valueUsd || 0) + positions.reduce((s, p) => s + (p.valueUsd || 0), 0),
    },
    meta: { tokenCount: tokens.length, txCount, notes },
    _internal: { logs, tokenMeta, nativeWei, blockTime },
  };
}

export async function rhPnl(address, portfolio) {
  const wallet = address.toLowerCase();
  const pf = portfolio || await rhPortfolio(wallet);
  const { logs, tokenMeta, blockTime } = pf._internal;
  const notes = [];

  // group transfers by tx
  const byTx = new Map();
  for (const l of logs) {
    if (!byTx.has(l.tx)) byTx.set(l.tx, { block: l.block, deltas: new Map() });
    const e = byTx.get(l.tx);
    const signed = l.to === wallet ? l.value : -l.value;
    e.deltas.set(l.token, (e.deltas.get(l.token) ?? 0n) + signed);
  }

  // transactions that move a meme token, newest first, capped
  let txs = [...byTx.entries()]
    .filter(([, e]) => [...e.deltas.keys()].some((t) => tokenMeta.get(t)?.cls === "meme"))
    .sort((a, b) => b[1].block - a[1].block);
  const totalMemeTxs = txs.length;
  if (txs.length > MAX_PNL_TXS) { txs = txs.slice(0, MAX_PNL_TXS); notes.push(`Cost basis computed from the newest ${MAX_PNL_TXS} of ${totalMemeTxs} meme transactions.`); }

  // Block timestamps come from the indexer's transfer data (captured in walletLogs), so PnL
  // needs no RPC call. Native-coin (tx.value) spend is not fetched: on RH, meme buys route
  // through WETH/USDG (visible in the transfer flows below), so tx.value is ~always zero.
  const blockTs = blockTime || new Map();

  // average-cost accounting per meme token, oldest -> newest
  const acct = new Map(); // token -> {qty, costUsd, realizedUsd, buys, sells, unknownIn}
  const getA = (t) => { if (!acct.has(t)) acct.set(t, { qty: 0, costUsd: 0, realizedUsd: 0, buys: 0, sells: 0, unknownIn: 0 }); return acct.get(t); };

  for (const [, e] of [...txs].reverse()) {
    const ts = blockTs.get(e.block) || Math.floor(Date.now() / 1000);
    const ethDay = await priceOnDay("ethereum", ts);

    // counterflows within the same tx
    let stableFlow = 0, wethFlow = 0n;
    for (const [t, d] of e.deltas) {
      if (t === USDG) stableFlow += bigToFloat(d, 6);
      if (t === WETH) wethFlow += d;
    }
    const nativeSpent = 0; // native-coin buys aren't tracked (see note above); WETH/USDG flows cover cost
    const spentUsd = Math.max(0, -stableFlow) + Math.max(0, -bigToFloat(wethFlow, 18)) * (ethDay || 0) + nativeSpent * (ethDay || 0);
    const receivedUsd = Math.max(0, stableFlow) + Math.max(0, bigToFloat(wethFlow, 18)) * (ethDay || 0);

    const memeDeltas = [...e.deltas].filter(([t]) => tokenMeta.get(t)?.cls === "meme");
    const buys = memeDeltas.filter(([, d]) => d > 0n);
    const sells = memeDeltas.filter(([, d]) => d < 0n);

    // buys: split the tx's spend across bought tokens by current value share (single-buy txs dominate)
    if (buys.length) {
      const per = spentUsd / buys.length;
      for (const [t, d] of buys) {
        const m = tokenMeta.get(t);
        const amt = bigToFloat(d, m.decimals);
        const a = getA(t);
        if (spentUsd > 0) { a.qty += amt; a.costUsd += per; a.buys++; }
        else { a.qty += amt; a.unknownIn += amt; } // airdrop or plain transfer in: no basis
      }
    }
    // sells: realized = proceeds minus average cost of the sold quantity
    if (sells.length) {
      const per = receivedUsd / sells.length;
      const isTransfer = receivedUsd < 0.000001; // outbound transfer, not a sale: no realized impact
      for (const [t, d] of sells) {
        const m = tokenMeta.get(t);
        const amt = -bigToFloat(d, m.decimals);
        const a = getA(t);
        const avg = a.qty > 0 ? a.costUsd / a.qty : 0;
        const costOut = avg * Math.min(amt, a.qty);
        if (!isTransfer) { a.realizedUsd += per - costOut; a.sells++; }
        a.costUsd = Math.max(0, a.costUsd - costOut);
        a.qty = Math.max(0, a.qty - amt);
      }
    }
  }

  const positions = [];
  for (const [t, a] of acct) {
    const m = tokenMeta.get(t);
    const price = m.priceUsd;
    const held = m.amount; // live on-chain balance
    // basis only covers the quantity we actually saw acquired with a visible spend;
    // holdings from before the parse window or from transfers get no basis claim
    let basis = a.costUsd > 0 ? "full" : "none";
    if (a.unknownIn > 0 || held > a.qty * 1.02 + 1e-9) basis = a.costUsd > 0 ? "partial" : "none";
    const portion = Math.min(held, a.qty);
    const unrealizedUsd = price !== null && basis !== "none" && a.qty > 0
      ? portion * price - a.costUsd * (portion / a.qty)
      : null;
    positions.push({
      id: t, symbol: m.symbol,
      qty: held, valueUsd: price !== null ? held * price : null,
      costUsd: a.costUsd, avgCostUsd: a.qty > 0 ? a.costUsd / a.qty : null,
      realizedUsd: a.realizedUsd, unrealizedUsd,
      basis, buys: a.buys, sells: a.sells,
    });
  }
  positions.sort((x, y) => (y.valueUsd ?? -1) - (x.valueUsd ?? -1));
  notes.push("Sell proceeds paid out as native ETH by a router are not visible in transfer logs; realized PnL can undercount.");

  return {
    chain: "robinhood", address: wallet, positions,
    totals: {
      costUsd: positions.reduce((s, p) => s + p.costUsd, 0),
      valueUsd: positions.reduce((s, p) => s + (p.valueUsd || 0), 0),
      realizedUsd: positions.reduce((s, p) => s + p.realizedUsd, 0),
      unrealizedUsd: positions.reduce((s, p) => s + (p.unrealizedUsd || 0), 0),
    },
    meta: { txsParsed: txs.length, txsTotal: totalMemeTxs, notes },
  };
}
