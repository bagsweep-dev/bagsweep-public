const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SweepPolicyRegistry", function () {
  let registry;
  let owner, user1, user2;

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("SweepPolicyRegistry");
    registry = await Factory.deploy(owner.address);
    await registry.waitForDeployment();
  });

  describe("setPolicy", function () {
    it("should create a policy with valid params", async function () {
      await registry.connect(user1).setPolicy(
        500,        // 5%
        10_000_000, // $10 minUsd (6 decimals)
        0,          // POSITION
        0,          // USDG_YIELD
        [],         // no whitelist
        300         // 3% max slippage
      );

      const p = await registry.getPolicy(user1.address);
      expect(p.pct).to.equal(500);
      expect(p.maxSlippageBps).to.equal(300);
      expect(p.minUsd).to.equal(10_000_000);
      expect(p.mode).to.equal(0); // POSITION
      expect(p.dest).to.equal(0); // USDG_YIELD
      expect(p.active).to.be.true;
      expect(p.tokenWhitelist.length).to.equal(0);
    });

    it("should revert if maxSlippageBps exceeds MAX_SLIPPAGE_BPS (5000)", async function () {
      await expect(
        registry.connect(user1).setPolicy(500, 0, 0, 0, [], 5001)
      ).to.be.revertedWithCustomError(registry, "InvalidSlippage");
    });

    it("should revert if the token whitelist exceeds MAX_WHITELIST (50)", async function () {
      const tooMany = Array.from(
        { length: 51 },
        (_, i) => ethers.zeroPadValue(ethers.toBeHex(i + 1), 20)
      );
      await expect(
        registry.connect(user1).setPolicy(500, 0, 0, 0, tooMany, 300)
      ).to.be.revertedWithCustomError(registry, "WhitelistTooLong");
    });

    it("should update an existing policy", async function () {
      await registry.connect(user1).setPolicy(500, 10_000_000, 0, 0, [], 0);
      await registry.connect(user1).setPolicy(1000, 5_000_000, 1, 1, [], 0);

      const p = await registry.getPolicy(user1.address);
      expect(p.pct).to.equal(1000);
      expect(p.minUsd).to.equal(5_000_000);
      expect(p.mode).to.equal(1); // PROFITS
      expect(p.dest).to.equal(1); // STOCKS
    });

    it("should accept a token whitelist", async function () {
      const tokens = [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
      ];
      await registry.connect(user1).setPolicy(500, 0, 0, 0, tokens, 0);

      const p = await registry.getPolicy(user1.address);
      expect(p.tokenWhitelist.length).to.equal(2);
      expect(p.tokenWhitelist[0]).to.equal(tokens[0]);
      expect(p.tokenWhitelist[1]).to.equal(tokens[1]);
    });

    it("should revert if pct is 0", async function () {
      await expect(
        registry.connect(user1).setPolicy(0, 0, 0, 0, [], 0)
      ).to.be.revertedWithCustomError(registry, "InvalidPercentage");
    });

    it("should revert if pct exceeds MAX_PCT (2500)", async function () {
      await expect(
        registry.connect(user1).setPolicy(2501, 0, 0, 0, [], 0)
      ).to.be.revertedWithCustomError(registry, "InvalidPercentage");
    });

    it("should revert when paused", async function () {
      await registry.setPaused(true);
      await expect(
        registry.connect(user1).setPolicy(500, 0, 0, 0, [], 0)
      ).to.be.revertedWithCustomError(registry, "Paused");
    });

    it("should emit PolicySet event", async function () {
      await expect(
        registry.connect(user1).setPolicy(500, 0, 0, 2, [], 0)
      )
        .to.emit(registry, "PolicySet")
        .withArgs(user1.address, 500, 0, 2, (ts) => ts > 0);
    });
  });

  describe("revokePolicy", function () {
    it("should revoke an active policy", async function () {
      await registry.connect(user1).setPolicy(500, 0, 0, 0, [], 0);
      await registry.connect(user1).revokePolicy();

      const p = await registry.getPolicy(user1.address);
      expect(p.active).to.be.false;
    });

    it("should revert if no active policy", async function () {
      await expect(
        registry.connect(user1).revokePolicy()
      ).to.be.revertedWithCustomError(registry, "PolicyNotFound");
    });

    it("should emit PolicyRevoked event", async function () {
      await registry.connect(user1).setPolicy(500, 0, 0, 0, [], 0);
      await expect(registry.connect(user1).revokePolicy())
        .to.emit(registry, "PolicyRevoked");
    });
  });

  describe("policyCount / getActiveAccounts", function () {
    it("should count active policies correctly", async function () {
      await registry.connect(user1).setPolicy(500, 0, 0, 0, [], 0);
      await registry.connect(user2).setPolicy(1000, 0, 1, 1, [], 0);

      expect(await registry.policyCount()).to.equal(2);
    });

    it("should decrement count after revoke", async function () {
      await registry.connect(user1).setPolicy(500, 0, 0, 0, [], 0);
      await registry.connect(user2).setPolicy(1000, 0, 1, 1, [], 0);
      await registry.connect(user1).revokePolicy();

      expect(await registry.policyCount()).to.equal(1);
    });

    it("should return only active accounts", async function () {
      await registry.connect(user1).setPolicy(500, 0, 0, 0, [], 0);
      await registry.connect(user2).setPolicy(1000, 0, 1, 1, [], 0);
      await registry.connect(user1).revokePolicy();

      const active = await registry.getActiveAccounts();
      expect(active.length).to.equal(1);
      expect(active[0]).to.equal(user2.address);
    });

    it("M7: prunes on revoke (swap-and-pop) keeping enumeration intact", async function () {
      const [, , , user3] = await ethers.getSigners();
      await registry.connect(user1).setPolicy(500, 0, 0, 0, [], 0);
      await registry.connect(user2).setPolicy(500, 0, 0, 0, [], 0);
      await registry.connect(user3).setPolicy(500, 0, 0, 0, [], 0);

      // Revoke the MIDDLE account; swap-and-pop must keep the other two enumerable.
      await registry.connect(user2).revokePolicy();
      let active = await registry.getActiveAccounts();
      expect(active.length).to.equal(2);
      expect(active).to.include(user1.address);
      expect(active).to.include(user3.address);
      expect(active).to.not.include(user2.address);

      // Re-adding the revoked account re-enumerates it (list == active set).
      await registry.connect(user2).setPolicy(500, 0, 0, 0, [], 0);
      active = await registry.getActiveAccounts();
      expect(active.length).to.equal(3);
      expect(active).to.include(user2.address);
      expect(await registry.totalAccounts()).to.equal(3);
    });
  });

  describe("admin", function () {
    it("should allow owner to toggle pause", async function () {
      await registry.setPaused(true);
      expect(await registry.paused()).to.be.true;
      await registry.setPaused(false);
      expect(await registry.paused()).to.be.false;
    });

    it("should reject non-owner pause toggle", async function () {
      await expect(
        registry.connect(user1).setPaused(true)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });
});
