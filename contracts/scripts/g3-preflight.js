// g3-preflight.js — G3: gate the "deployer != keeper" final testnet deploy BEFORE running it,
// so the deployer==keeper convenience can't sneak back into the frozen deployment.
//
// Refuses unless KEEPER_ADDRESS is set to a real address that differs from the deployer, and the
// deployer is funded. It does NOT generate or touch any key: mint the keeper key yourself with the
// printed one-liner (it runs in YOUR terminal; the private key never leaves your machine).
//
//   Run: npx hardhat run scripts/g3-preflight.js --network robinhood-testnet

const { ethers } = require("hardhat");
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");

async function main() {
  const [dep] = await ethers.getSigners();
  const cid = Number((await ethers.provider.getNetwork()).chainId);
  const keeper = process.env.KEEPER_ADDRESS || "";
  const bal = await ethers.provider.getBalance(dep.address);
  console.log(`\nG3 preflight — deployer ${dep.address} on chain ${cid}`);
  console.log(`  balance ${ethers.formatEther(bal)} ETH · KEEPER_ADDRESS=${keeper || "(unset)"}\n`);

  const problems = [];
  if (!isAddr(keeper)) problems.push("KEEPER_ADDRESS is not set to a valid address");
  else if (keeper.toLowerCase() === dep.address.toLowerCase()) problems.push("KEEPER_ADDRESS == deployer — that's the convenience G3 exists to drop");
  if (bal < ethers.parseEther("0.05")) problems.push(`deployer balance ${ethers.formatEther(bal)} ETH is thin for a full deploy + paymaster deposit (want ~0.05+)`);

  if (problems.length) {
    console.log("❌ NOT ready to deploy:");
    for (const p of problems) console.log("   - " + p);
    console.log("\nMint a FRESH keeper key (runs on YOUR machine; the key never leaves it):");
    console.log(`   node -e "const w=require('ethers').Wallet.createRandom();console.log('KEEPER_ADDRESS='+w.address+'\\nKEEPER_KEY='+w.privateKey)"`);
    console.log("Then: KEEPER_ADDRESS -> contracts/.env, KEEPER_KEY -> keeper/.env ONLY (never contracts/.env),");
    console.log("fund the deployer, and re-run this.\n");
    process.exit(1);
  }

  console.log("✅ READY — deployer != keeper, funded.");
  console.log("  Deploy:  npx hardhat run scripts/deploy.js --network robinhood-testnet");
  console.log("  Verify:  npx hardhat run scripts/g3-verify.js --network robinhood-testnet\n");
}

main().catch((e) => { console.error("\n❌ preflight error:", e.message); process.exit(1); });
