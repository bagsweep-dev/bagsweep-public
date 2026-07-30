/**
 * BagSweep Keeper — Main Entry Point
 * Orchestrates: Monitor → Evaluator → Relayer → Bundler
 */
import { config, validateConfig } from "./config.js";
import { initMonitor, backfillPolicies, pollEvents, markSwept } from "./monitor.js";
import { evaluateAll, getEvaluatorStats, auditRouteFees } from "./evaluator.js";
import { initRelayer, buildUserOp, getKeeperAddress } from "./relayer.js";
import { submitUserOp, waitForUserOp, checkBundlerHealth } from "./bundler.js";
import { runBuyback } from "./buyback.js";

// ── Stats ──
const stats = {
  startedAt:      Date.now(),
  pollCycles:     0,
  evalCycles:     0,
  sweepsAttempted: 0,
  sweepsSucceeded: 0,
  sweepsFailed:    0,
  lastPollTs:      0,
  lastEvalTs:      0,
  lastSweepTs:     0,
};

/**
 * Self-rescheduling loop: the next tick is scheduled `intervalMs` AFTER the previous one
 * finishes, so overlapping cycles are structurally impossible (a slow cycle can never stack
 * a second copy on top of itself). This turns a fixed rate into a fixed gap, which is what a
 * keeper wants. (audit P-1)
 */
function loop(name, fn, intervalMs, initialDelayMs = 0) {
  const tick = async () => {
    try { await fn(); }
    catch (e) { console.error(`[${name}] cycle error:`, e.message); }
    setTimeout(tick, intervalMs).unref?.();
  };
  setTimeout(tick, initialDelayMs).unref?.();
}

/**
 * Boot the keeper service.
 */
async function main() {
  console.log("═══════════════════════════════════════");
  console.log(" BagSweep Keeper Service v0.1.0");
  console.log("═══════════════════════════════════════");

  // Validate config
  const errors = validateConfig();
  if (errors.length > 0) {
    console.error("\nConfiguration errors:");
    errors.forEach(e => console.error(`  ✗ ${e}`));
    console.error("\nSet the required environment variables and restart.");
    process.exit(1);
  }

  console.log(`  Chain:    ${config.chainId}`);
  console.log(`  RPC:      ${config.rpcUrl}`);
  console.log(`  Registry: ${config.registry}`);
  console.log(`  Executor: ${config.executor}`);
  console.log(`  Bundler:  ${config.bundlerUrl}`);
  console.log(`  Poll:     ${config.pollIntervalMs}ms`);
  console.log(`  Eval:     ${config.evalIntervalMs}ms`);
  console.log(`  Cooldown: ${config.sweepCooldownMs}ms`);
  console.log("");

  // Initialize subsystems
  initMonitor();
  await backfillPolicies();

  // Relayer needs the monitor's provider
  const { getProvider } = await import("./monitor.js");
  initRelayer(getProvider());

  // Check bundler health
  const health = await checkBundlerHealth();
  if (health.ok) {
    console.log(`[boot] Bundler healthy (chainId: ${health.chainId})`);
  } else {
    console.warn(`[boot] Bundler unreachable: ${health.error} (will retry)`);
  }

  // ── Main loop ──
  console.log("\n[keeper] Running...\n");

  // Each job is an overlap-safe self-rescheduling loop (see loop() / audit P-1).

  // Poll for policy changes
  loop("poll", async () => {
    stats.pollCycles++;
    stats.lastPollTs = Date.now();
    await pollEvents();
  }, config.pollIntervalMs);

  // Evaluate and execute sweeps (first run after a short delay)
  loop("eval", async () => {
    stats.evalCycles++;
    stats.lastEvalTs = Date.now();
    await runEvalCycle();
  }, config.evalIntervalMs, 5000);

  // Periodic cross-tier fee sanity check (H-2 residual): warn if any configured pool fee
  // tier isn't the deepest. Read-only, never gates a sweep.
  loop("feeaudit", auditRouteFees, config.auditIntervalMs, 8000);

  // Buyback-and-burn job. OFF until $REAP launches (BUYBACK_ENABLED=1). Cooldown-gated
  // on-chain, so a frequent tick is safe: it no-ops until eligible.
  if (config.buybackEnabled) {
    loop("buyback", runBuyback, config.buybackIntervalMs, 12000);
    console.log(`[boot] Buyback job enabled (every ${config.buybackIntervalMs}ms, cooldown-gated)`);
  }
}

/**
 * Run one evaluation + execution cycle.
 */
async function runEvalCycle() {
  let plans;
  try {
    plans = await evaluateAll();
  } catch (err) {
    console.error("[eval] Cycle error:", err.message);
    return;
  }

  if (plans.length === 0) {
    console.log(`[eval] No sweeps needed`);
    return;
  }

  console.log(`[eval] ${plans.length} sweep plan(s) ready`);

  // Submit each UserOp sequentially (cheap), then confirm them all CONCURRENTLY. Total wait is
  // then ~the slowest op, not the sum of every op's confirmation, so N ready sweeps no longer
  // take N x (up to 60s). Nonce discipline holds: each UserOp carries its own account's
  // EntryPoint nonce, not a shared keeper-EOA nonce. (audit P-3)
  const submitted = [];
  for (const plan of plans) {
    console.log(`[eval] Sweep: ${plan.account}, ${plan.swaps.length} token(s), ~$${plan.estimatedOutputUsd.toFixed(2)} est. output`);
    stats.sweepsAttempted++;
    stats.lastSweepTs = Date.now();
    try {
      const userOp = await buildUserOp(plan);
      const opHash = await submitUserOp(userOp);
      if (opHash) {
        console.log(`[sweep] UserOp hash: ${opHash}`);
        submitted.push({ plan, opHash });
      } else {
        stats.sweepsFailed++;
        console.error(`[sweep] Failed to submit UserOp for ${plan.account}`);
      }
    } catch (err) {
      stats.sweepsFailed++;
      console.error(`[sweep] Execution error for ${plan.account}:`, err.message);
    }
  }

  await Promise.allSettled(submitted.map(async ({ plan, opHash }) => {
    try {
      const receipt = await waitForUserOp(opHash);
      if (receipt && receipt.success) {
        stats.sweepsSucceeded++;
        markSwept(plan.account);
        console.log(`[sweep] Success: ${plan.account} tx: ${receipt.receipt?.transactionHash || opHash}`);
      } else {
        stats.sweepsFailed++;
        console.error(`[sweep] UserOp reverted for ${plan.account}`);
      }
    } catch (err) {
      stats.sweepsFailed++;
      console.error(`[sweep] Confirmation error for ${plan.account}:`, err.message);
    }
  }));
}

/**
 * Get keeper stats (for the API layer).
 */
export function getStats() {
  return {
    ...stats,
    keeper: getKeeperAddress(),
    evaluator: getEvaluatorStats(),
  };
}

// ── Start ──
main().catch((err) => {
  console.error("[keeper] Fatal error:", err);
  process.exit(1);
});
