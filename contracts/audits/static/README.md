# Static-analysis gate

Slither runs in CI on every change to `contracts/**`, and the build **fails on any
finding not in the reviewed baseline**. A scanner whose output nobody is forced to read
is not a control; this makes the reviewed set (kept private) the enforced
floor.

## How it works

- `slither-baseline.json` — the accepted, human-reviewed findings (74 of them: the
  reentrancy-balance/arbitrary-send Highs are the CEI-protected, policy-bound payouts; the
  rest are Info/Low naming/loop/timestamp notes). Each is stored as a **line-shift-stable
  fingerprint** (`check + file + sorted element identities`), so refactors that move lines
  don't spam the gate, but a genuinely new issue (new check, new function, new file) does.
- `slither-gate.mjs` — `check` mode diffs a fresh Slither report against the baseline and
  exits 1 if any finding is not accepted. `baseline` mode regenerates the accepted set.
- `.github/workflows/static-gate.yml` — runs Slither + the gate on push/PR.

Verified: the gate passes clean on the current 76 findings, and fires (exit 1) the moment
a finding falls outside the baseline.

## Accepting a new finding (deliberate re-triage)

When the gate fails, review each new finding. If it is a real issue, fix it. If it is an
accepted false-positive or a known residual, regenerate the baseline **on purpose** (a
reviewed act, visible in the diff):

```
export PATH="/d/Python/Scripts:$PATH"   # or wherever slither lives
cd contracts
slither . --json audits/static/slither-report.json \
  --filter-paths "node_modules|contracts/testnet|forge-lib|lib/" || true
node audits/static/slither-gate.mjs baseline audits/static/slither-report.json
git add audits/static/slither-baseline.json   # the acceptance is now in the history
```

Never silence a finding by editing the report — only the committed baseline counts, and
every acceptance shows up in review.
