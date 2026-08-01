# On-chain monitor — deployed-contract drift alarm

The invariant suites prove the **code** is safe under a hostile keeper. This watches the
**deployment** for what code can't prevent: an owner-key compromise flipping a trust
anchor, an ownership transfer being initiated, the emergency pause changing, or the
paymaster deposit being drained. `watch.mjs` reads security-critical on-chain state,
diffs it against a committed baseline, and pages on any drift.

**Read-only.** `eth_call` + `eth_chainId` only. It never signs, sends, or touches a key.

## What it watches

| Contract | Fields | Alarm on |
|---|---|---|
| SweepExecutor | `owner`, `yieldPool`, `stockRouter`, `treasury`, `feeBps` | any change (critical) — these are the money-routing trust anchors |
| SweepExecutor | `USDG` | any change (critical) — immutable; a change means wrong address / proxy swap |
| SweepExecutor | `minSweepInterval` | change (notice) |
| SweepPaymaster | `owner`, `sponsorSigner`, `maxCostPerOp` | any change (critical) |
| SweepPaymaster | `getDeposit` | drop > `DEPOSIT_DROP_BPS` (default 10%) — the no-free-drain canary |
| SweepPolicyRegistry | `owner`, `paused` | any change (critical) — pause flip = incident |
| SweepAccountFactory | `owner` | any change (critical) |
| all (where present) | `pendingOwner` | non-zero = ownership transfer in flight (critical) |

## Usage

```
cd contracts
node audits/monitor/watch.mjs snapshot     # write watch-baseline.json (a reviewed act — commit it)
node audits/monitor/watch.mjs check        # diff live vs baseline; exit 2 on any critical drift
node audits/monitor/watch.mjs check --json # machine-readable alert on stdout
```

Env: `RPC_URL` (defaults to the network in `deployed-addresses.json`), `DEPOSIT_DROP_BPS`
(deposit-drop threshold, default 1000 = 10%), `WATCH_WEBHOOK` (a URL to POST the alert JSON
to on drift — Slack/Telegram/PagerDuty incoming-webhook).

Exit codes: `0` clean, `2` critical drift, `3` RPC on the wrong chain (guarded — it refuses
to compare against a baseline from a different network), `1` monitor error.

## Running it on a schedule (VPS cron)

```
# every 5 minutes; page via webhook and log
*/5 * * * * cd /opt/bagsweep/contracts && WATCH_WEBHOOK=$SWEEP_ALERT_URL \
  node audits/monitor/watch.mjs check >> /var/log/bagsweep-monitor.log 2>&1
```

## Verified

- `snapshot` reads 15 live fields off testnet 46630 and writes the baseline.
- `check` right after is green (exit 0).
- Drift **fires**: flipping `executor.treasury` and `registry.paused` in the baseline made
  `check` report 2 criticals and exit 2 (human + `--json` + webhook POST); restoring the
  baseline returned it to green. The alarm path is proven, same as the Slither gate.

## Two honest limitations

1. **Single-step ownership = after-the-fact.** `owner()` on the executor/paymaster/registry
   is plain `Ownable` (their `pendingOwner` reads as unreadable, correctly tolerated). So an
   owner change is watched as critical, but by the time the monitor sees it the transfer has
   already happened — this pages you to *respond*, it can't *prevent*. The factory exposes
   `pendingOwner`, so a factory takeover is caught while still in flight.
2. **The baseline currently watches an unconfigured deployment.** `yieldPool`, `stockRouter`,
   `treasury` are zero and `feeBps` is 0 on this testnet deploy — the sweep-to-stock/fee
   features aren't wired yet. When the operator sets them for real, the first write **will**
   page as a critical trust-anchor change. That's correct: review the change, confirm it was
   you, then `snapshot` again to accept the new baseline (the acceptance shows up in the diff,
   same discipline as the Slither gate).
