// wire-testnet.js — post-deploy wiring deploy.js leaves manual: deploy a meme->USDG
// MockSwapRouter, fund it with USDG payout liquidity, sanction it on the executor, and
// write its address into deployed-addresses.json (sweepRouter). Run this once after a fresh
// deploy so the drill scripts + keeper soak have a routable, sanctioned venue.
//
//   Run: npx hardhat run scripts/wire-testnet.js --network robinhood-testnet
//   Env: FUND_USDG (default 50000) — USDG minted to the router for sweep payouts.

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const ADDR_PATH = path.join(__dirname, "..", "..", "deployed-addresses.json");
const A = require(ADDR_PATH);

const FUND_USDG = ethers.parseUnits(process.env.FUND_USDG || "50000", 6);
const ok = (c, m) => { if (!c) throw new Error("assertion failed: " + m); console.log("   ✓ " + m); };

async function main() {
  const [dep] = await ethers.getSigners();
  const cid = Number((await ethers.provider.getNetwork()).chainId);
  if (cid !== 46630) throw new Error(`expected testnet 46630, got ${cid} (use --network robinhood-testnet)`);
  console.log(`\nwire-testnet — executor ${A.executor} on chain ${cid}\n`);

  const executor = await ethers.getContractAt("SweepExecutor", A.executor);
  const usdg = await ethers.getContractAt("MockUSDG", A.usdg);
  ok((await executor.owner()).toLowerCase() === dep.address.toLowerCase(), "deployer owns the executor");

  // MockSwapRouter out = amountIn * num / den. meme(18dp) -> USDG(6dp) at 1:1 value => num=1, den=1e12.
  const router = await (await ethers.getContractFactory("MockSwapRouter")).deploy(1n, 10n ** 12n);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log(`  MockSwapRouter ${routerAddr} (meme->USDG 1:1)`);

  await (await usdg.mint(routerAddr, FUND_USDG)).wait();
  ok((await usdg.balanceOf(routerAddr)) >= FUND_USDG, `funded ${ethers.formatUnits(FUND_USDG, 6)} USDG payout liquidity`);

  await (await executor.setSanctionedRouter(routerAddr, true)).wait();
  ok(await executor.sanctionedRouter(routerAddr), "router sanctioned on the executor");

  A.sweepRouter = routerAddr;
  fs.writeFileSync(ADDR_PATH, JSON.stringify(A, null, 2) + "\n");
  console.log(`   ✓ sweepRouter written to ${ADDR_PATH}`);

  console.log("\n✅ WIRED — the drill scripts + keeper soak can now run against this deploy.");
  console.log("   (sanctionedRouters isn't a monitored field, so no need to re-baseline watch.mjs.)\n");
}

main().catch((e) => { console.error("\n❌ wire failed:", e.message); process.exit(1); });
