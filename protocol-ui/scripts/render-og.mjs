// render-og.mjs — render the 1200x630 Twitter/OG card into public/og.png (Playwright/chromium).
// Run once when the card copy changes:  node scripts/render-og.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "..", "public", "og.png");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#0b0d10;color:#e8edf2;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;overflow:hidden}
.card{width:100%;height:100%;padding:60px 70px;display:flex;flex-direction:column;position:relative}
.bar{position:absolute;top:0;left:0;right:0;height:8px;background:#00c805}
.top{display:flex;align-items:center;justify-content:space-between}
.brand{font-size:40px;font-weight:800;letter-spacing:-.02em}
.brand .tag{color:#00c805;font-weight:700;font-size:24px;margin-left:10px}
.pill{border:1px solid #00c805;color:#00c805;font-size:19px;font-weight:700;padding:8px 18px;border-radius:999px;letter-spacing:.08em}
.mid{flex:1;display:flex;flex-direction:column;justify-content:center}
.h1{font-size:64px;font-weight:800;line-height:1.05;letter-spacing:-.02em}
.h1 .g{color:#00c805}
.sub{font-size:28px;color:#8b97a3;margin-top:22px;line-height:1.4;max-width:1000px}
.flow{display:flex;gap:12px;margin-top:32px;flex-wrap:wrap}
.flow .s{border:1px solid #232a31;border-radius:12px;padding:11px 17px;font-size:21px}
.flow .s b{color:#00c805;margin-right:6px}
.foot{display:flex;align-items:center;justify-content:space-between;font-size:23px}
.url{color:#00c805;font-weight:700;font-family:ui-monospace,monospace}
.note{color:#8b97a3}
</style></head><body>
<div class="card">
  <div class="bar"></div>
  <div class="top">
    <div class="brand">BagSweep <span class="tag">protocol</span></div>
    <div class="pill">LIVE TESTNET DEMO</div>
  </div>
  <div class="mid">
    <div class="h1">Automated <span class="g">take-profit</span>,<br>non-custodial by design.</div>
    <div class="sub">Set one on-chain policy. A bounded keeper harvests your meme gains into USDG for you, gasless. Your keys stay yours, exit anytime.</div>
    <div class="flow">
      <div class="s"><b>1</b>Deploy account</div>
      <div class="s"><b>2</b>Set a policy</div>
      <div class="s"><b>3</b>Keeper harvests</div>
      <div class="s"><b>4</b>Buy back &amp; burn $SWEPT</div>
    </div>
  </div>
  <div class="foot">
    <span class="url">app.bagsweep.xyz/demo</span>
    <span class="note">Robinhood Chain testnet &middot; no wallet needed to watch</span>
  </div>
</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(HTML, { waitUntil: "load" });
await page.screenshot({ path: OUT });
await browser.close();
console.log("OG card rendered ->", OUT);
