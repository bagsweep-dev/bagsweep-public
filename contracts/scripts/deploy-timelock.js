// Deploys the BagSweep governance timelock and transfers ownership of the config
// contracts (SweepExecutor, and SweepBuyback if deployed) to it. Every privileged
// setter then requires schedule -> minDelay -> execute, so a compromised admin key
// cannot change protocol config silently or instantly.
//
// The SweepPolicyRegistry is intentionally NOT timelocked: its only owner power is
// the emergency pause, which must stay fast. Keep it on a guardian. See SECURITY.md.
//
//   npx hardhat run scripts/deploy-timelock.js --network robinhood-testnet
//
// Env (optional):
//   TIMELOCK_MIN_DELAY   seconds a queued op must wait (default 86400 = 24h)
//   TIMELOCK_PROPOSERS   comma-separated addresses (default: deployer)
//   TIMELOCK_EXECUTORS   comma-separated addresses (default: deployer; use the
//                        zero address to let anyone execute a matured operation)

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const outPath = path.join(__dirname, "..", "..", "deployed-addresses.json");
  const addresses = JSON.parse(fs.readFileSync(outPath, "utf8"));

  const minDelay = BigInt(process.env.TIMELOCK_MIN_DELAY || 86400);
  const proposers = (process.env.TIMELOCK_PROPOSERS || deployer.address).split(",").map((s) => s.trim());
  const executors = (process.env.TIMELOCK_EXECUTORS || deployer.address).split(",").map((s) => s.trim());
  const admin = deployer.address; // renounce after wiring — see NEXT STEPS below

  console.log("═══════════════════════════════════════");
  console.log("  BagSweep — TIMELOCK DEPLOYMENT");
  console.log("═══════════════════════════════════════");
  console.log("Deployer: ", deployer.address);
  console.log("Chain ID: ", chainId);
  console.log("minDelay: ", minDelay.toString(), "s");
  console.log("proposers:", proposers.join(", "));
  console.log("executors:", executors.join(", "), "\n");

  // ── 1. Deploy the timelock ──
  console.log("▸ Deploying BagSweepTimelock...");
  const Timelock = await ethers.getContractFactory("BagSweepTimelock");
  const timelock = await Timelock.deploy(minDelay, proposers, executors, admin);
  await timelock.waitForDeployment();
  const timelockAddr = await timelock.getAddress();
  console.log("  BagSweepTimelock:", timelockAddr, "\n");

  // ── 2. Transfer config contracts to the timelock (NOT the registry) ──
  const toGovern = [];
  if (addresses.executor) toGovern.push(["executor", addresses.executor, "SweepExecutor"]);
  if (addresses.buyback) toGovern.push(["buyback", addresses.buyback, "SweepBuyback"]);

  for (const [key, addr, cname] of toGovern) {
    const c = await ethers.getContractAt(cname, addr);
    const cur = await c.owner();
    if (cur.toLowerCase() === timelockAddr.toLowerCase()) {
      console.log(`  ${key} already owned by timelock`);
      continue;
    }
    const tx = await c.transferOwnership(timelockAddr);
    await tx.wait();
    console.log(`  ${key} (${addr}) ownership -> timelock`);
  }

  // ── 3. Persist ──
  addresses.timelock = timelockAddr;
  addresses.timelockMinDelay = minDelay.toString();
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
  console.log("\nWrote timelock to deployed-addresses.json");

  console.log("\nNEXT STEPS (do deliberately):");
  console.log("  1. Verify owner() == timelock on each governed contract.");
  console.log("  2. Renounce the timelock DEFAULT_ADMIN_ROLE from the deployer so the");
  console.log("     timelock self-administers (proposer/executor roles stay).");
  console.log("  3. Keep the SweepPolicyRegistry on a FAST guardian for the emergency");
  console.log("     pause — do NOT transfer it to this timelock.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
