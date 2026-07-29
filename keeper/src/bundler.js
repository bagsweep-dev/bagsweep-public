/**
 * BagSweep Keeper — Bundler Client
 * Submits signed UserOperations to an ERC-4337 bundler endpoint.
 */
import { config } from "./config.js";

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
 * Serialize a UserOp for JSON-RPC (convert all fields to hex strings).
 */
function serializeUserOp(op) {
  return {
    sender: op.sender,
    nonce: toHex(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: toHex(op.preVerificationGas),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
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
