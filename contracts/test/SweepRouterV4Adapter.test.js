const { expect } = require("chai");
const { ethers } = require("hardhat");

// The V4 adapter presents the same V2 swapExactTokensForTokens shape the frozen
// SweepBuyback/SweepExecutor require, and routes through a (mocked) Uniswap V4
// UniversalRouter. The mock models V4's key mechanics: input pulled via Permit2, output
// TAKE_ALL'd to the router's CALLER (the adapter) — so the adapter must forward to `to`.
// These are logic tests against a mock; the real-V4 gate is contracts/scripts/forktest-v4.js.
describe("SweepRouterV4Adapter", function () {
  let owner, account, other;
  let usdg, reap, weth, permit2, ur, adapter;
  const ONE = (n) => ethers.parseUnits(n.toString(), 18);
  const USDG6 = (n) => ethers.parseUnits(n.toString(), 6);
  const DEAD = "0x000000000000000000000000000000000000dEaD";
  const HOOK = "0x00000000000000000000000000000000000000A8"; // any nonzero (mock ignores it)
  const DEADLINE = async () => (await ethers.provider.getBlock("latest")).timestamp + 600;

  beforeEach(async function () {
    [owner, account, other] = await ethers.getSigners();
    usdg = await (await ethers.getContractFactory("MockUSDG")).deploy();
    reap = await (await ethers.getContractFactory("MockMemeToken")).deploy("Reap", "REAP");
    weth = await (await ethers.getContractFactory("MockMemeToken")).deploy("Weth", "WETH");
    permit2 = await (await ethers.getContractFactory("MockPermit2")).deploy();
    ur = await (await ethers.getContractFactory("MockUniversalRouter")).deploy(await permit2.getAddress());
    adapter = await (await ethers.getContractFactory("SweepRouterV4Adapter"))
      .deploy(await ur.getAddress(), await permit2.getAddress(), owner.address);

    // Router liquidity + a direct USDG->REAP rate of 1:1 (6dp -> 18dp => out = in * 1e12).
    await reap.mint(await ur.getAddress(), ONE(1_000_000));
    await ur.setRate(await usdg.getAddress(), await reap.getAddress(), 10n ** 12n, 1n);
    await adapter.setPoolKey(await usdg.getAddress(), await reap.getAddress(), 3000, 60, HOOK);
  });

  async function fund(who, amt) {
    await usdg.mint(who.address, amt);
    await usdg.connect(who).approve(await adapter.getAddress(), amt);
  }
  const path = async () => [await usdg.getAddress(), await reap.getAddress()];

  it("routes a single-hop USDG->REAP swap and pays the recipient", async function () {
    await fund(account, USDG6(100));
    await adapter.connect(account).swapExactTokensForTokens(USDG6(10), ONE(9), await path(), other.address, await DEADLINE());
    expect(await reap.balanceOf(other.address)).to.equal(ONE(10));       // 10 USDG -> 10 REAP delivered to `to`
    expect(await reap.balanceOf(await adapter.getAddress())).to.equal(0n); // adapter retains nothing
    expect(await usdg.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("reverts PoolKeyNotSet on an unconfigured pair", async function () {
    await fund(account, USDG6(10));
    const p = [await usdg.getAddress(), await weth.getAddress()]; // weth key unset
    await expect(
      adapter.connect(account).swapExactTokensForTokens(USDG6(10), 0, p, other.address, await DEADLINE())
    ).to.be.revertedWithCustomError(adapter, "PoolKeyNotSet");
  });

  it("reverts once the deadline has passed", async function () {
    await fund(account, USDG6(10));
    await expect(
      adapter.connect(account).swapExactTokensForTokens(USDG6(10), 0, await path(), other.address, 1)
    ).to.be.revertedWithCustomError(adapter, "DeadlinePassed");
  });

  it("enforces the terminal amountOutMin (short fill reverts)", async function () {
    await fund(account, USDG6(10));
    await expect( // 10 USDG yields 10 REAP; demand 11 -> the router's TAKE_ALL floor reverts
      adapter.connect(account).swapExactTokensForTokens(USDG6(10), ONE(11), await path(), other.address, await DEADLINE())
    ).to.be.revertedWith("MockUR: too little received");
  });

  it("only the owner can set pool keys / hook data", async function () {
    await expect(
      adapter.connect(other).setPoolKey(await usdg.getAddress(), await reap.getAddress(), 500, 10, HOOK)
    ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    await expect(
      adapter.connect(other).setHookData(await usdg.getAddress(), await reap.getAddress(), "0x01")
    ).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
  });

  it("rejects a zero-address router or permit2 at construction", async function () {
    const F = await ethers.getContractFactory("SweepRouterV4Adapter");
    await expect(F.deploy(ethers.ZeroAddress, await permit2.getAddress(), owner.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(await ur.getAddress(), ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(F, "ZeroAddress");
  });

  it("poolKeyFor reports configured vs unset pairs (keeper route selection)", async function () {
    const [set, key] = await adapter.poolKeyFor(await usdg.getAddress(), await reap.getAddress());
    expect(set).to.equal(true);
    expect(key.fee).to.equal(3000);
    expect(key.hooks).to.equal(ethers.getAddress(HOOK));
    const [set2] = await adapter.poolKeyFor(await usdg.getAddress(), await weth.getAddress());
    expect(set2).to.equal(false);
  });

  it("routes a multi-hop USDG->WETH->REAP path, holding the intermediate on the adapter", async function () {
    // USDG(6dp)->WETH(18dp) at *1e12, WETH->REAP at *2  =>  10 USDG -> 10 WETH -> 20 REAP
    await weth.mint(await ur.getAddress(), ONE(1_000_000));
    await ur.setRate(await usdg.getAddress(), await weth.getAddress(), 10n ** 12n, 1n);
    await ur.setRate(await weth.getAddress(), await reap.getAddress(), 2n, 1n);
    await adapter.setPoolKey(await usdg.getAddress(), await weth.getAddress(), 500, 10, HOOK);
    await adapter.setPoolKey(await weth.getAddress(), await reap.getAddress(), 3000, 60, HOOK);

    await fund(account, USDG6(10));
    const p = [await usdg.getAddress(), await weth.getAddress(), await reap.getAddress()];
    await adapter.connect(account).swapExactTokensForTokens(USDG6(10), ONE(19), p, other.address, await DEADLINE());
    expect(await reap.balanceOf(other.address)).to.equal(ONE(20));
    expect(await weth.balanceOf(await adapter.getAddress())).to.equal(0n); // intermediate fully consumed
    expect(await reap.balanceOf(await adapter.getAddress())).to.equal(0n);
  });

  it("revokes the Permit2 ERC-20 allowance after the swap", async function () {
    await fund(account, USDG6(10));
    await adapter.connect(account).swapExactTokensForTokens(USDG6(10), ONE(9), await path(), other.address, await DEADLINE());
    expect(await usdg.allowance(await adapter.getAddress(), await permit2.getAddress())).to.equal(0n);
  });

  it("the frozen SweepBuyback buys back and burns $REAP through the adapter", async function () {
    const buyback = await (await ethers.getContractFactory("SweepBuyback"))
      .deploy(await usdg.getAddress(), owner.address, owner.address); // owner is the keeper
    await usdg.mint(await buyback.getAddress(), USDG6(100));           // accumulated fees
    await buyback.setSweepToken(await reap.getAddress());
    await buyback.setSanctionedRouter(await adapter.getAddress(), true);

    const usdgIn = USDG6(10); // -> 10 REAP
    const iface = new ethers.Interface(["function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"]);
    const swapData = iface.encodeFunctionData("swapExactTokensForTokens", [
      usdgIn, ONE(9), await path(), await buyback.getAddress(), await DEADLINE(),
    ]);
    await expect(buyback.buybackAndBurn(usdgIn, ONE(9), await adapter.getAddress(), swapData))
      .to.emit(buyback, "BuybackBurned");
    expect(await reap.balanceOf(DEAD)).to.equal(ONE(10));
    expect(await usdg.balanceOf(await buyback.getAddress())).to.equal(USDG6(90));
  });
});
