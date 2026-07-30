import {
  type Address,
  type Hex,
  encodeFunctionData,
  createPublicClient,
  http,
  getCreate2Address,
  keccak256,
  encodeAbiParameters,
  concatHex,
  toHex,
} from "viem";
import { rhChain } from "../config/chains";
import { ADDR, registryAbi, erc20Abi } from "../config/contracts";
import { SMART_ACCOUNT_CREATION_CODE } from "../config/smartAccountBytecode";

// ─────────────────────────────────────────────────────────────────────────────
// Account interaction layer.
//
// DESIGN NOTE: the audit-frozen SmartAccount validates the OWNER's UserOp signature as a RAW
// ECDSA signature over the userOpHash (OZ Account._signableUserOpHash returns the hash
// unwrapped; SignerECDSA recovers over it directly). A browser wallet cannot produce that
// (personal_sign adds the EIP-191 prefix, signTypedData is EIP-712, and eth_sign is
// deprecated/blocked). So the owner does NOT drive gasless UserOps from the browser. Instead:
//
//   - The OWNER acts via direct EOA transactions: factory.createAccount(owner, salt) to deploy,
//     then account.ownerExecute(target, 0, <calldata>) for everything else. ownerExecute is the
//     account's always-available, bundler/paymaster-independent path. Cheap on RH's L2 gas.
//   - The KEEPER performs the gasless, paymaster-sponsored sweeps server-side (it holds a raw
//     key and signs the raw userOpHash), submitted through the self-hosted bundler. The browser
//     never talks to the bundler/paymaster for the MVP.
//
// This module provides the reads (address resolution, deployment + policy state) and the
// calldata builders the owner flows submit via wagmi's useWriteContract. Owner-gasless setup
// would need EIP-712/ERC-7739 owner-sig support added to the account (a post-audit change).
// ─────────────────────────────────────────────────────────────────────────────

export const publicClient = createPublicClient({ chain: rhChain, transport: http() });

/**
 * Counterfactual (CREATE2) smart-account address, computed CLIENT-SIDE (no RPC). The factory's
 * read is getAddress(bytes32 salt, bytes bytecode) over the full init code, NOT (owner, salt), so
 * an (owner, salt) call reverts (audit M-1). This reproduces the factory's own computation,
 * keccak256(0xff ++ factory ++ salt ++ keccak256(creationCode ++ abi.encode(owner)))[12:], and is
 * verified on-chain to equal factory.getAddress; keccak256(creationCode) == accountInitCodeHash.
 */
export function getSmartAccountAddress(owner: Address, salt = 0n): Address {
  const initCode = concatHex([
    SMART_ACCOUNT_CREATION_CODE,
    encodeAbiParameters([{ type: "address" }], [owner]),
  ]);
  return getCreate2Address({
    from: ADDR.factory,
    salt: toHex(salt, { size: 32 }),
    bytecodeHash: keccak256(initCode),
  });
}

/** Whether an address has contract code (i.e. the account is deployed). */
export async function isDeployed(addr: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address: addr });
  return !!code && code !== "0x";
}

/** The account's configured sweep executor (zero until setSweepExecutor is called). */
export async function getSweepExecutor(account: Address): Promise<Address> {
  return publicClient.readContract({ address: account, abi: accountAbiView, functionName: "sweepExecutor" });
}

/** Read the account's active sweep policy from the registry (keyed by the account). */
export async function getPolicy(account: Address) {
  return publicClient.readContract({
    address: ADDR.registry,
    abi: registryAbi,
    functionName: "getPolicy",
    args: [account],
  });
}

// ── calldata the account runs via ownerExecute(target, 0, <this>) ──

/** registry.setPolicy(...) — pct/maxSlippageBps in bps, minUsd in 6-dp USDG. */
export function encodeSetPolicy(p: {
  pct: number;
  minUsd: bigint;
  mode: number;
  dest: number;
  tokenWhitelist: Address[];
  maxSlippageBps: number;
}): Hex {
  return encodeFunctionData({
    abi: registryAbi,
    functionName: "setPolicy",
    args: [p.pct, p.minUsd, p.mode, p.dest, p.tokenWhitelist, p.maxSlippageBps],
  });
}

/** registry.revokePolicy() — turns the keeper off for this account. */
export function encodeRevoke(): Hex {
  return encodeFunctionData({ abi: registryAbi, functionName: "revokePolicy", args: [] });
}

/** token.transfer(owner, amount) — used to self-exit a position via ownerExecute(token, 0, ...). */
export function encodeErc20Transfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
}

// Minimal view ABI (kept local; the writes use accountAbi from contracts.ts via wagmi).
const accountAbiView = [
  { type: "function", name: "sweepExecutor", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;
