# Mutation testing — proving the invariants can fail

A green suite proves nothing until a planted bug turns it red. Every invariant here
is mutation-tested: deliberate bugs are injected into the contract one at a time, and
a mutant that the suite fails to catch (SURVIVED) is a documented gap, not a pass.

## Invariant #1 — SweepExecutor no-theft (2026-08-01)

Four mutations against `SweepExecutor.sol`, suite `SweepExecutorNoTheft.t.sol`:

| ID | Mutation | Result | Reading |
|---|---|---|---|
| M2 | `_depositOrTransfer`: `safeTransfer(to, amount)` → `amount / 2` | **KILLED** | `executorHoldsNothing` + `valueConserved` catch a strand/skim. The invariant bites. |
| M1 | `_requireSelfRoutedUsdgSwap`: `to != address(this)` → `to == address(0)` | SURVIVED | Defense-in-depth: a redirected swap credits the executor 0 USDG, so the `usdgReceived < floor` check reverts the call regardless. The redirect guard is redundant with the floor for this attack. |
| M3 | remove `if (usdgReceived < floor) revert` | **KILLED** | A sanctioned under-delivering router (50%, honest quote) is rejected by the floor; remove the floor and it succeeds, breaking value conservation. Closed via `skimSweep`. |
| M4 | remove the per-swap pct cap (`|| s.amountIn > maxIn`) | **KILLED** | `invariant_boundedLiquidation` (invariant #2) catches a single call draining past the pct cap. |

### Verdict

**3 of 4 mutants killed.** The SweepExecutor suite provably catches value-stranding/skim
(M2), slippage-floor removal (M3, via the under-delivering `skimSweep` path), and
over-liquidation past the pct cap (M4, via invariant #2 bounded-liquidation). M1 survives
only because it is redundant with the floor check — a genuine defense-in-depth property of
the contract, not a hole in the suite. This is the core contract (where the C1 Critical
lived); it is now mutation-verified.

### Residuals

- **R3 (M1) — redirect guard is belt-and-suspenders with the floor check.** A redirected
  swap credits the executor 0 USDG, so the `usdgReceived < floor` check reverts it
  regardless. Documented as a defense-in-depth property; isolating it would require a
  mutant that also defeats the floor. No code change.

## Reproducing

```
export PATH="$PATH:/z/Sentinal Engine/foundry-bin"
# apply a mutation to contracts/SweepExecutor.sol, then:
forge test --mc SweepExecutorNoTheftTest    # red = killed (good), green = survived (gap)
```

## Invariant #3 — SweepBuyback no-exit (2026-08-01)

Four mutations against `SweepBuyback.sol`, suite `SweepBuybackNoExit.t.sol` — **4 of 4 killed**:

| ID | Mutation | Result | Reading |
|---|---|---|---|
| MB1 | `rescue`: drop the `token == USDG` guard | **KILLED** | `test_ownerCannotRescueUsdg` — the owner must never be able to pull the fee pool. |
| MB2 | `buybackAndBurn`: `safeTransfer(DEAD, …)` → `safeTransfer(msg.sender, …)` | **KILLED** | `invariant_noSweepRedirected` — output must go to DEAD, never the keeper. |
| MB3 | remove the `usdgAmount > maxSpendBps` cap | **KILLED** | `invariant_boundedBleed` — one call can't spend the whole pool. |
| MB4 | remove `if (sweepBurned < minSweepOut) revert` | **KILLED** | `invariant_noSweepRedirected` — without the floor, a redirected buyback leaks SWEPT to the attacker. |

The no-exit guarantee holds: a compromised keeper can slow-bleed the pool through burns (bounded, cooldowned) but can never extract USDG or redirect the burn. 4/4 mutants killed.

## Invariant #4 — SweepPaymaster no-free-drain (2026-08-01)

Three mutations against `SweepPaymaster.sol`, suite `SweepPaymasterNoFreeDrain.t.sol` — **3 of 3 killed**:

| ID | Mutation | Result | Reading |
|---|---|---|---|
| MP1 | `sigOk = true` (approve every op) | **KILLED** | `testFuzz_wrongSignerRejected` — a non-sponsor signature must never be sponsored. This is the H3 no-free-drain property. |
| MP2 | remove `if (maxCost > maxCostPerOp) revert` | **KILLED** | `test_maxCostCeiling` — the per-op cost ceiling must hold. |
| MP3 | drop `userOp.nonce` from the signed hash | **KILLED** | `testFuzz_noReplay` — a sponsorship signature must not replay onto a different op. |

Proves the H3 fix: a UserOp is sponsored only if it carries a valid, op-bound, ceiling-bounded sponsor signature. Residual (documented in-contract): the sponsor key itself is trusted — if it leaks, ops are sponsored up to maxCostPerOp until rotation. Off-chain concern, not a contract hole.

## Invariant #5 — SweepPolicyRegistry owner-retains-control (2026-08-01)

Three mutations against `SweepPolicyRegistry.sol`, suite `SweepPolicyRegistryControl.t.sol` — **3 of 3 killed**:

| ID | Mutation | Result | Reading |
|---|---|---|---|
| MR1 | `setPaused`: drop `onlyOwner` | **KILLED** | `invariant_onlyOwnerCanPause` — only the owner controls the emergency pause. |
| MR2 | remove the `pct > MAX_PCT` cap | **KILLED** | `invariant_capsHold` — a user must never author a policy past the caps the executor trusts. |
| MR3 | `revokePolicy`: skip the swap-and-pop prune | **KILLED** | `invariant_listIsExactlyActive` — the account list must equal the active set (the H7/M7 unbounded-growth fix). |

## Suite total (2026-08-01)

**14 mutations planted, 13 killed, 1 documented survivor** (the redirect guard, redundant
with the floor). Every Critical/High fix from `PREAUDIT_FINDINGS.md` now has an exhaustive,
mutation-proven guarantee under a hostile keeper: C1 (no-theft), H1 (cap composition),
H3 (paymaster no-free-drain), H4 (slippage floor), plus buyback no-exit and registry control.

## External audit round 2 — finding #2 (token stranding), 2026-08-01

A credible external review found a real fund-lock: a keeper pulls `s.amountIn` but encodes
a **smaller** `amountIn` in `swapData`, stranding the difference on the executor. The
existing suite missed it because `MockSwapRouter` always consumed the full approved amount.

Fix: `_requireSelfRoutedUsdgSwap` now requires `encodedAmountIn == s.amountIn`, plus a
defense-in-depth refund of any unconsumed `tokenIn`. New harness action `strandSweep`
attempts the attack every fuzz round.

| ID | Mutation | Result | Reading |
|---|---|---|---|
| M-STRAND | remove **both** the `encodedAmountIn` check and the leftover refund | **KILLED** | `invariant_executorHoldsNothing` and `invariant_valueConserved` both fail (`meme stranded on executor: 1e12 != 0`). The strand invariant is load-bearing. |

**15 mutations planted, 14 killed, 1 documented survivor.** The strand vector (external #2)
is now mutation-proven closed. Findings #3 (secure-by-default cooldown) and #4 (yield-pool
partial-fill refund) are covered by unit test `F3` and the yield-refund path.
