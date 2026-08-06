// set-cooldown.js — testnet soak helper: retune the executor's per-account sweep cooldown.
//
// SweepExecutor is secure-by-default at minSweepInterval = 1h (M-3). The multi-sweep soak needs
// it short so ONE account can be swept several times in minutes (otherwise it's 1 sweep/hour and
// the soak takes 2h+). This is a TESTNET-ONLY acceleration.
//
// ⚠ MAINNET must keep the secure cooldown (the 1h default, or whatever the timelock sets). Do NOT
//    ship a 30s cooldown. After the soak, restore it: COOLDOWN=3600 ... (then re-baseline watch.mjs).
//
//   Run: COOLDOWN=30 npx hardhat run scripts/set-cooldown.js --network robinhood-testnet

const { ethers } = require("hardhat");
const A = require("../../deployed-addresses.json");

async function main() {
  const cid = Number((await ethers.provider.getNetwork()).chainId);
  if (cid !== 46630) throw new Error(`refusing: expected testnet 46630, got ${cid} (this is a testnet-only helper)`);
  const secs = BigInt(process.env.COOLDOWN || "30");
  const ex = await ethers.getContractAt("SweepExecutor", A.executor);
  const before = await ex.minSweepInterval();
  await (await ex.setMinSweepInterval(secs)).wait();
  const after = await ex.minSweepInterval();
  console.log(`minSweepInterval: ${before}s -> ${after}s (testnet soak; restore to 3600 before freeze)`);
}

main().catch((e) => { console.error("\n❌ set-cooldown failed:", e.message); process.exit(1); });
