# BagSweep: Live Testnet Runbook (split keys)

Deploy the full BagSweep stack to **Robinhood Chain testnet, chain 46630**, with a real
`deployer ≠ keeper` key split and config locked behind the timelock. This is the dress
rehearsal for mainnet: run it exactly as you would run mainnet, minus real value.

This runbook covers the **deploy and wiring**. Validation scenarios (happy path S1-S5,
negative N1-N11, keeper loop) live in [`TESTNET_TEST_PLAN.md`](TESTNET_TEST_PLAN.md); the
scope and invariants live in [`AUDIT_SCOPE.md`](AUDIT_SCOPE.md). Run the deploy here, then
switch to the test plan for §9.

**Key handling is yours alone.** Every private key goes into a local, gitignored `.env`
that never leaves your machine. Nothing in this process should ever paste a private key
into a shared channel, a hosted service, or a committed file. Confirm `.env` is gitignored
before you begin (`git check-ignore contracts/.env keeper/.env` should echo both paths).

---

## 0. Preconditions (verified 2026-07-28)

| Dependency | State | Note |
|---|---|---|
| Testnet RPC `https://rpc.testnet.chain.robinhood.com` | **live**, `eth_chainId` = `0xb626` (46630) | used for all deploy txs |
| EntryPoint v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | **deployed on testnet** | paymaster + UserOp flow work against it |
| Bundler `https://bundler.testnet.chain.robinhood.com` (the `.env.example` default) | **does NOT resolve** (NXDOMAIN) | placeholder, not a real endpoint. See §8 |
| Testnet gas | operator must fund both keys | via RH testnet faucet / bridge |

The missing bundler blocks only the **UserOp-flow** scenarios (S1-S5 and the keeper loop).
The deploy, all owner wiring, and the owner always-exit path (`ownerExecute`, direct tx)
need **no bundler** and can be completed and verified today.

Toolchain: `cd contracts && npm install && npx hardhat compile` should be clean (66 tests
pass via `npx hardhat test`).

---

## 1. The key split

Generate **two independent keypairs**. Never derive one from the other, never store them in
the same file.

| Role | Key | Temperature | Holds | Funds it needs |
|---|---|---|---|---|
| **Deployer / admin** | `DEPLOYER_KEY` | **cold** | deploys contracts; becomes the initial owner; funds + stakes the paymaster; then hands config to the timelock | gas for ~10 deploy txs + 0.1 ETH paymaster deposit + stake |
| **Keeper** | `KEEPER_KEY` | **hot** (lives in the running keeper service) | signs sweep UserOps only; bounded on-chain to a policy-compliant `executeSweep` | little to none when sponsored by the paymaster; a small buffer for safety |

Record only the **public addresses** where they are needed:
- The deployer address is derived automatically from `DEPLOYER_KEY`.
- The keeper's **public** address goes into `contracts/.env` as `KEEPER_ADDRESS`. Its private
  key (`KEEPER_KEY`) goes only into `keeper/.env`, never into `contracts/.env`.

> On testnet the deploy script only *warns* if `KEEPER_ADDRESS` equals the deployer (it
> *throws* on mainnet, chainId 4663). The whole point of this rehearsal is the split, so set
> `KEEPER_ADDRESS` to the distinct keeper address here even though testnet would tolerate the
> collapse.

Fund both addresses with testnet gas before continuing. Confirm:
```bash
cd contracts
npx hardhat console --network robinhood-testnet
# > (await ethers.provider.getBalance("<deployer addr>")).toString()
# > (await ethers.provider.getBalance("<keeper addr>")).toString()
```

---

## 2. `contracts/.env` (deployer side)

Copy `contracts/.env.example` to `contracts/.env` and fill in the deployer half:

```ini
# ── Deployer (COLD) ──
DEPLOYER_KEY=<deployer private key>          # the cold admin key; see note on 0x below

# ── RPC ──
RH_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com

# ── Contracts ──
ENTRY_POINT=0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
# USDG_ADDRESS is intentionally UNSET on testnet (deploy.js deploys MockUSDG).

# ── The split ──
KEEPER_ADDRESS=<keeper PUBLIC address>       # MUST differ from the deployer

# ── Sanctioned venues ──
# Leave SWEEP_ROUTER/STOCK_ROUTER/SANCTIONED_STOCK unset for the first deploy;
# on testnet you sanction the MockSwapRouter as owner in §4 (it doesn't exist yet).
```

> **0x prefix:** the committed hardhat default key carries a `0x` prefix, so include it. If
> hardhat rejects the key on load, toggle the prefix. (The `.env.example` comment says
> "without 0x"; the code path accepts the `0x` form, which is the safer default.)

`DEPLOYER_KEY` is the only key in this file. `KEEPER_KEY` must **not** appear here.

---

## 3. Deploy the core (deployer owns everything, for now)

```bash
cd contracts
npx hardhat run scripts/deploy.js --network robinhood-testnet
```
This deploys, in order: MockUSDG (6dp) + MockMemeToken (18dp), the registry, executor,
factory (bound to `KEEPER_ADDRESS`), and the paymaster. It sets the paymaster's eligible
targets to the executor + registry and funds it 0.1 ETH via the real EntryPoint, then writes
every address to `deployed-addresses.json` at the repo root.

Expect the two testnet-convenience warnings and, because no router is sanctioned yet:
```
⚠ No SWEEP_ROUTER sanctioned — sweeps will revert until the owner
  calls executor.setSanctionedRouter(<realDexRouter>, true).
```
That warning is correct at this stage. Check the summary block lists a paymaster address and
an EntryPoint of `0x4337…` (not "N/A"; "N/A" would mean the fork/testnet EntryPoint was not
found and the paymaster was skipped).

---

## 4. Wire venues + fund the paymaster (as owner, BEFORE the timelock)

Do all owner-only wiring now, while the **deployer still owns** the executor. After §5 these
same calls require a 24h timelock schedule, so front-load them here.

On testnet there is no real DEX pool for the mock tokens, so deploy a `MockSwapRouter` and
sanction it. See [`TESTNET_TEST_PLAN.md`](TESTNET_TEST_PLAN.md) §2-§3 for the mock router and
fixture details. The owner transactions are:

```bash
cd contracts
npx hardhat console --network robinhood-testnet
```
```js
const a = require("../deployed-addresses.json");
const executor = await ethers.getContractAt("SweepExecutor", a.executor);

// 4a. Deploy + fund a MockSwapRouter for the meme→USDG leg, then sanction it.
const Router = await ethers.getContractFactory("MockSwapRouter");
const router = await Router.deploy(); await router.waitForDeployment();
const routerAddr = await router.getAddress();
// (fund the router with MockUSDG liquidity so it can pay out; see test plan §3)
await (await executor.setSanctionedRouter(routerAddr, true)).wait();

// 4b. STOCKS leg (optional, only for S2/S3): deploy a mock stock token + router.
// await (await executor.setStockRouter(<stockRouterAddr>)).wait();
// await (await executor.setSanctionedStock(<mockStockAddr>, true)).wait();

// 4c. Stake the paymaster (deposit was done by deploy.js). Staking is required
//     for the paymaster to read the registry during validation under 4337 rules.
const paymaster = await ethers.getContractAt("SweepPaymaster", a.paymaster);
await (await paymaster.addStake(86400, { value: ethers.parseEther("0.05") })).wait();

// 4d. Fee/buyback (optional, only for S4): deploy $REAP + SweepBuyback, then
//     buyback.setSweepToken($REAP); executor.setTreasury(buyback); executor.setFeeBps(50);
```

Leave `feeBps` at 0 unless you are running the S4 fee scenario. Everything the timelock will
govern (fees, treasury, routers, sanctioned stocks) should be in its final testnet state
before §5, or scheduled through the timelock afterward.

---

## 5. Lock config behind the timelock

```bash
cd contracts
npx hardhat run scripts/deploy-timelock.js --network robinhood-testnet
```
This deploys `BagSweepTimelock` (24h `minDelay` by default) and transfers **executor**
(and `SweepBuyback`, if its address is in `deployed-addresses.json`) ownership to it. The
**registry is intentionally left on the deployer/guardian**, because its only owner power is
the emergency pause, which must stay fast.

Optional env for this step:
```ini
TIMELOCK_MIN_DELAY=86400                      # seconds (default 24h)
TIMELOCK_PROPOSERS=<addr[,addr]>              # default: deployer
TIMELOCK_EXECUTORS=<addr[,addr]>              # default: deployer (0x0 = anyone can execute a matured op)
```

Then finish the governance handoff deliberately:
1. Verify `executor.owner()` == timelock and `registry.owner()` == guardian (not the timelock).
2. Renounce the timelock's `DEFAULT_ADMIN_ROLE` from the deployer so the timelock
   self-administers (proposer/executor roles stay).
3. From here, any executor config change is `schedule → 24h → execute`. Confirm the old
   deployer EOA can no longer call `executor.setFeeBps(...)` directly (it should revert
   `OwnableUnauthorizedAccount`).

The forked dry-run already confirmed this exact end state (executor→timelock, registry→guardian,
paymaster fail-closed, deployer setter reverts). §5 reproduces it on the real chain.

---

## 6. `keeper/.env` (keeper side, the hot half)

The keeper service reads its own environment and falls back to `deployed-addresses.json` for
addresses. Create `keeper/.env`:

```ini
# ── Keeper identity (HOT) ──
KEEPER_KEY=<keeper PRIVATE key>              # the hot key; lives ONLY here

# ── RPC (GOTCHA) ──
# The keeper reads RH_RPC_URL, NOT RH_TESTNET_RPC_URL. Its default is MAINNET.
# You MUST point it at testnet here or the keeper will watch the wrong chain.
RH_RPC_URL=https://rpc.testnet.chain.robinhood.com
CHAIN_ID=46630

# ── Paymaster (GOTCHA) ──
# PAYMASTER_ADDR has no deployed-addresses.json fallback, so set it explicitly.
PAYMASTER_ADDR=<paymaster address from deployed-addresses.json>

# ── Bundler (see §8) ──
BUNDLER_URL=<your bundler endpoint>          # the public default does NOT resolve

# Registry/executor/factory/entryPoint auto-load from deployed-addresses.json
# (run the keeper from the repo so that file resolves at ../../deployed-addresses.json).
```

Two things that bite if missed:
- **`RH_RPC_URL`, not `RH_TESTNET_RPC_URL`.** The keeper has one RPC variable and it defaults
  to mainnet. Set it to the testnet endpoint.
- **`PAYMASTER_ADDR` is required.** Unlike the other addresses, the keeper does not read it
  from `deployed-addresses.json`.

Sanity-check before running:
```bash
cd keeper && npm install
node -e "import('./src/config.js').then(m => console.log(m.validateConfig()))"   # [] means OK
```

Run it:
```bash
node src/index.js
```

---

## 7. Bundler (you must provide one)

The `.env.example` default `https://bundler.testnet.chain.robinhood.com` does not resolve, so
the UserOp path has no bundler until you supply one. Two options:

1. **Find RH's actual testnet bundler URL** (if one is published) and set `BUNDLER_URL` to it.
2. **Self-host a bundler** pointed at the testnet RPC + the canonical EntryPoint. It must
   support **EntryPoint v0.8** (many bundlers still default to v0.6/v0.7, so check before
   picking). Point `--entryPoint 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` and
   `--network https://rpc.testnet.chain.robinhood.com`, then set `BUNDLER_URL` to your local
   endpoint (the keeper's config default is `http://localhost:4337`).

Confirm it answers before wiring the keeper to it:
```bash
curl -s -X POST <BUNDLER_URL> -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_supportedEntryPoints","params":[],"id":1}'
# expect a result array containing 0x4337…
```

Until a bundler is live, you can still validate everything that does not route through it:
the deploy, all §4 owner wiring, the timelock handoff (§5), and the **owner always-exit**
(`account.ownerExecute(...)` directly from the owner EOA; N3 in the test plan).

---

## 8. Validation

Switch to [`TESTNET_TEST_PLAN.md`](TESTNET_TEST_PLAN.md) and run:
- **§4** happy paths S1-S5 (need the bundler from §7).
- **§5** negative scenarios N1-N11. The four highest-signal ones prove the trust claims:
  - **N2**: keeper cannot escape its bound (non-`executeSweep` UserOp rejected).
  - **N3**: owner always-exit works with keeper/bundler/paymaster all offline.
  - **N9**: buyback USDG can only leave as burned $REAP.
  - **N10**: paymaster rejects non-eligible targets (the §5 fix; drain vector closed).
- **§6** run the keeper loop unattended through several real sweeps.

N3 and the deploy/timelock checks do not need the bundler; run them first.

---

## 9. Freeze checklist (before the auditor)

- [ ] All of test plan §4 and §5 pass on testnet.
- [ ] `deployer ≠ keeper` on this deploy (confirmed via `deployed-addresses.json`: `keeper` ≠ `deployer`).
- [ ] Config owned by the timelock; registry on the guardian; timelock `DEFAULT_ADMIN_ROLE` renounced from the deployer.
- [ ] `executeSweep` reentrancy question resolved (guard added or documented as safe).
- [ ] Keeper ran N unattended sweeps with zero safety reverts.
- [ ] Bundler endpoint recorded (public URL or self-hosted config).
- [ ] Record the frozen commit SHA in `AUDIT_SCOPE.md` and tag it.

---

## Appendix: environment variable reference

| Variable | Side | Required | Notes |
|---|---|---|---|
| `DEPLOYER_KEY` | contracts | yes | cold admin key; the only key in `contracts/.env` |
| `RH_TESTNET_RPC_URL` | contracts | yes | testnet RPC (46630) |
| `ENTRY_POINT` | contracts | yes | `0x4337…`; deploy.js deploys one if absent |
| `KEEPER_ADDRESS` | contracts | yes | keeper's **public** address; must differ from deployer |
| `USDG_ADDRESS` | contracts | no (testnet) | leave unset so MockUSDG is deployed |
| `SWEEP_ROUTER` / `STOCK_ROUTER` / `SANCTIONED_STOCK` | contracts | no | usually wired as owner in §4 instead |
| `KEEPER_KEY` | keeper | yes | hot **private** key; lives only in `keeper/.env` |
| `RH_RPC_URL` | keeper | yes | **set to testnet**; the keeper's default is mainnet |
| `CHAIN_ID` | keeper | recommended | `46630` |
| `PAYMASTER_ADDR` | keeper | yes | no `deployed-addresses.json` fallback |
| `BUNDLER_URL` | keeper | yes | public default does not resolve; supply your own |
| registry/executor/factory/entryPoint/usdg | keeper | auto | read from `deployed-addresses.json` |
