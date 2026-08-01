# BagSweep in-house audit

The automated, adversarial, self-proving layer over the manual pre-audit
(kept private) and the Hardhat unit suite. Modeled on the Cowl
Protocol audit tree: a security claim without an artifact behind it does not
ship. Runs alongside Hardhat (Foundry uses `forge-out/` + `forge-cache/`; Hardhat
keeps `artifacts/` + `cache/`). Purpose: harden the contracts and give the
external auditor a running start, not replace them.

Threat model (kept private): the keeper is fully untrusted (assume
its key is compromised), the owner must always retain control, and Robinhood
Chain has no price oracle (DEX spot is manipulable).

## Status at a glance

| | Area | Where it stands |
|---|---|---|
| 🟢 | Foundry harness | `forge build` compiles all 9 contracts under solc 0.8.28 + via_ir, alongside Hardhat |
| 🟢 | Invariants #1 + #2 — SweepExecutor (no-theft + bounded liquidation) | 5 properties × 16,384 keeper sequences, all pass. **Mutation-verified: 3 of 4 killed** (strand M2, slippage-floor M3, pct-cap M4); M1 survives as documented defense-in-depth. The core contract (where C1 lived). `invariant/SweepExecutorNoTheft.t.sol`, matrix in `mutation/` |
| 🟢 | Invariant #3 — SweepBuyback no-exit | 4 invariants + 2 unit checks, 16,384 sequences. Mutation-verified 4/4 killed. USDG only exits as a burn; keeper cannot extract or redirect. `invariant/SweepBuybackNoExit.t.sol` |
| 🟢 | Invariant #4 — SweepPaymaster no-free-drain | 5 properties (fuzzed), mutation-verified 3/3 killed. Only sponsor-signed, op-bound, ceiling-bounded ops are sponsored (the H3 fix, proven). `invariant/SweepPaymasterNoFreeDrain.t.sol` |
| 🟢 | Invariant #5 — SweepPolicyRegistry owner-retains-control | 3 invariants, 16,384 sequences, mutation-verified 3/3 killed. Caps enforced, only owner pauses, list pruned (H7/M7). `invariant/SweepPolicyRegistryControl.t.sol` |
| 🟢 | Mutation testing | 14 bugs planted across all 4 contracts, 13 killed (1 documented defense-in-depth survivor). Every invariant proven to fail when its guard is removed. `mutation/README.md` |
| 🟢 | Triaged static + CI gate | Slither baseline of 74 reviewed findings + `slither-gate.mjs` + `.github/workflows/static-gate.yml`. Build fails on any new untriaged finding. Verified fires. `static/` |
| 🟡 | Deep scan (Counterscarp: Aderyn+Medusa+Mythril) | Wired: medusa.json targets the invariant harness + `deep/README.md` runbook. Local tools have version friction (crytic-compile/viaIR, broken aderyn npm, no local mythril); canonical run is the Counterscarp Docker image where all three are bundled + proven. `deep/` |
| 🟢 | Monitoring | `monitor/watch.mjs` — read-only on-chain drift alarm over the 4 deployed contracts (owners, trust anchors, pause, paymaster deposit, pendingOwner). Baseline committed; snapshot/check/webhook; drift verified to fire (exit 2). `monitor/` |

## The invariants to prove (from the threat model + the fixed findings)

Each encodes a guarantee that must hold across *any* random untrusted-keeper call
sequence — the automated form of "can a keeper break this."

1. **SweepExecutor — no keeper theft / bounded loss** (the C1 Critical, now fixed):
   across any keeper call sequence, an account cannot lose more than its policy
   cap allows, and swept proceeds land at the account, never a keeper-chosen
   recipient. *The crown jewel.*
2. **SweepExecutor — cap composition** (H1): repeated swaps of one token can never
   exceed the cumulative cap.
3. **SweepBuyback — no exit** (called out as solid in the pre-audit): buyback pool
   value only ever grows; no keeper-reachable drain path.
4. **SweepPaymaster — no free drain** (H3): the paymaster deposit only decreases by
   legitimately sponsored gas, never for free.
5. **SweepPolicyRegistry — owner retains control**: no keeper action changes
   owner-only state or the money-routing trust anchors.

## Reproducing

```
export PATH="$PATH:/z/Sentinal Engine/foundry-bin"
forge install foundry-rs/forge-std   # vendored dep, gitignored — install once into forge-lib/
forge build --skip test              # compile the contracts under Foundry
forge test --mc Invariant            # run the invariant suite
```

`forge-lib/` (forge-std) is gitignored, not committed — it's a third-party dependency, and
CI runs Slither only (no `forge build`), so it isn't needed there. Install it locally with
the command above, or point `libs` in `foundry.toml` at wherever your forge-std lives.
