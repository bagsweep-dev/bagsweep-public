const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const isTestnet = chainId === 46630;

  console.log("═══════════════════════════════════════");
  console.log(isTestnet ? "  BagSweep — TESTNET DEPLOYMENT" : "  BagSweep — MAINNET DEPLOYMENT");
  console.log("═══════════════════════════════════════");
  console.log("Deployer:", deployer.address);
  console.log("Chain ID:", chainId);
  console.log("Balance: ", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  const addresses = {
    chainId: chainId.toString(),
    network: isTestnet ? "robinhood-testnet" : "robinhood",
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };

  // ── 1. USDG ──
  let usdgAddr;
  if (isTestnet && !process.env.USDG_ADDRESS) {
    console.log("▸ Deploying MockUSDG (testnet)...");
    const MockUSDG = await ethers.getContractFactory("MockUSDG");
    const mockUsdg = await MockUSDG.deploy();
    await mockUsdg.waitForDeployment();
    usdgAddr = await mockUsdg.getAddress();
    console.log("  MockUSDG:", usdgAddr);

    // Mint some test USDG to deployer
    const mintTx = await mockUsdg.mint(deployer.address, ethers.parseUnits("100000", 6));
    await mintTx.wait();
    console.log("  Minted 100,000 USDG to deployer");
  } else {
    usdgAddr = process.env.USDG_ADDRESS || "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
    console.log("▸ Using USDG at:", usdgAddr);
  }
  addresses.usdg = usdgAddr;

  // ── 2. Mock Meme Token (testnet only, for sweep testing) ──
  if (isTestnet) {
    console.log("\n▸ Deploying MockMemeToken ($DOGE)...");
    const MockMemeToken = await ethers.getContractFactory("MockMemeToken");
    const memeToken = await MockMemeToken.deploy("Doge Coin", "DOGE");
    await memeToken.waitForDeployment();
    const memeAddr = await memeToken.getAddress();
    console.log("  MockMemeToken ($DOGE):", memeAddr);

    // Mint test tokens
    const mintTx = await memeToken.mint(deployer.address, ethers.parseEther("1000000"));
    await mintTx.wait();
    console.log("  Minted 1,000,000 $DOGE to deployer");
    addresses.mockMemeToken = memeAddr;
  }

  // ── 3. EntryPoint v0.8 ──
  const ENTRY_POINT_CANONICAL = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
  let entryPointAddr = process.env.ENTRY_POINT || ENTRY_POINT_CANONICAL;
  let epCode = await ethers.provider.getCode(entryPointAddr);

  if (epCode === "0x") {
    console.log("\n▸ EntryPoint v0.8 not found at canonical address");
    console.log("  Deploying EntryPoint from etherscan reference bytecode...");

    // Deploy EntryPoint v0.8 using the canonical creation code
    // This is the reference implementation from eth-infinitism
    try {
      const EntryPoint = await ethers.getContractFactory("EntryPoint");
      const entryPoint = await EntryPoint.deploy();
      await entryPoint.waitForDeployment();
      entryPointAddr = await entryPoint.getAddress();
      console.log("  EntryPoint deployed at:", entryPointAddr);
    } catch (e) {
      console.log("  ⚠ EntryPoint contract not in project artifacts.");
      console.log("  The Paymaster will be skipped — deploy EntryPoint manually.");
      entryPointAddr = null;
    }
  } else {
    console.log("\n▸ EntryPoint v0.8 found at:", entryPointAddr);
  }
  addresses.entryPoint = entryPointAddr;

  // ── 4. SweepPolicyRegistry ──
  console.log("\n▸ Deploying SweepPolicyRegistry...");
  const Registry = await ethers.getContractFactory("SweepPolicyRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  addresses.registry = await registry.getAddress();
  console.log("  SweepPolicyRegistry:", addresses.registry);

  // ── 5. SweepExecutor ──
  console.log("\n▸ Deploying SweepExecutor...");
  const Executor = await ethers.getContractFactory("SweepExecutor");
  const executor = await Executor.deploy(usdgAddr, addresses.registry, deployer.address);
  await executor.waitForDeployment();
  addresses.executor = await executor.getAddress();
  console.log("  SweepExecutor:", addresses.executor);

  // ── 5b. Sanction venues (required before any sweep will execute) ──
  // executeSweep reverts RouterNotSanctioned / StockNotSanctioned by design
  // until the owner allowlists a real DEX router (and, for STOCKS, a stock token).
  if (process.env.SWEEP_ROUTER) {
    await (await executor.setSanctionedRouter(process.env.SWEEP_ROUTER, true)).wait();
    console.log("  Sanctioned meme→USDG router:", process.env.SWEEP_ROUTER);
  }
  if (process.env.STOCK_ROUTER) {
    await (await executor.setStockRouter(process.env.STOCK_ROUTER)).wait();
    console.log("  USDG→stock router:", process.env.STOCK_ROUTER);
  }
  if (process.env.SANCTIONED_STOCK) {
    await (await executor.setSanctionedStock(process.env.SANCTIONED_STOCK, true)).wait();
    console.log("  Sanctioned stock token:", process.env.SANCTIONED_STOCK);
  }
  if (!process.env.SWEEP_ROUTER) {
    console.log("  ⚠ No SWEEP_ROUTER sanctioned — sweeps will revert until the owner");
    console.log("    calls executor.setSanctionedRouter(<realDexRouter>, true).");
  }

  // ── 6. SmartAccountFactory ──
  // deployer != keeper: the deployer is the cold admin/owner; the keeper is the hot
  // automated signer whose private key (KEEPER_KEY) lives ONLY in the keeper service,
  // never in the deployer's .env. On mainnet the split is mandatory: collapsing them
  // recreates the single-EOA-owns-everything failure mode.
  const isMainnet = chainId === 4663;
  const KEEPER = process.env.KEEPER_ADDRESS || deployer.address;
  if (isMainnet) {
    if (!process.env.KEEPER_ADDRESS) {
      throw new Error("KEEPER_ADDRESS is required on mainnet: set the keeper's address, not the deployer's.");
    }
    if (KEEPER.toLowerCase() === deployer.address.toLowerCase()) {
      throw new Error("KEEPER_ADDRESS must differ from the deployer on mainnet (deployer != keeper).");
    }
  } else if (KEEPER.toLowerCase() === deployer.address.toLowerCase()) {
    console.log("  ⚠ keeper == deployer (non-mainnet convenience; on mainnet these MUST differ).");
  }
  console.log("\n▸ Deploying SmartAccountFactory...");
  console.log("  Keeper address:", KEEPER);
  const Factory = await ethers.getContractFactory("SmartAccountFactory");
  const factory = await Factory.deploy(KEEPER);
  await factory.waitForDeployment();
  addresses.factory = await factory.getAddress();
  console.log("  SmartAccountFactory:", addresses.factory);
  addresses.keeper = KEEPER;

  // ── 7. SweepPaymaster ──
  if (entryPointAddr) {
    console.log("\n▸ Deploying SweepPaymaster (verifying)...");
    const Paymaster = await ethers.getContractFactory("SweepPaymaster");
    const paymaster = await Paymaster.deploy(entryPointAddr, deployer.address);
    await paymaster.waitForDeployment();
    addresses.paymaster = await paymaster.getAddress();
    console.log("  SweepPaymaster:", addresses.paymaster);

    // The paymaster sponsors ONLY UserOps signed by this sponsor signer. Its
    // private key lives in the sponsor backend (the keeper service), which decides
    // and rate-limits which ops to sponsor off-chain. Defaults to the keeper's
    // address; override with SPONSOR_SIGNER. Fail-closed if left at address(0).
    const sponsorSigner = process.env.SPONSOR_SIGNER || KEEPER;
    await (await paymaster.setSponsorSigner(sponsorSigner)).wait();
    addresses.sponsorSigner = sponsorSigner;
    console.log("  Sponsor signer set:", sponsorSigner);

    // Fund the paymaster with test ETH. Only sponsored UserOps draw on this deposit
    // (which needs a bundler), so a small amount is fine for a first deploy; top it
    // up later via paymaster.deposit(). Override with PAYMASTER_DEPOSIT (in ETH).
    const depositAmount = process.env.PAYMASTER_DEPOSIT
      ? ethers.parseEther(process.env.PAYMASTER_DEPOSIT)
      : (isTestnet ? ethers.parseEther("0.005") : ethers.parseEther("0.05"));
    const tx = await paymaster.deposit({ value: depositAmount });
    await tx.wait();
    console.log("  Paymaster funded:", ethers.formatEther(depositAmount), "ETH");
  } else {
    console.log("\n▸ Skipping SweepPaymaster (no EntryPoint available)");
  }

  // ── Summary ──
  console.log("\n═══════════════════════════════════════");
  console.log("  BagSweep Deployment Summary");
  console.log("═══════════════════════════════════════");
  console.log("  Network:    ", isTestnet ? "Testnet (46630)" : "Mainnet (4663)");
  console.log("  Registry:   ", addresses.registry);
  console.log("  Executor:   ", addresses.executor);
  console.log("  Factory:    ", addresses.factory);
  console.log("  Paymaster:  ", addresses.paymaster || "N/A");
  console.log("  EntryPoint: ", addresses.entryPoint || "N/A");
  console.log("  USDG:       ", addresses.usdg);
  console.log("  MemeToken:  ", addresses.mockMemeToken || "N/A (mainnet)");
  console.log("  Keeper:     ", addresses.keeper);
  console.log("═══════════════════════════════════════\n");

  // Write addresses to JSON file for the keeper and frontend
  const fs = require("fs");
  const path = require("path");
  const outPath = path.join(__dirname, "..", "..", "deployed-addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
  console.log("Addresses saved to:", outPath);

  // Verification commands for testnet
  if (isTestnet) {
    console.log("\n📋 Verify contracts on explorer:");
    console.log(`   npx hardhat verify --network robinhood-testnet ${addresses.registry} "${deployer.address}"`);
    console.log(`   npx hardhat verify --network robinhood-testnet ${addresses.executor} "${usdgAddr}" "${addresses.registry}" "${deployer.address}"`);
    console.log(`   npx hardhat verify --network robinhood-testnet ${addresses.factory} "${KEEPER}"`);
    if (addresses.paymaster) {
      console.log(`   npx hardhat verify --network robinhood-testnet ${addresses.paymaster} "${entryPointAddr}" "${deployer.address}"`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
