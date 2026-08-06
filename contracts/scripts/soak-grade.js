// soak-grade.js — one-shot HISTORICAL grade of the keeper soak (read-only).
// keeper-soak-watch.js counts from "now" forward (for a live run); this counts sweeps that
// already happened. Reports SweepExecuted / SweepFailed over a recent window, the paymaster
// deposit remaining, and the bundler executor's gas.
//   Run: npx hardhat run scripts/soak-grade.js --network robinhood-testnet
//   Env: LOOKBACK_BLOCKS (default 25000), BUNDLER_EOA (executor that sends handleOps)

const { ethers } = require("hardhat");
const A = require("../../deployed-addresses.json");
const LOOKBACK = parseInt(process.env.LOOKBACK_BLOCKS || "25000");
const BUNDLER_EOA = process.env.BUNDLER_EOA || "0xCF08bE27F54B9f526fbc9eF91214FcA50a1Dce81";

async function main() {
  const provider = ethers.provider;
  const executor = await ethers.getContractAt("SweepExecutor", A.executor);
  const pm = await ethers.getContractAt("SweepPaymaster", A.paymaster);
  const cur = await provider.getBlockNumber();
  const from = Math.max(0, cur - LOOKBACK);

  // chunked queryFilter to dodge RPC range caps
  const step = 2000;
  const ex = [], fl = [];
  for (let b = from; b <= cur; b += step + 1) {
    const to = Math.min(b + step, cur);
    ex.push(...await executor.queryFilter(executor.filters.SweepExecuted(), b, to));
    fl.push(...await executor.queryFilter(executor.filters.SweepFailed(), b, to));
  }

  console.log(`\nSoak grade — blocks ${from}..${cur} (executor ${A.executor})\n`);
  const ts = [];
  for (const e of ex) {
    ts.push(Number(e.args.timestamp));
    console.log(`  ✓ blk ${e.blockNumber} · ${ethers.formatUnits(e.args.amountIn, 18)} meme -> ${ethers.formatUnits(e.args.amountOut, 6)} USDG`);
  }
  for (const f of fl) console.warn(`  ⚠ SweepFailed blk ${f.blockNumber} · reason: ${f.args.reason}`);

  ts.sort((a, b) => a - b);
  const gaps = ts.slice(1).map((t, i) => t - ts[i]);
  const dep = await pm.getDeposit();
  const bgas = await provider.getBalance(BUNDLER_EOA);

  console.log(`\n── result ──`);
  console.log(`  SweepExecuted (real sweeps): ${ex.length}`);
  console.log(`  SweepFailed (safety reverts): ${fl.length}`);
  if (gaps.length) console.log(`  gaps between sweeps (s): ${gaps.join(", ")}`);
  console.log(`  paymaster deposit now: ${ethers.formatEther(dep)} ETH (soak started 0.005)`);
  console.log(`  bundler executor gas:  ${ethers.formatEther(bgas)} ETH (${BUNDLER_EOA.slice(0, 10)}…)`);
  const pass = ex.length >= 3 && fl.length === 0;
  console.log(`\n${pass ? "✅" : "❌"} keeper autonomy: ${ex.length} unattended sweeps, ${fl.length} safety reverts.\n`);
}

main().catch((e) => { console.error("\n❌ grade failed:", e.message); process.exit(1); });
