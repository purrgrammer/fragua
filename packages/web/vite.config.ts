// Vite config for @swarm/web.
//
// Dev proxy model:
//   - `/api/**` is the canonical prefix the client uses (see src/lib/api.ts).
//     We strip the prefix on the way out so `/api/health` → `/health` at
//     the server. Every client URL goes through `createApiClient` so this
//     is the only rule that matters in practice.
//   - The bare-prefix entries below (`/pipelines`, `/health`) are a dev-
//     only safety net: if any code path accidentally ships a non-prefixed
//     URL (or pastes from docs, or a hot-reload edge case), the request
//     still reaches the server instead of 404ing against the Vite dev
//     server. In prod the web bundle is served from the same origin as
//     the swarm server so there's no proxy at all.
//
// Path alias:
//   - `@/` → `src/`. Required by shadcn/ui + AI Elements components,
//     which import from paths like `@/components/ui/button` and
//     `@/lib/utils`. Kept in lockstep with `tsconfig.json#paths`.
//
// Build: emits a static bundle into `dist/` that `swarm serve` can host.
// Test:  happy-dom (see test/setup.ts) keeps tests runtime-agnostic.

import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverTarget = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: serverTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // Safety-net: unprefixed server paths forwarded as-is.
      "/pipelines": { target: serverTarget, changeOrigin: true },
      "/health": { target: serverTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
