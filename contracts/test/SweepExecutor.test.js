const { expect } = require("chai");
const { ethers } = require("hardhat");

// These tests exercise the SweepExecutor directly with an EOA standing in for the
// SmartAccount (executeSweep keys off msg.sender). That is exactly the surface a
// compromised keeper would reach, so it proves the on-chain policy bounds hold
// regardless of what the keeper submits.
describe("SweepExecutor — on-chain policy enforcement", function () {
  let owner, account, attacker;
  let registry, executor, meme, usdg, router;
  const ONE = (n, d = 18) => ethers.parseUnits(n.toString(), d);

  // Router rate: 1 meme (18 dec) -> 1 USDG (6 dec)  =>  out = in / 1e12
  const RATE_NUM = 1n;
  const RATE_DEN = 10n ** 12n;

  beforeEach(async function () {
    [owner, account, attacker] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("SweepPolicyRegistry");
    registry = await Registry.deploy(owner.address);

    const USDG = await ethers.getContractFactory("MockUSDG");
    usdg = await USDG.deploy();

    const Meme = await ethers.getContractFactory("MockMemeToken");
    meme = await Meme.deploy("Doge", "DOGE");

    const Executor = await ethers.getContractFactory("SweepExecutor");
    executor = await Executor.deploy(await usdg.getAddress(), await registry.getAddress(), owner.address);

    const Router = await ethers.getContractFactory("MockSwapRouter");
    router = await Router.deploy(RATE_NUM, RATE_DEN);

    // Owner sanctions the router; fund the router with USDG liquidity.
    await executor.setSanctionedRouter(await router.getAddress(), true);
    await usdg.mint(await router.getAddress(), ONE(1_000_000, 6));

    // The account holds meme tokens and approves the executor to pull them.
    await meme.mint(account.address, ONE(1000));
    await meme.connect(account).approve(await executor.getAddress(), ethers.MaxUint256);
  });

  // Build swapData for the mock router: meme -> USDG, output sent to the executor.
  async function swapData(amountIn, minOut) {
    const iface = new ethers.Interface([
      "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    ]);
    return iface.encodeFunctionData("swapExactTokensForTokens", [
      amountIn,
      0,
      [await meme.getAddress(), await usdg.getAddress()],
      await executor.getAddress(),
      Math.floor(Date.now() / 1000) + 300,
    ]);
  }

  async function swap(amountIn, spotQuote, routerAddr) {
    return {
      tokenIn: await meme.getAddress(),
      amountIn,
      spotQuote,
      router: routerAddr ?? (await router.getAddress()),
      swapData: await swapData(amountIn),
    };
  }

  async function setPolicy(pct, dest = 0, whitelist = [], maxSlippageBps = 1000) {
    await registry.connect(account).setPolicy(pct, 0, 0, dest, whitelist, maxSlippageBps);
  }

  it("reverts when the account has no active policy", async function () {
    const s = await swap(ONE(100), ONE(90, 6));
    await expect(executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0))
      .to.be.revertedWithCustomError(executor, "NoActivePolicy");
  });

  it("executes a policy-compliant sweep and returns USDG to the account", async function () {
    await setPolicy(1000); // 10%, USDG_YIELD
    const amountIn = ONE(100); // 10% of 1000
    const s = await swap(amountIn, ONE(90, 6));

    await executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0);

    expect(await meme.balanceOf(account.address)).to.equal(ONE(900));
    expect(await usdg.balanceOf(account.address)).to.equal(ONE(100, 6)); // 100 meme -> 100 USDG
  });

  it("rejects an amount that exceeds the policy percentage", async function () {
    await setPolicy(1000); // 10% of 1000 = 100 max
    const s = await swap(ONE(101), ONE(90, 6)); // one over the cap
    await expect(executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0))
      .to.be.revertedWithCustomError(executor, "AmountExceedsPolicy");
  });

  it("rejects an unsanctioned router (fake pool)", async function () {
    await setPolicy(1000);
    const s = await swap(ONE(100), ONE(90, 6), attacker.address); // attacker-controlled router
    await expect(executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0))
      .to.be.revertedWithCustomError(executor, "RouterNotSanctioned");
  });

  it("rejects a destination that does not match the policy", async function () {
    await setPolicy(1000, 0); // policy says USDG_YIELD
    const s = await swap(ONE(100), ONE(90, 6));
    await expect(executor.connect(account).executeSweep([s], 1, ethers.ZeroAddress, 0)) // caller claims STOCKS
      .to.be.revertedWithCustomError(executor, "DestinationMismatch");
  });

  it("rejects a zero spot quote", async function () {
    await setPolicy(1000);
    const s = await swap(ONE(100), 0);
    await expect(executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0))
      .to.be.revertedWithCustomError(executor, "SlippageFloorRequired");
  });

  it("enforces the user-authored max-slippage floor on the output", async function () {
    await setPolicy(1000, 0, [], 500); // 5% max slippage
    // 100 meme -> 100 USDG at the mock rate, but the keeper declares a 110 USDG spot
    // quote, so the floor is 110 * 0.95 = 104.5 USDG > 100 received -> reverts.
    const s = await swap(ONE(100), ONE(110, 6));
    await expect(executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0))
      .to.be.revertedWithCustomError(executor, "SweepSlippageExceeded");
  });

  it("passes when the fill is within the user's slippage tolerance", async function () {
    await setPolicy(1000, 0, [], 500); // 5% max slippage; quote 100, received 100, floor 95
    const s = await swap(ONE(100), ONE(100, 6));
    await executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0);
    expect(await usdg.balanceOf(account.address)).to.equal(ONE(100, 6));
  });

  it("rejects a token outside the policy whitelist", async function () {
    const other = await (await ethers.getContractFactory("MockMemeToken")).deploy("Other", "OTH");
    await setPolicy(1000, 0, [await other.getAddress()]); // whitelist excludes meme
    const s = await swap(ONE(100), ONE(90, 6));
    await expect(executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0))
      .to.be.revertedWithCustomError(executor, "TokenNotAllowed");
  });

  it("rejects a STOCKS sweep into an unsanctioned stock token", async function () {
    await setPolicy(1000, 1); // STOCKS
    const s = await swap(ONE(100), ONE(90, 6));
    await expect(executor.connect(account).executeSweep([s], 1, attacker.address, 0))
      .to.be.revertedWithCustomError(executor, "StockNotSanctioned");
  });

  // ─── Protocol fee: capped, disclosed, off by default ───

  it("takes no fee by default — the account keeps 100%", async function () {
    await setPolicy(1000);
    const s = await swap(ONE(100), ONE(90, 6));
    await executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0);
    expect(await usdg.balanceOf(account.address)).to.equal(ONE(100, 6));
    expect(await executor.feeBps()).to.equal(0n);
  });

  it("skims the configured fee to the treasury and routes the remainder", async function () {
    const treasury = (await ethers.getSigners())[3];
    await executor.setTreasury(treasury.address);
    await executor.setFeeBps(100); // 1.00%
    await setPolicy(1000);
    const s = await swap(ONE(100), ONE(90, 6));

    await expect(executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0))
      .to.emit(executor, "FeeCollected");

    // 100 USDG proceeds, 1% fee => 1 USDG to the treasury, 99 to the account.
    expect(await usdg.balanceOf(treasury.address)).to.equal(ONE(1, 6));
    expect(await usdg.balanceOf(account.address)).to.equal(ONE(99, 6));
  });

  it("reverts setting a fee above the hard cap", async function () {
    expect(await executor.MAX_FEE_BPS()).to.equal(100n);
    await expect(executor.setFeeBps(101))
      .to.be.revertedWithCustomError(executor, "FeeExceedsMax");
  });

  it("skips the fee when no treasury is set, even with feeBps > 0", async function () {
    await executor.setFeeBps(100); // treasury left at address(0)
    await setPolicy(1000);
    const s = await swap(ONE(100), ONE(90, 6));
    await executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0);
    expect(await usdg.balanceOf(account.address)).to.equal(ONE(100, 6));
  });

  it("only the owner can configure the fee", async function () {
    await expect(executor.connect(attacker).setFeeBps(50))
      .to.be.revertedWithCustomError(executor, "OwnableUnauthorizedAccount");
    await expect(executor.connect(attacker).setTreasury(attacker.address))
      .to.be.revertedWithCustomError(executor, "OwnableUnauthorizedAccount");
  });

  // ─────────────── Exploit repros (regression guards) ───────────────
  // Each of these encodes an invariant the pre-audit scan found broken. They
  // fail against the vulnerable code and pass once the fix lands.

  // Build swapData whose swap recipient is NOT the executor.
  async function redirectedSwapData(amountIn, to) {
    const iface = new ethers.Interface([
      "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    ]);
    return iface.encodeFunctionData("swapExactTokensForTokens", [
      amountIn, 0,
      [await meme.getAddress(), await usdg.getAddress()],
      to,
      Math.floor(Date.now() / 1000) + 300,
    ]);
  }

  // Deploy a sandbagged USDG->stock venue (dust rate) and sanction it.
  async function deployDustStockVenue() {
    const stock = await (await ethers.getContractFactory("MockMemeToken")).deploy("nvda", "NVDA");
    // 6-dp USDG -> 18-dp stock at a dust rate: 100 USDG yields ~100 wei of stock.
    const stockRouter = await (await ethers.getContractFactory("MockSwapRouter")).deploy(1n, 10n ** 6n);
    await stock.mint(await stockRouter.getAddress(), ONE(1_000_000));
    await executor.setStockRouter(await stockRouter.getAddress());
    await executor.setSanctionedStock(await stock.getAddress(), true);
    return stock;
  }

  // H4 adds a stock spot quote as executeSweep's 4th arg.
  const execStocks = (s, stock, stockSpotQuote) =>
    executor.connect(account).executeSweep([s], 1, stock, stockSpotQuote);

  // C1: a compromised keeper redirects the swap output to itself. A tiny
  // spotQuote makes the derived floor round to 0, and swapData's recipient is
  // unconstrained, so the executor's USDG delta is 0 and `0 < 0` never reverts.
  it("C1: blocks a keeper that redirects the swap output to a third party", async function () {
    await setPolicy(1000); // 10%, USDG_YIELD, 10% slippage
    const amountIn = ONE(100);
    const s = {
      tokenIn: await meme.getAddress(),
      amountIn,
      spotQuote: 1, // floor = 1 * 9000 / 10000 = 0
      router: await router.getAddress(),
      swapData: await redirectedSwapData(amountIn, attacker.address), // output stolen
    };
    await expect(executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0))
      .to.be.revertedWithCustomError(executor, "UnsafeSwapData");
    expect(await usdg.balanceOf(attacker.address)).to.equal(0n);
    expect(await meme.balanceOf(account.address)).to.equal(ONE(1000));
  });

  // C1 (hardening): a spotQuote small enough to round the floor to 0 is rejected,
  // so the keeper can never execute with no effective output floor.
  it("C1: rejects a spot quote that rounds the slippage floor to zero", async function () {
    await setPolicy(1000, 0, [], 500); // 5% slippage
    const s = await swap(ONE(100), 1); // floor = 1 * 9500 / 10000 = 0
    await expect(executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0))
      .to.be.revertedWithCustomError(executor, "SlippageFloorRequired");
  });

  // H1: the per-swap pct cap must be cumulative per token. Two swaps of the same
  // token, each within the per-swap cap, would otherwise liquidate 43% of a
  // position the user capped at 25%.
  it("H1: blocks repeating a token to exceed the per-call pct cap", async function () {
    await setPolicy(2500); // 25% of 1000 = 250 per-swap cap
    const s1 = await swap(ONE(250), ONE(250, 6)); // 25% of 1000
    const s2 = await swap(ONE(180), ONE(180, 6)); // 25% of the remaining 750 is 187, so this passes the per-swap check
    await expect(executor.connect(account).executeSweep([s1, s2], 0, ethers.ZeroAddress, 0))
      .to.be.revertedWithCustomError(executor, "DuplicateToken");
    expect(await meme.balanceOf(account.address)).to.equal(ONE(1000)); // nothing swept
  });

  // H4: the USDG->stock leg must enforce a real slippage floor. With a dust
  // stock rate and an honest keeper quote, the tiny output is below the floor.
  it("H4: enforces a slippage floor on the USDG->stock leg", async function () {
    const stock = await deployDustStockVenue();
    await setPolicy(1000, 1); // 10%, STOCKS, 10% slippage
    const s = await swap(ONE(100), ONE(100, 6)); // meme -> 100 USDG
    const stockQuote = ONE(100); // honest expectation: 100 USDG -> ~100 stock (1:1)
    // Floor = 100 * 0.90 = 90e18; the dust swap yields ~100 wei. Before the fix the
    // stock leg used minOut=0 and accepted it; now the floor is passed to the router
    // (which reverts) and re-checked as SweepSlippageExceeded if the router doesn't.
    await expect(execStocks(s, await stock.getAddress(), stockQuote)).to.be.reverted;
    expect(await meme.balanceOf(account.address)).to.equal(ONE(1000)); // whole sweep unwound
  });

  // H4 (positive): a legitimate STOCKS sweep still completes through the new floor.
  it("H4: a fair-rate STOCKS sweep passes the floor and delivers stock", async function () {
    const stock = await (await ethers.getContractFactory("MockMemeToken")).deploy("nvda", "NVDA");
    // Fair rate: 100 USDG (6dp) -> 100 stock (18dp)  =>  out = in * 1e12.
    const stockRouter = await (await ethers.getContractFactory("MockSwapRouter")).deploy(10n ** 12n, 1n);
    await stock.mint(await stockRouter.getAddress(), ONE(1_000_000));
    await executor.setStockRouter(await stockRouter.getAddress());
    await executor.setSanctionedStock(await stock.getAddress(), true);

    await setPolicy(1000, 1); // 10%, STOCKS, 10% slippage
    const s = await swap(ONE(100), ONE(100, 6)); // meme -> 100 USDG
    await execStocks(s, await stock.getAddress(), ONE(100)); // floor 90e18, receives 100e18

    expect(await meme.balanceOf(account.address)).to.equal(ONE(900));
    expect(await stock.balanceOf(account.address)).to.equal(ONE(100));
  });

  // H5: the guardian's registry pause must halt the money path (executeSweep),
  // not only new policy registration; unpausing resumes it.
  it("H5: the guardian pause halts sweeps, and unpausing resumes them", async function () {
    await setPolicy(1000);
    const s = await swap(ONE(100), ONE(100, 6));

    await registry.connect(owner).setPaused(true);
    await expect(executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0))
      .to.be.revertedWithCustomError(executor, "SweepsPaused");

    await registry.connect(owner).setPaused(false); // guardian lifts the pause
    await executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0);
    expect(await usdg.balanceOf(account.address)).to.equal(ONE(100, 6));
  });

  // M8: the yield-pool deposit path must credit the pool when it works, and never
  // strand funds when the pool returns success without pulling.
  it("M8: deposits into a well-behaved yield pool", async function () {
    const pool = await (await ethers.getContractFactory("MockYieldPool")).deploy(await usdg.getAddress());
    await executor.setYieldPool(await pool.getAddress());
    await setPolicy(1000);
    const s = await swap(ONE(100), ONE(100, 6));
    await executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0);
    expect(await pool.shares(account.address)).to.equal(ONE(100, 6));
    expect(await usdg.balanceOf(await executor.getAddress())).to.equal(0n);
  });

  it("M8: a pool that doesn't pull falls back to a direct transfer (no stranding)", async function () {
    const badPool = await (await ethers.getContractFactory("MockYieldPool")).deploy(await usdg.getAddress());
    await badPool.setMisbehave(true);
    await executor.setYieldPool(await badPool.getAddress());
    await setPolicy(1000);
    const s = await swap(ONE(100), ONE(100, 6));
    await executor.connect(account).executeSweep([s], 0, ethers.ZeroAddress, 0);
    // Nothing pulled -> executor transferred USDG straight to the account.
    expect(await usdg.balanceOf(account.address)).to.equal(ONE(100, 6));
    expect(await badPool.shares(account.address)).to.equal(0n);
    expect(await usdg.balanceOf(await executor.getAddress())).to.equal(0n);
    // The dangling approval was cleared.
    expect(await usdg.allowance(await executor.getAddress(), await badPool.getAddress())).to.equal(0n);
  });
});
