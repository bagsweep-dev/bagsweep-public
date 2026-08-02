// Launch wiring for the enforced buy-and-burn, around a LAUNCHPAD-created $SWEPT.
//
// ⚠ DO NOT RUN until the protocol is audited, live on mainnet, AND the phase-1 demand
//   signal has validated (see SWEEP_token_complete_profile PRE-LAUNCH guard + token
//   strategy). This deploys the fee sink and turns the protocol fee on (a real launch).
//
// $SWEPT is created on a launchpad (fair launch, 1B supply), NOT here. Pass its address as
// SWEEP_ADDR. Seeding/locking the USDG/$SWEPT V3 pool is done on the launchpad / DEX; this
// script only deploys + wires SweepBuyback and points the executor's fee at it.
//
// Required env: SWEEP_ADDR, USDG_ADDR, SWEEP_ROUTER (adapter), EXECUTOR_ADDR, KEEPER_ADDRESS,
//               TIMELOCK_ADDR. Optional: FEE_BPS (default 50 = 0.5%, must be <= 100).
const { ethers } = require("hardhat");

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const SWEPT = need("SWEEP_ADDR");         // launchpad-created token
  const USDG = need("USDG_ADDR");
  const ADAPTER = need("SWEEP_ROUTER");   // SweepRouterV3Adapter (the sanctioned router)
  const EXECUTOR = need("EXECUTOR_ADDR");
  const KEEPER = need("KEEPER_ADDRESS");
  const TIMELOCK = need("TIMELOCK_ADDR"); // final owner of the buyback
  const FEE_BPS = parseInt(process.env.FEE_BPS || "50");
  if (FEE_BPS > 100) throw new Error("FEE_BPS must be <= 100 (1%)");

  console.log(`Deployer: ${deployer.address}`);
  console.log(`$SWEPT:    ${SWEPT} (launchpad)`);

  // 1. Deploy the fee sink (owner = deployer for wiring; handed to the timelock at the end).
  const buyback = await (await ethers.getContractFactory("SweepBuyback")).deploy(USDG, deployer.address, KEEPER);
  await buyback.waitForDeployment();
  const buybackAddr = await buyback.getAddress();
  console.log(`SweepBuyback: ${buybackAddr}`);

  // 2. Point the burn target at $SWEPT (ONE-SHOT, immutable after this) and sanction the adapter.
  await (await buyback.setSweepToken(SWEPT)).wait();
  await (await buyback.setSanctionedRouter(ADAPTER, true)).wait();
  console.log("setSweepToken + setSanctionedRouter done");

  // 3. Route the executor's protocol fee into the buyback. (Executor must be owned by the
  //    caller here; if it's already timelock-owned, do these two via the timelock instead.)
  const executor = await ethers.getContractAt("SweepExecutor", EXECUTOR);
  await (await executor.setTreasury(buybackAddr)).wait();
  await (await executor.setFeeBps(FEE_BPS)).wait();
  console.log(`executor.setTreasury(${buybackAddr}) + setFeeBps(${FEE_BPS})`);

  // 4. Hand buyback governance to the timelock (keeper/router/cap setters now go through the delay).
  await (await buyback.transferOwnership(TIMELOCK)).wait();
  console.log(`buyback ownership -> timelock ${TIMELOCK}`);

  console.log("\nNEXT (manual, via the timelock):");
  console.log(`  - adapter.setPoolFee(${USDG}, ${SWEPT}, <feeTier>)  // so the keeper can quote/route USDG->$SWEPT`);
  console.log(`  - confirm the USDG/$SWEPT V3 pool is seeded + LP locked/burned on the launchpad`);
  console.log(`  - keeper env: BUYBACK_ENABLED=1, BUYBACK_ADDR=${buybackAddr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
