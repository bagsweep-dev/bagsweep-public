// keeper-soak-prep.js — G2 / §6 keeper-autonomy soak: PREP.
//
// Arms a fresh account for the keeper to sweep repeatedly, unattended, so the soak produces
// several real sweeps with no manual poking:
//   - tops the paymaster deposit up to a target (sponsored sweeps fail without it),
//   - deploys a fresh account, funds it generously with mock meme,
//   - funds the mock sweep router with USDG so it can pay out many sweeps,
//   - enables the keeper executor and sets a POSITION policy (mode 0 = sweep pct% of the
//     balance every cooldown, no cost basis needed -> fires round after round),
//   - prints the exact keeper/.env additions + start command.
//
//   Prereq: DEPLOYER_KEY (funded on testnet) in contracts/.env.
//   Run:    npx hardhat run scripts/keeper-soak-prep.js --network robinhood-testnet
//   Then:   start the Alto bundler (BUNDLER_RUNBOOK) + `cd keeper && node src/index.js`,
//           then grade with scripts/keeper-soak-watch.js.

const { ethers } = require("hardhat");
const A = require("../../deployed-addresses.json");

const PM_TARGET = ethers.parseEther(process.env.PM_TARGET || "0.1");   // paymaster deposit target
const FUND_MEME = ethers.parseUnits(process.env.FUND_MEME || "5000", 18);
const FUND_USDG = ethers.parseUnits(process.env.FUND_USDG || "20000", 6); // router payout liquidity
const ok = (c, m) => { if (!c) throw new Error("assertion failed: " + m); console.log("   ✓ " + m); };

async function main() {
  const [dep] = await ethers.getSigners();
  const cid = Number((await ethers.provider.getNetwork()).chainId);
  if (cid !== 46630) throw new Error(`expected testnet 46630, got ${cid} (use --network robinhood-testnet)`);
  console.log(`\nKeeper soak PREP — owner ${dep.address} on chain ${cid}\n`);

  const factory = await ethers.getContractAt("SmartAccountFactory", A.factory);
  const registry = await ethers.getContractAt("SweepPolicyRegistry", A.registry);
  const meme = await ethers.getContractAt("MockMemeToken", A.mockMemeToken);
  const usdg = await ethers.getContractAt("MockUSDG", A.usdg);
  const pm = await ethers.getContractAt("SweepPaymaster", A.paymaster);

  // 1. Paymaster deposit up to target (keeper UserOps are gas-sponsored from here).
  console.log("1. top up paymaster deposit");
  const have = await pm.getDeposit();
  if (have < PM_TARGET) { await (await pm.deposit({ value: PM_TARGET - have })).wait(); }
  ok((await pm.getDeposit()) >= PM_TARGET, `deposit >= ${ethers.formatEther(PM_TARGET)} ETH (was ${ethers.formatEther(have)})`);

  // 2. Fund the mock sweep router with USDG so it can pay out many sweeps.
  console.log("2. fund the sweep router with USDG payout liquidity");
  await (await usdg.mint(A.sweepRouter, FUND_USDG)).wait();
  ok((await usdg.balanceOf(A.sweepRouter)) >= FUND_USDG, `router holds >= ${ethers.formatUnits(FUND_USDG, 6)} USDG`);

  // 3. Fresh account + meme, keeper enabled, POSITION policy (sweeps pct% every cooldown).
  console.log("3. deploy + fund + arm a fresh account");
  const salt = BigInt(Date.now());
  const addr = await factory.createAccount.staticCall(dep.address, salt);
  await (await factory.createAccount(dep.address, salt)).wait();
  const account = await ethers.getContractAt("SmartAccount", addr);
  await (await meme.mint(addr, FUND_MEME)).wait();
  await (await account.setSweepExecutor(A.executor)).wait();
  // The account must let the executor pull the meme on each sweep (large allowance, once).
  const approve = meme.interface.encodeFunctionData("approve", [A.executor, ethers.MaxUint256]);
  await (await account.ownerExecute(A.mockMemeToken, 0, approve)).wait();
  const setPolicy = registry.interface.encodeFunctionData("setPolicy",
    [1000, 0, 0, 0, [A.mockMemeToken], 1000]); // pct 10% / minUsd 0 / mode 0 POSITION / USDG_YIELD / [meme] / 10% slip
  await (await account.ownerExecute(A.registry, 0, setPolicy)).wait();
  ok((await registry.getPolicy(addr)).active, `account ${addr} armed with an active POSITION policy`);
  console.log(`   funded ${ethers.formatUnits(FUND_MEME, 18)} meme; each sweep takes 10% of the remaining balance`);

  console.log("\n✅ PREP DONE. Add these to keeper/.env (the mock isn't on DexScreener, so price it):\n");
  console.log(`   SWEEP_ROUTER=${A.sweepRouter}`);
  console.log(`   PRICE_OVERRIDES={"${A.mockMemeToken.toLowerCase()}": 1}`);
  console.log(`   EVAL_INTERVAL_MS=30000   # evaluate every 30s (on-chain cooldown still gates at 60s)`);
  console.log(`   # KEEPER_KEY, ENTRY_POINT, BUNDLER_URL, USDG_ADDR + registry/executor/factory/paymaster`);
  console.log(`   # are read from contracts/.env + deployed-addresses.json.\n`);
  console.log("Then: start the Alto bundler (BUNDLER_RUNBOOK), `cd keeper && node src/index.js`,");
  console.log("and grade with:  npx hardhat run scripts/keeper-soak-watch.js --network robinhood-testnet\n");
}

main().catch((e) => { console.error("\n❌ PREP FAILED:", e.message, "\n", e.stack || ""); process.exit(1); });
