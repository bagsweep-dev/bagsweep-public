const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SmartAccountFactory", function () {
  let factory;
  let owner, user1, keeper;

  beforeEach(async function () {
    [owner, user1, keeper] = await ethers.getSigners();
    const F = await ethers.getContractFactory("SmartAccountFactory");
    factory = await F.deploy(keeper.address);
    await factory.waitForDeployment();
  });

  describe("createAccount", function () {
    it("should deploy a new SmartAccount and emit event", async function () {
      const tx = await factory.createAccount(user1.address, 0);
      const receipt = await tx.wait();

      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "AccountCreated"
      );
      expect(event).to.not.be.undefined;
      expect(event.args.ownerAddr).to.equal(user1.address);
      expect(event.args.keeper).to.equal(keeper.address);
    });

    it("should deploy different accounts for different salts", async function () {
      const tx0 = await factory.createAccount(user1.address, 0);
      const r0 = await tx0.wait();
      const addr0 = r0.logs.find(l => l.fragment?.name === "AccountCreated").args.account;

      const tx1 = await factory.createAccount(user1.address, 1);
      const r1 = await tx1.wait();
      const addr1 = r1.logs.find(l => l.fragment?.name === "AccountCreated").args.account;

      expect(addr0).to.not.equal(addr1);
      expect(await ethers.provider.getCode(addr0)).to.not.equal("0x");
      expect(await ethers.provider.getCode(addr1)).to.not.equal("0x");
    });

    it("should deploy different accounts for different owners", async function () {
      const tx0 = await factory.createAccount(user1.address, 0);
      const r0 = await tx0.wait();
      const addr0 = r0.logs.find(l => l.fragment?.name === "AccountCreated").args.account;

      const tx1 = await factory.createAccount(owner.address, 0);
      const r1 = await tx1.wait();
      const addr1 = r1.logs.find(l => l.fragment?.name === "AccountCreated").args.account;

      expect(addr0).to.not.equal(addr1);
    });

    it("should set correct owner and keeper on the deployed account", async function () {
      const tx = await factory.createAccount(user1.address, 0);
      const receipt = await tx.wait();
      const addr = receipt.logs.find(l => l.fragment?.name === "AccountCreated").args.account;

      const account = await ethers.getContractAt("SmartAccount", addr);
      expect(await account.owner()).to.equal(user1.address);
      expect(await account.keeper()).to.equal(keeper.address);
      expect(await account.factory()).to.equal(await factory.getAddress());
    });

    it("M1: account address is independent of defaultKeeper (no stranding on rotation)", async function () {
      // Predict the counterfactual address: depends only on (factory, salt, owner).
      const SA = await ethers.getContractFactory("SmartAccount");
      const initCode = ethers.concat([
        SA.bytecode,
        ethers.AbiCoder.defaultAbiCoder().encode(["address"], [user1.address]),
      ]);
      const salt = ethers.zeroPadValue(ethers.toBeHex(7), 32);
      const predicted = ethers.getCreate2Address(
        await factory.getAddress(), salt, ethers.keccak256(initCode)
      );

      // Rotate the default keeper BEFORE deploying to that address.
      await factory.setDefaultKeeper(owner.address);

      // Address is unchanged (deposits sent to `predicted` are safe), and the
      // freshly deployed account picks up the rotated keeper.
      const tx = await factory.createAccount(user1.address, 7);
      const r = await tx.wait();
      const actual = r.logs.find(l => l.fragment?.name === "AccountCreated").args.account;
      expect(actual.toLowerCase()).to.equal(predicted.toLowerCase());
      const account = await ethers.getContractAt("SmartAccount", actual);
      expect(await account.keeper()).to.equal(owner.address);
    });

    it("should expose accountInitCodeHash", async function () {
      const hash = await factory.accountInitCodeHash();
      expect(hash).to.match(/^0x[0-9a-f]{64}$/i);
    });
  });

  describe("getAddress (on-chain CREATE2 helper)", function () {
    it("should predict the correct address for a deployed account", async function () {
      // Use the actual creation code from the factory's compiled artifact
      const SmartAccountArtifact = await ethers.getContractFactory("SmartAccount");
      // The factory stores keccak256(type(SmartAccount).creationCode) as accountInitCodeHash
      // For the getAddress view function, we need the full init code
      const creationCode = SmartAccountArtifact.bytecode;
      const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [user1.address] // keeper is NOT a constructor arg (read from the factory)
      );
      const fullInitCode = ethers.concat([creationCode, constructorArgs]);
      const salt = ethers.zeroPadValue(ethers.toBeHex(0), 32);

      // Predict address via off-chain CREATE2 (same formula as on-chain)
      const factoryAddr = await factory.getAddress();
      const initCodeHash = ethers.keccak256(fullInitCode);
      const predicted = ethers.getCreate2Address(factoryAddr, salt, initCodeHash);

      // Actually deploy
      const tx = await factory.createAccount(user1.address, 0);
      const receipt = await tx.wait();
      const actual = receipt.logs.find(l => l.fragment?.name === "AccountCreated").args.account;

      expect(predicted.toLowerCase()).to.equal(actual.toLowerCase());
    });
  });

  describe("SmartAccount functionality", function () {
    let account;
    let accountAddr;

    beforeEach(async function () {
      const tx = await factory.createAccount(user1.address, 0);
      const receipt = await tx.wait();
      accountAddr = receipt.logs.find(l => l.fragment?.name === "AccountCreated").args.account;
      account = await ethers.getContractAt("SmartAccount", accountAddr);
    });

    it("should accept ETH deposits", async function () {
      await user1.sendTransaction({ to: accountAddr, value: ethers.parseEther("1") });
      expect(await ethers.provider.getBalance(accountAddr)).to.equal(ethers.parseEther("1"));
    });

    it("trusts the canonical v0.8 EntryPoint, not the OZ v0.9 default", async function () {
      // Regression guard for the EntryPoint-mismatch finding: OZ's Account base
      // defaults entryPoint() to v0.9, but the whole system (deploy script,
      // paymaster, deployed EntryPoint) targets v0.8. If the account trusted a
      // different EntryPoint than UserOps route through, validation would revert.
      const V08 = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
      const V09 = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
      expect(await account.entryPoint()).to.equal(V08);
      expect(await account.entryPoint()).to.not.equal(V09);
    });

    it("should allow owner to update keeper", async function () {
      await account.connect(user1).setKeeper(ethers.ZeroAddress);
      expect(await account.keeper()).to.equal(ethers.ZeroAddress);
    });

    it("should reject non-owner config changes", async function () {
      await expect(
        account.connect(keeper).setKeeper(ethers.ZeroAddress)
      ).to.be.revertedWith("not owner");
    });

    it("should allow owner to transfer ownership (two-step, L-1)", async function () {
      await account.connect(user1).transferOwnership(keeper.address);
      // Not transferred until accepted: guards against a mistyped new owner.
      expect(await account.pendingOwner()).to.equal(keeper.address);
      expect(await account.owner()).to.equal(user1.address);
      await account.connect(keeper).acceptOwnership();
      expect(await account.owner()).to.equal(keeper.address);
      expect(await account.signer()).to.equal(keeper.address);
      expect(await account.pendingOwner()).to.equal(ethers.ZeroAddress);
    });

    it("only the pending owner can accept ownership (L-1)", async function () {
      await account.connect(user1).transferOwnership(keeper.address);
      await expect(account.connect(user1).acceptOwnership()).to.be.revertedWith("not pending owner");
      expect(await account.owner()).to.equal(user1.address);
    });

    // ── Owner always-exit: direct, EntryPoint-independent escape hatch ──

    it("owner can exit ERC20 directly via ownerExecute (no EntryPoint)", async function () {
      const token = await (await ethers.getContractFactory("MockMemeToken")).deploy("Doge", "DOGE");
      await token.mint(accountAddr, ethers.parseEther("1000")); // funds sit in the account
      const data = token.interface.encodeFunctionData("transfer", [user1.address, ethers.parseEther("1000")]);
      // Owner sweeps them out with a direct call: no EntryPoint, bundler, or paymaster.
      await account.connect(user1).ownerExecute(await token.getAddress(), 0, data);
      expect(await token.balanceOf(user1.address)).to.equal(ethers.parseEther("1000"));
      expect(await token.balanceOf(accountAddr)).to.equal(0n);
    });

    it("owner can exit ETH directly via ownerExecute", async function () {
      await user1.sendTransaction({ to: accountAddr, value: ethers.parseEther("1") });
      const recipient = owner.address; // a different signer, so no gas accounting noise
      const before = await ethers.provider.getBalance(recipient);
      await account.connect(user1).ownerExecute(recipient, ethers.parseEther("1"), "0x");
      expect(await ethers.provider.getBalance(recipient)).to.equal(before + ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(accountAddr)).to.equal(0n);
    });

    it("blocks a non-owner from the escape hatch", async function () {
      await expect(
        account.connect(keeper).ownerExecute(user1.address, 0, "0x")
      ).to.be.revertedWith("not owner");
    });

    it("owner can batch-exit several assets via ownerExecuteBatch", async function () {
      const t1 = await (await ethers.getContractFactory("MockMemeToken")).deploy("A", "AAA");
      const t2 = await (await ethers.getContractFactory("MockMemeToken")).deploy("B", "BBB");
      await t1.mint(accountAddr, ethers.parseEther("10"));
      await t2.mint(accountAddr, ethers.parseEther("20"));
      const d1 = t1.interface.encodeFunctionData("transfer", [user1.address, ethers.parseEther("10")]);
      const d2 = t2.interface.encodeFunctionData("transfer", [user1.address, ethers.parseEther("20")]);
      await account.connect(user1).ownerExecuteBatch(
        [await t1.getAddress(), await t2.getAddress()],
        [0, 0],
        [d1, d2]
      );
      expect(await t1.balanceOf(user1.address)).to.equal(ethers.parseEther("10"));
      expect(await t2.balanceOf(user1.address)).to.equal(ethers.parseEther("20"));
    });
  });
});
