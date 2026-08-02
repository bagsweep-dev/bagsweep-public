# Deep scan results — Mythril symbolic execution (2026-08-01)

Independent cross-check after the low-severity hardening, run on the Counterscarp
engine host (which bundles slither / myth / aderyn / medusa / crytic-compile / solc).

## How it was run

The engine's `solc` is 0.8.25 and the host is offline, so Mythril could neither compile
`^0.8.28` sources nor download 0.8.28. Workaround: the runtime bytecode was compiled
locally (solc 0.8.28 + viaIR, the production settings) and Mythril ran directly on the
bytecode, which needs no solc:

```
myth analyze -f <Contract>.runtime.hex --bin-runtime --execution-timeout 140 --max-depth 20
```

Contracts scanned: SweepExecutor, SmartAccount, SweepBuyback, SweepPolicyRegistry.

## Result: no genuine findings

Mythril reported **only SWC-101 (Integer Arithmetic)** across the four contracts, and
**nothing else** — no reentrancy (SWC-107), no unprotected selfdestruct/delegatecall
(SWC-106/112), no unchecked call return, no access-control or arbitrary-write finding.

**The SWC-101 flags are the well-known Solidity-0.8 false positives.** These contracts
compile under 0.8.28, where arithmetic is checked and *reverts* on overflow (the safe
behaviour). Mythril analyses raw bytecode with no source map, sees the arithmetic opcode,
and flags a possible overflow without modelling the compiler-inserted guard. The
give-away that it is noise: it flagged pure getters — **`feeBps()`** and **`owner()`** —
for "integer arithmetic bugs", and those perform no arithmetic. The contracts contain no
`unchecked{}` blocks and no downcasts that 0.8's checked math would miss.

## Bottom line

The independent symbolic engine surfaced **no real vulnerability** in the four core
contracts. This corroborates the in-house evidence:

- Slither static gate: PASS (76 findings, all in the reviewed baseline; hardening added none)
- Foundry invariants: 19/19 across 16,384 hostile-keeper sequences each
- Hardhat unit suite: 102/102
- Mutation testing: 14 planted, 13 killed

It also corroborates the manual verdict on the automated "Sherlock.xyz" report: its 2
Critical / 4 High findings do not correspond to real fund-loss paths.

Aderyn was attempted but did not resolve the flattened files on the offline host; Slither
covers the static-analysis tier. To reproduce with source-level line mapping, run on a host
with solc 0.8.28 available (the Counterscarp Docker image, or `solc-select install 0.8.28`).
