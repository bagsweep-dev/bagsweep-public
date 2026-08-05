// keeper-soak-watch.js — G2 / §6 keeper-autonomy soak: WATCH / grade.
//
// Read-only. With the keeper running (after keeper-soak-prep.js), this polls the executor's
// SweepExecuted + SweepFailed events over a window and grades the soak against §6's exit
// criterion: several sweeps land, ZERO failed/safety reverts, and the paymaster deposit draws
// down (proving the sponsored path actually ran). PASS/FAIL at the end.
//
//   Run: npx hardhat run scripts/keeper-soak-watch.js --network robinhood-testnet
//   Env: SOAK_MINUTES (default 12), MIN_SWEEPS (default 3), POLL_SECS (default 15)

const { ethers } = require("hardhat");
const A = require("../../deployed-addresses.json");

const MINUTES = parseInt(process.env.SOAK_MINUTES || "12");
const MIN_SWEEPS = parseInt(process.env.MIN_SWEEPS || "3");
const POLL_SECS = parseInt(process.env.POLL_SECS || "15");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const provider = ethers.provider;
  const cid = Number((await provider.getNetwork()).chainId);
  if (cid !== 46630) throw new Error(`expected testnet 46630, got ${cid} (use --network robinhood-testnet)`);
  const executor = await ethers.getContractAt("SweepExecutor", A.executor);
  const pm = await ethers.getContractAt("SweepPaymaster", A.paymaster);

  const startBlock = await provider.getBlockNumber();
  const depositBefore = await pm.getDeposit();
  console.log(`\nKeeper soak WATCH — chain ${cid}, from block ${startBlock}`);
  console.log(`  window ${MINUTES}m · need >= ${MIN_SWEEPS} sweeps · 0 failures · paymaster deposit ${ethers.formatEther(depositBefore)} ETH\n`);

  const seen = new Set();
  const sweeps = [], fails = [];
  const deadline = Date.now() + MINUTES * 60_000;

  while (Date.now() < deadline) {
    const cur = await provider.getBlockNumber();
    const [ex, fl] = await Promise.all([
      executor.queryFilter(executor.filters.SweepExecuted(), startBlock, cur),
      executor.queryFilter(executor.filters.SweepFailed(), startBlock, cur),
    ]);
    for (const e of ex) {
      const k = e.transactionHash + ":" + e.index; if (seen.has(k)) continue; seen.add(k);
      sweeps.push(e);
      console.log(`  ✓ SWEEP blk ${e.blockNumber} · ${e.args.account.slice(0, 10)}… · ${ethers.formatUnits(e.args.amountIn, 18)} meme -> ${ethers.formatUnits(e.args.amountOut, 6)} USDG`);
    }
    for (const f of fl) {
      const k = "F:" + f.transactionHash + ":" + f.index; if (seen.has(k)) continue; seen.add(k);
      fails.push(f);
      console.warn(`  ⚠ SWEEP FAILED blk ${f.blockNumber} · ${f.args.account.slice(0, 10)}… · reason: ${f.args.reason}`);
    }
    if (sweeps.length >= MIN_SWEEPS && fails.length === 0) break; // early success
    if (fails.length > 0) break;                                  // fail fast on any safety revert
    await sleep(POLL_SECS * 1000);
  }

  // Cadence: consecutive sweeps should be >= the on-chain cooldown apart.
  const cd = Number(await executor.minSweepInterval());
  const ts = sweeps.map((e) => Number(e.args.timestamp)).sort((a, b) => a - b);
  let cadenceOk = true;
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] < cd) cadenceOk = false;
  const depositAfter = await pm.getDeposit();
  const drew = depositBefore - depositAfter;

  console.log(`\n── soak result ──`);
  console.log(`  sweeps landed:      ${sweeps.length} (need >= ${MIN_SWEEPS})`);
  console.log(`  failed/reverted:    ${fails.length} (need 0)`);
  console.log(`  cadence >= ${cd}s cooldown: ${ts.length < 2 ? "n/a" : cadenceOk ? "yes" : "NO"}`);
  console.log(`  paymaster drawdown: ${ethers.formatEther(drew)} ETH (proves sponsored path ran)`);

  const pass = sweeps.length >= MIN_SWEEPS && fails.length === 0 && cadenceOk && drew > 0n;
  if (pass) {
    console.log(`\n✅ SOAK PASSED — ${sweeps.length} unattended sweeps, 0 safety reverts, cooldown respected, sponsored.\n`);
  } else {
    console.log(`\n❌ SOAK NOT YET PASSED — ${fails.length ? "a sweep FAILED (investigate the reason above)" : "not enough sweeps in the window (is the keeper + bundler running? deposit funded? rate priced?)"}.\n`);
    process.exit(1);
  }
}

main().catch((e) => { console.error("\n❌ WATCH FAILED:", e.message, "\n", e.stack || ""); process.exit(1); });
