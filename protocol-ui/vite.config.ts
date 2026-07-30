import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server. Reads a browser-safe subset of env (VITE_*) only.
// Reuse the phase-1 server's RH-RPC proxy for reads (browser cannot hit the RH RPC directly:
// CORS). Point /api at it in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3020,
    proxy: {
      "/api": { target: "http://localhost:3010", changeOrigin: true },
    },
  },
});
