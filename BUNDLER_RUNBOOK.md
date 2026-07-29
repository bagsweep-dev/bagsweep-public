# BagSweep: Self-Hosting an ERC-4337 Bundler (v0.8)

A bundler accepts UserOperations over `eth_sendUserOperation`, validates them, and submits
`EntryPoint.handleOps(...)` on-chain. BagSweep needs one only for **decentralized UserOp
submission** (keeper → bundler → chain). It is **not** a correctness dependency: the full
sponsored flow (keeper-signed + paymaster-sponsored sweep through the deployed v0.8 EntryPoint)
is already proven on testnet by driving `handleOps` directly (a "private bundler"): see the
reference tx `0x09159433004ce344e911b056870f3dc379a4893a269b3299affe2b217c2d1a21`.

## Read this first: the Robinhood-chain constraint

Verified 2026-07-28 against `https://rpc.testnet.chain.robinhood.com`:

- The chain is **Arbitrum Nitro** (`web3_clientVersion` = `nitro/v3.11.3`).
- The public RPC does **NOT** expose **`debug_traceCall`** (`method does not exist`).
- No RH-operated bundler endpoint is live (`bundler.testnet.chain.robinhood.com` does not resolve).
- EntryPoint **v0.8** is deployed at `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`.

A standard bundler uses `debug_traceCall` (the ERC-7562 tracer) to enforce the 4337 validation
rules (banned opcodes, storage access) on **untrusted** ops. Without it you have two choices:

1. **`--unsafe` mode**: the bundler skips the tracer and validates with plain `eth_call`. It
   works against this RPC and is fine for a **single-operator testnet demo**, but it does NOT
   enforce the mempool-safety rules, so it must not run an open/production mempool.
2. **A tracing-enabled RPC/node**: run your own Nitro node with the debug namespace enabled,
   or use a provider that exposes `debug_traceCall`. Required for a real production bundler.

Because BagSweep's keeper is the only entity submitting ops (they are keeper-signed and
sponsor-signed), the practical near-term answer is `--unsafe` against the public RPC; move to
a tracing node only if you open submission beyond your own keeper.

## Requirements

1. A bundler build that supports **EntryPoint v0.8** (verify: v0.8 is newer than v0.6/v0.7 and
   not every bundler supports it yet). This repo pins `@account-abstraction/contracts@0.8.0`,
   so match the bundler to that EntryPoint.
2. A **funded bundler EOA** (the signer that sends `handleOps` and fronts gas, reimbursed from
   the paymaster deposit / account). In production keep it distinct from the deployer and the
   keeper.
3. Either a **tracing RPC** (production) or the bundler in **`--unsafe`** mode (testnet).
4. A **hosted long-running process** exposing the bundler JSON-RPC.

## Setup (eth-infinitism reference bundler, template)

Adjust flag names to your bundler's CLI; the values are what matter.

```bash
# 1. Get a v0.8-capable bundler and install it (verify v0.8 support first).
#    e.g. the eth-infinitism reference bundler at a version aligned with EntryPoint v0.8.

# 2. Configure it against RH testnet + the canonical v0.8 EntryPoint, unsafe mode:
#      --network        https://rpc.testnet.chain.robinhood.com
#      --entryPoint     0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
#      --beneficiary    <bundler EOA address>   (receives gas refunds)
#      --privateKey     <bundler EOA key>       (funded; NOT the deployer/keeper key)
#      --unsafe                                  (no debug_traceCall on the public RPC)
#      --port           3000
#      --minStake / --minUnstakeDelay            (0 for a demo)

# 3. Confirm it's up and speaks v0.8:
curl -s -X POST http://localhost:3000/rpc -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_supportedEntryPoints","params":[],"id":1}'
#   expect a result array containing 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
```

### Nitro gas-model gotcha

Arbitrum Nitro charges an L1 data component on top of L2 gas, and `eth_estimateUserOperationGas`
must account for it. If ops land but revert on gas, or the bundler under-estimates
`preVerificationGas`, raise `preVerificationGas` (it absorbs the L1 data fee) and confirm the
bundler's estimator is Nitro-aware. The manual UserOp in the proof above used
`preVerificationGas = 100000` with generous verification/call limits.

## Wire the keeper to it

The keeper already builds the UserOp (keeper signature + verifying-paymaster sponsor signature)
and submits it via `eth_sendUserOperation`. Point it at your bundler:

```ini
# keeper/.env
BUNDLER_URL=http://localhost:3000/rpc     # your bundler's JSON-RPC endpoint
```

`keeper/src/relayer.js` assembles the op (see the sign details below); `keeper/src/bundler.js`
posts it to `BUNDLER_URL`. No code change is needed, only the endpoint.

**Signing (already implemented, for reference):**
- Keeper signs the RAW `entryPoint.getUserOpHash(userOp)` with `wallet.signingKey.sign(...)`
  (OZ's `_signableUserOpHash` returns the v0.8 userOpHash unchanged; no EIP-191 prefix).
- Sponsor signs `paymaster.getHash(userOp, validUntil, validAfter)` with `signMessage`
  (EIP-191), appended to `paymasterAndData` as `[…gasLimits][validUntil][validAfter][sig]`.

## Verify end to end

Submit one sweep UserOp through the bundler and confirm the same result the private-bundler
proof produced: the account's meme is swept, USDG returns to it, `SweepExecuted` is emitted,
and the paymaster's EntryPoint deposit drops by the sponsored gas. The bundler log should show
it bundling the op and sending `handleOps`.

## Production checklist

- [ ] **Do NOT run `--unsafe`** for an open mempool. Stand up a tracing-enabled Nitro node (or
      a provider exposing `debug_traceCall`) and drop `--unsafe`.
- [ ] Bundler signer is **funded, monitored, and distinct** from the deployer and keeper.
- [ ] Paymaster **staked** at the EntryPoint (`addStake`) for bundler reputation. Note: the
      verifying paymaster reads **no external storage** during validation (the M5 fix), so it
      does not need stake for the storage rules, but stake is still expected for reputation.
- [ ] Sponsor-signer key secured (it authorizes all sponsorship; currently the keeper).
- [ ] Rate limiting on submission if you accept ops beyond your own keeper.
