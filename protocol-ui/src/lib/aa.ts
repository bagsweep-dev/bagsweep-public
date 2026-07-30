import {
  type Address,
  type Hex,
  encodeFunctionData,
  createPublicClient,
  http,
} from "viem";
import { rhChain } from "../config/chains";
import { ADDR, accountAbi, factoryAbi } from "../config/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// ERC-4337 plumbing for the BagSweep custom SmartAccount.
//
// This is the one non-mechanical piece of the phase-2 UI. permissionless.js gives us
// the bundler client + gas estimation + the sponsor (paymaster) round-trip; what it does
// NOT know is how OUR account encodes a batch and how it signs a UserOp. Those two hooks
// are what the adapter below has to supply. Everything else (getFactoryArgs, getAddress,
// getNonce against the EntryPoint) is standard and wired here.
//
// Build + test this against TESTNET first (chain 46630 + a testnet bundler). The read/exit
// paths (ownerExecute) do not need any of this and work today.
// ─────────────────────────────────────────────────────────────────────────────

export const publicClient = createPublicClient({ chain: rhChain, transport: http() });

const requireEnv = (v: string, name: string) => {
  if (!v) throw new Error(`Missing ${name}. Fill it in .env.local (see .env.example).`);
  return v;
};

/** Counterfactual smart-account address for an owner (salt defaults to 0). */
export async function getSmartAccountAddress(owner: Address, salt = 0n): Promise<Address> {
  return publicClient.readContract({
    address: ADDR.factory,
    abi: factoryAbi,
    functionName: "getAddress",
    args: [owner, salt],
  });
}

/** factory + factoryData for the account's first UserOp (deploy-on-first-use). */
export function getFactoryArgs(owner: Address, salt = 0n): { factory: Address; factoryData: Hex } {
  return {
    factory: ADDR.factory,
    factoryData: encodeFunctionData({
      abi: factoryAbi,
      functionName: "createAccount",
      args: [owner, salt],
    }),
  };
}

/** Encode a single call as the account's execute() calldata (the UserOp callData). */
export function encodeExecute(to: Address, value: bigint, data: Hex): Hex {
  return encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [to, value, data] });
}

// TODO(aa): build the permissionless smart-account client. Sketch:
//
//   import { createSmartAccountClient } from "permissionless";
//   import { createBundlerClient, entryPoint08Address } from "viem/account-abstraction";
//   import { toSmartAccount } from "viem/account-abstraction";
//
//   1. const account = await toSmartAccount({
//        client: publicClient,
//        entryPoint: { address: ADDR.entryPoint, version: "0.8" },
//        getAddress: () => getSmartAccountAddress(owner, salt),
//        getFactoryArgs: async () => getFactoryArgs(owner, salt),
//        encodeCalls: (calls) => encodeExecute(calls[0].to, calls[0].value ?? 0n, calls[0].data ?? "0x"),
//        //  ^ MVP does one call per op; batch = a multicall/executeBatch variant if the account has one.
//        getNonce: async () => /* EntryPoint.getNonce(account, key) */,
//        getStubSignature: async () => "0x" /* dummy sig of the right length for gas estimation */,
//        signUserOperation: async (userOp) => /* sign per SmartAccount.validateUserOp's scheme (EIP-712 or the EntryPoint userOpHash); confirm against the contract */,
//      });
//
//   2. const bundler = createBundlerClient({ client: publicClient, transport: http(requireEnv(import.meta.env.VITE_BUNDLER_URL, "VITE_BUNDLER_URL")) });
//
//   3. gasless: attach the verifying paymaster. Our SweepPaymaster is sponsor-signed, so the
//      client needs a getPaymasterData/getPaymasterStubData that calls VITE_PAYMASTER_URL to
//      fetch the sponsor signature for the userOp, returning { paymaster: ADDR.paymaster, paymasterData }.
//
//   4. return createSmartAccountClient({ account, bundler, chain: rhChain, paymaster });
//
// Confirm (2) the userOp hash / signature scheme against SweepAccount.validateUserOp and
// (3) the SweepPaymaster sponsor payload before trusting a send. Until then, sendUserOp throws.
export async function getSmartAccountClient(_owner: Address, _salt = 0n): Promise<never> {
  requireEnv(import.meta.env.VITE_BUNDLER_URL, "VITE_BUNDLER_URL");
  throw new Error(
    "AA client not wired yet: implement the toSmartAccount adapter (signUserOperation + paymaster sponsor call). See TODO in src/lib/aa.ts."
  );
}
