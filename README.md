<p align="center"><strong>BagSweep</strong></p>
<p align="center">The take-profit layer for on-chain meme traders. Author one policy, and a bounded keeper sweeps your profits into real yield or tokenized stocks, gaslessly. Keys stay yours, always.</p>

<p align="center">
  <a href="https://bagsweep.xyz">bagsweep.xyz</a> ·
  <a href="https://app.bagsweep.xyz">app (live)</a> ·
  <a href="https://t.me/bagsweep">Telegram</a> ·
  <a href="https://x.com/bagsweep">X</a>
</p>

---

> **Status.** Phase 1 (demand validation) is **live** at [app.bagsweep.xyz](https://app.bagsweep.xyz). The phase-2 protocol (ERC-4337 contracts + keeper) is built and running on **Robinhood Chain testnet**; mainnet is gated on a full external audit and the phase-1 demand signal.

## The idea

Traders ride a 10x back to zero because taking profit means watching charts and signing at the right moment. BagSweep makes it a policy instead.

You deploy an ERC-4337 smart account, author one sweep policy (for example, "when a token is up 300%, sweep 5% into USDG yield"), and a gasless, paymaster-sponsored keeper executes it around the clock. The keeper is mathematically bounded: it can only ever execute the exact policy you authored, within your caps, into the destinations you chose. It cannot drain your wallet, seize funds, or act outside your policy, and `ownerExecute()` lets you exit any position yourself at any time with no dependency on the keeper or a bundler. Keys stay yours.

## How it works

- **Smart account** (ERC-4337 v0.8) holds your funds and accepts a keeper signature only for a single sanctioned call shape.
- **Policy** is authored on-chain in the registry (percentage cap, user slippage floor, destination, optional token whitelist). Yours to change or revoke anytime.
- **Executor** re-derives every bound from your policy on-chain, so even a fully compromised keeper stays bounded to policy-compliant sweeps.
- **Paymaster** sponsors gas (verifying paymaster, sponsor-signed), so sweeps are free to you.
- **Destinations**: USDG yield, tokenized stocks, or a 50/50 split.

## Security

Security is the whole thesis, so the work is in the open. Start with `SECURITY.md` (trust model + residual risks) before touching the contracts.

- `PREAUDIT_FINDINGS.md`: 19 internal findings (1 critical, 5 high, 8 medium, 5 low) found and remediated with per-finding fix commits, before freezing the audit baseline.
- `AUDIT_SCOPE.md`: the frozen in-scope contract set, with the two post-freeze router adapters called out.

The core invariant, verified under adversarial review: **a fully compromised keeper cannot exceed a user's own policy.** Recipient-pinned swaps, a user-authored slippage floor, a cumulative per-call cap, and a guardian pause close proceeds redirection; users always exit via `revokePolicy` or `ownerExecute`. A full external audit is the gate before mainnet.

## Repository layout

| Path | What it is |
|---|---|
| `server.js`, `lib/`, `public/` | Phase-1 tracker (read-only, no custody) |
| `contracts/` | ERC-4337 sweep protocol (Hardhat). `cd contracts && npm install && npx hardhat test` |
| `keeper/` | Off-chain keeper (monitor to evaluator to relayer to bundler). Bounded on-chain; no secrets in code. `cd keeper && npm test` |
| `landing/` | Static apex site |
| `deploy/` | nginx + systemd for the tracker and landing |
| `deployed-addresses.json` | Robinhood Chain **testnet** addresses |

Secrets live in gitignored `.env` files (`contracts/.env`, `keeper/.env`). Never commit them.

## The token: $SWEPT

$SWEPT captures protocol revenue through an **enforced** buy-and-burn: a share of the sweep fee buys $SWEPT on the open market and burns it, on-chain, with no owner-withdrawal path in the buyback contract. More usage means more burn.

Holding $SWEPT also unlocks the optional gasless keeper tier. That is a read of the balance in your own wallet, so there is no staking, no lockup, and no escrow, and your keys stay yours. The read-only tracker, the self-serve sweep, and the `ownerExecute` exit stay open to everyone, whether they hold $SWEPT or not.

**Live on Robinhood Chain.** The one official $SWEPT contract is `0x4f2b3Af4eD8b89E1957c68524D2dbaf0521b20Bf` (fair launch via Pons, 1B fixed supply, ownerless). Any other contract calling itself $SWEPT is an impersonator.

## Phase-1 tracker

The read-only tracker at `app.bagsweep.xyz` is the demand test: paste any Robinhood Chain or Solana address, see meme exposure and best-effort PnL, simulate a sweep policy, and answer one question. No wallet connection, no signing, no custody. The server makes all chain reads (the RH RPC has an intermittent CORS double-header bug, so browsers must never call it directly).

**Run:** `node server.js` (port 3010; env: `PORT`, `TRUST_PROXY`, `RH_RPC_URL`, `SOL_RPC_URL`, `SOL_BALANCE_RPC_URL`). Share links work: `/?address=<wallet>` auto-runs.

**Endpoints:**
- `GET /api/portfolio?address=` returns positions, classes, and totals
- `GET /api/pnl?address=` returns cost basis and realized/unrealized PnL
- `POST /api/signal` records the would-you-authorize answer
- `GET /api/signals` returns the deduped tally

**Data sources:** Robinhood Chain public RPC (full-range `eth_getLogs` + batch JSON-RPC), DexScreener (`chainId: robinhood`), Scallar for the ERC-8056 stock-token registry; Solana `api.mainnet-beta` + PublicNode; Coingecko for ETH/SOL prices.

**Known limits (also disclosed in the UI):** cost basis is derived from visible in-transaction counterflows (transfers in and native-coin sell proceeds are invisible, so PnL is best-effort); history is capped (150 tx RH, 120 Solana); Solana majors and xStocks are classified heuristically; RH stock balances apply `uiMultiplier()`.

## License

**Source-available, not open source.** This code is published so anyone can read, audit, and independently verify the protocol, and run it locally against test networks. Deploying it, using it in production or commercially, or presenting a derivative as BagSweep or $SWEPT requires written permission. See `LICENSE`.
