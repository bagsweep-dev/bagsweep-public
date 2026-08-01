// slither-gate.mjs — CI gate over Slither findings.
//
// A scanner nobody is forced to read is not a control. This turns the reviewed
// pre-audit findings set into a machine-checked baseline: every current Slither
// finding is accepted once (human-reviewed), and CI FAILS if a *new* finding appears
// that is not in the baseline. Accepting a new finding is a deliberate, reviewed act
// (regenerate the baseline on purpose), never a silent pass.
//
// Fingerprint is line-shift-stable: check + file + the sorted identities of the code
// elements involved — so refactors that move lines don't spam the gate, but a genuinely
// new issue (new check, new function, new file) does.
//
// Usage:
//   node slither-gate.mjs baseline <slither-report.json>   # write slither-baseline.json
//   node slither-gate.mjs check    <slither-report.json>   # exit 1 on any new finding

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(DIR, 'slither-baseline.json');

function fingerprint(f) {
  const els = (f.elements || []).map(e => `${e.type}:${e.name}`).sort().join(',');
  const file = ((f.elements || [])[0]?.source_mapping?.filename_relative) || '';
  return crypto.createHash('sha256').update(`${f.check}|${file}|${els}`).digest('hex').slice(0, 16);
}
function loadFindings(reportPath) {
  const d = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  return (d.results?.detectors) || [];
}
function summarize(f) {
  const el = (f.elements || [])[0] || {};
  const where = `${el.source_mapping?.filename_relative || '?'}:${el.name || ''}`;
  return { fp: fingerprint(f), check: f.check, impact: f.impact, where };
}

const [mode, reportPath] = process.argv.slice(2);
if (!mode || !reportPath) { console.error('usage: slither-gate.mjs <baseline|check> <report.json>'); process.exit(2); }
const findings = loadFindings(reportPath);

if (mode === 'baseline') {
  const accepted = findings.map(summarize);
  const seen = new Set(); const uniq = [];
  for (const a of accepted) if (!seen.has(a.fp)) { seen.add(a.fp); uniq.push(a); }
  fs.writeFileSync(BASELINE, JSON.stringify({
    tool: 'slither', generated_from: path.basename(reportPath), count: uniq.length,
    note: 'Accepted, human-reviewed findings (reviewed pre-audit set, kept private). CI fails on any finding not listed here.',
    accepted: uniq.sort((a, b) => a.check.localeCompare(b.check)),
  }, null, 2));
  console.log(`baseline written: ${uniq.length} accepted findings -> ${path.basename(BASELINE)}`);
  process.exit(0);
}

if (mode === 'check') {
  if (!fs.existsSync(BASELINE)) { console.error('no baseline; run `baseline` first'); process.exit(2); }
  const base = new Set(JSON.parse(fs.readFileSync(BASELINE, 'utf8')).accepted.map(a => a.fp));
  const current = findings.map(summarize);
  const isNew = current.filter(c => !base.has(c.fp));
  // dedup new by fp
  const seen = new Set(); const newUniq = isNew.filter(n => !seen.has(n.fp) && seen.add(n.fp));
  if (newUniq.length === 0) {
    console.log(`static gate PASS — ${current.length} findings, all in the baseline.`);
    process.exit(0);
  }
  console.error(`static gate FAIL — ${newUniq.length} new untriaged finding(s):`);
  for (const n of newUniq) console.error(`  [${n.impact}] ${n.check}  ${n.where}  (${n.fp})`);
  console.error('\nReview each. If accepted, regenerate the baseline deliberately:');
  console.error('  node audits/static/slither-gate.mjs baseline audits/static/slither-report.json');
  process.exit(1);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
