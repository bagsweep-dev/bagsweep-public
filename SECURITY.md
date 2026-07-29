# BagSweep — Security Model

## Trust claim

BagSweep is non-custodial in the sense that **a compromised keeper key cannot drain
or take over a user's account**. The keeper can only trigger sweeps that comply with
the policy the user authored on-chain. The user's own EOA (the account owner) retains
full control at all times and can revoke the policy or the keeper.

The owner can also **exit unconditionally**. `SmartAccount.ownerExecute` (and its batch
variant) moves funds directly from the owner's EOA with no dependency on the EntryPoint,
a bundler, a paymaster, or the keeper, so a broken, paused, or censoring 4337 stack can
never trap a user's assets. It is `onlyOwnerOrSelf` and grants no new authority (the
owner already has full authority via UserOps); it only removes the 4337 stack as a
dependency of exiting.

## What the keeper CAN do

Submit a UserOp that calls, on the user's SmartAccount:

```
execute(sweepExecutor, 0, executeSweep(swaps, dest, stockTarget))
```

and nothing else. This is enforced in `SmartAccount._validateUserOp` /
`_isAllowedKeeperCall`: the keeper signature is rejected for any other target, any
ETH value, `executeBatch`, or any inner selector other than `executeSweep`. The
keeper is **not** a general ERC-1271 signer for the account.

## What SweepExecutor enforces on-chain (keeper is untrusted)

For each sweep, `executeSweep` reads the caller's policy from `SweepPolicyRegistry`
and requires:

| Bound | Enforcement |
|---|---|
| Active policy | `NoActivePolicy` if `!policy.active` |
| Destination matches policy | `DestinationMismatch` |
| Token permitted | `TokenNotAllowed` if not in a non-empty whitelist |
| Amount ≤ pct × current balance | `AmountExceedsPolicy` (bounds POSITION and PROFITS) |
| Real DEX venue | `RouterNotSanctioned` (owner allowlist) |
| User-authored slippage floor | `SlippageFloorRequired` if `spotQuote == 0`; floor = `spotQuote × (10000 − policy.maxSlippageBps)/10000`, `SweepSlippageExceeded` if the fill is below it |
| Stock destination is sanctioned | `StockNotSanctioned` (owner allowlist) |
| Proceeds (net of a capped fee) return to the account | routing sends USDG/stock to `account`; the fee is capped at 1%, see Protocol fee below |

Worst case for a fully compromised keeper: it executes a policy-compliant sweep of
≤ pct of one whitelisted token, through an owner-sanctioned venue, with proceeds
landing back in the user's account. It cannot exceed the percentage, touch an
un-whitelisted token, redirect proceeds, or change the destination.

## Residual risks (documented, not yet closed)

1. **Meme→USDG slippage.** The output floor is now user-authored: the keeper declares
   a spot quote per swap and the executor enforces
   `usdgReceived ≥ spotQuote × (10000 − policy.maxSlippageBps)/10000`, so the slippage
   tolerance belongs to the user, not the keeper. The spot quote is still keeper-declared
   because RH has **no external oracle and no provisioned DEX TWAP** (Pyth/Chainlink
   absent; Uniswap V3 pools are observation-cardinality 1 so `observe()` reverts; V4 has
   no native TWAP without a hook; and memes pair with tokenized stocks/WETH, not USDG).
   So a keeper that manipulates spot in the same block is **not** stopped here, it stays
   bounded by the pct cap (≤ pct% of one token per sweep). A stronger, manipulation-proof
   floor would require provisioning a V3 TWAP on the specific pools, a partial (V3-only),
   per-pool upgrade.
2. **USDG→stock leg uses router `minOut = 0`** in `_swapToStock`. This is the safe
   direction: `stockRouter` and `stockTarget` are owner-sanctioned, the stock/USDG pools
   are deep (e.g. NVDA/USDG), and the USDG that reaches this leg is already bounded by the
   meme→USDG floor above. A per-leg spot bound can be added later.
3. **Owner powers.** The executor owner controls the sanctioned router/stock lists,
   the protocol fee (capped at 1%), and the treasury, and can `rescueTokens` from the
   executor (which only ever holds in-flight dust). The registry owner can pause.
   These are protocol-admin powers, not per-account custody. See Governance below:
   the config powers move to a timelock; the registry pause stays on a fast guardian.
4. **Not audited.** These contracts have unit tests (`test/`) but no external audit.
   Do not deploy to mainnet or describe as production-ready without one.

## Protocol fee and buyback

`SweepExecutor` skims an optional protocol fee in USDG off the top of proceeds
(after the meme→USDG swaps, before routing), then sends the remainder to the account.
The fee is **hard-capped at `MAX_FEE_BPS` = 1%** (an immutable ceiling the owner can
never exceed), **defaults to 0**, and is **skipped entirely when no treasury is set**.
Every skim emits `FeeCollected`, so total fee volume is a verifiable on-chain read.

The fee sink is `SweepBuyback`. USDG that lands there can **only** leave by being
swapped for `$SWEEP` and burned to `0x...dEaD`: there is **no owner withdrawal path
for USDG** (`rescue` reverts on both USDG and `$SWEEP`), so the buy-and-burn is
enforced by the contract, not promised. `buybackAndBurn` is keeper-gated with a
sanctioned router, a mandatory slippage floor, and `nonReentrant`; `$SWEEP` is set
once (immutable burn target). `burnStuckSweep` is permissionless.

## Governance

Protocol-admin powers are split by temperature:

| Surface | Owner | Why |
|---|---|---|
| `SweepExecutor`, `SweepBuyback` config (fees, treasury, routers, keeper, pools) | `BagSweepTimelock` | Config is cold: changes must be queued and wait out `minDelay` (default 24h), so a compromised key cannot alter protocol config silently or instantly, and users can exit during the delay. |
| `SweepPolicyRegistry` emergency pause | Fast guardian (multisig/EOA) | Pause is hot: an emergency brake behind a 24h delay is useless, so it stays fast on a guardian. |

`BagSweepTimelock` is a thin wrapper over OpenZeppelin's audited `TimelockController`.
Wire it with `scripts/deploy-timelock.js`, then renounce the timelock
`DEFAULT_ADMIN_ROLE` from the deployer so it self-administers. The on-chain fee cap
holds even through governance: a queued `setFeeBps` above `MAX_FEE_BPS` still reverts.

## Operational

- `contracts/.env` holds the cold `DEPLOYER_KEY` (admin/owner); it is gitignored. The
  hot keeper key (`KEEPER_KEY`) lives ONLY in the keeper service, never here.
  **deployer != keeper is enforced on mainnet** by `deploy.js`: set `KEEPER_ADDRESS`
  to the keeper's public address, distinct from the deployer. The current testnet
  deploy uses keeper == deployer (testnet convenience only).
- Sweeps revert until the owner sanctions a real DEX router
  (`executor.setSanctionedRouter(router, true)`).
