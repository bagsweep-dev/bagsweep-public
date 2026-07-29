/**
 * BagSweep Keeper — Relayer
 * Takes a SweepPlan and constructs an ERC-4337 UserOperation.
 * Signs it with the keeper's private key.
 */
import { ethers } from "ethers";
import { config } from "./config.js";

const EXECUTOR_ABI = [
  "function executeSweep(tuple(address tokenIn, uint256 amountIn, uint256 spotQuote, address router, bytes swapData)[] swaps, uint8 dest, address stockTarget, uint256 stockSpotQuote)",
];

const SMART_ACCOUNT_ABI = [
  "function execute(address dest, uint256 value, bytes data) external payable returns (bytes)",
  "function getNonce() view returns (uint256)",
  "function getNonce(uint192 key) view returns (uint256)",
];

// v0.8 EntryPoint: canonical userOpHash used by the account's validation.
const ENTRYPOINT_ABI = [
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
];

// Verifying paymaster: the exact digest the sponsor signs (binds op + paymaster + chain).
const PAYMASTER_ABI = [
  "function getHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)",
];

let keeperWallet;
let sponsorWallet;
let entryPoint;
let paymasterContract;

/**
 * Initialize the relayer with the keeper's private key.
 */
export function initRelayer(provider) {
  keeperWallet = new ethers.Wallet(config.keeperKey, provider);
  if (config.entryPoint) {
    entryPoint = new ethers.Contract(config.entryPoint, ENTRYPOINT_ABI, provider);
  }
  if (config.paymaster && config.sponsorKey) {
    sponsorWallet = new ethers.Wallet(config.sponsorKey, provider);
    paymasterContract = new ethers.Contract(config.paymaster, PAYMASTER_ABI, provider);
    console.log(`[relayer] Sponsor signer: ${sponsorWallet.address}`);
  }
  console.log(`[relayer] Keeper address: ${keeperWallet.address}`);
}

/**
 * Build and sign a UserOperation from a SweepPlan.
 * @param {SweepPlan} plan
 * @returns {Promise<Object>} The packed UserOperation
 */
export async function buildUserOp(plan) {
  const { account, swaps, dest, stockTarget, stockSpotQuote } = plan;

  // 1. Encode the SweepExecutor.executeSweep call
  const executorIface = new ethers.Interface(EXECUTOR_ABI);
  const executorCallData = executorIface.encodeFunctionData("executeSweep", [
    swaps.map(s => ({
      tokenIn: s.tokenIn,
      amountIn: s.amountIn,
      spotQuote: s.spotQuote,
      router: s.router,
      swapData: s.swapData,
    })),
    dest,
    stockTarget,
    stockSpotQuote ?? 0, // required > 0 for STOCKS/SPLIT; the executor derives the floor
  ]);

  // 2. Wrap in SmartAccount.execute(SweepExecutor, 0, executorCallData)
  const accountIface = new ethers.Interface(SMART_ACCOUNT_ABI);
  const callData = accountIface.encodeFunctionData("execute", [
    config.executor,
    0,
    executorCallData,
  ]);

  // 3. Nonce + initCode. Fail loudly on an undeployed account instead of silently
  //    signing a doomed op (nonce 0 + empty initCode just reverts at the EntryPoint).
  //    If the plan carries the account's {ownerAddr, salt}, deploy it on the first
  //    sweep via initCode (counterfactual flow).
  const provider = keeperWallet.provider;
  const smartAccount = new ethers.Contract(account, SMART_ACCOUNT_ABI, provider);
  let nonce = 0n;
  let initCode = "0x";
  if ((await provider.getCode(account)) !== "0x") {
    nonce = await smartAccount.getNonce();
  } else if (plan.ownerAddr != null && plan.salt != null) {
    const factoryIface = new ethers.Interface(["function createAccount(address ownerAddr, uint256 salt)"]);
    initCode = ethers.concat([config.factory, factoryIface.encodeFunctionData("createAccount", [plan.ownerAddr, plan.salt])]);
  } else {
    throw new Error(`[relayer] account ${account} is not deployed and the plan has no {ownerAddr, salt} for initCode`);
  }

  // 3b. Gas fees from the chain. RH is ~0.01 gwei, so a hardcoded 10 gwei would
  //     demand a prefund far above the paymaster deposit; derive from the RPC.
  const feeData = await provider.getFeeData();
  const baseFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? 1_000_000_000n;
  const maxFeePerGas = baseFee * 2n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? baseFee;

  // 4. Build paymasterAndData
  let paymasterAndData = "0x";
  if (config.paymaster) {
    // Pack: paymaster address + verificationGasLimit + postOpGasLimit
    paymasterAndData = ethers.concat([
      config.paymaster,
      ethers.zeroPadValue(ethers.toBeHex(config.gas.pmVerification), 16),  // verificationGasLimit
      ethers.zeroPadValue(ethers.toBeHex(config.gas.pmPostOp), 16),        // postOpGasLimit
    ]);
  }

  // 5. Construct the PackedUserOperation
  const userOp = {
    sender: account,
    nonce: nonce.toString(),
    initCode,  // "0x" if deployed, else the factory createAccount payload
    callData,
    accountGasLimits: ethers.concat([
      ethers.zeroPadValue(ethers.toBeHex(config.gas.verification), 16),  // verificationGasLimit
      ethers.zeroPadValue(ethers.toBeHex(config.gas.call), 16),          // callGasLimit
    ]),
    preVerificationGas: config.gas.preVerification.toString(),
    gasFees: ethers.concat([
      ethers.zeroPadValue(ethers.toBeHex(maxPriorityFeePerGas), 16),
      ethers.zeroPadValue(ethers.toBeHex(maxFeePerGas), 16),
    ]),
    paymasterAndData,
    signature: "0x",  // placeholder
  };

  // 5b. Verifying paymaster: attach the sponsor signature. The paymaster's getHash
  //     reads the base paymasterAndData ([addr][gasLimits], bytes 20..52), which is
  //     already in place, so sign that digest and then finalize paymasterAndData
  //     with [validUntil][validAfter][sponsorSig]. Done BEFORE the account signature
  //     (step 6) because the account's userOpHash covers the full paymasterAndData.
  if (config.paymaster && sponsorWallet && paymasterContract) {
    const validAfter = 0;
    const validUntil = Math.floor(Date.now() / 1000) + 600; // sponsorship expires in 10 min
    const pmHash = await paymasterContract.getHash(userOp, validUntil, validAfter);
    const sponsorSig = await sponsorWallet.signMessage(ethers.getBytes(pmHash));
    userOp.paymasterAndData = ethers.concat([
      config.paymaster,
      ethers.zeroPadValue(ethers.toBeHex(config.gas.pmVerification), 16),
      ethers.zeroPadValue(ethers.toBeHex(config.gas.pmPostOp), 16),
      ethers.zeroPadValue(ethers.toBeHex(validUntil), 6),
      ethers.zeroPadValue(ethers.toBeHex(validAfter), 6),
      sponsorSig,
    ]);
  }

  // 6. Sign the UserOp with the keeper key.
  //    The account recovers this signature over the RAW EntryPoint userOpHash
  //    (v0.8 makes userOpHash directly signable — no EIP-191 prefix). Using
  //    personal_sign / signMessage here would NOT validate.
  if (!entryPoint) {
    throw new Error("[relayer] EntryPoint not configured — set ENTRY_POINT so UserOps can be hashed correctly");
  }
  const userOpHash = await entryPoint.getUserOpHash(userOp);
  userOp.signature = keeperWallet.signingKey.sign(userOpHash).serialized;

  return userOp;
}

/**
 * Get the keeper wallet address.
 */
export function getKeeperAddress() {
  return keeperWallet?.address || config.keeperAddr;
}
