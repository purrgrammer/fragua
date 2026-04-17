// Vite config for @swarm/web.
//
// Dev proxy model:
//   - `/api/**` is the ONLY prefix the client uses (see src/lib/api.ts).
//     We strip the prefix on the way out so `/api/health` → `/health` at
//     the server. Every client URL goes through `createApiClient` so this
//     is the only rule that matters in practice.
//   - We deliberately do NOT proxy the bare `/pipelines` or `/health`
//     prefixes. `/pipelines/:id` is also a client-side route (see
//     src/lib/router.tsx); proxying the bare prefix would forward a
//     full-page reload on `/pipelines/<id>` to the API server, which
//     returns JSON and bypasses React Router entirely. In prod the web
//     bundle is served from the same origin as the swarm server so there
//     is no proxy at all.
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
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
