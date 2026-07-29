# BagSweep Protocol — External Audit Scope

**Status:** frozen for external audit (2026-07-28). Deployed + validated on Robinhood testnet only; NOT deployed to mainnet; do not treat as production-ready until the audit clears.
**Repo:** github.com/bagsweep-dev/bagsweep · **Audit baseline:** tag `audit-freeze-2026-07-28`, code remediated through commit `82cbcb1`.
**Solidity:** ^0.8.28 (evm target: cancun) · **Framework:** Hardhat · **Libraries:** OpenZeppelin Contracts (incl. `account`, `governance/TimelockController`), account-abstraction (EntryPoint v0.8)

**Audit freeze (2026-07-28).** This is the frozen baseline for the external audit; review the exact tag `audit-freeze-2026-07-28`.
- **Findings:** all 19 pre-audit findings (1 Critical, 5 High, 8 Medium, 5 Low) remediated and regression-tested; per-finding commit map in `PREAUDIT_FINDINGS.md`. Test suite: **83 passing**.
- **Testnet-verified (chain 46630):** full deploy (12/12 on-chain wiring checks) and a sponsored, keeper-signed sweep through the deployed v0.8 EntryPoint (tx `0x09159433004ce344e911b056870f3dc379a4893a269b3299affe2b217c2d1a21`).
- **Open operational items (not code):** renounce the timelock `DEFAULT_ADMIN_ROLE` at deploy (M3); a production mempool bundler needs a tracing-enabled RPC (see `BUNDLER_RUNBOOK.md`).

---

## 1. What BagSweep is

BagSweep is an ERC-4337 "take-profit" protocol on Robinhood Chain (chain 4663). A user deploys a smart account, authors one on-chain sweep policy, and a bounded off-chain keeper executes policy-compliant harvests (sell a bounded slice of a meme token, route the USDG proceeds to a yield venue or a tokenized stock, proceeds returning to the user's account).

**The core trust claim to verify:** *a compromised keeper key cannot drain, seize, or lock a user's funds, and cannot do anything outside the user's authored policy; the user's owner key retains ultimate control and can always exit.* The auditor's job is to try to break that claim, and to find any path to drain/seize/trap user funds or protocol funds.

The off-chain keeper is **untrusted by design**: it is modeled as an attacker in every on-chain bound.

---

## 2. Scope

### In scope (7 frozen contracts + 2 post-freeze adapters, `contracts/contracts/`)

| Contract | Purpose | Key trust surface |
|---|---|---|
| `SmartAccount.sol` | ERC-4337 user wallet; owner + bounded keeper | keeper authority bound (`_validateUserOp` / `_isAllowedKeeperCall`); owner escape hatch (`ownerExecute`) |
| `SmartAccountFactory.sol` | CREATE2 deployer for accounts | init-code hash, deterministic address, keeper wiring |
| `SweepExecutor.sol` | Stateless sweep execution; on-chain policy enforcement; protocol fee skim | the policy bounds; proceeds routing; the capped fee; the user slippage floor |
| `SweepPolicyRegistry.sol` | User-authored policies; emergency pause | policy validation; the pause (kept on a fast guardian, not the timelock) |
| `SweepPaymaster.sol` | ERC-4337 paymaster; sponsors keeper gas | who/what gets sponsored (SEE §6, self-identified gap) |
| `SweepBuyback.sol` | Fee sink; enforced buy-and-burn of $REAP | no owner USDG withdrawal path; keeper-gated buyback |
| `BagSweepTimelock.sol` | Governance timelock (thin `TimelockController` wrapper) | delay enforcement; role config |
| `SweepRouterV3Adapter.sol` *(post-freeze)* | V2->V3 router bridge: presents `swapExactTokensForTokens` to the executor, routes via Uniswap V3 `exactInput` | non-custodial routing; bounded by the executor's floor + recipient-pinning; owner fee config |
| `SweepRouterV4Adapter.sol` *(post-freeze, Path-A only)* | V2->V4 router bridge for a launchpad-graduated V4 $REAP pool: presents `swapExactTokensForTokens`, routes via the UniversalRouter's V4_SWAP | non-custodial; bounded by the upstream (SweepBuyback/executor) floor + balance-delta; owner-configured full PoolKey + stored hookData |

Interfaces `interfaces/ISweepExecutor.sol`, `interfaces/ISweepPolicy.sol` are in scope as the type surface.

> **`SweepRouterV3Adapter.sol` is a POST-FREEZE addition** (NOT in the `audit-freeze-2026-07-28` tag; added later to bridge the frozen V2-shaped executor to RH mainnet's Uniswap V3 DEX, which has no V2 router). Internal adversarial review found NO fund-theft path: it is stateless / non-custodial, pulls only from its own caller, and is fully bounded by the executor's recipient-pinning + USDG balance-delta floor + atomicity (any misbehavior reverts, never steals). Hardened with `nonReentrant`, a `rescue` event, and a zero-address guard. **✅ ROUTER GATE RESOLVED (2026-07-29, read-only on-chain probe):** RH mainnet's canonical Uniswap V3 periphery router is **SwapRouter02** at `0xCaf681a66D020601342297493863E78C959E5cb2` (verified: `factory()` == the RH V3 factory `0x1f7d…2EfA`, `WETH9()` == aeWETH; `exactInput` = the no-`deadline` selector `0xb858183f` which decodes down to the pool's `AS` revert, while the with-`deadline` v1 selector `0xc04b8d59` reverts `require(false)` = absent). The adapter's internal `IV3SwapRouter` was updated to SwapRouter02's no-`deadline` `exactInput`; the adapter still enforces `deadline` itself (`DeadlinePassed`). **Deploy action:** set the adapter's `v3Router` constructor arg to `0xCaf681a66D020601342297493863E78C959E5cb2` and configure per-pool fee tiers via the timelock.

> **`SweepRouterV4Adapter.sol` is a POST-FREEZE, Path-A-ONLY addition** (needed only if $REAP launches on a Uniswap-V4 launchpad — pmav/ORO — instead of a V3 pad). Same security model as the V3 adapter: non-custodial, forwards the caller's floor, reverts on an unconfigured pool (`PoolKeyNotSet`), stored (never caller-supplied) `hookData`, and bounded upstream by `SweepBuyback`'s balance-delta + `minSweepOut` so misbehavior degrades to a revert, never theft. V4 delivery note: `TAKE_ALL` takes output to the adapter (the router's caller), which then forwards to `to` — verified against a mock V4 router (10 tests). **⚠ MUST NOT be sanctioned on SweepBuyback until the fork gate passes** (`contracts/scripts/forktest-v4.js`): pin the real UniversalRouter + Permit2 addresses, verify the V4 command/action byte constants, read the graduated pool's real PoolKey (fee/tickSpacing/hook) from the `Initialize` event, and run one canary buyback from a contract caller. A wrong byte/address is total DoS (no fund loss), by design uncorrectable without redeploy.

### Out of scope
- `contracts/contracts/testnet/*` (MockMemeToken, MockUSDG, MockSwapRouter, MockV3Router, MockYieldPool, MockPermit2, MockUniversalRouter, DeployHelpers): test-only, never deployed to mainnet.
- The off-chain keeper service (`keeper/`) and the read-only tracker (`server.js`, `public/`, `lib/`): reviewed for correctness but explicitly untrusted on-chain. Any keeper compromise must be contained by the in-scope contracts.
- OpenZeppelin and account-abstraction library code (assumed audited; report only misuse).
- Robinhood Chain infra: the canonical EntryPoint v0.8, USDG (`0x5fc5360d…`, 6 decimals), and the DEX (Uniswap V3/V4) are external dependencies, not BagSweep code.

---

## 3. Architecture and roles

```
user (owner EOA)  ── authors policy ──▶  SweepPolicyRegistry
      │
      │ owns
      ▼
  SmartAccount  ──(UserOp via EntryPoint)──▶  SweepExecutor.executeSweep
      ▲                                             │ reads policy, enforces bounds
      │ ownerExecute (direct, no EntryPoint)        │ meme ─▶ USDG (sanctioned router)
      │                                             │ skims capped fee ─▶ SweepBuyback
   keeper (bounded, hot) ──submits sweep UserOp──   │ proceeds ─▶ account (USDG / stock / split)
                                                     ▼
   BagSweepTimelock  owns  SweepExecutor + SweepBuyback config setters
   guardian (fast)   owns  SweepPolicyRegistry pause
```

**Roles and temperatures:**
- **Owner (user):** cold; controls their own `SmartAccount`; can always exit via `ownerExecute`.
- **Keeper:** hot, automated; can only submit `execute(sweepExecutor, 0, executeSweep(...))` on a user's account. Untrusted.
- **Timelock:** cold governance over `SweepExecutor` + `SweepBuyback` config (fees, treasury, routers, keeper, pools). Schedule → `minDelay` → execute.
- **Guardian:** hot; owns only the `SweepPolicyRegistry` emergency pause (a delayed pause is useless, so it is deliberately NOT behind the timelock).
- **Deployer:** cold; must be distinct from the keeper on mainnet (enforced by `deploy.js`).
- **Buyback keeper:** triggers `buybackAndBurn`; cannot steal (output is burned) or withdraw USDG.

---

## 4. Security properties / invariants to verify

The auditor should confirm each of these holds, or find a counterexample.

**Account / keeper**
- I1. A keeper signature authorizes ONLY `execute(sweepExecutor, 0, executeSweep(...))`, never another target, non-zero value, `executeBatch`, or another inner selector.
- I2. The keeper is not a general ERC-1271 signer for the account.
- I3. The owner can move funds directly via `ownerExecute` / `ownerExecuteBatch` with no dependency on the EntryPoint, a bundler, a paymaster, or the keeper (unconditional exit).

**Sweep bounds (keeper untrusted)**
- I4. Each swap sells at most `pct × currentBalance` of a token (bounds both POSITION and PROFITS modes).
- I5. The destination must match the user's policy; STOCKS/SPLIT require an owner-sanctioned stock token.
- I6. Only owner-sanctioned routers can be used; a redirected or fake-pool swap yields 0 and reverts.
- I7. Output floor = `spotQuote × (10000 − policy.maxSlippageBps) / 10000`, with `spotQuote > 0` required. (Scope: see §6, the spot quote is keeper-declared.)
- I8. Proceeds (net of the capped fee) always return to the account.

**Fee / buyback**
- I9. The protocol fee is capped at `MAX_FEE_BPS = 1%` (immutable), defaults to 0, and is skipped when no treasury is set. The owner can never exceed the cap, even through the timelock.
- I10. USDG that reaches `SweepBuyback` can only leave as burned $REAP; there is no owner USDG-withdrawal path (`rescue` reverts on USDG and $REAP). `sweepToken` is set once (immutable burn target).

**Governance / immutability**
- I11. `SweepExecutor`, `SweepBuyback`, `SweepPolicyRegistry` are non-proxy / immutable (no upgrade path).
- I12. Config setters on the executor and buyback are only callable by the timelock once ownership is transferred; a change cannot execute before `minDelay`.
- I13. The registry pause remains callable by a fast guardian, not gated by the timelock.

---

## 5. Threat model / scenarios the auditor should attack

1. **Compromised keeper key:** attempt to drain/seize any account, exceed a policy, redirect proceeds, sweep an un-whitelisted token, or route through a fake pool.
2. **Sandwiching keeper:** manipulate the pool in-block to defeat the slippage floor (see §6, expected to be bounded only by the pct cap).
3. **Malicious protocol owner (pre-timelock, or a compromised timelock proposer):** attempt to redirect fees, register a malicious adapter/router, or change config to enable a drain; verify the timelock delay and the on-chain caps contain it.
4. **Compromised guardian:** can it do more than pause new policy registration?
5. **Reentrancy:** `SweepExecutor.executeSweep` performs external `router.call` / `yieldPool.call` / `stockRouter.call` and is NOT `nonReentrant` (see §6); `SweepBuyback.buybackAndBurn` is `nonReentrant`. Probe both.
6. **Paymaster abuse:** drain the sponsor deposit (see §6, self-identified gap).
7. **ERC-4337 edge cases:** validation-data packing, signature malleability, storage-access rules during validation, aggregator assumptions, `postOp` accounting.
8. **Decimal / math:** USDG is 6 decimals, meme tokens 18; verify the fee and slippage math and any implicit scaling.
9. **Factory:** init-code-hash correctness, address prediction, re-deployment / salt collisions.

---

## 6. Self-identified issues and accepted residuals (be upfront with the auditor)

**A. Paymaster sponsorship bound (FIXED; was a self-identified drain vector).** Originally `validatePaymasterUserOp` checked only `maxCost` and active-policy, so any active-policy account could get arbitrary UserOps sponsored and drain the deposit. Now fixed: it sponsors only a single `execute(target, 0, ...)` into an owner-sanctioned target (`eligibleTargets`, set to the executor and registry at deploy), from an active-policy sender, within `maxCostPerOp`. The unenforced keeper-only machinery was removed rather than half-implemented, because keeper-signer recovery inside paymaster validation is impractical under the 4337 storage-access rules. Covered by `SweepPaymaster.test.js`. The auditor should still confirm the callData decode and the fail-closed default (no eligible targets set means nothing is sponsored).

**B. Slippage floor is spot-based and keeper-declared (accepted, documented).** Robinhood Chain has no external oracle (Pyth/Chainlink absent) and no provisioned DEX TWAP (V3 pools are observation-cardinality 1; V4 has no native TWAP without a hook), and memes pair with tokenized stocks/WETH, not USDG. So `spotQuote` is keeper-declared. A keeper that manipulates spot in-block is bounded by the pct cap (I4), not by the floor. This is stated in `SECURITY.md`. Question for the auditor: is the pct-cap bound tight enough, and is there a better achievable floor on this chain?

**C. USDG→stock leg uses router `minOut = 0`** in `_swapToStock`. Safe direction: `stockRouter` and `stockTarget` are owner-sanctioned, the stock/USDG pools are deep, and the USDG amount is already bounded by the meme→USDG floor.

**D. `executeSweep` is not `nonReentrant`.** Bounded by the policy and the sanctioned-router allowlist, but flag whether a reentrancy guard should be added.

**E. Current testnet deploy uses `deployer == keeper`** (testnet convenience). The mainnet path in `deploy.js` throws if the two are equal, so this is a testnet-only state.

---

## 7. Hardening already applied (context)

Before this audit, four hardening items were implemented and merged (see `SECURITY.md` and the git history on `main`):
1. **Timelock** over the config setters (`BagSweepTimelock`), with the registry pause left on a fast guardian.
2. **deployer ≠ keeper** enforced at deploy time on mainnet.
3. **Owner always-exit** (`ownerExecute` / `ownerExecuteBatch`).
4. **User-authored slippage floor** (`maxSlippageBps` in the policy).

Plus the fee-capture economics (capped fee → `SweepBuyback` → enforced buy-and-burn). The auditor should still independently verify all of the above; this list is context, not a substitute for review.

---

## 8. Test coverage

- `contracts/test/` (Hardhat, Chai): 66 passing tests across `SmartAccount`, `SmartAccountFactory`, `SweepExecutor` (policy enforcement, fee, slippage), `SweepPolicyRegistry`, `SweepBuyback`, `SweepPaymaster`, `BagSweepTimelock`.
- **Gaps to note:** no fuzz / invariant tests yet. Recommend the auditor add Foundry invariant tests for I1–I13 (especially the keeper bound, the fee cap, and the buyback no-USDG-exit invariant), and the paymaster after fix A.

Build/run:
```bash
cd contracts && npm install
npx hardhat compile
npx hardhat test
```

---

## 9. Deployment topology

**Testnet (chain 46630, current):** addresses in `deployed-addresses.json`. Uses mock USDG / meme / router. `deployer == keeper` (testnet only).

**Mainnet target (chain 4663):**
- Deploy core + factory + paymaster via `scripts/deploy.js` (enforces `KEEPER_ADDRESS ≠ deployer`).
- Deploy the timelock and transfer `SweepExecutor` + `SweepBuyback` ownership via `scripts/deploy-timelock.js`; renounce the timelock admin role after wiring.
- Leave `SweepPolicyRegistry` on a fast guardian (multisig/EOA) for pause.
- EntryPoint v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`; USDG `0x5fc5360d0400a0fd4f2af552add042d716f1d168`.

---

## 10. Logistics

- Provide the auditor: this doc, `SECURITY.md`, `PREAUDIT_FINDINGS.md`, the frozen tag `audit-freeze-2026-07-28`, and read access to the repo.
- Report format: OWASP/CWE-style with severity, reproduction, and remediation.
- Disclosure: coordinate through the project's security contact; do not deploy to mainnet or describe as production-ready until the audit clears and the demand gate (Phase 1) validates.
