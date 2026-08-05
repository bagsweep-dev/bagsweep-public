// g3-verify.js — G3: verify the fresh testnet deploy actually dropped the deployer==keeper
// convenience and is wired correctly, then point at the re-baseline + freeze steps. READ-ONLY.
//
//   Run AFTER scripts/deploy.js (with KEEPER_ADDRESS != deployer):
//     npx hardhat run scripts/g3-verify.js --network robinhood-testnet

const { ethers } = require("hardhat");
const A = require("../../deployed-addresses.json");
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const ok = (c, m) => { if (!c) throw new Error("FAIL: " + m); console.log("   ✓ " + m); };
const warn = (c, m) => console.log((c ? "   ✓ " : "   ! ") + m);

async function main() {
  const cid = Number((await ethers.provider.getNetwork()).chainId);
  console.log(`\nG3 verify — deployment chain ${A.chainId} (live ${cid})`);
  console.log(`  deployer ${A.deployer}\n  keeper   ${A.keeper}\n`);

  // 1. the split: recorded + on-chain
  ok(isAddr(A.keeper) && A.keeper.toLowerCase() !== A.deployer.toLowerCase(), "recorded keeper != deployer");
  const factory = await ethers.getContractAt("SmartAccountFactory", A.factory);
  const executor = await ethers.getContractAt("SweepExecutor", A.executor);
  const registry = await ethers.getContractAt("SweepPolicyRegistry", A.registry);
  const dk = await factory.defaultKeeper();
  ok(dk.toLowerCase() === A.keeper.toLowerCase(), "on-chain factory.defaultKeeper == recorded keeper");
  ok(dk.toLowerCase() !== A.deployer.toLowerCase(), "on-chain keeper != deployer (the split took)");

  // 2. ownership: the cold deployer owns everything (pre-lockdown)
  ok((await executor.owner()).toLowerCase() === A.deployer.toLowerCase(), "executor owner == deployer");
  ok((await registry.owner()).toLowerCase() === A.deployer.toLowerCase(), "registry owner == deployer");
  ok((await factory.owner()).toLowerCase() === A.deployer.toLowerCase(), "factory owner == deployer");

  // 3. core wiring (some is manual post-deploy per the test plan, so warn rather than fail)
  ok((await executor.USDG()).toLowerCase() === A.usdg.toLowerCase(), "executor USDG wired");
  ok((await executor.minSweepInterval()) > 0n, "minSweepInterval set (> 0)");
  if (A.sweepRouter) warn(await executor.sanctionedRouters(A.sweepRouter), "sweepRouter sanctioned (else run setSanctionedRouter)");
  if (A.paymaster) {
    const pm = await ethers.getContractAt("SweepPaymaster", A.paymaster);
    warn((await pm.getDeposit()) > 0n, "paymaster deposit funded (else deposit before the keeper soak)");
  }

  console.log("\n✅ G3 VERIFIED — deployer != keeper on-chain, owners = the cold deployer.\n");
  console.log("Then, to freeze:");
  console.log("  1. Re-baseline the drift monitor (a reviewed act):  node audits/monitor/watch.mjs snapshot");
  console.log("  2. Re-run the suite against THIS deploy: testnet-fee-path / -exit-drill / -paymaster-check + the keeper soak.");
  console.log("  3. Record this commit SHA in AUDIT_SCOPE.md and tag it (plan §8).\n");
}

main().catch((e) => { console.error("\n❌ verify:", e.message); process.exit(1); });
