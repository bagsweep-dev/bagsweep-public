const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Proves that once a config contract's ownership is handed to the timelock, its
// privileged setters can no longer be called instantly by an EOA: a change must
// be queued, wait out `minDelay`, and only then execute. This is the primary
// hardening for the single-EOA admin.
describe("BagSweepTimelock — governance over config setters", function () {
  let deployer, other;
  let usdg, registry, executor, timelock;
  const MIN_DELAY = 24 * 60 * 60; // 24h

  beforeEach(async function () {
    [deployer, other] = await ethers.getSigners();

    usdg = await (await ethers.getContractFactory("MockUSDG")).deploy();
    registry = await (await ethers.getContractFactory("SweepPolicyRegistry")).deploy(deployer.address);
    executor = await (await ethers.getContractFactory("SweepExecutor")).deploy(
      await usdg.getAddress(),
      await registry.getAddress(),
      deployer.address
    );

    timelock = await (await ethers.getContractFactory("BagSweepTimelock")).deploy(
      MIN_DELAY,
      [deployer.address], // proposers
      [deployer.address], // executors
      deployer.address // admin (renounced in production after setup)
    );

    // Hand the executor's config ownership to the timelock.
    await executor.transferOwnership(await timelock.getAddress());
  });

  it("moves ownership of the config surface to the timelock", async function () {
    expect(await executor.owner()).to.equal(await timelock.getAddress());
    expect(await timelock.getMinDelay()).to.equal(MIN_DELAY);
  });

  it("blocks a direct setter call from the old EOA owner", async function () {
    await expect(executor.connect(deployer).setFeeBps(50))
      .to.be.revertedWithCustomError(executor, "OwnableUnauthorizedAccount");
  });

  it("requires schedule + delay + execute to change config", async function () {
    const target = await executor.getAddress();
    const data = executor.interface.encodeFunctionData("setFeeBps", [50]);
    const predecessor = ethers.ZeroHash;
    const salt = ethers.id("setFeeBps-50");

    await timelock.schedule(target, 0, data, predecessor, salt, MIN_DELAY);

    // Cannot execute before the delay elapses.
    await expect(timelock.execute(target, 0, data, predecessor, salt)).to.be.reverted;
    expect(await executor.feeBps()).to.equal(0n);

    // After the delay, execution lands.
    await time.increase(MIN_DELAY + 1);
    await timelock.execute(target, 0, data, predecessor, salt);
    expect(await executor.feeBps()).to.equal(50n);
  });

  it("only a proposer can queue an operation", async function () {
    const data = executor.interface.encodeFunctionData("setFeeBps", [50]);
    await expect(
      timelock
        .connect(other)
        .schedule(await executor.getAddress(), 0, data, ethers.ZeroHash, ethers.id("x"), MIN_DELAY)
    ).to.be.reverted; // AccessControlUnauthorizedAccount
  });

  it("rejects a minDelay below the sanity floor (no zero-delay timelock)", async function () {
    const Timelock = await ethers.getContractFactory("BagSweepTimelock");
    const roles = [[deployer.address], [deployer.address], deployer.address];
    await expect(Timelock.deploy(0, ...roles))
      .to.be.revertedWithCustomError(Timelock, "DelayTooShort");
    await expect(Timelock.deploy(60, ...roles))
      .to.be.revertedWithCustomError(Timelock, "DelayTooShort");
  });

  it("cannot bypass the on-chain fee cap even through governance", async function () {
    const target = await executor.getAddress();
    const data = executor.interface.encodeFunctionData("setFeeBps", [101]); // over MAX_FEE_BPS
    const salt = ethers.id("over-cap");

    await timelock.schedule(target, 0, data, ethers.ZeroHash, salt, MIN_DELAY);
    await time.increase(MIN_DELAY + 1);

    // The inner setFeeBps reverts FeeExceedsMax, so the timelock op fails too.
    await expect(timelock.execute(target, 0, data, ethers.ZeroHash, salt)).to.be.reverted;
    expect(await executor.feeBps()).to.equal(0n);
  });
});
