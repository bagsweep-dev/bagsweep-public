// ── V4 buyback canary: the launch-day fork gate for SweepRouterV4Adapter ──
//
// ⚠ CANNOT run until $SWEEP has graduated to a real V4 pool AND you can fork RH Chain.
//   This is the non-negotiable pre-sanction gate the audit + gotchas analysis call for:
//   it collapses all three V4 config risks (plan-byte constants, pool identity, hook
//   behavior) into one real end-to-end swap. If the bytes/addresses/PoolKey are wrong,
//   it reverts here — for free — instead of DoS'ing the live buyback.
//
// How to run (after graduation):
//   1. Add a forking network to hardhat.config (fork RH at a recent block):
//        rhfork: { url: process.env.RH_RPC_URL, forking: { url: process.env.RH_RPC_URL } }
//   2. Pin the REAL addresses (Uniswap official deployment registry / RH explorer, NOT
//      launchpad docs) and the graduated pool's PoolKey (read fee/tickSpacing/hook from
//      the PoolManager `Initialize` event in the graduation tx):
//        UNIVERSAL_ROUTER, PERMIT2, USDG_ADDR, SWEEP_ADDR, POOL_FEE, POOL_TICK_SPACING,
//        POOL_HOOK, USDG_WHALE (an address holding USDG on the fork to impersonate)
//   3. npx hardhat run contracts/scripts/forktest-v4.js --network rhfork
//
// Checks: (a) a direct adapter swap FROM A CONTRACT CALLER succeeds (hook allows
// contract-initiated swaps), (b) Permit2 allowance is revoked after, (c) the frozen
// SweepBuyback buys back + burns $SWEEP to dEaD through the adapter. Run it FIRST inside
// and then outside any launch/anti-snipe window, and keep the very first live buyback a
// minimal-amount canary.
const { ethers, network } = require("hardhat");

const DEAD = "0x000000000000000000000000000000000000dEaD";
function need(n) { const v = process.env[n]; if (!v) throw new Error(`set ${n}`); return v; }

async function main() {
  const UR = need("UNIVERSAL_ROUTER"), PERMIT2 = need("PERMIT2");
  const USDG = need("USDG_ADDR"), SWEEP = need("SWEEP_ADDR");
  const FEE = parseInt(need("POOL_FEE")), TICK = parseInt(need("POOL_TICK_SPACING")), HOOK = need("POOL_HOOK");
  const WHALE = need("USDG_WHALE");
  const CANARY = ethers.parseUnits(process.env.CANARY_USDG || "1", 6); // smallest viable

  const [dep] = await ethers.getSigners();
  const usdg = await ethers.getContractAt("IERC20", USDG);
  const sweep = await ethers.getContractAt("IERC20", SWEEP);

  // Fund the deployer with USDG by impersonating a whale on the fork.
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [WHALE] });
  const whale = await ethers.getSigner(WHALE);
  await usdg.connect(whale).transfer(dep.address, CANARY * 3n);
  console.log(`funded deployer with ${CANARY * 3n} USDG (from whale ${WHALE})`);

  // 1. Deploy + configure the adapter against the REAL router/permit2/pool.
  const adapter = await (await ethers.getContractFactory("SweepRouterV4Adapter")).deploy(UR, PERMIT2, dep.address);
  await adapter.waitForDeployment();
  await (await adapter.setPoolKey(USDG, SWEEP, FEE, TICK, HOOK)).wait();
  console.log(`adapter ${await adapter.getAddress()} · PoolKey(USDG,SWEEP,${FEE},${TICK},${HOOK}) set`);

  // 2. Direct adapter swap from a contract-less caller path is fine; the real question is
  //    a contract-INITIATED swap works and the plan bytes are right. Route USDG->SWEEP.
  await (await usdg.approve(await adapter.getAddress(), CANARY)).wait();
  const before = await sweep.balanceOf(dep.address);
  const dl = (await ethers.provider.getBlock("latest")).timestamp + 600;
  await (await adapter.swapExactTokensForTokens(CANARY, 1n, [USDG, SWEEP], dep.address, dl)).wait();
  const got = (await sweep.balanceOf(dep.address)) - before;
  if (got <= 0n) throw new Error("direct swap returned 0 SWEEP — check PoolKey / plan bytes");
  const p2Allowance = await usdg.allowance(await adapter.getAddress(), PERMIT2);
  console.log(`✓ direct swap: ${CANARY} USDG -> ${got} SWEEP · permit2 allowance now ${p2Allowance} (want 0)`);
  if (p2Allowance !== 0n) throw new Error("Permit2 allowance not revoked");

  // 3. End-to-end through the FROZEN SweepBuyback (the real burn path).
  const buyback = await (await ethers.getContractFactory("SweepBuyback")).deploy(USDG, dep.address, dep.address);
  await buyback.waitForDeployment();
  await (await usdg.transfer(await buyback.getAddress(), CANARY)).wait();
  await (await buyback.setSweepToken(SWEEP)).wait();
  await (await buyback.setSanctionedRouter(await adapter.getAddress(), true)).wait();

  const deadBefore = await sweep.balanceOf(DEAD);
  const iface = new ethers.Interface(["function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"]);
  const dl2 = (await ethers.provider.getBlock("latest")).timestamp + 600;
  const swapData = iface.encodeFunctionData("swapExactTokensForTokens", [CANARY, 1n, [USDG, SWEEP], await buyback.getAddress(), dl2]);
  await (await buyback.buybackAndBurn(CANARY, 1n, await adapter.getAddress(), swapData)).wait();
  const burned = (await sweep.balanceOf(DEAD)) - deadBefore;
  if (burned <= 0n) throw new Error("buyback burned 0 SWEEP");
  console.log(`✓ buyback burned ${burned} SWEEP to dEaD through the adapter`);

  console.log("\n✅ V4 canary PASSED — plan bytes, addresses, PoolKey, and hook all verified. Safe to sanction on the timelocked SweepBuyback.");
}

main().catch((e) => { console.error("\n❌ V4 canary FAILED:", e.message); process.exit(1); });
