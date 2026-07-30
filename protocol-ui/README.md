# BagSweep protocol UI (phase 2)

The live-protocol app: connect a wallet, deploy an ERC-4337 smart account, author a sweep
policy, watch harvests. Gasless, non-custodial, exit anytime. Testnet-first.

Full scope + decisions: `../MAINNET_UI_SCOPE.md`.

## Run
```bash
cp .env.example .env.local   # fill VITE_BUNDLER_URL + VITE_PAYMASTER_URL
npm install
npm run dev                  # http://localhost:3020
```
`.env.example` defaults to **Robinhood Chain testnet (46630)** and the testnet contracts.
Flip to mainnet by pointing the same vars at `deployed-addresses.mainnet.json` + chain `4663`.

Reads proxy through the phase-1 tracker (`vite.config.ts` `/api` -> `:3010`) because the browser
cannot hit the RH RPC directly (CORS). Start that server for the read/portfolio panels.

## State
Scaffold. Working: EOA connect, deterministic account-address resolution, the policy form
(assembles the real `setPolicy` calldata). **Not yet wired:** the ERC-4337 send path.

### The one piece to finish: `src/lib/aa.ts`
`getSmartAccountClient` throws until the custom-account adapter is implemented. permissionless.js
supplies the bundler + gas + paymaster round-trip; the adapter must supply what it can't know
about our account:
- `encodeCalls` -> `execute(dest, value, func)` (helper already in `aa.ts`)
- `getFactoryArgs` -> `createAccount(owner, salt)` (helper already in `aa.ts`)
- `signUserOperation` -> confirm the scheme against `SmartAccount.validateUserOp`
- paymaster -> call `VITE_PAYMASTER_URL` for the `SweepPaymaster` sponsor signature

`setPolicy` and `revokePolicy` are account ops (msg.sender must be the account), so they route
through this client. The self-exit (`ownerExecute`) is an owner-signed EOA tx and needs none of it.

### Before trusting anything on mainnet
The ABIs in `src/config/contracts.ts` are hand-written for the scaffold. Replace each with the
real `abi` from `contracts/artifacts/**/<Name>.json`, and confirm the `getPolicy` struct shape
and the `SweepMode` enum values.

## Decisions (defaults, change in `MAINNET_UI_SCOPE.md`)
React + Vite + TS · viem + wagmi + permissionless.js · USDG-yield-only MVP (stocks/split in v2) ·
bundler + paymaster URLs are env-driven (self-host per `BUNDLER_RUNBOOK`, or a hosted RH bundler).
