// Surgical testnet redeploy: redeploy ONLY the contracts a revision changed (SweepExecutor,
// SmartAccountFactory) and REUSE the unchanged ecosystem (registry, paymaster, USDG, DOGE, router,
// EntryPoint) from deployed-addresses.json. After this, regenerate the UI bytecode constant
// (node scripts/gen-ui-bytecode.js) so it matches the new factory's accountInitCodeHash.
//   npx hardhat run scripts/redeploy-testnet.js --network robinhood-testnet
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 46630) throw new Error(`expected testnet 46630, got ${chainId} (refusing to run off testnet)`);
  const [deployer] = await ethers.getSigners();
  const addrPath = path.join(__dirname, "..", "..", "deployed-addresses.json");
  const A = JSON.parse(fs.readFileSync(addrPath, "utf8"));
  console.log("deployer:", deployer.address, "| balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("reusing:  registry", A.registry, "| usdg", A.usdg, "| router", A.sweepRouter, "| paymaster", A.paymaster);
  const wait = async (tx) => (await tx).wait();

  // 1. new SweepExecutor (M-3), reusing the existing USDG + registry.
  console.log("\n▸ SweepExecutor...");
  const executor = await (await ethers.getContractFactory("SweepExecutor")).deploy(A.usdg, A.registry, deployer.address);
  await executor.waitForDeployment();
  const executorAddr = await executor.getAddress();
  await wait(executor.setSanctionedRouter(A.sweepRouter, true));
  const cooldown = Number(process.env.SWEEP_COOLDOWN || 60); // M-3 active on testnet (short, testable)
  await wait(executor.setMinSweepInterval(cooldown));
  console.log("  ", executorAddr, "| router sanctioned | minSweepInterval", cooldown + "s");

  // 2. new SmartAccountFactory (deploys the L-1 two-step SmartAccount).
  console.log("▸ SmartAccountFactory...");
  const factory = await (await ethers.getContractFactory("SmartAccountFactory")).deploy(A.keeper);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  const initHash = await factory.accountInitCodeHash();
  console.log("  ", factoryAddr, "| accountInitCodeHash", initHash);

  // 3. surgically update deployed-addresses.json (executor + factory only; the rest is reused).
  A.executor = executorAddr;
  A.factory = factoryAddr;
  A.minSweepInterval = cooldown;
  A.accountInitCodeHash = initHash;
  A.deployedAt = new Date().toISOString();
  A.revision = "v4/v5: M-3 cooldown + L-1/L-4 two-step ownership (executor+factory redeployed, rest reused)";
  fs.writeFileSync(addrPath, JSON.stringify(A, null, 2));
  console.log("\nupdated", addrPath);
  console.log("NEXT: node scripts/gen-ui-bytecode.js  +  point VITE_FACTORY/VITE_EXECUTOR at the new addresses");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
