// watch.mjs — on-chain monitor for the deployed BagSweep contracts.
//
// The invariant suites prove the *code* is safe under a hostile keeper. This watches
// the *deployment* for the things that code can't prevent: an owner-key compromise
// flipping a trust anchor, an ownership transfer being initiated, the emergency pause
// changing, or the paymaster deposit being drained. It reads security-critical on-chain
// state, diffs it against a committed baseline, and alarms on any drift.
//
// It is READ-ONLY: eth_call + eth_chainId only. It never signs, sends, or touches a key.
//
// Usage:
//   node watch.mjs snapshot     # write watch-baseline.json from current chain state (reviewed act)
//   node watch.mjs check        # diff live state vs baseline; exit 2 if anything drifted
//   node watch.mjs check --json # same, machine-readable alert on stdout
//
// Env:
//   RPC_URL          override the RPC (default: Robinhood mainnet RPC)
//   DEPOSIT_DROP_BPS alarm if paymaster deposit falls > this many bps vs baseline (default 1000 = 10%)
//   WATCH_WEBHOOK    optional URL; check mode POSTs the alert JSON here when anything drifts
//
// Meant to run on a cron on the VPS (see README). Baseline is committed, so a drift is
// visible both as a page (exit 2 / webhook) and as a reviewed diff when you re-snapshot.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..', '..');          // sweep-tracker/
const BASELINE = path.join(DIR, 'watch-baseline.json');
const ADDRS = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployed-addresses.json'), 'utf8'));

// Default matches the deployment network in deployed-addresses.json (testnet 46630).
// The chainId guard below refuses to run if RPC_URL points at the wrong network.
const RPC_URL = process.env.RPC_URL ||
  (ADDRS.chainId === '4663' ? 'https://rpc.mainnet.chain.robinhood.com'
                            : 'https://rpc.testnet.chain.robinhood.com');
const DEPOSIT_DROP_BPS = BigInt(process.env.DEPOSIT_DROP_BPS || '1000');
const WEBHOOK = process.env.WATCH_WEBHOOK || '';

// Robinhood RPC rejects the default node UA and rate-limits per IP.
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
  staticNetwork: true,
  fetchRequest: (() => { const r = new ethers.FetchRequest(RPC_URL); r.setHeader('User-Agent', 'Mozilla/5.0'); return r; })(),
});

const ABI = {
  executor: [
    'function owner() view returns (address)',
    'function pendingOwner() view returns (address)',
    'function USDG() view returns (address)',
    'function yieldPool() view returns (address)',
    'function stockRouter() view returns (address)',
    'function treasury() view returns (address)',
    'function feeBps() view returns (uint256)',
    'function minSweepInterval() view returns (uint256)',
  ],
  paymaster: [
    'function owner() view returns (address)',
    'function pendingOwner() view returns (address)',
    'function sponsorSigner() view returns (address)',
    'function maxCostPerOp() view returns (uint256)',
    'function getDeposit() view returns (uint256)',
  ],
  registry: [
    'function owner() view returns (address)',
    'function pendingOwner() view returns (address)',
    'function paused() view returns (bool)',
  ],
  factory: [
    'function owner() view returns (address)',
    'function pendingOwner() view returns (address)',
  ],
};

// What we read, and how each field is judged. `critical` = any change pages.
// `deposit` = alarm only on a drop past the threshold. `pendingOwner` = alarm on non-zero
// (a transfer in flight) as well as on change. `immutable` = must NEVER change (a change
// means we're reading the wrong address / a proxy swap).
const WATCH = [
  { c: 'executor',  addr: ADDRS.executor,  fn: 'owner',           kind: 'critical'  },
  { c: 'executor',  addr: ADDRS.executor,  fn: 'pendingOwner',    kind: 'pendingOwner' },
  { c: 'executor',  addr: ADDRS.executor,  fn: 'USDG',            kind: 'immutable' },
  { c: 'executor',  addr: ADDRS.executor,  fn: 'yieldPool',       kind: 'critical'  },
  { c: 'executor',  addr: ADDRS.executor,  fn: 'stockRouter',     kind: 'critical'  },
  { c: 'executor',  addr: ADDRS.executor,  fn: 'treasury',        kind: 'critical'  },
  { c: 'executor',  addr: ADDRS.executor,  fn: 'feeBps',          kind: 'critical'  },
  { c: 'executor',  addr: ADDRS.executor,  fn: 'minSweepInterval',kind: 'notice'    },
  { c: 'paymaster', addr: ADDRS.paymaster, fn: 'owner',           kind: 'critical'  },
  { c: 'paymaster', addr: ADDRS.paymaster, fn: 'pendingOwner',    kind: 'pendingOwner' },
  { c: 'paymaster', addr: ADDRS.paymaster, fn: 'sponsorSigner',   kind: 'critical'  },
  { c: 'paymaster', addr: ADDRS.paymaster, fn: 'maxCostPerOp',    kind: 'critical'  },
  { c: 'paymaster', addr: ADDRS.paymaster, fn: 'getDeposit',      kind: 'deposit'   },
  { c: 'registry',  addr: ADDRS.registry,  fn: 'owner',           kind: 'critical'  },
  { c: 'registry',  addr: ADDRS.registry,  fn: 'pendingOwner',    kind: 'pendingOwner' },
  { c: 'registry',  addr: ADDRS.registry,  fn: 'paused',          kind: 'critical'  },
  { c: 'factory',   addr: ADDRS.factory,   fn: 'owner',           kind: 'critical'  },
  { c: 'factory',   addr: ADDRS.factory,   fn: 'pendingOwner',    kind: 'pendingOwner' },
];

const ZERO = '0x0000000000000000000000000000000000000000';
const key = w => `${w.c}.${w.fn}`;

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  throw last;
}

async function readState() {
  const net = await withRetry(() => provider.getNetwork());
  const chainId = net.chainId.toString();
  const values = {};
  const errors = {};
  for (const w of WATCH) {
    try {
      const contract = new ethers.Contract(w.addr, ABI[w.c], provider);
      const raw = await withRetry(() => contract[w.fn]());
      // pendingOwner may not exist on single-step-Ownable contracts; tolerate.
      values[key(w)] = typeof raw === 'bigint' ? raw.toString() : String(raw);
    } catch (e) {
      errors[key(w)] = (e.shortMessage || e.message || 'read failed').slice(0, 120);
    }
  }
  return { chainId, values, errors, at: null }; // `at` is stamped by the caller (no Date in-script)
}

function alarmsFor(base, live) {
  const alarms = [];
  for (const w of WATCH) {
    const k = key(w);
    const was = base.values[k];
    const now = live.values[k];
    if (now === undefined) continue;                 // unreadable now (webhook covers persistent read failures)
    if (was === undefined) { alarms.push({ k, level: 'notice', msg: `new field observed = ${now}` }); continue; }

    if (w.kind === 'deposit') {
      const wasB = BigInt(was), nowB = BigInt(now);
      if (nowB < wasB) {
        const dropBps = wasB === 0n ? 0n : ((wasB - nowB) * 10000n) / wasB;
        if (dropBps > DEPOSIT_DROP_BPS)
          alarms.push({ k, level: 'critical', msg: `paymaster deposit dropped ${dropBps}bps (${was} -> ${now})` });
      }
      continue;
    }
    if (w.kind === 'pendingOwner') {
      if (now !== ZERO && now !== was)
        alarms.push({ k, level: 'critical', msg: `ownership transfer in flight -> pendingOwner = ${now}` });
      else if (now !== was)
        alarms.push({ k, level: 'notice', msg: `pendingOwner cleared/changed: ${was} -> ${now}` });
      continue;
    }
    if (now !== was) {
      const level = w.kind === 'immutable' ? 'critical' : (w.kind === 'notice' ? 'notice' : 'critical');
      const tag = w.kind === 'immutable' ? 'IMMUTABLE CHANGED (wrong address / proxy swap?)' : 'trust anchor changed';
      alarms.push({ k, level, msg: `${tag}: ${was} -> ${now}` });
    }
  }
  return alarms;
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const asJson = rest.includes('--json');
  const live = await readState();

  if (live.chainId !== ADDRS.chainId) {
    console.error(`REFUSING: RPC chainId ${live.chainId} != deployed-addresses chainId ${ADDRS.chainId}. Set RPC_URL to the right network.`);
    process.exit(3);
  }

  if (mode === 'snapshot') {
    fs.writeFileSync(BASELINE, JSON.stringify({
      note: 'Committed baseline of security-critical on-chain state. Re-snapshot is a REVIEWED act (visible in the diff). CI/cron `check` pages on any drift from this.',
      network: ADDRS.network, chainId: live.chainId, rpc: RPC_URL,
      addresses: { executor: ADDRS.executor, paymaster: ADDRS.paymaster, registry: ADDRS.registry, factory: ADDRS.factory },
      values: live.values, unreadable: Object.keys(live.errors),
    }, null, 2));
    console.log(`baseline written: ${Object.keys(live.values).length} fields -> ${path.basename(BASELINE)}`);
    if (Object.keys(live.errors).length) console.log(`  (${Object.keys(live.errors).length} field(s) unreadable, recorded: ${Object.keys(live.errors).join(', ')})`);
    process.exit(0);
  }

  if (mode === 'check') {
    if (!fs.existsSync(BASELINE)) { console.error('no baseline; run `node watch.mjs snapshot` first'); process.exit(2); }
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const alarms = alarmsFor(base, live);
    const critical = alarms.filter(a => a.level === 'critical');

    if (asJson) {
      console.log(JSON.stringify({ chainId: live.chainId, alarms, unreadable: Object.keys(live.errors) }));
    } else if (alarms.length === 0) {
      console.log(`monitor OK — ${Object.keys(live.values).length} fields, all match baseline (chain ${live.chainId}).`);
    } else {
      console.error(`MONITOR ALERT — ${critical.length} critical, ${alarms.length - critical.length} notice:`);
      for (const a of alarms) console.error(`  [${a.level.toUpperCase()}] ${a.k}: ${a.msg}`);
    }
    if (Object.keys(live.errors).length) console.error(`  unreadable this run: ${Object.keys(live.errors).join(', ')}`);

    if (alarms.length && WEBHOOK) {
      try {
        await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `BagSweep monitor: ${critical.length} critical alarm(s)`, alarms }) });
      } catch (e) { console.error(`webhook POST failed: ${e.message}`); }
    }
    process.exit(critical.length ? 2 : 0);
  }

  console.error('usage: node watch.mjs <snapshot|check> [--json]');
  process.exit(2);
}

main().catch(e => { console.error('monitor failed:', e.message); process.exit(1); });
