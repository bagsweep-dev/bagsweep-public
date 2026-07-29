# BagSweep: Pre-Audit Security Scan

Internal adversarial review of the 7 in-scope contracts before the external audit. Threat
model per `AUDIT_SCOPE.md`: the keeper is fully untrusted (assume its key is compromised),
the owner must always retain control, and Robinhood Chain has no price oracle (DEX spot is
manipulable). Reviewed at the current `main` state (66 unit tests passing).

**Method:** three independent adversarial reviewers over disjoint contract sets, plus a
direct read-through, with the two headline findings verified against the installed code
(OZ Contracts 5.6.1, account-abstraction 0.8.0).

**Verdict (at scan time): do not ship to mainnet.** One Critical (keeper steals 100% of
swept value) and several High issues break the core on-chain guarantee or the account layer's
operation. The bounded-executor skeleton and the buyback no-exit invariant are genuinely
solid; the holes are in swap-recipient constraint, cap composition, EntryPoint wiring, the
paymaster, and the emergency-stop wiring.

**Remediation status (2026-07-28): all findings addressed.** Every Critical, High, Medium,
and Low finding below has been fixed and covered by a regression test (the suite grew 66 → 83
passing), each committed per-finding on `main`. The single exception is the operational half
of **M3** (renouncing the timelock `DEFAULT_ADMIN_ROLE` at deploy), which is a deploy-time
action, not a code change (documented in `deploy-timelock.js` and `AUDIT_SCOPE.md`). The
informational note **I1** is acknowledged, not code-changed. A re-audit of the fixed code is
still required before mainnet. The **Fixed in** column gives the commit for each finding.

---

## Summary

| # | Sev | Finding | Contract | Fixed in |
|---|-----|---------|----------|----------|
| C1 | **Critical** | Keeper redirects 100% of swept proceeds: `spotQuote` rounds the floor to 0 and `swapData` recipient is unconstrained | SweepExecutor | `f8f7017` |
| H1 | **High** | Per-swap `pct` cap is not cumulative: repeating one token liquidates ~94% of a position capped at 25% | SweepExecutor | `f8f7017` |
| H2 | **High** | SmartAccount trusts the wrong EntryPoint (OZ default v0.9) vs the v0.8 the system targets: every UserOp reverts | SmartAccount | `aa856f1` |
| H3 | **High** | Paymaster deposit drainable for free by any permissionless active-policy account (no rate limit, inner selector unchecked) | SweepPaymaster | `7ea75f8` |
| H4 | **High** | USDG to stock leg swaps with `minAmountOut = 0`: unbounded sandwich/value leak on STOCKS and SPLIT | SweepExecutor | `f8f7017` |
| H5 | **High** | Emergency pause does not gate `executeSweep`: the guardian has no fast stop for an in-progress incident | Registry + Executor | `2dea987` |
| M1 | Medium | CREATE2 address depends on mutable `defaultKeeper`: keeper rotation strands counterfactual deposits | SmartAccountFactory | `d9c7d24` |
| M2 | Medium | PROFITS mode is never enforced on-chain: keeper sweeps `pct` of the full position regardless of mode | SweepExecutor | `81e7153` (documented) |
| M3 | Medium | Timelock `DEFAULT_ADMIN_ROLE` must be renounced or governance collapses to one key; no `minDelay` floor | BagSweepTimelock | `431ee24` (floor); renounce = operational |
| M4 | Medium | SweepBuyback keeper self-sandwich via keeper-chosen `minSweepOut`: fee-pool value bleed | SweepBuyback | `b8e3a5f` |
| M5 | Medium | Paymaster reads the full policy struct (dynamic array) in validation: needs stake, risks ERC-7562 rejection | SweepPaymaster | `7ea75f8` |
| M6 | Medium | Unbounded `tokenWhitelist` copied and linear-scanned per swap: gas DoS / paymaster grief | Registry + Executor | `28ec083` |
| M7 | Medium | `_allAccounts` grows unbounded with permissionless registration: keeper enumeration DoS | SweepPolicyRegistry | `1397d7e` |
| M8 | Medium | `_depositOrTransfer` treats any `ok==true` as success (funds strand) and leaves a dangling approval | SweepExecutor | `c9d75ce` |
| L1 | Low | `executeSweep` is not `nonReentrant` (buyback is): defense-in-depth gap | SweepExecutor | `c9d75ce` |
| L2 | Low | No events on the money-routing trust-anchor setters and the pause | Executor + Registry | `c9d75ce`, `1397d7e`, `9d9ed2f` |
| L3 | Low | `minUsd` is stored but never enforced on-chain (keeper hint presented as a bound) | Registry + Executor | `b622939` (documented) |
| L4 | Low | Timelock accepts `minDelay == 0`, silently defeating itself | BagSweepTimelock | `431ee24` |
| L5 | Low | `postOp` under-reports true deposit spend (successful ops only) | SweepPaymaster | `6fadb54` |
| I1 | Info | ERC-1271 comment references an unimplemented surface; `_extractRevertReason` hacky (event-only); FoT tokens unsweepable | SmartAccount / Executor | acknowledged |

---

## Critical

### C1. Keeper steals 100% of swept proceeds (floor rounds to zero, swap recipient unconstrained)

**SweepExecutor.sol:133-134, 143-161.** The enforced output floor is
`floor = spotQuote * (10000 - maxSlippageBps) / 10000`, where `spotQuote` is keeper-declared
and only checked `!= 0`. With `spotQuote = 1` and any `maxSlippageBps > 0`, integer division
makes `floor = 0` (e.g. `1 * 9700 / 10000 == 0`). The post-swap check `usdgReceived < floor`
becomes `0 < 0`, which never reverts. `swapData` is fully keeper-controlled and the executor
never constrains the swap's recipient.

**Exploit (keeper alone, no manipulation):**
1. Keeper submits one swap: `spotQuote = 1`, a real sanctioned `router`, whitelisted
   `tokenIn`, `amountIn = maxIn`.
2. `swapData = swapExactTokensForTokens(amountIn, 0, [tokenIn, USDG], ATTACKER, deadline)`.
3. Executor pulls the meme tokens (line 138), approves the router (143), and calls it (146);
   the router sends the USDG output to `ATTACKER`.
4. `usdgReceived = balanceOf(this) delta = 0`; `0 < 0` is false, no revert; the call returns
   cleanly at line 177.

The account's meme tokens are sold at a fair price and the entire USDG proceeds go to the
attacker. This is not the accepted sandwich residual; it is direct theft, and it refutes the
product's core guarantee. The comment at lines 129-133 ("since maxSlippageBps < 100% the
floor is always > 0, so a redirected or zero-output swap still reverts") is false under
integer rounding.

**Fix (both, the recipient constraint is load-bearing):**
- Construct the meme to USDG swap inside the executor with a hardcoded `to = address(this)`
  (as `_swapToStock` already does), or decode `swapData` and require its recipient field to
  equal `address(this)`. This makes `usdgReceived` reflect the real output.
- Reject a zero effective floor: after line 134, `if (floor == 0) revert SlippageFloorRequired();`.

---

## High

### H1. Per-swap `pct` cap is not cumulative (repeat-token over-liquidation)

**SweepExecutor.sol:111, 123-124.** `maxIn = balanceOf(account) * pct / 10000` is recomputed
on the current balance each iteration, and line 138 has already reduced that balance in prior
iterations. `swaps[]` may repeat the same `tokenIn` up to `MAX_SWAPS = 10` times. For
`pct = 2500` (25%) and 10 identical swaps each taking the full `maxIn`, the remaining balance
is `B * 0.75^10 = 5.63%`, so 94.37% of the position is liquidated in one call. A user who
authorized "at most 25% per sweep" gets 94% force-liquidated. Proceeds still return to the
account (so this is forced over-liquidation and amplified slippage exposure, not direct
theft), but it breaks the advertised keeper bound. There is also no cross-call cooldown.

**Fix:** snapshot each token's balance once at entry and enforce a cumulative per-token cap
against `snapshot * pct / 10000`, or reject duplicate `tokenIn` entries in `swaps[]`.

### H2. SmartAccount trusts the wrong EntryPoint (v0.9 default vs v0.8 target)

**SmartAccount.sol (no `entryPoint()` override).** Verified: OZ Contracts 5.6.1
`Account.entryPoint()` returns `ERC4337Utils.ENTRYPOINT_V09 = 0x433709009B8330FDa32311DF1C2AFA402eD8D009`.
The system targets `ENTRYPOINT_V08 = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` (deploy.js,
paymaster, the deployed testnet EntryPoint). `onlyEntryPoint` / `onlyEntryPointOrSelf` back
`validateUserOp`, `execute`, and `executeBatch`, so with ops routed through v0.8 the account
reverts `AccountUnauthorized` on every UserOp: the entire 4337 path (owner UserOps, keeper
sweeps, paymaster) is dead. Funds are not lost (the direct `ownerExecute` EOA path still
works), so this is liveness, not theft. The forked dry-run did not catch it because it never
submitted a UserOp; test-plan S1-S5 would have.

**Fix:** override `entryPoint()` in SmartAccount to return the single canonical EntryPoint
the deployment standardizes on (v0.8), construct the paymaster with the identical address,
and assert `paymaster.entryPoint == account.entryPoint()` at deploy.

### H3. Paymaster deposit drainable for free by any active-policy account

**SweepPaymaster.sol:66-91, 96-106.** Validation gates on `maxCost <= maxCostPerOp`, outer
selector `execute` with `value == 0` and `eligibleTargets[target]`, and
`registry.getPolicy(sender).active`. There is no per-account or global rate limit, the inner
selector is not checked (the decoded inner calldata is discarded), and `sender` need not be a
BagSweep-deployed account. Getting an active policy is permissionless (`registry.setPolicy`
keys on `msg.sender` and only bounds pct/slippage).

**Exploit:** attacker makes one account active (pays their own gas once), then signs owner
UserOps with `paymasterAndData` pointing at the paymaster and
`callData = execute(registry, 0, setPolicy(...))` or `execute(executor, 0, executeSweep(...))`,
sizing gas so `maxCost` stays just under the cap while burning near-cap real gas. The
EntryPoint debits the deposit for actual gas regardless of inner success; `postOp` never
refunds or throttles. Each op costs the attacker ~0 and removes up to `maxCostPerOp` from the
shared deposit, repeatable across nonces. Successful `setPolicy` ops do not trip bundler
reputation. Result: total loss of the sponsorship deposit plus denial of sponsorship to
legitimate users.

**Fix:** add a per-account sponsorship budget/rate window enforced in `postOp` (the `sender`
and `maxCost` are already in `context`); check the inner selector (require
`executeSweep.selector` for the executor target, an explicit allowlist for the registry); and
consider requiring `sender` to be a factory-attested account.

### H4. USDG to stock leg swaps with `minAmountOut = 0`

**SweepExecutor.sol:259 (reached from `_routeProceeds` 214-224).** The USDG to stock swap
passes `minAmountOut = 0`; the comment "slippage already enforced upstream" is wrong, since
the upstream floor only covers the meme to USDG leg. `stockTarget` is sanctioned but its pool
price is manipulable (no oracle). Any MEV actor, not only the keeper, can sandwich a standing
`minOut = 0` swap; the loss on this leg is unbounded (up to ~100% of the swept USDG), unlike
the meme leg which is bounded by `maxSlippageBps`. Exposure hits STOCKS and SPLIT_50_50;
USDG_YIELD is safe.

**Fix:** thread a keeper-declared stock quote through `SwapParams`/routing, compute
`stockFloor = stockQuote * (10000 - maxSlippageBps) / 10000` against the measured stock
delta, and reject `stockFloor == 0` (same rounding reason as C1).

### H5. Emergency pause does not gate the money-movement path

**SweepPolicyRegistry.sol:57 (whenNotPaused gates setPolicy only); SweepExecutor.sol:89-107
(never reads `registry.paused`).** The guardian's only fast lever pauses new policy
registration and nothing else. During an "emergency," the keeper keeps driving `executeSweep`
against every already-active account. The setters that could actually contain an incident
(`setSanctionedRouter`, `setSanctionedStock`, `setStockRouter`) sit behind the timelock's
`minDelay`, so there is no fast stop at all: the fast lever does nothing and the effective
levers are delayed. Single-op loss is bounded by `pct` + slippage, but cumulative loss across
accounts and blocks during a `minDelay` window is not.

**Fix:** give the money path a fast stop, either by having `executeSweep` short-circuit on
`registry.paused()` at line 94, or by adding an independent guardian-controlled pause on
SweepExecutor that is NOT behind the timelock. Keep `revokePolicy` ungated so users still exit.

---

## Medium

### M1. CREATE2 address depends on mutable `defaultKeeper`; keeper rotation strands deposits

**SmartAccountFactory.sol:53, 86-88, 38.** The keeper is a constructor argument, so it is part
of the CREATE2 init code and therefore the address. `defaultKeeper` is mutable and
`createAccount` always uses the current value. If a user deposits to their counterfactual
address computed with keeper K1, then the owner rotates to K2 (a routine op for an
assume-compromised keeper), `createAccount` deploys at a different address and the deposit is
permanently stranded. Front-running `createAccount(victim, salt)` is not a takeover (owner is
bound in the init code), so stranding is the only real harm. Separately,
`accountInitCodeHash = keccak256(creationCode)` excludes constructor args, so an integrator
who plugs it into address derivation computes a wrong address; the name invites misuse.

**Fix:** make the address independent of the mutable global (constructor takes only `owner`,
keeper set post-deploy via `setKeeper`; or bake an immutable factory-level keeper). Remove or
rename `accountInitCodeHash`.

### M2. PROFITS mode is never enforced on-chain

**SweepExecutor.sol:120-124; ISweepPolicy.sol `SweepMode`.** `executeSweep` never reads
`pol.mode`; the cap is always `pct * balanceOf`. A user who selected PROFITS believes only a
fraction of gains is swept, but the keeper can sweep `pct` of the entire position, including
when flat or underwater (forced loss realization). There is no on-chain cost basis on RH, so
PROFITS cannot be enforced as written. This is a claim/enforcement mismatch, not a code bug.

**Fix:** drop PROFITS from the on-chain policy surface and enforce it only in the off-chain
keeper (stop presenting it as an on-chain bound), or add a user-supplied cost-basis reference.

### M3. Timelock admin renounce is load-bearing; no `minDelay` floor

**BagSweepTimelock.sol:34-39.** The wrapper adds no invariants. In OZ v5 `TimelockController`,
each proposer also gets `CANCELLER_ROLE`, and `DEFAULT_ADMIN_ROLE` administers all roles. If
`admin` is left as the deployer and not renounced, that key can, with no delay, grant itself
proposer/executor/canceller and revoke everyone else, collapsing governance to one key (still
bounded to one `minDelay` notice window for any config change, but owning role membership
outright and removing the independent canceller). A lone compromised proposer cannot push
config faster than `minDelay` (refuted: no reschedule-shorter trick), but can cancel others'
legitimate ops.

**Fix (operational + guard):** mandate renouncing `DEFAULT_ADMIN_ROLE` after setup and verify
on-chain (`getRoleMemberCount(DEFAULT_ADMIN_ROLE)`); keep at least one independent canceller;
add `require(minDelay >= SOME_MIN)` (see L4).

### M4. SweepBuyback keeper self-sandwich via keeper-chosen `minSweepOut`

**SweepBuyback.sol:70-97.** The no-USDG-exit invariant genuinely holds (`rescue` blocks USDG
and sweepToken, `setSweepToken` is one-time, output is measured by delta and sent only to
DEAD). But `minSweepOut` is keeper-chosen: a compromised buyback keeper can set
`minSweepOut = 1`, sandwich its own buyback against a thin or self-seeded pool, burn far below
fair value, and capture the difference through its LP. `usdgSpent` is the full approved
amount, so the fee pool bleeds value even though the burn "succeeds." The "keeper cannot
steal" claim is overstated (it cannot withdraw USDG, but it can waste it).

**Fix:** derive the buyback floor from a value the keeper does not solely control (a
governance-set minimum, or a floor bounded to a configured fraction of `usdgAmount`).

### M5. Paymaster reads the full policy struct in validation (stake + ERC-7562)

**SweepPaymaster.sol:143-146, reached from 85-86.** `_hasActivePolicy` calls
`registry.getPolicy(sender)`, reading external storage during validation. Under ERC-4337 /
ERC-7562 a paymaster may access sender-associated storage only if staked, and nothing enforces
that the paymaster is staked before use (`addStake` is optional). Worse, `getPolicy` decodes
the entire struct including the dynamic `tokenWhitelist` array, whose element slots are not
sender-associated; a full-spec bundler can reject sponsored ops for any user with a non-empty
whitelist even when staked. The standard revoke-before-inclusion grief also applies.

**Fix:** add `registry.isActive(address) view returns (bool)` reading only the `active` slot
and call that; require and verify the paymaster is staked at deploy.

### M6. Unbounded `tokenWhitelist` copied and scanned per swap

**SweepPolicyRegistry.sol:78-81; SweepExecutor.sol:115, 197-202.** `setPolicy` accepts an
arbitrarily long whitelist (registration cost is the user's, but the scan cost is
externalized). `_inWhitelist` linear-scans the stored list once per swap (up to MAX_SWAPS).
If the paymaster sponsors `executeSweep`, a user with a huge whitelist makes the sponsor pay
O(whitelist x swaps) per sweep, a cheap repeatable drain; without a paymaster, an oversized
whitelist can brick the user's own sweeps past the block gas limit.

**Fix:** cap the whitelist length in `setPolicy` (e.g. 20-50). Dedup is optional.

### M7. `_allAccounts` grows unbounded with permissionless registration

**SweepPolicyRegistry.sol:64-67, 111-134.** The array only grows (revoked entries stay), and
`setPolicy` has no origin check, so any address can register. `getActiveAccounts` and
`policyCount` are O(all-time accounts). An attacker registering junk from many addresses (or
honest churn over time) degrades the keeper's `getActiveAccounts()` read until it exceeds the
node's `eth_call` cap, at which point the keeper can no longer enumerate accounts (liveness
DoS). Off-chain today, so it degrades rather than reverts.

**Fix:** prune on revoke (swap-and-pop + clear `_isTracked`), or drop on-chain enumeration and
index `PolicySet`/`PolicyRevoked` events off-chain, or paginate. Consider requiring `msg.sender`
be a factory-produced account.

### M8. `_depositOrTransfer` unchecked success + dangling approval

**SweepExecutor.sol:228-238.** The yield-pool `deposit(uint256,address)` low-level call returns
on `ok == true` without confirming USDG actually left the executor or shares were credited; a
pool that does not implement that exact selector can hit a fallback that returns success while
pulling nothing, stranding proceeds on the stateless executor (recoverable only by owner
`rescueTokens`). On the failure branch, the approval set at line 230 is not reset before the
fallback transfer. Bounded by owner configuration (Medium, not keeper-triggerable).

**Fix:** verify the deposit consumed USDG (balance delta or nonzero shares) before treating it
as success; reset the approval to 0 on the fallback path.

---

## Low / Info

- **L1. `executeSweep` not `nonReentrant`** (SweepExecutor.sol:89). It makes external calls to
  keeper-influenced targets (token transfers, router call, yield-pool call) while `SweepBuyback`
  guards its equivalent. No concrete drain was constructed (the contract is stateless with
  local before/after accounting), so this is defense-in-depth. Add the guard for parity and to
  close the class.
- **L2. No events on trust-anchor setters** (SweepExecutor `setYieldPool` / `setStockRouter` /
  `setSanctionedRouter` / `setSanctionedStock` / `rescueTokens`; Registry `setPaused`;
  SmartAccount `setKeeper` / `setSweepExecutor`; Factory `setDefaultKeeper`). These define where
  money can be routed and who the keeper is: the exact anchors a guardian must watch. Emit an
  event on every one; this is the cheapest mitigation for the H5 monitoring gap.
- **L3. `minUsd` stored but never enforced** (Registry:74; Executor never reads it). A keeper
  can sweep positions below the user's stated threshold. Enforce on-chain (hard without an
  oracle) or document it as a keeper hint with no guarantee.
- **L4. Timelock accepts `minDelay == 0`** (BagSweepTimelock.sol:34-39), silently removing the
  delay. Add `require(minDelay >= MIN_SANE_DELAY)` and verify `getMinDelay()` post-deploy.
- **L5. `postOp` under-reports spend** (SweepPaymaster.sol:96-106): `totalGasSponsored`
  increments only on `opSucceeded`, but the deposit is debited for reverted ops too. Increment
  on all modes or document as successful-spend-only and reconcile against `balanceOf`.
- **I1.** ERC-1271 comment (SmartAccount.sol:47-51) references an `isValidSignature` surface
  that is not implemented (harmless, and it means no 1271 path for the keeper). `_extractRevertReason`
  (314-321) does raw `abi.decode` of caller bytes but only feeds an event (benign). Fee-on-transfer
  `tokenIn` reverts `SweepAmountMismatch` (140), making FoT tokens unsweepable (availability quirk).

---

## Verified positives (do not regress these)

- **Keeper call restriction is tight.** `_isAllowedKeeperCall` (SmartAccount.sol:99-113)
  permits exactly `execute(sweepExecutor, 0, executeSweep(...))`: `executeBatch`, non-zero
  value, wrong dest, short/garbage calldata, and any other inner selector all fail validation.
  The keeper never takes the owner signature path.
- **Owner escape hatch holds.** `ownerExecute` / `ownerExecuteBatch` are `onlyOwnerOrSelf`,
  independent of EntryPoint/bundler/paymaster/keeper, and grant no authority beyond what the
  owner already has. (This is what keeps H2 at liveness rather than fund loss.)
- **Buyback no-exit invariant holds.** USDG can only leave `SweepBuyback` as burned $SWEEP;
  the burn target is set once; `rescue` cannot touch either protocol asset (subject to M4's
  value-bleed caveat).
- **Users can always exit.** `revokePolicy` is ungated by the pause and `executeSweep` checks
  `pol.active`, so a revoke genuinely stops future sweeps (users must also revoke the ERC-20
  approval to the executor for a full exit).
- **No cross-account policy writes; non-owner cannot pause; enum bounds are safe** (Solidity
  0.8 reverts on out-of-range enum decode).
- **Fee logic is correctly bounded** by `MAX_FEE_BPS = 100`; no drain vector in `_skimFee` /
  `setFeeBps`.

---

## Remediation order (completed 2026-07-28)

Executed in this priority order; all landed on `main` (see the Fixed-in column):

1. **C1** (recipient-constrained swap + reject `floor == 0`) and **H4** (real stock-leg floor):
   removed the direct-theft and value-leak paths on the money route.
2. **H1** (cumulative per-token cap): restored the advertised keeper bound.
3. **H2** (override `entryPoint()` to v0.8): so ops route through the intended EntryPoint.
4. **H3** (verifying paymaster) and **M5** (no registry read in validation): protected and
   corrected the sponsor path (the chosen fix removed the on-chain registry read entirely).
5. **H5** (fast stop on the money path) and **M3/L4** (`minDelay` floor): made the emergency
   and governance controls real. (M3's admin-renounce remains an operational deploy gate.)
6. **M1, M2, M4, M6, M7, M8, L1-L5**: cleared.

The suite is at **83 passing** (66 at scan time). Remaining before the auditor: renounce the
timelock `DEFAULT_ADMIN_ROLE` at deploy (M3 operational), re-freeze the commit SHA in
`AUDIT_SCOPE.md`, and re-validate on testnet with a real bundler (which also exercises H2)
via the `TESTNET_TEST_PLAN.md` N-series.
