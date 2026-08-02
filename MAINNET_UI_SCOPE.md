# BagSweep Mainnet Protocol UI: scope

Take `app.bagsweep.xyz` from the phase-1 read-only tracker to the live protocol app:
connect a wallet, deploy an ERC-4337 smart account, author a sweep policy, turn the
bounded keeper on, watch harvests. Gasless, keys stay yours, exit anytime.

## Decisions (defaults; change any)
- **Framework:** React + Vite + TypeScript SPA (heavier tx/AA UX than the vanilla phase-1 app).
- **Chain lib / AA:** viem + wagmi + `permissionless.js` (viem-native ERC-4337).
- **MVP destinations:** USDG-yield only (`Destination.YIELD`); stocks + 50/50 in v2.
- **Bundler + paymaster:** env-driven URLs (self-hosted per `BUNDLER_RUNBOOK`, or a hosted RH 4337 bundler). Build/test on testnet first.
- **Reads:** reuse the phase-1 server's RH-RPC proxy (browser cannot hit the RH RPC directly, CORS bug) + the portfolio/PnL + sweep-simulator layer as the policy preview.

## Core flows (MVP)
1. **Connect + detect** — wallet connect (EOA). Compute the deterministic smart-account address (`factory.getAddress(owner, salt)`); show deployed vs counterfactual.
2. **Deploy + fund** — `factory.createAccount(owner, salt)` (or counterfactual + deploy-on-first-op). Move the meme bags into the account.
3. **Author policy** — form -> `registry.setPolicy(pct, minUsd, mode, dest, tokenWhitelist, maxSlippageBps)`, submitted as a UserOp through the account (gasless via paymaster). MVP: `dest = YIELD`.
4. **Dashboard** — active policy (`getPolicy`), keeper activity, bounded-keeper explainer.
5. **Manage / exit** — `revokePolicy`, and `ownerExecute` (self-exit any position, no keeper/bundler needed).
6. **Transparency (v2)** — `$SWEEP` buyback-burn stats.

## The long pole
The AA path (custom `SmartAccount` adapter for permissionless: factory args, `encodeCalls` via
`execute`, `signUserOperation`, gasless via the verifying paymaster's sponsor flow) is the real
work. It depends on a bundler + paymaster being live, which is part of the mainnet deploy, so
**build and test against testnet now** (chain 46630, the testnet contracts, a testnet bundler),
then flip addresses to mainnet at go-live. Nothing here waits on the audit.

## Reuse from phase-1
Portfolio/PnL read + sweep-simulator (= policy preview), the RH-RPC proxy, the design system,
the signals endpoint.

## Scaffold status (this repo: `protocol-ui/`)
Project + config + chain/contracts wiring + the four screens are stubbed with the real contract
calls. TODOs mark the custom-account AA adapter (the one non-mechanical piece). `npm install &&
npm run dev` after filling `.env` from `.env.example`.
