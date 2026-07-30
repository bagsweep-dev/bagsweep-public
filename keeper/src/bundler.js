/**
 * BagSweep Keeper — Bundler Client
 * Submits signed UserOperations to an ERC-4337 bundler endpoint.
 */
import { config } from "./config.js";
import { dataSlice, dataLength } from "ethers";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Submit a signed UserOperation to the bundler.
 * @param {Object} userOp - The signed PackedUserOperation
 * @returns {Promise<string|null>} - The UserOp hash, or null on failure
 */
export async function submitUserOp(userOp) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // The op arrives already signed by the relayer. Both signatures — the account's
      // (over the EntryPoint userOpHash) and the sponsor's (over the paymaster getHash)
      // — cover preVerificationGas and the gas limits, so mutating ANY field here would
      // invalidate both and the op could never land. Submit it verbatim. Gas must be
      // estimated BEFORE signing (in the relayer), never after. (v2 audit M-1 / L-6)
      const result = await bundlerRpc("eth_sendUserOperation", [
        serializeUserOp(userOp),
        getEntryPointAddress(),
      ]);

      if (result.result) {
        console.log(`[bundler] UserOp submitted: ${result.result}`);
        return result.result;
      }

      if (result.error) {
        console.error(`[bundler] Submission error: ${result.error.message} (code ${result.error.code})`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      return null;
    } catch (err) {
      console.error(`[bundler] Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
  return null;
}

/**
 * Wait for a UserOp to be mined and return the receipt.
 */
export async function waitForUserOp(userOpHash, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await bundlerRpc("eth_getUserOperationReceipt", [userOpHash]);
      if (result.result) {
        return result.result;
      }
    } catch {
      // not yet mined
    }
    await sleep(2000);
  }
  return null;
}

/**
 * Check if the bundler is reachable.
 */
export async function checkBundlerHealth() {
  try {
    const result = await bundlerRpc("eth_chainId", []);
    return { ok: true, chainId: result.result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Internal ──

async function bundlerRpc(method, params) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  });

  const res = await fetch(config.bundlerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Bundler HTTP ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

/**
 * Serialize a UserOp for JSON-RPC. The relayer builds the PACKED PackedUserOperation
 * (the on-chain handleOps struct), but `eth_sendUserOperation` takes the UNPACKED
 * ERC-4337 v0.7/v0.8 shape, so unpack the composite fields here. The unpacking is the
 * exact inverse of the relayer's packing, so a bundler re-packing these fields recomputes
 * the identical userOpHash and both signatures stay valid:
 *   accountGasLimits = verificationGasLimit(16) ++ callGasLimit(16)
 *   gasFees          = maxPriorityFeePerGas(16) ++ maxFeePerGas(16)
 *   initCode         = factory(20) ++ factoryData
 *   paymasterAndData = paymaster(20) ++ pmVerificationGas(16) ++ pmPostOpGas(16) ++ paymasterData
 */
function serializeUserOp(op) {
  const qty = (hex) => "0x" + BigInt(hex).toString(16);
  const out = {
    sender: op.sender,
    nonce: toHex(op.nonce),
    callData: op.callData,
    verificationGasLimit: qty(dataSlice(op.accountGasLimits, 0, 16)),
    callGasLimit: qty(dataSlice(op.accountGasLimits, 16, 32)),
    preVerificationGas: toHex(op.preVerificationGas),
    maxPriorityFeePerGas: qty(dataSlice(op.gasFees, 0, 16)),
    maxFeePerGas: qty(dataSlice(op.gasFees, 16, 32)),
    signature: op.signature,
  };
  if (op.initCode && op.initCode !== "0x" && dataLength(op.initCode) >= 20) {
    out.factory = dataSlice(op.initCode, 0, 20);
    out.factoryData = dataLength(op.initCode) > 20 ? dataSlice(op.initCode, 20) : "0x";
  }
  if (op.paymasterAndData && op.paymasterAndData !== "0x" && dataLength(op.paymasterAndData) >= 52) {
    out.paymaster = dataSlice(op.paymasterAndData, 0, 20);
    out.paymasterVerificationGasLimit = qty(dataSlice(op.paymasterAndData, 20, 36));
    out.paymasterPostOpGasLimit = qty(dataSlice(op.paymasterAndData, 36, 52));
    out.paymasterData = dataLength(op.paymasterAndData) > 52 ? dataSlice(op.paymasterAndData, 52) : "0x";
  }
  return out;
}

function toHex(val) {
  if (typeof val === "string" && val.startsWith("0x")) return val;
  return "0x" + BigInt(val).toString(16);
}

function getEntryPointAddress() {
  // Centralized from config (falls back to the canonical v0.8 EntryPoint), so the
  // bundler and the relayer always agree on the EntryPoint.
  return config.entryPoint || "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
