import { useMemo, useState } from "react";
import { type Address, encodeFunctionData, parseUnits } from "viem";
import { useAccount, useConnect, useDisconnect, useWriteContract } from "wagmi";
import { rhChain, IS_MAINNET } from "./config/chains";
import { ADDR, Destination, SweepMode, registryAbi } from "./config/contracts";
import { getSmartAccountAddress, getSmartAccountClient } from "./lib/aa";
import { publicClient } from "./lib/aa";
import { useQuery } from "@tanstack/react-query";

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
        {isConnected && address && (
          <>
            <SmartAccount owner={address} />
            <PolicyForm owner={address} />
          </>
        )}
      </main>

      <footer className="foot">
        Non-custodial. Keys stay yours. Testnet build, do not use real funds.
      </footer>
    </div>
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
        <button className="ghost" onClick={() => disconnect()}>
          Disconnect
        </button>
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

function SmartAccount({ owner }: { owner: Address }) {
  const { data, isLoading } = useQuery({
    queryKey: ["smart-account", owner],
    queryFn: async () => {
      const addr = await getSmartAccountAddress(owner);
      const code = await publicClient.getCode({ address: addr });
      return { addr, deployed: !!code && code !== "0x" };
    },
  });

  return (
    <section className="card">
      <h2>2 · Sweep account</h2>
      {isLoading && <p className="muted">Computing address...</p>}
      {data && (
        <>
          <p className="mono">{data.addr}</p>
          <p className={data.deployed ? "ok" : "muted"}>
            {data.deployed
              ? "Deployed. Fund it with the meme bags you want managed."
              : "Not deployed yet. It deploys automatically with your first gasless action."}
          </p>
        </>
      )}
    </section>
  );
}

function PolicyForm({ owner }: { owner: Address }) {
  const [pct, setPct] = useState("25"); // percent of gains to harvest
  const [minUsd, setMinUsd] = useState("100"); // don't act below this notional
  const [slippageBps, setSlippageBps] = useState("100"); // 1%
  const [token, setToken] = useState<string>(ADDR.testMeme);
  const [status, setStatus] = useState<string>("");

  // MVP: destination is always USDG-yield; mode = profit-only.
  const calldata = useMemo(() => {
    try {
      return encodeFunctionData({
        abi: registryAbi,
        functionName: "setPolicy",
        args: [
          Number(pct) * 100, // pct as bps (uint16): 25% -> 2500
          parseUnits(minUsd || "0", 6), // USDG is 6dp
          SweepMode.PROFIT_ONLY,
          Destination.USDG_YIELD,
          [token as Address],
          Number(slippageBps),
        ],
      });
    } catch {
      return undefined;
    }
  }, [pct, minUsd, slippageBps, token]);

  async function authorize() {
    setStatus("");
    try {
      // The account itself is the policy holder, so setPolicy runs as a UserOp:
      // account.execute(registry, setPolicy(...)) — gasless via the paymaster.
      const client = await getSmartAccountClient(owner); // throws until the AA adapter is wired
      // await client.sendUserOperation({ calls: [{ to: ADDR.registry, data: calldata! }] });
      void client;
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  return (
    <section className="card">
      <h2>3 · Author policy</h2>
      <p className="muted">Take profit into USDG yield. You can revoke or exit anytime.</p>

      <label>
        Harvest % of gains
        <input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="numeric" />
      </label>
      <label>
        Minimum notional (USDG)
        <input value={minUsd} onChange={(e) => setMinUsd(e.target.value)} inputMode="numeric" />
      </label>
      <label>
        Max slippage (bps)
        <input value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} inputMode="numeric" />
      </label>
      <label>
        Token
        <input value={token} onChange={(e) => setToken(e.target.value)} className="mono" />
      </label>

      <div className="row">
        <button onClick={authorize} disabled={!calldata}>
          Authorize (gasless)
        </button>
        <span className="dest">→ USDG yield</span>
      </div>
      {status && <p className="err">{status}</p>}

      <ExitControls owner={owner} />
    </section>
  );
}

// Revoke + self-exit. Self-exit (ownerExecute) is an owner-signed EOA tx on the account, so it
// works without a bundler — the always-available escape hatch. Revoke is an account op (its
// msg.sender must be the account), so it routes through the AA client alongside setPolicy.
function ExitControls({ owner }: { owner: Address }) {
  const { writeContract, isPending } = useWriteContract();
  void owner; // used once ownerExecute is wired to the resolved account address

  return (
    <div className="exit">
      <h3>Manage</h3>
      <p className="muted">
        Revoke turns the keeper off. Self-exit calls <code>ownerExecute</code> directly, no keeper
        and no bundler.
      </p>
      <button
        className="ghost"
        disabled={isPending}
        onClick={() =>
          // TODO(aa): route through the AA client (getSmartAccountClient) like setPolicy, since
          // msg.sender must be the account. Direct EOA call shown for shape only.
          writeContract({
            address: ADDR.registry,
            abi: registryAbi,
            functionName: "revokePolicy",
            args: [],
          })
        }
      >
        Revoke policy
      </button>
    </div>
  );
}
