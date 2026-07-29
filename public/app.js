const $ = (id) => document.getElementById(id);
const fmtUsd = (v, d) => v === null || v === undefined || isNaN(v) ? '<span class="dim">?</span>'
  : (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: d ?? (Math.abs(v) >= 1000 ? 0 : 2) });
const fmtAmt = (v) => v === null || v === undefined ? '?' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toLocaleString(undefined, { maximumFractionDigits: 4 });
const cls = (v) => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
const clip = (s, n) => s && s.length > n ? s.slice(0, n) + '…' : (s || '');

let portfolio = null, pnl = null;

$('analyze').onclick = analyze;
$('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });
$('pnlBtn').onclick = computePnl;
$('yesBtn').onclick = () => sendSignal(true);
$('noBtn').onclick = () => sendSignal(false);
['pct', 'minUsd'].forEach((id) => $(id).addEventListener('input', simulate));
document.querySelectorAll('input[name=mode],input[name=dest]').forEach((r) => r.addEventListener('change', simulate));

// share links: /?address=... auto-runs the analysis
const preset = new URLSearchParams(location.search).get('address');
if (preset) { $('addr').value = preset.trim(); analyze(); }

async function analyze() {
  const address = $('addr').value.trim();
  if (!address) return;
  portfolio = null; pnl = null;
  $('results').classList.add('hidden');
  $('status').innerHTML = '<span class="spin">Reading chain history, balances and prices...</span>';
  try {
    const res = await fetch('/api/portfolio?address=' + encodeURIComponent(address));
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'request failed');
    portfolio = body;
    history.replaceState(null, '', '?address=' + encodeURIComponent(address));
    $('status').innerHTML = 'Chain: <span class="badge b-chain">' + (body.chain === 'robinhood' ? 'Robinhood Chain (4663)' : 'Solana') + '</span>'
      + (body.meta.txCount !== null ? ' · ' + body.meta.txCount + ' transfers seen' : '')
      + ' · ' + body.meta.tokenCount + ' tokens touched';
    render();
    simulate();
    $('results').classList.remove('hidden');
    $('askStatus').textContent = '';
    document.querySelectorAll('.pnl-col').forEach((el) => el.classList.add('hidden'));
    $('pnlStatus').textContent = '';
  } catch (e) {
    $('status').innerHTML = '<span class="err">' + e.message + '</span>';
  }
}

function render() {
  const p = portfolio;
  const memePct = p.totals.totalUsd ? Math.round(100 * p.totals.memeUsd / p.totals.totalUsd) : 0;
  $('statCards').innerHTML =
    stat('Total value', fmtUsd(p.totals.totalUsd)) +
    stat('Meme exposure', fmtUsd(p.totals.memeUsd) + ' <span class="dim small">(' + memePct + '%)</span>') +
    stat('Stable', fmtUsd(p.totals.stableUsd)) +
    stat('Tokenized stocks', fmtUsd(p.totals.stockUsd)) +
    stat('Majors', fmtUsd(p.totals.majorUsd || 0)) +
    stat('Native', fmtUsd(p.totals.nativeUsd));

  const rows = [];
  if (p.native.amount) rows.push(rowHtml({ symbol: p.native.symbol, class: 'native', amount: p.native.amount, priceUsd: p.native.priceUsd, valueUsd: p.native.valueUsd, id: 'native' }));
  const MAX_ROWS = 150;
  for (const pos of p.positions.slice(0, MAX_ROWS)) rows.push(rowHtml(pos));
  if (p.positions.length > MAX_ROWS) rows.push('<tr><td colspan="8" class="dim">+ ' + (p.positions.length - MAX_ROWS) + ' smaller positions not shown (still counted in totals and the simulator)</td></tr>');
  document.querySelector('#posTable tbody').innerHTML = rows.join('');
  $('metaNotes').innerHTML = (p.meta.notes || []).map((n) => '<li>' + n + '</li>').join('');
}

const stat = (k, v) => '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';

function rowHtml(pos) {
  const pnlPos = pnl && pnl.positions.find((x) => x.id === pos.id);
  const pnlCells = pnl ? (
    '<td class="num pnl-col">' + (pnlPos ? fmtUsd(pnlPos.costUsd) : '<span class="dim">·</span>') + '</td>' +
    '<td class="num pnl-col ' + (pnlPos ? cls(pnlPos.realizedUsd) : '') + '">' + (pnlPos ? fmtUsd(pnlPos.realizedUsd) : '<span class="dim">·</span>') + '</td>' +
    '<td class="num pnl-col ' + (pnlPos && pnlPos.unrealizedUsd !== null ? cls(pnlPos.unrealizedUsd) : '') + '">' +
      (pnlPos ? (pnlPos.unrealizedUsd === null ? '<span class="dim">no basis</span>' : fmtUsd(pnlPos.unrealizedUsd)) : '<span class="dim">·</span>') + '</td>'
  ) : '<td class="num pnl-col hidden"></td>'.repeat(3);
  return '<tr><td class="sym" title="' + pos.id + '">' + clip(pos.symbol, 14) + '</td>' +
    '<td><span class="badge b-' + pos.class + '">' + pos.class + '</span></td>' +
    '<td class="num">' + fmtAmt(pos.amount) + '</td>' +
    '<td class="num">' + (pos.priceUsd === null ? '<span class="dim">no price</span>' : fmtUsd(pos.priceUsd, pos.priceUsd < 0.01 ? 6 : 2)) + '</td>' +
    '<td class="num">' + fmtUsd(pos.valueUsd) + '</td>' + pnlCells + '</tr>';
}

async function computePnl() {
  $('pnlBtn').disabled = true;
  $('pnlStatus').innerHTML = '<span class="spin">Parsing transaction history. This can take up to a minute on busy wallets...</span>';
  try {
    const res = await fetch('/api/pnl?address=' + encodeURIComponent(portfolio.address));
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'request failed');
    pnl = body;
    document.querySelectorAll('.pnl-col').forEach((el) => el.classList.remove('hidden'));
    render();
    document.querySelectorAll('.pnl-col').forEach((el) => el.classList.remove('hidden'));
    const t = pnl.totals;
    $('pnlStatus').innerHTML = 'Parsed ' + pnl.meta.txsParsed + ' transactions. Realized: <span class="' + cls(t.realizedUsd) + '">' + fmtUsd(t.realizedUsd) +
      '</span> · Unrealized: <span class="' + cls(t.unrealizedUsd) + '">' + fmtUsd(t.unrealizedUsd) + '</span>' +
      (pnl.meta.notes.length ? '<ul>' + pnl.meta.notes.map((n) => '<li>' + n + '</li>').join('') + '</ul>' : '');
    simulate();
  } catch (e) {
    $('pnlStatus').innerHTML = '<span class="err">' + e.message + '</span>';
  }
  $('pnlBtn').disabled = false;
}

function policy() {
  return {
    pct: Number($('pct').value),
    minUsd: Number($('minUsd').value),
    mode: document.querySelector('input[name=mode]:checked').value,
    dest: document.querySelector('input[name=dest]:checked').value,
  };
}

function simulate() {
  if (!portfolio) return;
  const p = policy();
  $('pctOut').textContent = p.pct + '%';
  $('minOut').textContent = '$' + p.minUsd;
  const memes = portfolio.positions.filter((x) => x.class === 'meme' && x.valueUsd !== null && x.valueUsd >= p.minUsd);
  let total = 0; const parts = [];
  if (p.mode === 'profits' && !pnl) {
    $('simOut').innerHTML = '<span class="dim">Profits-only mode needs cost basis. Click "Compute cost basis" above, or switch to whole-position mode.</span>';
    return;
  }
  for (const m of memes) {
    let base = m.valueUsd;
    if (p.mode === 'profits') {
      const pp = pnl.positions.find((x) => x.id === m.id);
      base = pp && pp.unrealizedUsd !== null ? Math.max(0, pp.unrealizedUsd) : 0;
    }
    const amt = base * p.pct / 100;
    if (amt > 0.5) { total += amt; parts.push({ sym: m.symbol, amt }); }
  }
  parts.sort((a, b) => b.amt - a.amt);
  const destTxt = p.dest === 'usdg' ? 'USDG yield' : p.dest === 'stocks' ? 'tokenized stocks (for example NVDA)' : 'a 50/50 USDG and stock split';
  $('simOut').innerHTML = total < 1
    ? '<span class="dim">Nothing eligible to sweep with these settings' + (memes.length === 0 ? ' (no priced meme positions above the minimum)' : '') + '.</span>'
    : 'A sweep today would move <span class="big">' + fmtUsd(total) + '</span> into ' + destTxt + '.' +
      '<div class="notes">' + parts.slice(0, 6).map((x) => clip(x.sym, 12) + ' ' + fmtUsd(x.amt)).join(' · ') + (parts.length > 6 ? ' · +' + (parts.length - 6) + ' more' : '') + '</div>';
}

async function sendSignal(wouldAuthorize) {
  const p = policy();
  const simTotal = (() => { try { return parseFloat($('simOut').querySelector('.big')?.textContent.replace(/[$,]/g, '')) || null; } catch { return null; } })();
  try {
    const res = await fetch('/api/signal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: portfolio.chain, address: portfolio.address, wouldAuthorize, policy: p, sweepTodayUsd: simTotal, note: $('note').value.trim() || null }),
    });
    if (!res.ok) throw new Error('failed to record');
    $('askStatus').innerHTML = wouldAuthorize
      ? '<span class="pos">Recorded. That is exactly the signal this phase exists to measure.</span>'
      : 'Recorded, thanks. The note field is the most useful part if you have a second.';
  } catch (e) {
    $('askStatus').innerHTML = '<span class="err">' + e.message + '</span>';
  }
}
