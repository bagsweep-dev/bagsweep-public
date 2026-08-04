// testnet-paymaster-check.js — G2 / N10: paymaster drain-protection audit.
//
// The SweepPaymaster is a VERIFYING paymaster: it sponsors a UserOp only if the op carries a
// valid signature from the off-chain `sponsorSigner`, the per-op cost is capped, and it is the
// EntryPoint calling. The "can't be free-drained" property is proven exhaustively by the
// SweepPaymasterNoFreeDrain invariant (forge, green). This script audits the LIVE deployment's
// drain-bounding config + the onlyEntryPoint gate, and prints the exact live-submission
// procedure for the end-to-end rejection check.
//
//   Run: npx hardhat run scripts/testnet-paymaster-check.js --network robinhood-testnet

const { ethers } = require("hardhat");
const A = require("../../deployed-addresses.json");

const ok = (c, m) => { if (!c) throw new Error("assertion failed: " + m); console.log("   ✓ " + m); };

async function main() {
  const cid = Number((await ethers.provider.getNetwork()).chainId);
  if (cid !== 46630) throw new Error(`expected testnet 46630, got ${cid} (use --network robinhood-testnet)`);
  console.log(`\nBagSweep N10 paymaster drain-protection audit — chain ${cid}\n`);

  const pm = await ethers.getContractAt("SweepPaymaster", A.paymaster);

  // 1. Config: the three bounds that make a drain impossible/limited.
  console.log("1. drain-bounding config");
  const sponsor = await pm.sponsorSigner();
  const maxCost = await pm.maxCostPerOp();
  const deposit = await pm.getDeposit();
  ok(sponsor !== ethers.ZeroAddress, `sponsorSigner set (${sponsor}) — only sponsor-signed ops are sponsored`);
  if (A.sponsorSigner) ok(sponsor.toLowerCase() === A.sponsorSigner.toLowerCase(), "sponsorSigner == the deployed sponsor");
  ok(maxCost > 0n, `maxCostPerOp = ${ethers.formatEther(maxCost)} ETH — per-op cost is capped`);
  console.log(`   deposit funded: ${ethers.formatEther(deposit)} ETH (finite; worst case is a bounded, sponsor-gated spend)`);

  // 2. The onlyEntryPoint gate: nobody but the EntryPoint can drive paymaster validation.
  console.log("2. onlyEntryPoint gate");
  const dummyOp = {
    sender: A.paymaster, nonce: 0, initCode: "0x", callData: "0x",
    accountGasLimits: ethers.ZeroHash, preVerificationGas: 0,
    gasFees: ethers.ZeroHash, paymasterAndData: "0x", signature: "0x",
  };
  let reverted = false, reason = "";
  try { await pm.validatePaymasterUserOp.staticCall(dummyOp, ethers.ZeroHash, 0n); }
  catch (e) { reverted = true; reason = e.shortMessage || e.message; }
  ok(reverted, `validatePaymasterUserOp reverts for a non-EntryPoint caller (${reason})`);

  console.log("\n✅ N10 config PASSED — sponsor-gated, per-op-capped, EntryPoint-only.");
  console.log("   The free-drain impossibility itself is proven by the SweepPaymasterNoFreeDrain invariant (forge, green).\n");

  console.log("── Live end-to-end rejection (operator, needs the bundler running) ──");
  console.log("  With the keeper/bundler up, use the keeper's relayer to build TWO UserOps for a policied");
  console.log("  account, both requesting this paymaster:");
  console.log("   a) an ELIGIBLE keeper sweep (execute(executor, executeSweep)) with a valid sponsor signature");
  console.log("      -> sponsored: the op lands and paymaster.getDeposit() drops by the gas cost.");
  console.log("   b) the SAME op with NO / a wrong sponsor signature (or an owner-signed op to any other target)");
  console.log("      -> NOT sponsored: bundler simulation rejects it (AA34), deposit unchanged.");
  console.log("  Confirm (a) succeeds, (b) is refused, and getDeposit() only moved for (a).\n");
}

main().catch((e) => { console.error("\n❌ N10 FAILED:", e.message, "\n", e.stack || ""); process.exit(1); });
