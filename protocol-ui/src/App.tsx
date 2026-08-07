import { useEffect, useMemo, useState } from "react";
import { type Address, parseUnits } from "viem";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { rhChain, IS_MAINNET } from "./config/chains";
import { ADDR, Destination, SweepMode, factoryAbi, accountAbi } from "./config/contracts";
import {
  getSmartAccountAddress,
  isDeployed,
  getSweepExecutor,
  getPolicy,
  getSweeps,
  getBurnTotal,
  getCooldown,
  encodeSetPolicy,
  encodeRevoke,
  assertBytecodeInSync,
} from "./lib/aa";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

type AcctState = { addr: Address; deployed: boolean; executorSet: boolean };

function useAccountState(owner: Address): UseQueryResult<AcctState> {
  return useQuery({
    queryKey: ["account-state", owner],
    queryFn: async () => {
      const addr = await getSmartAccountAddress(owner);
      const deployed = await isDeployed(addr);
      const executor = deployed ? await getSweepExecutor(addr) : ZERO;
      return { addr, deployed, executorSet: executor.toLowerCase() === ADDR.executor.toLowerCase() };
    },
  });
}

// No-wallet walkthrough: what happens, in order, before you ever connect. Plain language.
const STEPS = [
  { t: "Make your account", d: "A wallet only you control. Your coins and keys never leave your hands." },
  { t: "Set your take-profit rule", d: "Pick when to cash out. For example: sell 10% of the gains once a coin has pumped." },
  { t: "A bot does the selling", d: "An automated bot follows your rule and does the selling for you, and it pays the gas, not you. It can only ever do what your rule allows." },
  { t: "You stay in control", d: "It runs on its own, but you can change the rule, cash out, or pull everything back anytime. No middleman, no lockup." },
];

function HowItWorks() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setActive((a) => (a + 1) % STEPS.length), 2200);
    return () => clearInterval(id);
  }, []);
  return (
    <section className="demoblock">
      <h2 className="sech">How it works</h2>
      <p className="muted">Take profit without watching charts. Four steps, then it runs on its own.</p>
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={i} className={`step ${i === active ? "on" : ""}`} onMouseEnter={() => setActive(i)}>
            <span className="num">{i + 1}</span>
            <div>
              <b>{s.t}</b>
              <p>{s.d}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function App() {
  const { address, isConnected } = useAccount();
  // Preview any account's read-only dashboard via ?dash=0x… (also drives the live example below).
  const dashPreview = new URLSearchParams(location.search).get("dash");
  const demo = ADDR.demoAccount;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          BagSweep <span className="tag">protocol</span>
        </div>
        <div className={`net ${IS_MAINNET ? "mainnet" : "testnet"}`}>
          {rhChain.name} · {rhChain.id}
        </div>
      </header>

      <section className="hero">
        <h1>Take profit on autopilot</h1>
        <p>
          Set one rule. When your meme coin pumps, BagSweep sells a slice into stablecoin for you,
          automatically. Your coins never leave your wallet, and you can stop anytime.
        </p>
      </section>

      {!IS_MAINNET && (
        <div className="demobanner">
          <b>Live demo on testnet.</b> Not real money. Watch a real account in action below, or
          connect a test wallet to try it yourself.
        </div>
      )}

      <main>
        {dashPreview ? (
          <Dashboard account={dashPreview as Address} />
        ) : (
          <>
            <HowItWorks />
            {demo && (
              <section className="demoblock">
                <h2 className="sech">See it live · no wallet needed</h2>
                <p className="muted">
                  A real trader set this up. Their rule: bank 10% of the gains. The bot has quietly
                  done it four times for them already, no clicking, no watching charts. It is all
                  live from the chain below, nothing to connect or sign.
                </p>
                <Dashboard account={demo} />
              </section>
            )}
            <section className="demoblock">
              <h2 className="sech">Try it yourself · for testers</h2>
              <p className="muted">
                Want to click through it? You will need a wallet on Robinhood Chain testnet and a
                little test ETH (not real money). Not set up for that? Just watch the live account
                above, that is the whole thing working.
              </p>
              <Connect />
              {isConnected && address && <Protocol owner={address} />}
            </section>
          </>
        )}
      </main>

      <footer className="foot">
        Your coins never leave your wallet, and you can cash out anytime. This is a testnet demo,
        not real money.
      </footer>
    </div>
  );
}

function Protocol({ owner }: { owner: Address }) {
  // Fail loud if the embedded bytecode doesn't match the configured factory (audit v5): a mismatch
  // means every computed address is wrong, so disable account flows rather than strand deposits.
  const guard = useQuery({ queryKey: ["bytecode-guard"], queryFn: assertBytecodeInSync, retry: false, staleTime: Infinity });
  const state = useAccountState(owner);
  if (guard.isError) {
    return (
      <section className="card">
        <h2>Configuration error</h2>
        <p className="err">
          The embedded SmartAccount bytecode does not match the configured factory, so computed
          addresses would be wrong. Account flows are disabled. Regenerate the UI constant from the
          deploying build (contracts/scripts/gen-ui-bytecode.js).
        </p>
      </section>
    );
  }
  return (
    <>
      <SmartAccount state={state} owner={owner} />
      <PolicyForm state={state} />
      {state.data?.addr && <Dashboard account={state.data.addr} />}
    </>
  );
}

function Connect() {
  const { isConnected, address } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  if (isConnected)
    return (
      <section className="card">
        <h2>1 · Wallet</h2>
        <p className="mono">{address}</p>
        <button className="ghost" onClick={() => disconnect()}>Disconnect</button>
      </section>
    );
  return (
    <section className="card">
      <h2>1 · Connect</h2>
      <p className="muted">Connect the EOA that will own your sweep account.</p>
      {connectors.map((c) => (
        <button key={c.uid} onClick={() => connect({ connector: c })} disabled={isPending}>
          {isPending ? "Connecting..." : `Connect ${c.name}`}
        </button>
      ))}
    </section>
  );
}

// A write + confirm button: submits the tx, waits for the receipt, then refetches state.
function TxButton({
  label,
  ghost,
  disabled,
  onRun,
  onDone,
}: {
  label: string;
  ghost?: boolean;
  disabled?: boolean;
  onRun: (write: ReturnType<typeof useWriteContract>["writeContract"]) => void;
  onDone?: () => void;
}) {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: confirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  useEffect(() => {
    if (isSuccess) onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess]);
  return (
    <div className="txbtn">
      <button className={ghost ? "ghost" : ""} disabled={disabled || isPending || confirming} onClick={() => { reset(); onRun(writeContract); }}>
        {isPending ? "Confirm in wallet..." : confirming ? "Confirming..." : label}
      </button>
      {isSuccess && <span className="ok"> done</span>}
      {error && <p className="err">{(error as { shortMessage?: string }).shortMessage || error.message}</p>}
    </div>
  );
}

function SmartAccount({ state, owner }: { state: UseQueryResult<AcctState>; owner: Address }) {
  const s = state.data;
  return (
    <section className="card">
      <h2>2 · Sweep account</h2>
      {state.isLoading && <p className="muted">Resolving address...</p>}
      {s && (
        <>
          <p className="mono">{s.addr}</p>
          {!s.deployed && (
            <>
              <p className="muted">Not deployed yet. Deploy it, then enable the keeper.</p>
              <TxButton
                label="Deploy account"
                onRun={(w) => w({ address: ADDR.factory, abi: factoryAbi, functionName: "createAccount", args: [owner, 0n], chainId: rhChain.id })}
                onDone={() => state.refetch()}
              />
            </>
          )}
          {s.deployed && !s.executorSet && (
            <>
              <p className="ok">Deployed.</p>
              <p className="muted">Enable the keeper (one-time): points the account at the sweep executor.</p>
              <TxButton
                label="Enable keeper"
                onRun={(w) => w({ address: s.addr, abi: accountAbi, functionName: "setSweepExecutor", args: [ADDR.executor], chainId: rhChain.id })}
                onDone={() => state.refetch()}
              />
            </>
          )}
          {s.deployed && s.executorSet && (
            <p className="ok">Deployed and keeper-enabled. Fund it with the meme bags you want managed.</p>
          )}
        </>
      )}
    </section>
  );
}

function PolicyForm({ state }: { state: UseQueryResult<AcctState> }) {
  const [pct, setPct] = useState("25");
  const [minUsd, setMinUsd] = useState("100");
  const [slippageBps, setSlippageBps] = useState("100");
  const [token, setToken] = useState<string>(ADDR.testMeme);
  const s = state.data;
  const ready = !!s && s.deployed && s.executorSet;
  // audit M-3 interim: the registry permits up to 5000 bps (50%) slippage, which widens the
  // worst case of a keeper-key compromise. Cap what this UI will author well below that until
  // the executor gains an on-chain per-account cooldown (next audited contract revision).
  const MAX_UI_SLIPPAGE_BPS = 500;
  const slipOk = Number(slippageBps) > 0 && Number(slippageBps) <= MAX_UI_SLIPPAGE_BPS;

  // MVP: destination always USDG yield, mode profit-only. Assembled as ownerExecute calldata.
  const setPolicyData = useMemo(() => {
    try {
      return encodeSetPolicy({
        pct: Number(pct) * 100, // 25% -> 2500 bps
        minUsd: parseUnits(minUsd || "0", 6),
        mode: SweepMode.PROFIT_ONLY,
        dest: Destination.USDG_YIELD,
        tokenWhitelist: [token as Address],
        maxSlippageBps: Number(slippageBps),
      });
    } catch {
      return undefined;
    }
  }, [pct, minUsd, slippageBps, token]);

  return (
    <section className="card">
      <h2>3 · Author policy</h2>
      <p className="muted">Take profit into USDG yield. You can revoke or exit anytime.</p>
      {!ready && <p className="hint">Deploy the account and enable the keeper first.</p>}

      <label>Harvest % of gains
        <input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="numeric" />
      </label>
      <label>Minimum notional (USDG)
        <input value={minUsd} onChange={(e) => setMinUsd(e.target.value)} inputMode="numeric" />
      </label>
      <label>Max slippage (bps, ≤ {MAX_UI_SLIPPAGE_BPS})
        <input value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} inputMode="numeric" />
        {!slipOk && <span className="err"> capped at {MAX_UI_SLIPPAGE_BPS} bps ({MAX_UI_SLIPPAGE_BPS / 100}%) in this build</span>}
      </label>
      <label>Token
        <input value={token} onChange={(e) => setToken(e.target.value)} className="mono" />
      </label>

      <div className="row">
        <TxButton
          label="Authorize policy"
          disabled={!ready || !setPolicyData || !slipOk}
          onRun={(w) => w({ address: s!.addr, abi: accountAbi, functionName: "ownerExecute", args: [ADDR.registry, 0n, setPolicyData!], chainId: rhChain.id })}
        />
        <span className="dest">→ USDG yield</span>
      </div>

      <div className="exit">
        <h3>Manage</h3>
        <p className="muted">
          Revoke turns the keeper off. Self-exit runs <code>ownerExecute</code> directly, no keeper
          and no bundler.
        </p>
        <TxButton
          label="Revoke policy"
          ghost
          disabled={!ready}
          onRun={(w) => w({ address: s!.addr, abi: accountAbi, functionName: "ownerExecute", args: [ADDR.registry, 0n, encodeRevoke()], chainId: rhChain.id })}
        />
      </div>
    </section>
  );
}

// ── Step 4: live dashboard — active policy, the keeper's sweep history, and the
// fee -> buyback -> burn flywheel. All read straight from chain; renders only once a
// policy is active, so it is the natural reward after authoring one.
const DEST_LABEL = ["USDG (stablecoin)", "Stocks", "Split 50/50"];
const MODE_LABEL = ["profit-only", "whole position"];
const fmtUnits = (v: bigint, d: number, max = 2) =>
  (Number(v) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: max });
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtCooldown = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(s % 3600 ? 1 : 0)}h` : `${Math.round(s / 60)}m`);

function Dashboard({ account }: { account: Address }) {
  const policy = useQuery({ queryKey: ["policy", account], queryFn: () => getPolicy(account) });
  const cooldown = useQuery({ queryKey: ["cooldown"], queryFn: getCooldown, staleTime: Infinity });
  const sweeps = useQuery({ queryKey: ["sweeps", account], queryFn: () => getSweeps(account), refetchInterval: 30_000 });
  const hasBuyback = !!ADDR.buyback;
  const burn = useQuery({ queryKey: ["burn"], queryFn: getBurnTotal, refetchInterval: 60_000, enabled: hasBuyback });

  const p = policy.data;
  if (!p || !p.active) return null; // no card until a policy is live

  return (
    <section className="card">
      <h2>
        This account's rule <span className="pill ok">live</span> <span className="pill g">runs automatically</span>
      </h2>
      <div className="kv"><span>Takes profit</span><b>{p.pct / 100}% of gains → {DEST_LABEL[p.dest] ?? p.dest}</b></div>
      <div className="kv"><span>Minimum sale</span><b>≥ ${fmtUnits(p.minUsd, 6)} · {MODE_LABEL[p.mode] ?? p.mode}</b></div>
      <div className="kv"><span>Max slippage</span><b>{p.maxSlippageBps / 100}%</b></div>
      {cooldown.data != null && (
        <div className="kv"><span>Waits between sells</span><b>at least {fmtCooldown(cooldown.data)}</b></div>
      )}

      <h3>What the bot has done</h3>
      {sweeps.isLoading && <p className="muted">Loading…</p>}
      {sweeps.data && sweeps.data.length === 0 && (
        <p className="muted">Nothing sold yet. The bot sells when a coin crosses your threshold.</p>
      )}
      {sweeps.data?.map((s) => (
        <div className="sweep" key={`${s.block}-${s.token}-${s.ts}`}>
          <span className="t">{new Date(s.ts * 1000).toLocaleDateString()}</span>
          <span className="m">{shortAddr(s.token)} took profit</span>
          <span className="v">+{fmtUnits(s.amountOut, 6)} USDG</span>
          <span className="sub">→ {DEST_LABEL[s.dest] ?? s.dest}</span>
        </div>
      ))}

      <h3>Where the fees go</h3>
      <div className="flywheel">
        <span className="n">a small fee</span><span className="arrow">→</span>
        <span>buys {burn.data?.symbol ?? "$SWEPT"}</span><span className="arrow">→</span>
        <span className="n">burns it</span>
      </div>
      {hasBuyback && burn.data ? (
        <>
          <div className="burn">{fmtUnits(burn.data.burned, burn.data.decimals)} {burn.data.symbol}</div>
          <p className="hint">
            Total {burn.data.symbol} bought back and burned. Every sale pays a tiny fee that does this.
          </p>
        </>
      ) : hasBuyback ? (
        <p className="muted">Loading…</p>
      ) : (
        <p className="hint">
          Every sale pays a tiny fee that buys $SWEPT and burns it. This kicks in with $SWEPT on
          mainnet; on testnet it just shows the mechanism.
        </p>
      )}
    </section>
  );
}
