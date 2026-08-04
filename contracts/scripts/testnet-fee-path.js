// testnet-fee-path.js — G1: exercise the fee -> buyback -> burn flywheel end-to-end on
// Robinhood Chain TESTNET (chain 46630). This is the one path the live testnet deployment
// has never run (feeBps has always been 0, no buyback deployed), and it is exactly what
// mainnet go-live turns on. If anything in the skim/route/burn wiring is wrong, it reverts
// here instead of on mainnet with real fees.
//
// It deploys a throwaway mock $SWEPT + a USDG->$SWEPT mock router + a fresh SweepBuyback,
// points the executor's fee sink at it, turns fees on (50 bps), runs ONE owner-driven sweep
// on the existing policied test account to skim a real 0.5% fee, then buys back + burns that
// fee to dEaD. Every step is asserted from chain. Fees are turned back OFF at the end.
//
//   Prereq: DEPLOYER_KEY (owner of TEST_ACCOUNT, funded on testnet) in contracts/.env
//   Run:    npx hardhat run scripts/testnet-fee-path.js --network robinhood-testnet
//
// Re-runnable: fresh mocks each run, single sweep (cooldown-safe if >60s since the account's
// last sweep). Optional env: TEST_ACCOUNT; SWEEP_MEME (whole meme tokens to sell, default = the
// policy pct cap on the current balance, always policy-valid).

const { ethers } = require("hardhat");
const A = require("../../deployed-addresses.json");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const USDG_YIELD = 0;
const TEST_ACCOUNT = process.env.TEST_ACCOUNT || "0x2b6664830d4b2fd977bf390ebcc3e5aede290c59";
const SWAP_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const ok = (c, m) => { if (!c) throw new Error("assertion failed: " + m); console.log("   ✓ " + m); };
const evt = (rc, iface, name) =>
  rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === name);

async function main() {
  const [dep] = await ethers.getSigners();
  const cid = Number((await ethers.provider.getNetwork()).chainId);
  if (cid !== 46630) throw new Error(`expected testnet 46630, got ${cid} (use --network robinhood-testnet)`);
  console.log(`\nBagSweep G1 fee-path canary — deployer/owner ${dep.address} on chain ${cid}\n`);

  const usdg = await ethers.getContractAt("IERC20", A.usdg);
  const meme = await ethers.getContractAt("IERC20", A.mockMemeToken);
  const executor = await ethers.getContractAt("SweepExecutor", A.executor);
  const account = await ethers.getContractAt("SmartAccount", TEST_ACCOUNT);
  const sweepRouter = await ethers.getContractAt("MockSwapRouter", A.sweepRouter);
  const registry = await ethers.getContractAt("SweepPolicyRegistry", A.registry);

  ok((await account.owner()).toLowerCase() === dep.address.toLowerCase(), "deployer owns TEST_ACCOUNT");
  ok((await executor.owner()).toLowerCase() === dep.address.toLowerCase(), "deployer owns the executor");

  // A single sweep may sell at most policy.pct of the current balance (audit N1). Default the
  // sweep to exactly that cap so it is always policy-valid; SWEEP_MEME can override (still capped).
  const pol = await registry.getPolicy(TEST_ACCOUNT);
  ok(pol.active, "account has an active policy");
  const memeBal = await meme.balanceOf(TEST_ACCOUNT);
  const cap = (memeBal * BigInt(pol.pct)) / 10000n;
  const SWEEP_MEME = process.env.SWEEP_MEME ? ethers.parseUnits(process.env.SWEEP_MEME, 18) : cap;
  ok(SWEEP_MEME > 0n && SWEEP_MEME <= cap,
    `sweep ${ethers.formatUnits(SWEEP_MEME, 18)} meme <= pct cap ${ethers.formatUnits(cap, 18)} (${Number(pol.pct) / 100}% of ${ethers.formatUnits(memeBal, 18)})`);

  // Expected meme->USDG output at the mock router's configured rate (out = in * num / den).
  const num = await sweepRouter.rateNum(), den = await sweepRouter.rateDen();
  const spotQuote = (SWEEP_MEME * num) / den;
  ok(spotQuote > 0n, `mock router quotes ${ethers.formatUnits(spotQuote, 6)} USDG for the sweep`);

  // 1. Mock $SWEPT + a USDG(6dp)->$SWEPT(18dp) router at 1:1 value (num=1e12, den=1), funded.
  console.log("1. deploy mocks");
  const swept = await (await ethers.getContractFactory("MockMemeToken")).deploy("Mock SWEPT", "SWEPT");
  await swept.waitForDeployment();
  const bbRouter = await (await ethers.getContractFactory("MockSwapRouter")).deploy(10n ** 12n, 1n);
  await bbRouter.waitForDeployment();
  await (await swept.mint(await bbRouter.getAddress(), ethers.parseUnits("1000000", 18))).wait();
  console.log(`   $SWEPT ${await swept.getAddress()} · bbRouter ${await bbRouter.getAddress()} (funded 1e6 SWEPT)`);

  // 2. SweepBuyback, wired to the mock $SWEPT + buyback router.
  console.log("2. deploy + wire SweepBuyback");
  const buyback = await (await ethers.getContractFactory("SweepBuyback")).deploy(A.usdg, dep.address, dep.address);
  await buyback.waitForDeployment();
  await (await buyback.setSweepToken(await swept.getAddress())).wait();
  await (await buyback.setSanctionedRouter(await bbRouter.getAddress(), true)).wait();
  // Open the rate-limit on this THROWAWAY buyback so the whole fee burns in one call.
  // Production keeps the default 20%/1h guard (SpendExceedsCap / Cooldown), unit-tested separately.
  await (await buyback.setMaxSpendBps(10000)).wait();
  await (await buyback.setCooldown(0)).wait();
  console.log(`   buyback ${await buyback.getAddress()} (maxSpendBps=100%, cooldown=0 for the test)`);

  // 3. Point the executor fee sink at the buyback and turn fees on (50 bps = 0.5%).
  console.log("3. executor.setTreasury(buyback) + setFeeBps(50)");
  await (await executor.setTreasury(await buyback.getAddress())).wait();
  await (await executor.setFeeBps(50)).wait();
  ok((await executor.feeBps()) === 50n, "feeBps = 50");
  ok((await executor.treasury()).toLowerCase() === (await buyback.getAddress()).toLowerCase(), "treasury = buyback");

  // 4. Owner-driven sweep: sell meme -> USDG, executor skims 0.5% to the buyback.
  console.log(`4. sweep ${ethers.formatUnits(SWEEP_MEME, 18)} meme -> USDG (ownerExecute), fee skims to buyback`);
  const slipBps = 1000n; // <= the account policy's maxSlippageBps
  const minOut = (spotQuote * (10000n - slipBps)) / 10000n;
  const dl = (await ethers.provider.getBlock("latest")).timestamp + 300;
  const memeSwapData = SWAP_IFACE.encodeFunctionData("swapExactTokensForTokens",
    [SWEEP_MEME, minOut, [A.mockMemeToken, A.usdg], A.executor, dl]);
  const swaps = [{ tokenIn: A.mockMemeToken, amountIn: SWEEP_MEME, spotQuote, router: A.sweepRouter, swapData: memeSwapData }];
  const execCall = executor.interface.encodeFunctionData("executeSweep", [swaps, USDG_YIELD, ethers.ZeroAddress, 0]);

  // The account authorizes the executor to pull the meme (owner grants via ownerExecute).
  const approveData = meme.interface.encodeFunctionData("approve", [A.executor, SWEEP_MEME]);
  await (await account.ownerExecute(A.mockMemeToken, 0, approveData)).wait();

  const bbUsdgBefore = await usdg.balanceOf(await buyback.getAddress());
  const rc = await (await account.ownerExecute(A.executor, 0, execCall)).wait();
  const swept_ev = evt(rc, executor.interface, "SweepExecuted");
  const fee_ev = evt(rc, executor.interface, "FeeCollected");
  ok(swept_ev, "SweepExecuted emitted");
  ok(fee_ev, "FeeCollected emitted");
  const proceeds = swept_ev.args.amountOut;   // gross USDG from the swap
  const usdgFee = fee_ev.args.usdgFee;
  console.log(`   proceeds ${ethers.formatUnits(proceeds, 6)} USDG · fee ${ethers.formatUnits(usdgFee, 6)} USDG (bps ${fee_ev.args.feeBps})`);
  ok(usdgFee === (proceeds * 50n) / 10000n, "fee == 0.5% of proceeds");
  ok((await usdg.balanceOf(await buyback.getAddress())) - bbUsdgBefore === usdgFee, "buyback received exactly the skimmed fee");

  // 5. Buy back + burn that fee: USDG -> $SWEPT -> dEaD.
  console.log("5. buyback.buybackAndBurn -> $SWEPT to dEaD");
  const bbSwapData = SWAP_IFACE.encodeFunctionData("swapExactTokensForTokens",
    [usdgFee, 1n, [A.usdg, await swept.getAddress()], await buyback.getAddress(), dl + 300]);
  const deadBefore = await swept.balanceOf(DEAD);
  const brc = await (await buyback.buybackAndBurn(usdgFee, 1n, await bbRouter.getAddress(), bbSwapData)).wait();
  const burn_ev = evt(brc, buyback.interface, "BuybackBurned");
  ok(burn_ev, "BuybackBurned emitted");
  const burned = (await swept.balanceOf(DEAD)) - deadBefore;
  ok(burned > 0n, "$SWEPT at dEaD increased");
  console.log(`   spent ${ethers.formatUnits(burn_ev.args.usdgSpent, 6)} USDG · burned ${ethers.formatUnits(burned, 18)} $SWEPT to dEaD`);

  // 6. Restore the deployment to how we found it (fees off, treasury cleared if allowed).
  console.log("6. restore feeBps=0");
  await (await executor.setFeeBps(0)).wait();
  ok((await executor.feeBps()) === 0n, "feeBps restored to 0");
  try { await (await executor.setTreasury(ethers.ZeroAddress)).wait(); console.log("   ✓ treasury restored to 0x0"); }
  catch { console.log("   ! treasury left at the throwaway buyback (inert with feeBps=0); re-snapshot watch.mjs if you monitor it"); }

  console.log("\n✅ G1 PASSED — 0.5% skim -> FeeCollected -> buyback -> burn -> BuybackBurned, all verified on-chain.\n");
}

main().catch((e) => { console.error("\n❌ G1 FAILED:", e.message, "\n", e.stack || ""); process.exit(1); });
