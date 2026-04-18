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
//   - Target selection: always proxy to the daemon. The daemon's
//     `/health` is the only one that carries the `daemon` key the UI
//     keys its job-queue features off of, so pointing the dev proxy at a
//     plain `swarm serve` (port 3000) would hide the banner state we
//     want. Read the live port from `.swarm/daemon/daemon.json`; if the
//     pidfile isn't there yet, fall back to the daemon's default port
//     (3737) so starting the daemon after Vite just works on reload.
//     Override with SWARM_API_TARGET.
//
// Path alias:
//   - `@/` → `src/`. Required by shadcn/ui + AI Elements components,
//     which import from paths like `@/components/ui/button` and
//     `@/lib/utils`. Kept in lockstep with `tsconfig.json#paths`.
//
// Build: emits a static bundle into `dist/` that `swarm serve` can host.
// Test:  happy-dom (see test/setup.ts) keeps tests runtime-agnostic.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function resolveServerTarget(): string {
  if (process.env.SWARM_API_TARGET) return process.env.SWARM_API_TARGET;
  // Walk up from the web package to find the repo root's daemon state.
  // The config file lives at `packages/web/vite.config.ts`; the daemon
  // writes its pidfile at `<repo>/.swarm/daemon/daemon.json`.
  const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
  try {
    const raw = readFileSync(resolve(repoRoot, ".swarm/daemon/daemon.json"), "utf8");
    const { port } = JSON.parse(raw) as { port?: number };
    if (typeof port === "number" && port > 0) return `http://localhost:${port}`;
  } catch {
    // No daemon pidfile yet — fall through to the daemon's default port
    // so starting the daemon after Vite just works on next reload.
  }
  return "http://localhost:3737";
}

const serverTarget = resolveServerTarget();

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
