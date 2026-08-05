// reclaim-paymaster.js — pull a paymaster's EntryPoint deposit back to the deployer.
//
// Useful when testnet ETH is faucet-limited: the deposit funding sponsored UserOps is
// withdrawable (owner-gated) and can be recycled into a fresh deploy. Targets the paymaster
// in deployed-addresses.json by default; PAYMASTER=<addr> targets a specific (e.g. old) one.
//
//   Run: npx hardhat run scripts/reclaim-paymaster.js --network robinhood-testnet
//   Old paymaster: PAYMASTER=0x... npx hardhat run scripts/reclaim-paymaster.js --network robinhood-testnet

const { ethers } = require("hardhat");
const A = require("../../deployed-addresses.json");

async function main() {
  const [dep] = await ethers.getSigners();
  const target = process.env.PAYMASTER || A.paymaster;
  if (!/^0x[0-9a-fA-F]{40}$/.test(target || "")) throw new Error(`no paymaster address (set PAYMASTER or deployed-addresses.json)`);
  const pm = await ethers.getContractAt("SweepPaymaster", target);

  const owner = await pm.owner();
  if (owner.toLowerCase() !== dep.address.toLowerCase()) {
    throw new Error(`you (${dep.address}) are not the paymaster owner (${owner}) — can't withdraw`);
  }
  const bal = await pm.getDeposit();
  console.log(`\npaymaster ${target}\n  deposit: ${ethers.formatEther(bal)} ETH`);
  if (bal === 0n) { console.log("  nothing to reclaim.\n"); return; }

  const before = await ethers.provider.getBalance(dep.address);
  await (await pm.withdrawTo(dep.address, bal)).wait();
  const after = await ethers.provider.getBalance(dep.address);
  console.log(`  ✓ withdrew ${ethers.formatEther(bal)} ETH to the deployer`);
  console.log(`  deployer balance: ${ethers.formatEther(before)} -> ${ethers.formatEther(after)} ETH\n`);
}

main().catch((e) => { console.error("\n❌ reclaim failed:", e.message); process.exit(1); });
