const { expect } = require("chai");
const { ethers } = require("hardhat");

// The verifying paymaster sponsors a UserOp only when it carries a valid signature
// from the configured sponsorSigner over that exact op. That is what stops the
// shared deposit from being drained by arbitrary callers: an unsigned or
// wrongly-signed op is rejected (sigFailed), and the sponsor backend decides and
// rate-limits which ops it signs off-chain.
describe("SweepPaymaster — verifying (sponsor-signed)", function () {
  let deployer, entryPoint, sponsor, other, sender;
  let paymaster;

  // 32 bytes of paymaster gas limits (verificationGasLimit || postOpGasLimit).
  const PM_GAS = ethers.concat([
    ethers.zeroPadValue(ethers.toBeHex(100000), 16),
    ethers.zeroPadValue(ethers.toBeHex(50000), 16),
  ]);

  const CAP = ethers.parseEther("0.001");
  const MASK160 = (1n << 160n) - 1n; // low 160 bits = authorizer (0 = success, 1 = failed)

  function baseUserOp(senderAddr, paymasterAddr) {
    return {
      sender: senderAddr,
      nonce: 0,
      initCode: "0x",
      callData: "0x1234",
      accountGasLimits: ethers.ZeroHash,
      preVerificationGas: 0,
      gasFees: ethers.ZeroHash,
      // [addr][pmGasLimits] is enough for getHash, which reads [20:52].
      paymasterAndData: ethers.concat([paymasterAddr, PM_GAS]),
      signature: "0x",
    };
  }

  function withPaymasterSig(op, paymasterAddr, validUntil, validAfter, sig) {
    return {
      ...op,
      paymasterAndData: ethers.concat([
        paymasterAddr,
        PM_GAS,
        ethers.zeroPadValue(ethers.toBeHex(validUntil), 6),
        ethers.zeroPadValue(ethers.toBeHex(validAfter), 6),
        sig,
      ]),
    };
  }

  async function signedOp(signer, senderAddr, validUntil = 0, validAfter = 0) {
    const pmAddr = await paymaster.getAddress();
    const op = baseUserOp(senderAddr, pmAddr);
    const hash = await paymaster.getHash(op, validUntil, validAfter);
    const sig = await signer.signMessage(ethers.getBytes(hash));
    return withPaymasterSig(op, pmAddr, validUntil, validAfter, sig);
  }

  const validate = (from, op, cost = CAP) =>
    paymaster.connect(from).validatePaymasterUserOp.staticCall(op, ethers.ZeroHash, cost);

  beforeEach(async function () {
    [deployer, entryPoint, sponsor, other, sender] = await ethers.getSigners();
    paymaster = await (await ethers.getContractFactory("SweepPaymaster")).deploy(entryPoint.address, deployer.address);
    await paymaster.setSponsorSigner(sponsor.address);
  });

  it("sponsors a UserOp signed by the sponsorSigner", async function () {
    const op = await signedOp(sponsor, sender.address);
    const [, validationData] = await validate(entryPoint, op);
    expect(validationData).to.equal(0n); // success, no time restriction
  });

  it("rejects a UserOp signed by a non-sponsor (drain vector closed)", async function () {
    const op = await signedOp(other, sender.address); // wrong signing key
    const [, validationData] = await validate(entryPoint, op);
    expect(validationData & MASK160).to.equal(1n); // SIG_VALIDATION_FAILED, not a revert
  });

  it("rejects a garbage sponsorship signature", async function () {
    const pmAddr = await paymaster.getAddress();
    const op = withPaymasterSig(baseUserOp(sender.address, pmAddr), pmAddr, 0, 0, "0x" + "11".repeat(65));
    const [, validationData] = await validate(entryPoint, op);
    expect(validationData & MASK160).to.equal(1n);
  });

  it("binds the signature to the op: tampering flips it to failed", async function () {
    const op = await signedOp(sponsor, sender.address);
    const tampered = { ...op, callData: "0x5678" }; // differs from what was signed
    const [, validationData] = await validate(entryPoint, tampered);
    expect(validationData & MASK160).to.equal(1n);
  });

  it("propagates the sponsorship time window into validationData", async function () {
    const op = await signedOp(sponsor, sender.address, 2_000_000_000, 1_000_000_000);
    const [, validationData] = await validate(entryPoint, op);
    expect(validationData & MASK160).to.equal(0n); // authorizer == success
    expect(validationData >> 160n).to.not.equal(0n); // a [validAfter, validUntil] window is packed
  });

  it("rejects a gas cost above the per-op ceiling", async function () {
    const op = await signedOp(sponsor, sender.address);
    await expect(validate(entryPoint, op, ethers.parseEther("1")))
      .to.be.revertedWithCustomError(paymaster, "CostTooHigh");
  });

  it("only the EntryPoint can call validation", async function () {
    const op = await signedOp(sponsor, sender.address);
    await expect(validate(other, op)).to.be.revertedWithCustomError(paymaster, "NotEntryPoint");
  });

  it("postOp counts gas from all modes, not only success (L5)", async function () {
    const cost = ethers.parseEther("0.0005");
    // opReverted (mode = 1) still debits the deposit, so it must be counted.
    await paymaster.connect(entryPoint).postOp(1, "0x", cost, 0);
    expect(await paymaster.totalGasSponsored()).to.equal(cost);
  });

  it("setSponsorSigner is owner-only and rotates the trusted key", async function () {
    await expect(paymaster.connect(other).setSponsorSigner(other.address))
      .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    await paymaster.setSponsorSigner(other.address); // rotate
    const op = await signedOp(other, sender.address); // `other` is now the sponsor
    const [, validationData] = await validate(entryPoint, op);
    expect(validationData).to.equal(0n);
  });
});
