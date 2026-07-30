# BagSweep Mainnet Runbook (Robinhood Chain, 4663)

The staged, human-gated path to take the phase-2 protocol live. Every step has a verify
check; do not proceed past a failed check. Run only after a clean external audit.

Canonical mainnet addresses used below:
- USDG `0x5fc5360d0400a0fd4f2af552add042d716f1d168`
- aeWETH `0x0bd7d308f8e1639fab988df18a8011f41eacad73`
- Uniswap V3 SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`
- Uniswap V3 QuoterV2 `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7`
- EntryPoint v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`
- $REAP `0xD36F5744a655bD786993574b94bbf11B6B126FFa`

---

## 0. Gates (do not start until all true)
- [ ] External audit complete and findings remediated; audit baseline re-frozen.
- [ ] Phase-1 demand signal supports going to mainnet (business decision).
- [ ] **Three distinct keys** exist: `deployer` (cold admin), `keeper` (hot signer, its key lives ONLY on the keeper host), `guardian` (fast pause). Never reuse one for another.
- [ ] Deployer funded with mainnet ETH for deploys + the paymaster deposit.

> **Audit v4 contract deltas (must be in external-audit scope).** This revision changes the core:
> M-3 (per-account `minSweepInterval` on the executor, set to 3600s at deploy, moves under the
> timelock at lockdown), L-1/L-4 (two-step ownership on the account + factory), L-5 (V3 adapter
> rescue zero-guard). So the contracts are NOT the previously-frozen bytes — the external audit
> must cover these. **M-2:** never call `paymaster.addStake` (stake would be irrecoverable; the
> own-bundler setup needs none). **I-4:** the `SweepRouterV4Adapter` is dormant — $REAP is a V3
> token, so it is NOT sanctioned for the $REAP buyback; run `forktest-v4.js` only if a
> V4-graduating token is later supported. Canonical Permit2 on RH confirmed at
> `0x000000000022D473030F116dDEE9F6B43aC78BA3`; source the V4 UniversalRouter from Uniswap's
> official registry at that time.

## 1. Read the real pool fee tiers
The buyback routes USDG -> WETH -> $REAP; the adapter needs the exact tier for each hop.
```bash
# USDG/WETH pool + fee, and WETH/$REAP pool + fee, from the canonical V3 factory 0x1f7d7550...
cast call 0x1f7d7550b1b028f7571e69a784071f0205fd2efa "getPool(address,address,uint24)(address)" <USDG> <WETH> <tier>
cast call <poolAddr> "fee()(uint24)"
```
Record `FEE_USDG_WETH` and `FEE_WETH_REAP`.

**Verified on-chain 2026-07-29 ($REAP is a V3 token, not V4).** $REAP trades in a live Uniswap
**V3** pool, REAP/WETH at the **1% (10000) tier**, pool `0xa8e95ddca643d0a4a6d695912e65b172e8f96e03`
(initialized, has liquidity). There is no REAP/USDG pool and no REAP/WETH pool at the 500 or 3000
tiers, so `FEE_WETH_REAP` **must be `10000`** — a default of 500/3000 would point `feeFor` at a
non-existent pool and the buyback would skip forever. USDG/WETH exists at all three tiers (pick the
deepest, historically the 500 tier). The V3 Quoter + `SweepRouterV3Adapter` see this pool fine; the
shipped `SweepRouterV4Adapter` is not needed for $REAP (keep it for future launchpad tokens that
graduate to a V4 pool).

⚠ **Thin pool caveat.** At graduation the REAP/WETH pool holds only ~0.02 WETH of depth, so any
non-trivial buyback swap blows past the slippage floor and the pre-submit simulation reverts, so the
keeper correctly **skips**. This is the slippage guard working, not a routing bug: the burn will
legitimately no-op until the pool deepens. Set `maxSpendBps` conservatively and expect early
`[buyback] simulation reverted` skips; do not "fix" them by widening slippage.

## 2. Deploy
```bash
cd contracts
PRIVATE_KEY=<deployer> \
KEEPER_ADDRESS=<keeper> \
GUARDIAN_ADDRESS=<guardian> \
REAP_ADDRESS=0xD36F5744a655bD786993574b94bbf11B6B126FFa \
FEE_USDG_WETH=<from step 1> FEE_WETH_REAP=<from step 1> \
TIMELOCK_MIN_DELAY=172800 \
npx hardhat run scripts/deploy-mainnet.js --network robinhood
```
Deploys registry, executor, factory, paymaster, adapter, SweepBuyback, timelock; wires the
adapter + `treasury -> SweepBuyback` + `sweepToken = $REAP`. **feeBps stays 0 (fees OFF)** and
ownership stays with the deployer. Addresses are written to `deployed-addresses.mainnet.json`.

Verify + publish contracts on Blockscout (`npx hardhat verify --network robinhood <addr> <ctorArgs>`).

## 3. Verify the wiring (all must match)
```bash
cast call <buyback>  "sweepToken()(address)"                 # == $REAP
cast call <buyback>  "sanctionedRouters(address)(bool)" <adapter>   # true
cast call <executor> "treasury()(address)"                   # == <buyback>
cast call <executor> "sanctionedRouters(address)(bool)" <adapter>   # true
cast call <executor> "feeBps()(uint256)"                     # 0 (still off)
cast call <adapter>  "feeFor(address,address)(uint24)" <USDG> <WETH>   # == FEE_USDG_WETH
cast call <adapter>  "feeFor(address,address)(uint24)" <WETH> <REAP>   # == FEE_WETH_REAP
```

## 4. Deploy the keeper (systemd service)
Deploy the keeper as a long-running service (systemd or equivalent). Keeper env (`.env`, root-only, never world-readable):
```
RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com
KEEPER_KEY=<keeper private key>            # this box only; never in the deployer env
USDG_ADDR=0x5fc5360d0400a0fd4f2af552add042d716f1d168
SWEEP_ROUTER=<adapter>
QUOTER_ADDR=0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7
BUYBACK_ADDR=<buyback>
SWEEP_HUBS=["0x0bd7d308f8e1639fab988df18a8011f41eacad73"]   # aeWETH, for the multi-hop route
BUYBACK_ENABLED=1
```
`systemctl start bagsweep-keeper` then confirm it reads state and logs `skip: ...` cleanly
(no revert). It is cap/cooldown-aware and simulates every tx, so a misconfig degrades to a
skip, not a bad send.

## 5. Canary (fees still OFF)
- **Sweep:** from a throwaway smart account with a tiny meme position, author a policy and let
  the keeper harvest one sweep. Confirm the output lands and `ownerExecute()` still exits.
- **Buyback:** set `feeBps` to a small value briefly, generate one harvest so USDG lands in the
  buyback, then confirm `runBuyback` picks the USDG -> WETH -> $REAP route and burns:
  ```bash
  cast call <buyback> "buybackAndBurn(uint256,uint256,address,bytes)" ...   # staticCall first
  ```
  Check the `BuybackBurned` event and that $REAP `balanceOf(0x...dEaD)` increased.

## 6. Go live (fees on)
```bash
cast send <executor> "setFeeBps(uint256)" <bps>   # e.g. the audited cap; start conservative
```
Fees now accrue in SweepBuyback; the keeper's buyback loop burns $REAP on its cooldown.

## 7. Lock it down (after the canary is clean)
Order matters: hand config to the timelock, keep the pause fast.
```bash
# config setters -> timelock (delayed, public):
cast send <executor> "transferOwnership(address)" <timelock>
cast send <buyback>  "transferOwnership(address)" <timelock>
cast send <adapter>  "transferOwnership(address)" <timelock>
# pause stays FAST: registry (which holds setPaused) -> guardian, NOT the timelock:
cast send <registry> "transferOwnership(address)" <guardian>
# then renounce the timelock's DEFAULT_ADMIN so it is self-administered (see BagSweepTimelock NatSpec)
```
Verify each `owner()` afterwards. From here, every config change is a queued, `minDelay`-delayed,
publicly visible timelock op.

## 8. Monitoring + emergency
- Watch `BuybackBurned` (verifiable burn volume) and keeper logs.
- **Emergency pause (fast, guardian key):** `cast send <registry> "setPaused(bool)" true`. This
  is off the timelock by design so it is instant; unpause the same way.
- No owner path drains USDG or user funds by design; the worst case is a paused protocol while
  a fix is queued through the timelock.

## STOCKS / SPLIT destinations (deferred; only if enabled later)
MVP mainnet ships USDG-yield only. Before enabling STOCKS/SPLIT policies:
- `stockRouter` MUST be a sanctioned adapter (`SweepRouterV3Adapter`/`SweepRouterV4Adapter`), never
  a raw DEX router: `_swapToStock` builds a fixed direct `[USDG, stockTarget]` V2-style call, so a
  raw router with no direct USDG/stock pair makes the destination unusable. The adapters resolve
  the configured pool per pair. (audit L-3)
- The keeper must quote the stock leg on the **net-of-fee** USDG amount (the executor skims the fee
  before `_swapToStock`); quoting the gross amount yields spurious `SweepSlippageExceeded` reverts
  once `feeBps` exceeds the user's slippage tolerance. (audit L-2)

## 9. Sync
Mirror `scripts/deploy-mainnet.js` + this runbook into the public repo (`bagsweep-public`) so
the source-available record matches what was deployed. Do NOT commit `deployed-addresses.mainnet.json`
if it should stay private; the contract addresses are public on-chain regardless.
