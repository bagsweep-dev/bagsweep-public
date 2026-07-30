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
  encodeSetPolicy,
  encodeRevoke,
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

export default function App() {
  const { address, isConnected } = useAccount();
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
      <main>
        <Connect />
        {isConnected && address && <Protocol owner={address} />}
      </main>
      <footer className="foot">
        Non-custodial. Keys stay yours. Owner actions are direct transactions; the keeper's
        sweeps are gasless. Testnet build, do not use real funds.
      </footer>
    </div>
  );
}

function Protocol({ owner }: { owner: Address }) {
  const state = useAccountState(owner);
  return (
    <>
      <SmartAccount state={state} owner={owner} />
      <PolicyForm state={state} />
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
      <label>Max slippage (bps)
        <input value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} inputMode="numeric" />
      </label>
      <label>Token
        <input value={token} onChange={(e) => setToken(e.target.value)} className="mono" />
      </label>

      <div className="row">
        <TxButton
          label="Authorize policy"
          disabled={!ready || !setPolicyData}
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
