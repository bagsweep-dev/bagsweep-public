// testnet-exit-drill.js — G2 / N3: the always-exit guarantee.
//
// Proves the core BagSweep safety promise: the OWNER can always pull funds out of the smart
// account directly, with ZERO dependency on the keeper, bundler, paymaster, or EntryPoint —
// even while a policy is active and the keeper is enabled (the worst case: keeper compromised).
// ownerExecute is a plain owner-signed EOA transaction: account -> ERC20.transfer(owner, bal).
//
//   Prereq: DEPLOYER_KEY (funded on testnet) in contracts/.env. Nothing else needs to run.
//   Run:    npx hardhat run scripts/testnet-exit-drill.js --network robinhood-testnet
//
// To make the "infra offline" condition explicit, STOP the keeper service before running; the
// result is identical either way, which is the whole point. Uses a fresh throwaway account, so
// it never touches the main test account or its balances.

const { ethers } = require("hardhat");
const A = require("../../deployed-addresses.json");

const FUND_MEME = ethers.parseUnits(process.env.FUND_MEME || "500", 18);
const ok = (c, m) => { if (!c) throw new Error("assertion failed: " + m); console.log("   ✓ " + m); };

async function main() {
  const [dep] = await ethers.getSigners();
  const cid = Number((await ethers.provider.getNetwork()).chainId);
  if (cid !== 46630) throw new Error(`expected testnet 46630, got ${cid} (use --network robinhood-testnet)`);
  console.log(`\nBagSweep N3 always-exit drill — owner ${dep.address} on chain ${cid}\n`);

  const factory = await ethers.getContractAt("SmartAccountFactory", A.factory);
  const registry = await ethers.getContractAt("SweepPolicyRegistry", A.registry);
  const meme = await ethers.getContractAt("MockMemeToken", A.mockMemeToken);

  // 1. Fresh throwaway account (unique salt each run so it never collides).
  console.log("1. deploy a fresh smart account");
  const salt = BigInt(Date.now());
  const addr = await factory.createAccount.staticCall(dep.address, salt);
  await (await factory.createAccount(dep.address, salt)).wait();
  ok((await ethers.provider.getCode(addr)) !== "0x", `account deployed at ${addr}`);
  const account = await ethers.getContractAt("SmartAccount", addr);
  ok((await account.owner()).toLowerCase() === dep.address.toLowerCase(), "deployer is the owner");

  // 2. Fund it and put it in the fully-live state: keeper enabled + an active policy.
  console.log("2. fund + arm (keeper enabled, policy active) — the worst case to exit from");
  await (await meme.mint(addr, FUND_MEME)).wait();
  ok((await meme.balanceOf(addr)) === FUND_MEME, `funded ${ethers.formatUnits(FUND_MEME, 18)} meme`);
  await (await account.setSweepExecutor(A.executor)).wait();
  ok((await account.sweepExecutor()).toLowerCase() === A.executor.toLowerCase(), "keeper executor enabled");
  const setPolicy = registry.interface.encodeFunctionData("setPolicy",
    [1000, 0, 0, 0, [A.mockMemeToken], 1000]); // 10% / minUsd 0 / PROFIT_ONLY / USDG_YIELD / [meme] / 10% slip
  await (await account.ownerExecute(A.registry, 0, setPolicy)).wait();
  ok((await registry.getPolicy(addr)).active, "policy is ACTIVE (keeper could act on this account)");

  // 3. THE DRILL: owner exits everything directly. No keeper, bundler, paymaster, or EntryPoint.
  console.log("3. owner exits via ownerExecute — no keeper / bundler / paymaster / EntryPoint");
  const bal = await meme.balanceOf(addr);
  const ownerBefore = await meme.balanceOf(dep.address);
  const exitData = meme.interface.encodeFunctionData("transfer", [dep.address, bal]);
  const rc = await (await account.ownerExecute(A.mockMemeToken, 0, exitData)).wait();
  ok((await meme.balanceOf(addr)) === 0n, "account fully drained (balance now 0)");
  ok((await meme.balanceOf(dep.address)) === ownerBefore + bal, "owner received the full balance");
  console.log(`   exited ${ethers.formatUnits(bal, 18)} meme in tx ${rc.hash.slice(0, 12)}… (a single owner EOA tx)`);

  console.log("\n✅ N3 PASSED — the owner exited a live, policied, keeper-enabled account unilaterally,");
  console.log("   with no dependency on any off-chain component. Self-custody holds in the worst case.\n");
}

main().catch((e) => { console.error("\n❌ N3 FAILED:", e.message, "\n", e.stack || ""); process.exit(1); });
