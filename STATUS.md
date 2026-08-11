# BagSweep component status

**Snapshot date: 2026-08-11.** This page exists so that no reader has to infer maturity from
tone. Every component below carries an explicit status label, the evidence that supports it,
and the exact gate that must be cleared before it advances.

Read the labels literally. "Live" means deployed and reachable on mainnet. "Testnet-validated"
means it has never held mainnet value. They are not the same claim and this document will never
blur them.

## What is NOT true today

Stated first, because a status page that only lists progress is marketing.

- **The protocol is not deployed to Robinhood mainnet.** Every protocol address in
  `deployed-addresses.json` is chain **46630 (testnet)**.
- **The external audit has not cleared.** Two independent reviews have been run and remediated;
  neither is a completed engagement against the current baseline.
- **The buyback-burn has never fired.** It is deployed logic with no live execution.
- **The TWAP manipulation gate ships in `warn` mode, not `enforce`.** It logs and does not block.
- **The keeper soak test has not completed.** It is blocked on testnet ETH, not on code.
- **No user has ever swept mainnet value through this protocol.**

## Component status

| Layer | Status | Evidence and next release gate |
|---|---|---|
| **Protocol contracts** (`SweepExecutor`, `SweepPolicyRegistry`, `SmartAccount`, `SmartAccountFactory`, `SweepPaymaster`, `SweepBuyback`, `BagSweepTimelock`, V3/V4 router adapters) | **Testnet-validated, audit-pending** | **Current:** deployed and exercised on Robinhood testnet (46630). Audit baseline frozen at tag `audit-freeze-4-2026-08-01`. Two external reviews completed: the first returned only false positives; the second engaged the real threat model and produced genuine findings, all fixed and mutation-verified, with one disclosed as an unfixable Robinhood Chain residual rather than silently closed. An independent code review graded the repo B+ pending the external audit. Contract bytecode is unchanged since Revision 4; Revisions 5 to 8 touched naming, docs, and the off-chain keeper only. **Next:** a completed external audit against `audit-freeze-4-2026-08-01` with no unresolved critical or high findings, then mainnet deploy under `MAINNET_RUNBOOK.md`. |
| **Keeper** (`keeper/`, off-chain) | **Testnet operational, soak incomplete** | **Current:** runs the full evaluate, route, gate, and submit path against testnet. Out of audit scope by design: the keeper can never price a sweep, only decide whether one may proceed. **Next:** completed soak run (currently blocked on testnet ETH, not on code), and the G3 deploy in which the deployer key is not the keeper key. |
| **TWAP manipulation gate** (`keeper/src/twap.js`) | **Shipped, non-blocking** | **Current:** three checks (pool observation cardinality, window age, fast/slow/spot divergence) wired into `evaluator.js` after route selection. Default `TWAP_GATE_MODE=warn`: it logs and permits. Fails open by design so a gate outage cannot halt sweeps. Built after measuring real Robinhood Chain pools and finding usable cardinality (1400 on the pairs checked), which corrected a prior internal claim that no usable TWAP existed on this chain. **Next:** promote to `enforce` once warn-mode logs show the divergence thresholds do not fire on honest routes. |
| **$SWEPT token** (RH mainnet 4663) | **Live, bootstrap-thin** | **Current:** launched via the Pons pad. Fixed supply 1B, ownerless, immutable, WETH-paired Uniswap V3 pool with permanently locked LP. On-chain reality is thin and stated plainly: roughly 4 holders, about 98.5% of supply sits in the pool, and pool depth is around 0.02 WETH. **Next:** genuine holder distribution and pool depth. Neither is engineering work and neither is promised. |
| **Buyback-burn** (`SweepBuyback`) | **Deployed, dormant** | **Current:** protocol fee in USDG routes to WETH, buys $SWEPT, burns it. Supply-side only. It has never executed: the protocol is pre-mainnet, and even at mainnet the pool is too thin for a buyback to clear the slippage floor, so it no-ops until depth improves. Deflationary on paper, inert in fact. **Next:** mainnet deploy plus sufficient pool depth for a buy to clear the floor. |
| **Public app** (`app.bagsweep.xyz`) | **Testnet demo** | **Current:** live, publicly reachable, running against testnet with a testnet banner. Demonstrates the policy-authoring and sweep flow end to end. **Next:** repoint at mainnet contracts after the audit clears, per `MAINNET_UI_SCOPE.md`. |
| **Marketing site** (`bagsweep.xyz`) | **Live** | **Current:** static landing, no protocol interaction, no wallet connection. **Next:** none pending. |
| **PnL tracker** (phase 1) | **Live** | **Current:** meme PnL tracking across Robinhood Chain and Solana. Independent of the protocol contracts; it holds no user value and requires no approval. **Next:** none blocking. |
| **$SWEPT demand gate** (hold-to-access tier) | **Design note only** | **Current:** an internal design document. No contract, no deployment, no commitment. Explicitly changes nothing about the frozen on-chain contracts. **Next:** a decision on whether to build it at all, then legal review before any public description, since a hold-to-access tier is exactly the kind of design that attracts a securities question. |
| **Revenue share to $SWEPT holders** | **Not built, deliberately** | **Current:** does not exist. A chain-wide survey of 180 staking and fee-share vaults on Robinhood Chain found 150 holding zero real revenue, with the two largest "earners" being Robinhood's own infrastructure rather than any project. Mechanism is not the moat; revenue is. Adding a revenue-share to a protocol with no revenue would be theatre. **Next:** revisit only if the protocol earns settled fees worth sharing. |

## How to verify any row

Nothing above needs to be taken on trust:

- **Deployment claims:** `deployed-addresses.json` states `chainId 46630`. Read the addresses on
  the testnet explorer.
- **Audit baseline:** tag `audit-freeze-4-2026-08-01`. Diff it against `HEAD` to confirm the
  contract bytecode has not moved.
- **$SWEPT supply and LP lock:** read the token contract and the position on RH mainnet 4663.
  Ownerless, fixed supply, and locked LP are all on-chain facts, not claims in this file.
- **TWAP gate mode:** `keeper/src/config.js`, `twapGate.mode`, defaults to `warn`.

## Rule for updating this file

A status label may only advance when the evidence exists, not when the work feels finished.
"Testnet-validated" does not become "Live" because a mainnet deploy is scheduled; it changes when
the transaction confirms. If a component regresses, the label moves back.

The failure mode this page is designed to prevent is the one that shows up repeatedly in audits
of other projects: a claim that was true at some point, restated later in a context where it is
no longer true, with nobody noticing because the wording never changed.
