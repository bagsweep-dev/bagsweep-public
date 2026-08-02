# BagSweep — Testnet Test Plan

Robinhood Chain testnet, **chain 46630**. Goal: exercise every trust boundary end to end before freezing for the external audit. The keeper is treated as untrusted throughout, so the negative scenarios (§5) matter more than the happy paths (§4).

**Exit criteria (what "testnet-validated" means):**
1. All happy-path scenarios (§4) succeed via the real UserOp → EntryPoint → executor flow.
2. All negative scenarios (§5) revert or are contained exactly as specified.
3. The paymaster gap (AUDIT_SCOPE §6.A) is fixed and re-tested.
4. The keeper service runs autonomously through several real sweeps (§6).
5. `deployer ≠ keeper` on the testnet re-deploy (drop the testnet convenience once flows work).

---

## 1. Environment

```bash
# contracts/.env
DEPLOYER_KEY=<cold deployer key>            # funded on RH testnet
KEEPER_ADDRESS=<hot keeper's PUBLIC address> # MUST differ from deployer
RH_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
ENTRY_POINT=0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
BUNDLER_URL=https://bundler.testnet.chain.robinhood.com
```
- EntryPoint v0.8 is the canonical `0x4337…`.
- On testnet, `deploy.js` deploys `MockUSDG` (6 dp), `MockMemeToken` (18 dp), and you deploy a `MockSwapRouter` for the meme→USDG leg.
- The keeper service holds its own `KEEPER_KEY` (the private key for `KEEPER_ADDRESS`) in `keeper/.env`, never in `contracts/.env`.

---

## 2. Deploy sequence

```bash
cd contracts && npm install && npx hardhat compile

# 1. Core: registry, executor, factory, paymaster, mocks
npx hardhat run scripts/deploy.js --network robinhood-testnet
#    -> writes deployed-addresses.json

# 2. Governance: timelock owns executor + buyback (leave registry on the guardian)
npx hardhat run scripts/deploy-timelock.js --network robinhood-testnet
```
Manual wiring after deploy (owner txs, or via the timelock once ownership moves):
- `executor.setSanctionedRouter(mockRouter, true)` (sweeps revert until a router is sanctioned).
- For STOCKS tests: deploy a mock stock token, `executor.setStockRouter(mockRouter2)`, `executor.setSanctionedStock(mockStock, true)`.
- Fund the paymaster: `paymaster.deposit({value: 0.1 ether})` and `paymaster.addStake(…)`.
- Fee/buyback (optional, for §4 S4): deploy a mock `$SWEEP`, deploy `SweepBuyback`, `buyback.setSweepToken($SWEEP)`, `buyback.setSanctionedRouter(sweepRouter, true)`, `executor.setTreasury(buyback)`, `executor.setFeeBps(50)`.

---

## 3. Fixtures per test run

1. `factory.createAccount(userOwner, salt)` → a `SmartAccount`.
2. Mint mock meme tokens to the account.
3. `account.setSweepExecutor(executor)` and `account.setKeeper(keeper)` (or set at factory).
4. As the user: `registry.setPolicy(pct, minUsd, mode, dest, tokenWhitelist, maxSlippageBps)`.
5. Fund `MockSwapRouter` with USDG liquidity so it can pay out.
6. The account approves the executor to pull the meme token (via a UserOp or `ownerExecute`).

Use freshly-created accounts + mock tokens on testnet. (The mainnet test wallets in the project notes are for the read-only tracker, not for live sweeps.)

---

## 4. Happy-path scenarios (via the real UserOp flow)

| # | Scenario | Expected |
|---|---|---|
| S1 | USDG_YIELD sweep: keeper submits `execute(executor,0,executeSweep([meme swap], USDG_YIELD, 0))` as a UserOp | meme sold, USDG (net of fee) returns to the account; `SweepExecuted` emitted |
| S2 | STOCKS sweep | meme → USDG → sanctioned stock; stock returns to the account |
| S3 | SPLIT_50_50 | half to yield, half to stock |
| S4 | Fee on (feeBps=50, treasury=buyback) | `FeeCollected` emitted, 0.5% of proceeds skimmed to `SweepBuyback`; then `buyback.buybackAndBurn(...)` burns $SWEEP, `BuybackBurned` emitted |
| S5 | Paymaster-sponsored | the keeper UserOp is gas-sponsored; `totalGasSponsored` increases |

Verify each by reading events and account balances, and that the UserOp actually routed through the EntryPoint (not a direct call).

---

## 5. Negative / security scenarios (the important ones)

| # | Attack | Expected containment |
|---|---|---|
| N1 | Keeper submits a sweep exceeding `pct × balance` | reverts `AmountExceedsPolicy` |
| N2 | Keeper UserOp targets something other than `executeSweep` (different dest, non-zero value, `executeBatch`, other selector) | `SmartAccount._validateUserOp` rejects the keeper signature (SIG_VALIDATION_FAILED) |
| N3 | **Always-exit:** remove/replace the keeper, take the paymaster/bundler offline, then the user calls `account.ownerExecute(meme, 0, transfer(user, bal))` directly | funds exit; no dependency on keeper/EntryPoint/bundler/paymaster |
| N4 | Keeper submits a `spotQuote` such that `usdgReceived < spotQuote × (1 − maxSlippageBps)` | reverts `SweepSlippageExceeded`; `spotQuote == 0` reverts `SlippageFloorRequired` |
| N5 | Un-sanctioned router / fake pool | reverts `RouterNotSanctioned` (or 0 output → slippage revert) |
| N6 | Un-whitelisted token / mismatched destination | `TokenNotAllowed` / `DestinationMismatch` |
| N7 | **Timelock:** call `executor.setFeeBps(…)` from the old EOA after ownership moved | reverts `OwnableUnauthorizedAccount`; schedule via timelock, execute before delay reverts, after `minDelay` succeeds; a queued `setFeeBps(101)` still reverts `FeeExceedsMax` on execute |
| N8 | **deployer ≠ keeper:** run `deploy.js` with `chainId 4663` (or force the mainnet branch) and `KEEPER_ADDRESS == deployer` | deploy script throws |
| N9 | **Buyback no-exit:** `buyback.rescue(USDG, …)` and `rescue($SWEEP, …)` | both revert `CannotRescueProtocolAsset`; USDG only leaves via `buybackAndBurn` |
| N10 | **Paymaster (after fix A):** an account with an active policy submits a UserOp targeting something other than the executor/registry, or a non-keeper submits | rejected (`TargetNotEligible` / `NotKeeper`). Before the fix, document that it is currently sponsored (the bug). |
| N11 | Guardian pause: pause the registry, confirm new `setPolicy` reverts `Paused`, confirm existing sweeps and `ownerExecute` are unaffected | pause scoped to new policy registration only |

N2, N3, N9, and N10 are the highest-signal tests: they prove the keeper cannot escape its bound, the user can always exit, the fees can only burn, and the paymaster cannot be drained.

---

## 6. Keeper service loop (end-to-end autonomy)

```bash
cd keeper && npm install
# keeper/.env: KEEPER_KEY=<hot private key>, registry/executor/bundler from deployed-addresses.json
node src/index.js   # monitor -> evaluator -> relayer -> bundler
```
- Point the keeper at the test account with an active policy.
- Move the mock meme price so the policy trigger fires (adjust the `MockSwapRouter` rate, or the price feed the evaluator reads).
- Confirm the loop: monitor detects the account, evaluator builds a policy-compliant `spotQuote` + swap, relayer signs the raw `entryPoint.getUserOpHash`, the UserOp lands, and the sweep executes within bounds.
- Run it through several sweeps unattended; confirm no drift and no failed-safety reverts.

---

## 7. Observability

Watch these events during every scenario:
- `SweepExecuted(account, tokenIn, amountIn, amountOut, dest, ts)` and `SweepFailed(…)`
- `FeeCollected(account, usdgFee, feeBps, ts)`
- `BuybackBurned(usdgSpent, sweepBurned, caller, ts)`
- `PolicySet` / `PolicyRevoked`
- Timelock `CallScheduled` / `CallExecuted`; `FeeConfigured`

Cross-check declared-vs-actual: compare each swap's `spotQuote` (in the UserOp calldata) against the `amountOut` in `SweepExecuted` to spot any keeper under-declaration.

---

## 8. Freeze checklist (before handing to the auditor)

- [ ] All of §4 and §5 pass on testnet.
- [ ] Paymaster fix (A) implemented + N10 passes.
- [ ] `executeSweep` reentrancy question resolved (guard added or documented as safe).
- [ ] Keeper loop ran N unattended sweeps with zero safety reverts.
- [ ] `deployer ≠ keeper` on the final testnet deploy.
- [ ] Record the frozen commit SHA in `AUDIT_SCOPE.md` and tag it.
