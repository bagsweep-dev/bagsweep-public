/**
 * BagSweep Keeper — Buyback job
 * Periodically triggers SweepBuyback.buybackAndBurn: swap accumulated USDG protocol fees
 * into $REAP and burn them to 0x…dEaD. buybackAndBurn is keeper-gated on-chain, so this
 * submits a DIRECT keeper transaction (not a 4337 UserOp). It is cooldown- and cap-aware
 * (mirrors the contract's checks so it never submits a reverting tx) and derives
 * minSweepOut from the V3 Quoter, the way the evaluator does for sweeps.
 *
 * $REAP is read from buyback.sweepToken(), so this is agnostic to how the token was
 * created (launchpad or otherwise). No-op until the token is set (post-launch).
 */
import { ethers } from "ethers";
import { config } from "./config.js";
import { getProvider } from "./monitor.js";
import { encodeV3Path } from "./router.js";

const ZERO = "0x0000000000000000000000000000000000000000";

const BUYBACK_ABI = [
  "function sweepToken() view returns (address)",
  "function maxSpendBps() view returns (uint256)",
  "function cooldown() view returns (uint256)",
  "function lastBuyback() view returns (uint256)",
  "function buybackAndBurn(uint256 usdgAmount, uint256 minSweepOut, address router, bytes swapData) returns (uint256)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const ADAPTER_ABI = ["function feeFor(address a, address b) view returns (uint24)"];
const QUOTER_ABI = ["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] a, uint32[] b, uint256 c)"];
const SWAP_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
]);

/**
 * Pure eligibility + sizing for a buyback. The contract caps spend at maxSpendBps of the
 * current balance and enforces a cooldown; this mirrors both so we never submit a tx that
 * would revert. All USDG amounts are BigInt (6dp); times are seconds.
 * @returns {{eligible:true, usdgAmount:bigint} | {eligible:false, reason:string}}
 */
export function planBuyback({ usdgBalance, maxSpendBps, cooldown, lastBuyback, now, minBuybackUsd6, sweepTokenSet }) {
  if (!sweepTokenSet) return { eligible: false, reason: "sweep token not set (pre-launch)" };
  if (now < lastBuyback + cooldown) return { eligible: false, reason: `cooldown (${lastBuyback + cooldown - now}s left)` };
  const usdgAmount = (usdgBalance * BigInt(maxSpendBps)) / 10000n; // the contract's per-call cap
  if (usdgAmount < minBuybackUsd6) return { eligible: false, reason: `spendable ${usdgAmount} < min ${minBuybackUsd6}` };
  return { eligible: true, usdgAmount };
}

/**
 * Run one buyback cycle. Returns the tx hash, or null when it's a no-op (disabled,
 * pre-launch, on cooldown, under the min threshold, or the USDG/$REAP pool isn't quotable).
 */
export async function runBuyback(provider = getProvider()) {
  if (!config.buyback || !config.sweepRouter || !config.quoter) {
    console.warn("[buyback] needs BUYBACK_ADDR + sweepRouter + QUOTER_ADDR; skipping");
    return null;
  }
  const wallet = new ethers.Wallet(config.keeperKey, provider);
  const buyback = new ethers.Contract(config.buyback, BUYBACK_ABI, wallet);
  const usdgC = new ethers.Contract(config.usdg, ERC20_ABI, provider);

  const [sweepToken, maxSpendBps, cooldown, lastBuyback, usdgBalance, block] = await Promise.all([
    buyback.sweepToken(), buyback.maxSpendBps(), buyback.cooldown(), buyback.lastBuyback(),
    usdgC.balanceOf(config.buyback), provider.getBlock("latest"),
  ]);

  const plan = planBuyback({
    usdgBalance,
    maxSpendBps: Number(maxSpendBps),
    cooldown: Number(cooldown),
    lastBuyback: Number(lastBuyback),
    now: block.timestamp,
    minBuybackUsd6: config.minBuybackUsd6,
    sweepTokenSet: sweepToken !== ZERO,
  });
  if (!plan.eligible) { console.log(`[buyback] skip: ${plan.reason}`); return null; }

  // Quote USDG -> $REAP on the direct pool via the adapter's configured fee tier.
  const adapter = new ethers.Contract(config.sweepRouter, ADAPTER_ABI, provider);
  const quoter = new ethers.Contract(config.quoter, QUOTER_ABI, provider);
  const fee = Number(await adapter.feeFor(config.usdg, sweepToken));
  if (!fee) { console.warn("[buyback] no USDG/$REAP fee configured on the adapter; skipping"); return null; }
  let quoted;
  try { quoted = (await quoter.quoteExactInput.staticCall(encodeV3Path([config.usdg, sweepToken], [fee]), plan.usdgAmount))[0]; }
  catch (e) { console.warn(`[buyback] quote failed (${e.message}); skipping`); return null; }
  if (!quoted || BigInt(quoted) <= 0n) { console.warn("[buyback] quote returned 0; skipping"); return null; }

  const minOut = (BigInt(quoted) * BigInt(10000 - config.buybackSlippageBps)) / 10000n;
  const deadline = block.timestamp + 300;
  const swapData = SWAP_IFACE.encodeFunctionData("swapExactTokensForTokens", [
    plan.usdgAmount, minOut, [config.usdg, sweepToken], config.buyback, deadline,
  ]);

  // Simulate first: a plan-byte / pool / cooldown / floor failure reverts here for free
  // (eth_call) instead of burning keeper gas on a doomed on-chain tx. Especially valuable
  // for the V4 adapter, whose failures surface as opaque router reverts.
  try {
    await buyback.buybackAndBurn.staticCall(plan.usdgAmount, minOut, config.sweepRouter, swapData);
  } catch (e) {
    console.warn(`[buyback] simulation reverted (${e.shortMessage || e.message}); not submitting`);
    return null;
  }

  const tx = await buyback.buybackAndBurn(plan.usdgAmount, minOut, config.sweepRouter, swapData);
  console.log(`[buyback] submitted ${tx.hash} (spend ${plan.usdgAmount} USDG, minOut ${minOut} $REAP)`);
  const rc = await tx.wait();
  console.log(`[buyback] burned in block ${rc?.blockNumber}`);
  return tx.hash;
}
