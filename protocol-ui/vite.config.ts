import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server. Reads a browser-safe subset of env (VITE_*) only.
// Reuse the phase-1 server's RH-RPC proxy for reads (browser cannot hit the RH RPC directly:
// CORS). Point /api at it in dev.
export default defineConfig({
  plugins: [react()],
  // Served from app.bagsweep.xyz/demo on the VPS (nginx static location). Base must match the
  // subpath so asset URLs resolve. For a root/subdomain deploy, set this back to "/".
  base: "/demo/",
  server: {
    port: 3020,
    proxy: {
      "/api": { target: "http://localhost:3010", changeOrigin: true },
    },
  },
});
