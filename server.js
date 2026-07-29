// BagSweep, phase 1: read-only meme PnL tracker + sweep simulator.
// Chains: Robinhood Chain (4663) and Solana. No wallet connection, no signing, no custody.
// Run: node server.js   (PORT env to override, default 3010)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEvmAddress, isSolAddress, TTLCache } from "./lib/util.js";
import { rhPortfolio, rhPnl } from "./lib/rh.js";
import { solPortfolio, solPnl } from "./lib/sol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3010);
const DATA_DIR = path.join(__dirname, "data");
const SIGNALS = path.join(DATA_DIR, "signals.jsonl");
const PUBLIC = path.join(__dirname, "public");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const SEC_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

const pnlCache = new TTLCache();
const pfCache = new TTLCache();

// The app sits behind nginx on the VPS. Only honor X-Forwarded-For when explicitly told
// we're behind a trusted proxy (systemd sets TRUST_PROXY=1); otherwise a caller reaching
// the Node port directly could spoof the header and bypass the per-IP rate limits. (v2 audit M-2)
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

// /api/signals tally cache: tallySignals() re-reads and JSON.parses the whole append-only
// signals file per request, so cache the result briefly and invalidate on write to stop a
// read-amplification loop. (v2 audit M-3)
let signalsTallyCache = null; // { data, ts }
const SIGNALS_TALLY_TTL = 15_000;

// per-IP token buckets
const buckets = new Map();
function allow(key, limit, windowMs = 60_000) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n <= limit;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 5 * 60_000).unref();

const clientIp = (req) => {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "?";
};

// upstream sources are shared and free; bound concurrent heavy computations globally
let heavyInFlight = 0;
const MAX_HEAVY = 4;

function send(res, code, body, type = "application/json") {
  const payload = type.startsWith("application/json") ? JSON.stringify(body) : body;
  res.writeHead(code, { ...SEC_HEADERS, "content-type": type, "cache-control": "no-store" });
  res.end(payload);
}

function detectChain(address) {
  if (isEvmAddress(address)) return "robinhood";
  if (isSolAddress(address)) return "solana";
  return null;
}

// strip _internal before returning portfolios to the client
const publicView = ({ _internal, ...rest }) => rest;

async function handlePortfolio(address) {
  const chain = detectChain(address);
  if (!chain) return { code: 400, body: { error: "Not a valid Robinhood Chain (0x...) or Solana address." } };
  const key = `${chain}:${address}`;
  let pf = pfCache.get(key);
  if (!pf) {
    pf = chain === "robinhood" ? await rhPortfolio(address) : await solPortfolio(address);
    pfCache.set(key, pf, 60_000);
  }
  return { code: 200, body: publicView(pf) };
}

async function handlePnl(address) {
  const chain = detectChain(address);
  if (!chain) return { code: 400, body: { error: "Not a valid Robinhood Chain (0x...) or Solana address." } };
  const key = `${chain}:${address}`;
  let pnl = pnlCache.get(key);
  if (!pnl) {
    const pf = pfCache.get(key);
    pnl = chain === "robinhood" ? await rhPnl(address, pf) : await solPnl(address, pf);
    pnlCache.set(key, pnl, 5 * 60_000);
  }
  return { code: 200, body: pnl };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 64 * 1024) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function tallySignals() {
  const all = [];
  try {
    const content = await fs.promises.readFile(SIGNALS, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try { all.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
  } catch { /* no file yet */ }
  // one vote per wallet, latest answer wins; addressless records keep their own slot
  const byWallet = new Map();
  all.forEach((s, i) => byWallet.set(s.address ? `${s.chain}:${s.address}` : `anon:${i}`, s));
  let yes = 0, no = 0;
  for (const s of byWallet.values()) s.wouldAuthorize ? yes++ : no++;
  return { yes, no, uniqueWallets: byWallet.size, rawResponses: all.length, last10: all.slice(-10) };
}

async function tallySignalsCached() {
  if (signalsTallyCache && Date.now() - signalsTallyCache.ts < SIGNALS_TALLY_TTL) return signalsTallyCache.data;
  const data = await tallySignals();
  signalsTallyCache = { data, ts: Date.now() };
  return data;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const started = Date.now();
  try {
    if ((url.pathname === "/api/portfolio" || url.pathname === "/api/pnl") && req.method === "GET") {
      if (!allow(clientIp(req), 10)) return send(res, 429, { error: "Rate limit: 10 lookups per minute. Give it a moment." });
      if (heavyInFlight >= MAX_HEAVY) return send(res, 503, { error: "Busy right now, retry in a few seconds." });
      heavyInFlight++;
      try {
        const address = (url.searchParams.get("address") || "").trim();
        const { code, body } = url.pathname === "/api/portfolio" ? await handlePortfolio(address) : await handlePnl(address);
        return send(res, code, body);
      } finally {
        heavyInFlight--;
      }
    }
    if (url.pathname === "/api/signal" && req.method === "POST") {
      if (!allow(clientIp(req) + ":sig", 5)) return send(res, 429, { error: "Rate limit." });
      const raw = await readBody(req);
      let p;
      try { p = JSON.parse(raw); } catch { return send(res, 400, { error: "bad json" }); }
      if (typeof p.wouldAuthorize !== "boolean") return send(res, 400, { error: "wouldAuthorize (boolean) required" });
      const record = {
        ts: new Date().toISOString(),
        chain: typeof p.chain === "string" ? p.chain.slice(0, 20) : null,
        // M-4 (v2 audit): only keep a well-formed address so the "unique wallets" tally
        // excludes garbage/forged keys. (Still self-reported, not sybil-proof.)
        address: (typeof p.address === "string" && (isEvmAddress(p.address) || isSolAddress(p.address))) ? p.address : null,
        wouldAuthorize: p.wouldAuthorize,
        policy: p.policy && typeof p.policy === "object" ? {
          pct: Number(p.policy.pct) || null,
          minUsd: Number(p.policy.minUsd) || 0,
          mode: p.policy.mode === "profits" ? "profits" : "position",
          dest: typeof p.policy.dest === "string" ? p.policy.dest.slice(0, 30) : null,
        } : null,
        sweepTodayUsd: Number(p.sweepTodayUsd) || null,
        note: typeof p.note === "string" ? p.note.slice(0, 500) : null,
      };
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      await fs.promises.appendFile(SIGNALS, JSON.stringify(record) + "\n");
      signalsTallyCache = null; // invalidate the read cache on write (v2 audit M-3)
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/signals" && req.method === "GET") {
      if (!allow(clientIp(req) + ":sigr", 30)) return send(res, 429, { error: "Rate limit." });
      return send(res, 200, await tallySignalsCached());
    }

    // static
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "forbidden" });
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full);
      res.writeHead(200, { ...SEC_HEADERS, "content-type": MIME[ext] || "application/octet-stream", "cache-control": "public, max-age=300" });
      return res.end(fs.readFileSync(full));
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(`[err] ${url.pathname} ${e.message}`);
    return send(res, 502, { error: "Upstream data source failed. Try again shortly.", detail: String(e.message).slice(0, 200) });
  } finally {
    console.log(`${req.method} ${url.pathname} ${Date.now() - started}ms`);
  }
});

// Behind nginx (TRUST_PROXY=1) bind loopback so the Node port is never directly reachable;
// in local dev bind all interfaces. (v2 audit M-2)
const HOST = TRUST_PROXY ? "127.0.0.1" : undefined;
server.listen(PORT, HOST, () => console.log(`BagSweep phase 1 listening on http://${HOST || "localhost"}:${PORT}`));
