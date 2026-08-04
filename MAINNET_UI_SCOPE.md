# BagSweep Mainnet Protocol UI: scope

Take `app.bagsweep.xyz` from the phase-1 read-only tracker to the live protocol app:
connect a wallet, deploy an ERC-4337 smart account, author a sweep policy, turn the
bounded keeper on, watch harvests. Gasless, keys stay yours, exit anytime.

## Decisions (defaults; change any)
- **Framework:** React + Vite + TypeScript SPA (heavier tx/AA UX than the vanilla phase-1 app).
- **Chain lib:** viem + wagmi; the owner acts via direct `ownerExecute` txs. `permissionless.js` is not a dependency; add it only if the future owner-gasless path is taken (see the signature-model note below).
- **MVP destinations:** USDG-yield only (`Destination.YIELD`); stocks + 50/50 in v2.
- **Bundler + paymaster:** env-driven URLs (self-hosted per `BUNDLER_RUNBOOK`, or a hosted RH 4337 bundler). Build/test on testnet first.
- **Reads:** reuse the phase-1 server's RH-RPC proxy (browser cannot hit the RH RPC directly, CORS bug) + the portfolio/PnL + sweep-simulator layer as the policy preview.

## Core flows (MVP)
1. **Connect + detect** — wallet connect (EOA). Compute the deterministic smart-account address client-side via CREATE2 (audit M-1: the factory read is `getAddress(salt, bytecode)` over the full init code, not `(owner, salt)`); show deployed vs counterfactual.
2. **Deploy + fund** — `factory.createAccount(owner, salt)` (or counterfactual + deploy-on-first-op). Move the meme bags into the account.
3. **Author policy** — form -> `registry.setPolicy(pct, minUsd, mode, dest, tokenWhitelist, maxSlippageBps)`, submitted as an owner-signed `ownerExecute` tx (not a gasless UserOp; see the signature-model note below). MVP: `dest = YIELD`.
4. **Dashboard** — active policy (`getPolicy`), keeper activity, bounded-keeper explainer.
5. **Manage / exit** — `revokePolicy`, and `ownerExecute` (self-exit any position, no keeper/bundler needed).
6. **Transparency (v2)** — `$SWEPT` buyback-burn stats.

## Signature model (why no browser gasless owner path)
The audit-frozen `SmartAccount` (`Account` + `SignerECDSA`, no `_signableUserOpHash` override)
validates the owner's UserOp signature as a raw ECDSA signature over the plain `userOpHash`. No
browser wallet can produce that (`personal_sign` prefixes EIP-191, `signTypedData` is EIP-712, raw
`eth_sign` is disabled), so the owner does not drive gasless UserOps from the browser. Instead the
owner acts via direct `ownerExecute` txs (a cheap one-time setup on RH's L2), and the gasless path
is the keeper's: it holds a raw key server-side, signs the raw `userOpHash`, and submits
paymaster-sponsored sweeps through the bundler, bounded on-chain to sweep calls only. A future
browser-owner-gasless path would need EIP-191/ERC-7739 owner-sig support added to `SmartAccount` (a
post-audit change: re-audit the delta, redeploy the factory, regenerate the UI bytecode +
`VITE_FACTORY`). **Build and test against testnet now** (chain 46630, the testnet contracts), then
flip addresses to mainnet at go-live.

## Reuse from phase-1
Portfolio/PnL read + sweep-simulator (= policy preview), the RH-RPC proxy, the design system,
the signals endpoint.

## Scaffold status (this repo: `protocol-ui/`)
Project + config + chain/contracts wiring + the four screens are stubbed with the real contract
calls. TODOs mark the custom-account AA adapter (the one non-mechanical piece). `npm install &&
npm run dev` after filling `.env` from `.env.example`.
