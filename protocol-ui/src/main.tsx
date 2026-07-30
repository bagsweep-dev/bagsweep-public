import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { rhChain } from "./config/chains";
import App from "./App";
import "./styles.css";

// EOA connection only (the smart account is deployed/controlled by the connected EOA).
const wagmiConfig = createConfig({
  chains: [rhChain],
  connectors: [injected()],
  transports: { [rhChain.id]: http() },
});

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
