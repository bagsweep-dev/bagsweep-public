const { expect } = require("chai");
const { ethers } = require("hardhat");

// The adapter lets the frozen, V2-shaped SweepExecutor use RH's Uniswap V3
// liquidity: it exposes swapExactTokensForTokens (which the executor's C1 check
// requires) and routes through a V3 SwapRouter (exactInput) internally.
describe("SweepRouterV3Adapter", function () {
  let owner, account, other;
  let meme, weth, usdg, v3, adapter;
  const ONE = (n, d = 18) => ethers.parseUnits(n.toString(), d);
  // Base the deadline on the block timestamp: other suites call time.increase(),
  // so the network clock can be far ahead of wall-clock Date.now().
  const DEADLINE = async () => (await ethers.provider.getBlock("latest")).timestamp + 600;
  // 18-dp meme -> 6-dp USDG at 1:1 value  =>  out = in / 1e12
  const RATE_NUM = 1n, RATE_DEN = 10n ** 12n;

  beforeEach(async function () {
    [owner, account, other] = await ethers.getSigners();
    meme = await (await ethers.getContractFactory("MockMemeToken")).deploy("Doge", "DOGE");
    weth = await (await ethers.getContractFactory("MockMemeToken")).deploy("Weth", "WETH");
    usdg = await (await ethers.getContractFactory("MockUSDG")).deploy();
    v3 = await (await ethers.getContractFactory("MockV3Router")).deploy(RATE_NUM, RATE_DEN);
    adapter = await (await ethers.getContractFactory("SweepRouterV3Adapter")).deploy(await v3.getAddress(), owner.address);

    await usdg.mint(await v3.getAddress(), ONE(1_000_000, 6)); // V3 router liquidity
    // configure the two-hop fees: meme/WETH (0.3%) and WETH/USDG (0.05%)
    await adapter.setPoolFee(await meme.getAddress(), await weth.getAddress(), 3000);
    await adapter.setPoolFee(await weth.getAddress(), await usdg.getAddress(), 500);
  });

  async function path() {
    return [await meme.getAddress(), await weth.getAddress(), await usdg.getAddress()];
  }

  it("routes a multi-hop path through the V3 router and pays the recipient", async function () {
    await meme.mint(account.address, ONE(100));
    await meme.connect(account).approve(await adapter.getAddress(), ONE(100));

    await adapter.connect(account).swapExactTokensForTokens(
      ONE(100), ONE(90, 6), await path(), account.address, await DEADLINE()
    );
    expect(await usdg.balanceOf(account.address)).to.equal(ONE(100, 6)); // 100 meme -> 100 USDG
    expect(await meme.balanceOf(account.address)).to.equal(0n);
    // adapter holds nothing between calls
    expect(await usdg.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("reverts a hop with no configured fee (no silent wrong-pool routing)", async function () {
    await meme.mint(account.address, ONE(10));
    await meme.connect(account).approve(await adapter.getAddress(), ONE(10));
    const p = [await meme.getAddress(), await other.address, await usdg.getAddress()]; // meme/other fee unset
    await expect(
      adapter.connect(account).swapExactTokensForTokens(ONE(10), 0, p, account.address, await DEADLINE())
    ).to.be.revertedWithCustomError(adapter, "FeeNotSet");
  });

  it("reverts once the deadline has passed", async function () {
    await meme.mint(account.address, ONE(10));
    await meme.connect(account).approve(await adapter.getAddress(), ONE(10));
    await expect(
      adapter.connect(account).swapExactTokensForTokens(ONE(10), 0, await path(), account.address, 1)
    ).to.be.revertedWithCustomError(adapter, "DeadlinePassed");
  });

  it("only the owner can set pool fees", async function () {
    await expect(
      adapter.connect(other).setPoolFee(await meme.getAddress(), await weth.getAddress(), 100)
    ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
  });

  it("rejects a zero-address V3 router at construction", async function () {
    const F = await ethers.getContractFactory("SweepRouterV3Adapter");
    await expect(F.deploy(ethers.ZeroAddress, owner.address))
      .to.be.revertedWithCustomError(F, "ZeroAddress");
  });

  it("exposes feeFor (order-independent) for keeper route selection", async function () {
    const m = await meme.getAddress(), w = await weth.getAddress(), u = await usdg.getAddress();
    expect(await adapter.feeFor(m, w)).to.equal(3000);
    expect(await adapter.feeFor(w, m)).to.equal(3000); // same pool either direction
    expect(await adapter.feeFor(m, u)).to.equal(0);     // unconfigured pool
  });

  // The load-bearing proof: the FROZEN executor accepts the adapter's V2 interface
  // and a multi-hop path, and the sweep completes via the V3 router.
  it("the frozen executor sweeps through the adapter over a multi-hop V3 path", async function () {
    const registry = await (await ethers.getContractFactory("SweepPolicyRegistry")).deploy(owner.address);
    const executor = await (await ethers.getContractFactory("SweepExecutor")).deploy(
      await usdg.getAddress(), await registry.getAddress(), owner.address
    );
    await executor.setSanctionedRouter(await adapter.getAddress(), true);

    // account authors a policy, holds meme, approves the executor
    await registry.connect(account).setPolicy(1000, 0, 0, 0, [], 1000); // 10%, USDG_YIELD, 10% slip
    await meme.mint(account.address, ONE(1000));
    await meme.connect(account).approve(await executor.getAddress(), ethers.MaxUint256);

    const amountIn = ONE(100); // 10% of 1000
    const iface = new ethers.Interface(["function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"]);
    const swapData = iface.encodeFunctionData("swapExactTokensForTokens", [
      amountIn, ONE(90, 6), await path(), await executor.getAddress(), await DEADLINE(),
    ]);
    const swap = {
      tokenIn: await meme.getAddress(),
      amountIn,
      spotQuote: ONE(100, 6),
      router: await adapter.getAddress(),
      swapData,
    };
    await executor.connect(account).executeSweep([swap], 0, ethers.ZeroAddress, 0);

    expect(await meme.balanceOf(account.address)).to.equal(ONE(900));
    expect(await usdg.balanceOf(account.address)).to.equal(ONE(100, 6));
  });
});
