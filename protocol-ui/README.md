# BagSweep protocol UI (phase 2)

Connect the EOA that owns your sweep account, deploy your ERC-4337 smart account, author a
take-profit policy, and watch the keeper harvest it. Non-custodial, exit anytime. Testnet-first.

Full scope + decisions: `../MAINNET_UI_SCOPE.md`.

## Run
```bash
cp .env.example .env.local   # testnet defaults work as-is
npm install
npm run dev                  # http://localhost:3020
```
`.env.example` targets **Robinhood Chain testnet (46630)** with the testnet contracts from
`../deployed-addresses.json`. Flip to mainnet by pointing the same vars at
`deployed-addresses.mainnet.json` + chain `4663`.

On-chain reads go straight to `VITE_RPC_URL` via viem (verified working on RH testnet). The
`vite.config.ts` `/api` -> `:3010` proxy is a leftover for a future portfolio panel; it is not
required by the current UI, and also serves as a fallback if the public RPC's intermittent CORS
behavior ever bites.

## What works
- **Owner flows (direct EOA txs):** deploy the account (`factory.createAccount`), enable the keeper
  (`setSweepExecutor`), author / revoke a policy (`ownerExecute` -> `registry.setPolicy` /
  `revokePolicy`), and self-exit (`ownerExecute`). All owner-signed via wagmi `useWriteContract`.
- **Live dashboard (step 4):** the active policy (`registry.getPolicy`), the keeper's sweep history
  (`SweepExecuted` logs), the on-chain cooldown (`minSweepInterval`), and the total burned
  (`buyback.sweepToken()` -> `balanceOf(0x…dEaD)`). Renders only once a policy is active. A dev-only
  `?dash=0x…` preview (`import.meta.env.DEV`, stripped from production builds) renders any account's
  read-only dashboard without a wallet.

## Why there is no browser ERC-4337 send path (by design)
The owner does **not** drive gasless UserOps from the browser. The audit-frozen `SmartAccount`
(`Account` + `SignerECDSA`, with no `_signableUserOpHash` override) validates the owner's UserOp
signature as a **raw ECDSA signature over the plain `userOpHash`**. No browser wallet can produce
that: `personal_sign` adds the EIP-191 prefix, `signTypedData` is EIP-712, and raw `eth_sign` is
disabled in mainstream wallets. So:

- the **owner** acts via direct `ownerExecute` transactions (a cheap, one-time setup on RH's L2), and
- the **gasless path is the keeper's**: it holds a raw key server-side, signs the raw `userOpHash`,
  and submits paymaster-sponsored sweeps through the bundler (see `../BUNDLER_RUNBOOK.md`). The keeper
  is bounded on-chain to `execute(sweepExecutor, executeSweep)` only, which is a security property,
  not a limitation to remove.

A future browser-owner-gasless path would need EIP-191/ERC-7739 owner-signature support added to
`SmartAccount` (a post-audit contract change: re-audit the delta, redeploy the factory, regenerate
the UI bytecode constant + `VITE_FACTORY`). The `VITE_BUNDLER_URL` / `VITE_PAYMASTER_URL` env are
kept **reserved** for that path; `permissionless` was removed as unused, re-add it if you take it.

## Before trusting anything on mainnet
The ABIs in `src/config/contracts.ts` are hand-written. Replace each with the real `abi` from
`contracts/artifacts/**/<Name>.json` (including the dashboard's `SweepExecuted` event and the
buyback reads), and confirm the `getPolicy` struct shape and the `SweepMode` enum values.

## Decisions (defaults, change in `MAINNET_UI_SCOPE.md`)
React + Vite + TS · viem + wagmi (the owner acts via direct txs) · USDG-yield-only MVP (stocks/split
in v2) · gasless sweeps run server-side in the keeper, not the browser · bundler / paymaster env
reserved for a possible future post-audit owner-gasless path (add `permissionless` then).
