// Robinhood Chain (4663) adapter.
// Discovery + history: two full-range eth_getLogs (the public RPC allows genesis-to-latest
// address-topic queries). Balances/metadata: batch eth_call. Prices: DexScreener + Scallar.
// All reads are server-side (the RH RPC has a known intermittent CORS double-header bug).

import {
  evmRpc, evmRpcBatch, topicAddress, addrFromTopic, hexToBigInt,
  decodeUint, decodeString, bigToFloat, TTLCache, chunk,
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

async function walletLogs(address) {
  const key = address.toLowerCase();
  const hit = logsCache.get(key);
  if (hit) return hit;
  const t = topicAddress(address);
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
  const val = { logs: parsed, truncated };
  logsCache.set(key, val, 5 * 60_000);
  return val;
}

export async function rhPortfolio(address) {
  const wallet = address.toLowerCase();
  const notes = [];
  const { logs, truncated } = await walletLogs(wallet);
  if (truncated) notes.push(`History truncated to the newest ${MAX_LOGS} transfers.`);

  const tokens = [...new Set(logs.map((l) => l.token))];
  const txCount = new Set(logs.map((l) => l.tx)).size;

  // balances + metadata + native balance in one batch
  const calls = [];
  for (const t of tokens) {
    calls.push({ method: "eth_call", params: [{ to: t, data: SEL.balanceOf + topicAddress(wallet).slice(2) }, "latest"] });
    calls.push({ method: "eth_call", params: [{ to: t, data: SEL.decimals }, "latest"] });
    calls.push({ method: "eth_call", params: [{ to: t, data: SEL.symbol }, "latest"] });
  }
  calls.push({ method: "eth_getBalance", params: [wallet, "latest"] });
  const res = await evmRpcBatch(RPC, calls, 30);
  const nativeWei = hexToBigInt(res[res.length - 1]?.result || "0x0");

  const [stocks, ds, natives] = await Promise.all([
    stockTokens(),
    dexPrices("robinhood", tokens),
    nativePrices(),
  ]);
  const ethPx = natives.ethereum;

  const positions = [];
  const tokenMeta = new Map(); // reused by PnL
  tokens.forEach((t, i) => {
    const bal = decodeUint(res[i * 3]?.result) ?? 0n;
    const decimals = Number(decodeUint(res[i * 3 + 1]?.result) ?? 18n);
    const stock = stocks.get(t);
    const pair = ds.get(t);
    const symbol = stock?.symbol || pair?.symbol || decodeString(res[i * 3 + 2]?.result) || t.slice(0, 8);
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
    const meta = { token: t, symbol, decimals, cls, priceUsd, amount };
    tokenMeta.set(t, meta);
    if (bal === 0n) return;
    positions.push({
      id: t, symbol, name: stock?.name || pair?.name || null, decimals,
      class: cls, amount, priceUsd, valueUsd: priceUsd !== null ? amount * priceUsd : null,
      priceSource, liquidityUsd: pair?.liquidityUsd ?? null, priceChange24h: pair?.priceChange24h ?? null,
    });
  });

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
    _internal: { logs, tokenMeta, nativeWei },
  };
}

export async function rhPnl(address, portfolio) {
  const wallet = address.toLowerCase();
  const pf = portfolio || await rhPortfolio(wallet);
  const { logs, tokenMeta } = pf._internal;
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

  // fetch tx.value + block timestamps in batches
  const txHashes = txs.map(([h]) => h);
  const blockNums = [...new Set(txs.map(([, e]) => e.block))];
  const txRes = await evmRpcBatch(RPC, txHashes.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })), 25);
  const blkRes = await evmRpcBatch(RPC, blockNums.map((b) => ({ method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] })), 25);
  const txInfo = new Map(txHashes.map((h, i) => [h, txRes[i]?.result || null]));
  const blockTs = new Map(blockNums.map((b, i) => [b, Number(hexToBigInt(blkRes[i]?.result?.timestamp || "0x0"))]));

  // average-cost accounting per meme token, oldest -> newest
  const acct = new Map(); // token -> {qty, costUsd, realizedUsd, buys, sells, unknownIn}
  const getA = (t) => { if (!acct.has(t)) acct.set(t, { qty: 0, costUsd: 0, realizedUsd: 0, buys: 0, sells: 0, unknownIn: 0 }); return acct.get(t); };

  for (const [hash, e] of [...txs].reverse()) {
    const info = txInfo.get(hash);
    const ts = blockTs.get(e.block) || Math.floor(Date.now() / 1000);
    const ethDay = await priceOnDay("ethereum", ts);

    // counterflows within the same tx
    let stableFlow = 0, wethFlow = 0n;
    for (const [t, d] of e.deltas) {
      if (t === USDG) stableFlow += bigToFloat(d, 6);
      if (t === WETH) wethFlow += d;
    }
    const nativeSpent = info && info.from?.toLowerCase() === wallet ? bigToFloat(hexToBigInt(info.value || "0x0"), 18) : 0;
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
