// Shared helpers: HTTP, JSON-RPC (single + batch), retry, caching, hex/ABI decode.

export async function jfetch(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${url}`);
      err.status = res.status;
      err.body = body ?? text.slice(0, 200);
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function withRetry(fn, { tries = 4, baseMs = 400, retryOn = (e) => e.status === 429 || e.status >= 500 || !e.status } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i === tries - 1 || !retryOn(e)) throw e;
      await sleep(baseMs * 2 ** i + Math.random() * 200);
    }
  }
  throw last;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Run tasks with bounded concurrency; results aligned to input order, errors -> null.
export async function pool(items, worker, concurrency = 4) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await worker(items[i], i); } catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

// TTL cache with a hard size bound. Expiry is lazy (checked on read), so without the bound
// entries for never-re-queried keys would live forever; since callers key by user-supplied
// address, that is an unbounded slow leak. maxSize + FIFO eviction caps it. (audit S-4/P-7)
export class TTLCache {
  constructor(maxSize = 1000) { this.map = new Map(); this.maxSize = maxSize; }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.exp) { this.map.delete(key); return undefined; }
    return hit.val;
  }
  set(key, val, ttlMs) {
    if (this.map.size >= this.maxSize && !this.map.has(key)) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { val, exp: Date.now() + ttlMs });
  }
}

// ---- EVM JSON-RPC ----

export async function evmRpc(url, method, params) {
  const body = await withRetry(() => jfetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  if (body.error) { const e = new Error(`${method}: ${body.error.message}`); e.rpc = body.error; throw e; }
  return body.result;
}

// calls: [{method, params}] -> results aligned to input order; per-item errors -> {error}.
export async function evmRpcBatch(url, calls, batchSize = 25) {
  const out = new Array(calls.length);
  for (const group of chunk(calls.map((c, i) => ({ ...c, i })), batchSize)) {
    const payload = group.map((c, k) => ({ jsonrpc: "2.0", id: k, method: c.method, params: c.params }));
    const body = await withRetry(() => jfetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
    const byId = new Map((Array.isArray(body) ? body : []).map((r) => [r.id, r]));
    group.forEach((c, k) => {
      const r = byId.get(k);
      out[c.i] = r?.error ? { error: r.error } : { result: r?.result };
    });
  }
  return out;
}

// ---- Solana JSON-RPC ----

export async function solRpc(url, method, params) {
  const body = await withRetry(() => jfetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), { tries: 5, baseMs: 500, retryOn: (e) => e.status === 429 || e.status >= 500 || !e.status });
  if (body.error) { const e = new Error(`${method}: ${body.error.message}`); e.rpc = body.error; throw e; }
  return body.result;
}

// ---- hex / ABI helpers ----

export const strip0x = (h) => (h || "").replace(/^0x/, "");
export const topicAddress = (addr) => "0x" + strip0x(addr).toLowerCase().padStart(64, "0");
export const addrFromTopic = (topic) => "0x" + strip0x(topic).slice(24).toLowerCase();
export const hexToBigInt = (h) => (h && h !== "0x" ? BigInt(h) : 0n);

export function decodeUint(hex) {
  const d = strip0x(hex);
  if (!d) return null;
  try { return BigInt("0x" + d.slice(0, 64)); } catch { return null; }
}

export function decodeString(hex) {
  const d = strip0x(hex);
  if (!d) return null;
  const clean = (s) => s.replace(/[^\x20-\x7E]/g, "").trim() || null;
  try {
    if (d.length === 64) return clean(Buffer.from(d, "hex").toString("utf8")); // bytes32 style
    const off = Number(BigInt("0x" + d.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + d.slice(off, off + 64))) * 2;
    if (len > 512) return null;
    return clean(Buffer.from(d.slice(off + 64, off + 64 + len), "hex").toString("utf8"));
  } catch { return null; }
}

export function bigToFloat(v, decimals) {
  if (v === null || v === undefined) return null;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(decimals + 1, "0");
  const f = Number(`${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`);
  return neg ? -f : f;
}

export const dayKey = (msOrSec) => {
  const ms = msOrSec > 1e12 ? msOrSec : msOrSec * 1000;
  return new Date(ms).toISOString().slice(0, 10);
};

export const isEvmAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);
export const isSolAddress = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
