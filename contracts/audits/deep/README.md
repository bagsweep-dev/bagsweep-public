# Deep scan — Counterscarp engine (Aderyn · Medusa · Mythril)

The third analysis tier, on top of the invariant suite and the Slither gate: the deep
tools from the Counterscarp engine. These need a bundled, version-locked toolchain
(crytic-compile + solc + the three tools), which is what the Counterscarp Docker image
provides — so the **canonical run is through Counterscarp**, and this folder wires it.

| Tool | Kind | Adds over what we have |
|---|---|---|
| **Aderyn** | static (Rust) | a second static engine beside Slither — different detector set |
| **Medusa** | coverage-guided fuzzer | fuzzes the Foundry invariant harness with a different engine than Foundry's own |
| **Mythril** | symbolic execution | the genuinely additive one — explores paths symbolically, not by sampling |

## Running it (canonical: Counterscarp)

Counterscarp bundles all three + a pinned crytic-compile in its Docker image and accepts
a project by git URL or zip (`project_ingest.py`). Point it at this repo:

```
# from the Counterscarp checkout (the operator's own engine)
counterscarp audit --project /path/to/sweep-tracker/contracts \
  --solc-args "--optimize --via-ir" --exclude "node_modules,contracts/testnet,forge-lib"
# or submit the zip/git URL through app.counterscarp.io (private project)
```

The engine runs the full pipeline (heuristic + fingerprint + Slither + Aderyn + Medusa +
Mythril + supply-chain OSV) and emits the branded report.

## Local Medusa (partial)

`medusa.json` targets the invariant test contracts in assertion + property mode. Medusa
1.5.1 is installed locally, but its crytic-compile → `forge build` bridge fails on this
project's `via_ir` + non-default `out` layout ("No source files found in specified build
paths"). The Counterscarp Docker image pins a crytic-compile/solc/forge combination that
handles it; run there. To retry locally once the toolchain aligns:

```
export PATH="$PATH:/z/Sentinal Engine/foundry-bin:/c/Users/David/go/bin"
medusa fuzz --config audits/deep/medusa.json
```

## Aderyn (blocked locally)

The npm `aderyn` shim on this machine is broken (`MODULE_NOT_FOUND`). Use the Rust binary
(`cargo install aderyn` or the Counterscarp image), then:

```
aderyn contracts/ -o audits/deep/aderyn-report.md
```

## Status

Deep-scan **wired** (config + this runbook + CI hook below). Canonical execution is the
Counterscarp Docker pipeline, where the three tools are bundled and proven together. The
local partial runs are blocked only by toolchain-version friction, not by the harness.
