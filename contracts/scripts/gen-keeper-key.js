// gen-keeper-key.js — mint a fresh keeper keypair and write it straight to the env files, so the
// PRIVATE KEY never prints to the terminal (nothing to paste). Prints only the public address.
//
//   Run from the contracts dir:  node scripts/gen-keeper-key.js
//
// Writes KEEPER_ADDRESS to contracts/.env and KEEPER_KEY to keeper/.env ONLY (never the reverse).
// Both files are gitignored, so the key is never committed. Re-run to rotate (it replaces).

const fs = require("fs");
const path = require("path");
const { Wallet } = require("ethers");

const CONTRACTS_ENV = path.join(__dirname, "..", ".env");
const KEEPER_ENV = path.join(__dirname, "..", "..", "keeper", ".env");

function upsert(file, key, value) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const re = new RegExp("^\\s*" + key + "=");
  let found = false;
  const out = lines.map((l) => (re.test(l) ? ((found = true), `${key}=${value}`) : l));
  if (!found) { if (out.length && out[out.length - 1] !== "") out.push(""); out.push(`${key}=${value}`); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join("\n"));
  return found ? "updated" : "added";
}

// best-effort: confirm `.env` is covered by a .gitignore up the tree before writing a secret.
function gitignored(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 6; i++) {
    const gi = path.join(dir, ".gitignore");
    if (fs.existsSync(gi) && /(^|\n)\s*(\*\*\/)?\.env(\b|\*)/.test(fs.readFileSync(gi, "utf8"))) return true;
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return false;
}

if (!gitignored(KEEPER_ENV)) {
  console.error(`\n❌ refusing to write a key: could not confirm ${KEEPER_ENV} is gitignored. Add ".env" to .gitignore first.\n`);
  process.exit(1);
}

const w = Wallet.createRandom();
const a = upsert(CONTRACTS_ENV, "KEEPER_ADDRESS", w.address);
const k = upsert(KEEPER_ENV, "KEEPER_KEY", w.privateKey);

console.log("\n✓ fresh keeper key minted — the private key was NOT printed (by design).");
console.log(`  KEEPER_ADDRESS = ${w.address}`);
console.log(`    ${a} in ${CONTRACTS_ENV}`);
console.log(`  KEEPER_KEY (secret) ${k} in ${KEEPER_ENV}  ← the only place it lives`);
console.log("\nNext: npx hardhat run scripts/g3-preflight.js --network robinhood-testnet\n");
