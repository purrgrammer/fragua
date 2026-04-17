// Vite config for @swarm/web.
//
// Dev: proxies `/api/**` to the @swarm/server instance on :3000 so the React
//      app can use relative fetch paths in both dev and prod (served behind
//      the same origin later). The server mounts routes at root (`/health`,
//      `/pipelines`, …), so we strip the `/api` prefix on the way out.
// Build: emits a static bundle into `dist/` that `swarm serve` can host.
// Test: happy-dom keeps the component tests runtime-agnostic (works under
//       `bun test`, no jsdom peer dep required).

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
