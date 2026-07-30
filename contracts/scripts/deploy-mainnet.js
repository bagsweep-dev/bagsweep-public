/**
 * BagSweep: MAINNET deploy (Robinhood Chain, chainId 4663).
 *
 * Superset of scripts/deploy.js: deploys the core (registry, executor, factory, paymaster)
 * PLUS the SweepRouterV3Adapter, SweepBuyback, and BagSweepTimelock, then wires the routing,
 * the buyback ($REAP), and the fee sink. It deliberately does NOT:
 *   - flip feeBps on   (fees stay OFF until the runbook's canary passes)
 *   - hand config ownership to the timelock or move the pause to the guardian
 *     (both are staged, human-gated steps in MAINNET_RUNBOOK.md, after the canary)
 * so the deployer keeps fast control during bring-up. Run ONLY after a clean external audit.
 *
 *   npx hardhat run scripts/deploy-mainnet.js --network robinhood
 *
 * Required env: PRIVATE_KEY (deployer), KEEPER_ADDRESS (!= deployer), REAP_ADDRESS.
 * Optional env: USDG_ADDRESS, WETH_ADDRESS, SWAP_ROUTER02, ENTRY_POINT, GUARDIAN_ADDRESS,
 *   SPONSOR_SIGNER, PAYMASTER_DEPOSIT, TIMELOCK_MIN_DELAY, FEE_USDG_WETH, FEE_WETH_REAP.
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Canonical Robinhood Chain mainnet infrastructure.
const CANON = {
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // aeWETH
  swapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2",
  entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
};

const req = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
};
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 4663) {
    throw new Error(`MAINNET script: expected chainId 4663, got ${chainId}. Use scripts/deploy.js for testnet.`);
  }

  // ── preconditions (fail before spending gas) ──
  const keeper = req("KEEPER_ADDRESS");
  const reap = req("REAP_ADDRESS");
  const usdg = process.env.USDG_ADDRESS || CANON.usdg;
  const weth = process.env.WETH_ADDRESS || CANON.weth;
  const swapRouter02 = process.env.SWAP_ROUTER02 || CANON.swapRouter02;
  const entryPoint = process.env.ENTRY_POINT || CANON.entryPoint;
  const guardian = process.env.GUARDIAN_ADDRESS || deployer.address;
  const timelockDelay = Number(process.env.TIMELOCK_MIN_DELAY || 172800); // 48h
  const feeUsdgWeth = process.env.FEE_USDG_WETH ? Number(process.env.FEE_USDG_WETH) : null;
  const feeWethReap = process.env.FEE_WETH_REAP ? Number(process.env.FEE_WETH_REAP) : null;

  for (const [n, v] of [["KEEPER_ADDRESS", keeper], ["REAP_ADDRESS", reap], ["USDG", usdg], ["WETH", weth], ["SWAP_ROUTER02", swapRouter02]]) {
    if (!isAddr(v)) throw new Error(`${n} is not a valid address: ${v}`);
  }
  if (keeper.toLowerCase() === deployer.address.toLowerCase()) {
    throw new Error("KEEPER_ADDRESS must differ from the deployer (deployer != keeper is mandatory on mainnet).");
  }
  if ((await ethers.provider.getCode(reap)) === "0x") throw new Error(`REAP_ADDRESS has no code on mainnet: ${reap}`);
  if ((await ethers.provider.getCode(swapRouter02)) === "0x") throw new Error(`SWAP_ROUTER02 has no code on mainnet: ${swapRouter02}`);
  if (timelockDelay < 3600) throw new Error("TIMELOCK_MIN_DELAY must be >= 3600 (contract floor is 1h; 24-48h recommended).");

  console.log("═══════════════════════════════════════");
  console.log("  BagSweep: MAINNET DEPLOYMENT (4663)");
  console.log("═══════════════════════════════════════");
  console.log("Deployer: ", deployer.address);
  console.log("Keeper:   ", keeper, "(hot signer; key lives ONLY in the keeper service)");
  console.log("$REAP:    ", reap);
  console.log("Balance:  ", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  const A = {
    chainId: "4663", network: "robinhood", deployedAt: new Date().toISOString(),
    deployer: deployer.address, keeper, guardian, usdg, weth, entryPoint, sweepToken: reap,
  };
  const wait = async (tx) => (await tx).wait();

  // ── 1. SweepPolicyRegistry ──
  console.log("▸ SweepPolicyRegistry...");
  const registry = await (await ethers.getContractFactory("SweepPolicyRegistry")).deploy(deployer.address);
  await registry.waitForDeployment();
  A.registry = await registry.getAddress();
  console.log("  ", A.registry);

  // ── 2. SweepExecutor ──
  console.log("▸ SweepExecutor...");
  const executor = await (await ethers.getContractFactory("SweepExecutor")).deploy(usdg, A.registry, deployer.address);
  await executor.waitForDeployment();
  A.executor = await executor.getAddress();
  console.log("  ", A.executor);

  // ── 3. SmartAccountFactory (keeper is the hot signer, != deployer) ──
  console.log("▸ SmartAccountFactory...");
  const factory = await (await ethers.getContractFactory("SmartAccountFactory")).deploy(keeper);
  await factory.waitForDeployment();
  A.factory = await factory.getAddress();
  console.log("  ", A.factory);

  // ── 4. SweepPaymaster (verifying) ──
  if ((await ethers.provider.getCode(entryPoint)) !== "0x") {
    console.log("▸ SweepPaymaster...");
    const paymaster = await (await ethers.getContractFactory("SweepPaymaster")).deploy(entryPoint, deployer.address);
    await paymaster.waitForDeployment();
    A.paymaster = await paymaster.getAddress();
    const sponsorSigner = process.env.SPONSOR_SIGNER || keeper;
    await wait(paymaster.setSponsorSigner(sponsorSigner));
    A.sponsorSigner = sponsorSigner;
    // M-2 (audit v4): deposit gas ONLY. Do NOT call paymaster.addStake — we run our own bundler
    // (safe-mode off, single operator), so no stake is needed, and staked ETH would be
    // irrecoverable (the paymaster has no unlockStake/withdrawStake passthrough). Deposit is
    // withdrawable via withdrawTo; stake would not be.
    const deposit = ethers.parseEther(process.env.PAYMASTER_DEPOSIT || "0.05");
    await wait(paymaster.deposit({ value: deposit }));
    console.log("  ", A.paymaster, "| sponsor", sponsorSigner, "| funded", ethers.formatEther(deposit), "ETH");
  } else {
    console.log("⚠ EntryPoint not found at", entryPoint, "- skipping paymaster (deploy/point it manually).");
  }

  // ── 5. SweepRouterV3Adapter (V2 interface over Uniswap V3 SwapRouter02) ──
  console.log("▸ SweepRouterV3Adapter...");
  const adapter = await (await ethers.getContractFactory("SweepRouterV3Adapter")).deploy(swapRouter02, deployer.address);
  await adapter.waitForDeployment();
  A.sweepRouter = await adapter.getAddress();
  console.log("  ", A.sweepRouter);
  // Pool fee tiers for the buyback route USDG->WETH->$REAP. Must match the real pools;
  // determine them per the runbook (read pool.fee()). Per-meme sweep legs (meme/WETH) are
  // set operationally as memes are supported.
  if (feeUsdgWeth) { await wait(adapter.setPoolFee(usdg, weth, feeUsdgWeth)); console.log("   setPoolFee USDG/WETH", feeUsdgWeth); }
  if (feeWethReap) { await wait(adapter.setPoolFee(weth, reap, feeWethReap)); console.log("   setPoolFee WETH/$REAP", feeWethReap); }
  if (!feeUsdgWeth || !feeWethReap) {
    console.log("  ⚠ FEE_USDG_WETH / FEE_WETH_REAP not both set: buyback quotes will fail until");
    console.log("    adapter.setPoolFee is called for the USDG/WETH and WETH/$REAP pools.");
  }

  // ── 6. SweepBuyback (fee sink; enforced buy-and-burn of $REAP) ──
  console.log("▸ SweepBuyback...");
  const buyback = await (await ethers.getContractFactory("SweepBuyback")).deploy(usdg, deployer.address, keeper);
  await buyback.waitForDeployment();
  A.buyback = await buyback.getAddress();
  await wait(buyback.setSweepToken(reap));           // burn target = the live $REAP
  await wait(buyback.setSanctionedRouter(A.sweepRouter, true));
  console.log("  ", A.buyback, "| sweepToken=$REAP | router sanctioned");

  // ── 7. Wire the executor: sanction the adapter, route fees to the burn sink ──
  // The executor skims its capped fee into `treasury`; pointing treasury at SweepBuyback is
  // what makes the fee->buyback->burn flywheel real. feeBps stays 0 (OFF) until the canary.
  console.log("▸ Wiring executor...");
  await wait(executor.setSanctionedRouter(A.sweepRouter, true));
  await wait(executor.setTreasury(A.buyback));
  // M-3 (audit v4): enable the per-account on-chain sweep cooldown so a compromised keeper
  // cannot chain successive pct-of-balance sweeps. Owner-set now; moves under the timelock at
  // lockdown. Default 1h; override with SWEEP_COOLDOWN.
  const sweepCooldown = Number(process.env.SWEEP_COOLDOWN || 3600);
  await wait(executor.setMinSweepInterval(sweepCooldown));
  A.minSweepInterval = sweepCooldown;
  console.log(`   adapter sanctioned; treasury -> SweepBuyback; feeBps LEFT 0; minSweepInterval ${sweepCooldown}s`);
  if (process.env.YIELD_POOL) { await wait(executor.setYieldPool(process.env.YIELD_POOL)); console.log("   yieldPool", process.env.YIELD_POOL); }
  if (process.env.STOCK_ROUTER) { await wait(executor.setStockRouter(process.env.STOCK_ROUTER)); }
  if (process.env.SANCTIONED_STOCK) { await wait(executor.setSanctionedStock(process.env.SANCTIONED_STOCK, true)); }

  // ── 8. BagSweepTimelock (config governor; ownership handed over in the runbook) ──
  console.log("▸ BagSweepTimelock...");
  const timelock = await (await ethers.getContractFactory("BagSweepTimelock")).deploy(
    timelockDelay, [deployer.address], [ethers.ZeroAddress], deployer.address // proposer=deployer, anyone executes, admin=deployer (renounce in runbook)
  );
  await timelock.waitForDeployment();
  A.timelock = await timelock.getAddress();
  A.timelockMinDelay = timelockDelay;
  console.log("  ", A.timelock, `| minDelay ${timelockDelay}s`);

  // ── write mainnet addresses (separate file; testnet's deployed-addresses.json is left intact) ──
  const outPath = path.join(__dirname, "..", "..", "deployed-addresses.mainnet.json");
  fs.writeFileSync(outPath, JSON.stringify(A, null, 2));

  console.log("\n═══════════════════════════════════════");
  console.log("  Deployed (feeBps OFF, owner = deployer). Addresses:", outPath);
  console.log("═══════════════════════════════════════");
  for (const k of ["registry", "executor", "factory", "paymaster", "sweepRouter", "buyback", "timelock"]) {
    console.log(`  ${k.padEnd(11)} ${A[k] || "N/A"}`);
  }
  console.log("\n📋 NEXT (see MAINNET_RUNBOOK.md): set pool fees if unset -> deploy keeper (VPS) ->");
  console.log("   canary sweep + canary buyback -> executor.setFeeBps(<bps>) -> hand config ownership");
  console.log("   to the timelock and move the registry pause to the guardian.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
