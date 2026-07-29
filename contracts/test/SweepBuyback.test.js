const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// SweepBuyback is the fee sink: USDG in can ONLY leave as burned $SWEEP. These
// tests prove the enforced-burn property (no USDG withdrawal path), the bounded
// keeper, and the once-only $SWEEP target.
describe("SweepBuyback — enforced buy-and-burn", function () {
  let owner, keeper, attacker;
  let usdg, sweep, router, buyback;
  const ONE = (n, d = 18) => ethers.parseUnits(n.toString(), d);
  const DEAD = "0x000000000000000000000000000000000000dEaD";

  // USDG (6 dec) -> SWEEP (18 dec) at 1:1  =>  out = in * 1e12
  const RATE_NUM = 10n ** 12n;
  const RATE_DEN = 1n;

  beforeEach(async function () {
    [owner, keeper, attacker] = await ethers.getSigners();

    usdg = await (await ethers.getContractFactory("MockUSDG")).deploy();
    sweep = await (await ethers.getContractFactory("MockMemeToken")).deploy("Sweep", "SWEEP");
    router = await (await ethers.getContractFactory("MockSwapRouter")).deploy(RATE_NUM, RATE_DEN);
    buyback = await (await ethers.getContractFactory("SweepBuyback")).deploy(
      await usdg.getAddress(),
      owner.address,
      keeper.address
    );

    // Accumulated USDG fees sit on the buyback; the router holds $SWEEP liquidity.
    await usdg.mint(await buyback.getAddress(), ONE(100, 6));
    await sweep.mint(await router.getAddress(), ONE(1_000_000));

    await buyback.setSweepToken(await sweep.getAddress());
    await buyback.setSanctionedRouter(await router.getAddress(), true);
  });

  async function swapData(amountIn) {
    const iface = new ethers.Interface([
      "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    ]);
    return iface.encodeFunctionData("swapExactTokensForTokens", [
      amountIn,
      0,
      [await usdg.getAddress(), await sweep.getAddress()],
      await buyback.getAddress(),
      Math.floor(Date.now() / 1000) + 300,
    ]);
  }

  it("keeper buys back USDG for SWEEP and burns it to DEAD", async function () {
    const usdgIn = ONE(10, 6); // 10 USDG -> 10 SWEEP
    const data = await swapData(usdgIn);

    await expect(
      buyback.connect(keeper).buybackAndBurn(usdgIn, ONE(9), await router.getAddress(), data)
    ).to.emit(buyback, "BuybackBurned");

    expect(await sweep.balanceOf(DEAD)).to.equal(ONE(10));
    expect(await usdg.balanceOf(await buyback.getAddress())).to.equal(ONE(90, 6)); // 100 - 10 spent
    expect(await sweep.balanceOf(await buyback.getAddress())).to.equal(0n); // nothing retained
  });

  it("USDG can never be withdrawn — rescue reverts on the fee asset", async function () {
    await expect(
      buyback.rescue(await usdg.getAddress(), ONE(1, 6), owner.address)
    ).to.be.revertedWithCustomError(buyback, "CannotRescueProtocolAsset");
  });

  it("rescue reverts on $SWEEP too (must be burned, not rescued)", async function () {
    await expect(
      buyback.rescue(await sweep.getAddress(), 1, owner.address)
    ).to.be.revertedWithCustomError(buyback, "CannotRescueProtocolAsset");
  });

  it("only the keeper can trigger a buyback", async function () {
    const data = await swapData(ONE(10, 6));
    await expect(
      buyback.connect(attacker).buybackAndBurn(ONE(10, 6), ONE(9), await router.getAddress(), data)
    ).to.be.revertedWithCustomError(buyback, "NotKeeper");
  });

  it("rejects an unsanctioned router", async function () {
    const data = await swapData(ONE(10, 6));
    await expect(
      buyback.connect(keeper).buybackAndBurn(ONE(10, 6), ONE(9), attacker.address, data)
    ).to.be.revertedWithCustomError(buyback, "RouterNotSanctioned");
  });

  it("requires a non-zero slippage floor", async function () {
    const data = await swapData(ONE(10, 6));
    await expect(
      buyback.connect(keeper).buybackAndBurn(ONE(10, 6), 0, await router.getAddress(), data)
    ).to.be.revertedWithCustomError(buyback, "SlippageFloorRequired");
  });

  it("reverts when the buyback falls short of minSweepOut", async function () {
    const usdgIn = ONE(10, 6); // yields 10 SWEEP
    const data = await swapData(usdgIn);
    await expect(
      buyback.connect(keeper).buybackAndBurn(usdgIn, ONE(11), await router.getAddress(), data)
    ).to.be.revertedWithCustomError(buyback, "BuybackSlippage");
  });

  it("sets the $SWEEP token once — immutable thereafter", async function () {
    await expect(
      buyback.setSweepToken(attacker.address)
    ).to.be.revertedWithCustomError(buyback, "SweepTokenAlreadySet");
  });

  it("M4: caps USDG spent per call to a fraction of the balance", async function () {
    // balance 100 USDG, cap = 20% = 20; requesting 25 exceeds it.
    const data = await swapData(ONE(25, 6));
    await expect(
      buyback.connect(keeper).buybackAndBurn(ONE(25, 6), ONE(9), await router.getAddress(), data)
    ).to.be.revertedWithCustomError(buyback, "SpendExceedsCap");
  });

  it("M4: enforces a cooldown between buybacks", async function () {
    const data = await swapData(ONE(10, 6));
    await buyback.connect(keeper).buybackAndBurn(ONE(10, 6), ONE(9), await router.getAddress(), data);

    // A second buyback within the cooldown is blocked.
    const data2 = await swapData(ONE(10, 6));
    await expect(
      buyback.connect(keeper).buybackAndBurn(ONE(10, 6), ONE(9), await router.getAddress(), data2)
    ).to.be.revertedWithCustomError(buyback, "Cooldown");

    // After the cooldown elapses, it succeeds.
    await time.increase(3600 + 1);
    await expect(
      buyback.connect(keeper).buybackAndBurn(ONE(10, 6), ONE(9), await router.getAddress(), data2)
    ).to.emit(buyback, "BuybackBurned");
  });

  it("permissionlessly burns stray $SWEEP", async function () {
    await sweep.mint(await buyback.getAddress(), ONE(5));
    await buyback.connect(attacker).burnStuckSweep(); // anyone may call
    expect(await sweep.balanceOf(DEAD)).to.equal(ONE(5));
  });
});
