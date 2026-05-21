// Vite config for @fragua/web.
//
// Dev proxy model:
//   - `/api/**` is the ONLY prefix the client uses (see src/lib/api.ts).
//     We strip the prefix on the way out so `/api/health` → `/health` at
//     the server. Every client URL goes through `createApiClient` so this
//     is the only rule that matters in practice.
//   - We deliberately do NOT proxy the bare `/runs` or `/health`
//     prefixes. `/runs/:id` is also a client-side route (see
//     src/lib/router.tsx); proxying the bare prefix would forward a
//     full-page reload on `/runs/<id>` to the API server, which
//     returns JSON and bypasses React Router entirely. In prod the web
//     bundle is served from the same origin as the fragua server so there
//     is no proxy at all.
//   - Target selection: always proxy to the daemon. The daemon's
//     `/health` is the only one that carries the `daemon` key the UI
//     keys its job-queue features off of, so pointing the dev proxy at a
//     plain `fragua serve` (port 3000) would hide the banner state we
//     want. Read the live port from `.fragua/daemon/daemon.json`; if the
//     pidfile isn't there yet, fall back to the daemon's default port
//     (3737) so starting the daemon after Vite just works on reload.
//
// Path alias:
//   - `@/` → `src/`. Required by shadcn/ui + AI Elements components,
//     which import from paths like `@/components/ui/button` and
//     `@/lib/utils`. Kept in lockstep with `tsconfig.json#paths`.
//
// Build: emits a static bundle into `dist/` that `fragua serve` can host.
// Test:  happy-dom (see test/setup.ts) keeps tests runtime-agnostic.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

interface ProxyTarget {
  /** Origin proxied requests are forwarded to (no path). */
  target: string;
  /** When true, strip the leading `/api` before forwarding (legacy daemon
   * mode where the API lives at root). When false, forward the full
   * `/api/...` path (matches `fragua serve --dev`, where the API is mounted
   * under `/api`). */
  stripApiPrefix: boolean;
}

function resolveServerTarget(): ProxyTarget {
  // 1. Explicit env override from `fragua serve --dev` (preferred). The
  //    parent process binds the API and tells Vite where to find it. The
  //    URL already includes `/api`, so we strip it here and don't rewrite
  //    on the way out — Vite forwards the full path verbatim.
  const fromEnv = process.env["FRAGUA_API_URL"];
  if (fromEnv) {
    const trimmed = fromEnv.replace(/\/+$/, "");
    const apiSuffixed = trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
    const origin = apiSuffixed.slice(0, -"/api".length);
    return { target: origin, stripApiPrefix: false };
  }
  // 2. Legacy fallback: read the daemon pidfile and proxy to its built-in
  //    HTTP (API at root, requires `/api` rewrite). Walks up from
  //    `packages/web/vite.config.ts` to the repo root.
  const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
  try {
    const raw = readFileSync(resolve(repoRoot, ".fragua/daemon/daemon.json"), "utf8");
    const { port } = JSON.parse(raw) as { port?: number };
    if (typeof port === "number" && port > 0) {
      return { target: `http://localhost:${port}`, stripApiPrefix: true };
    }
  } catch {
    // No daemon pidfile yet — fall through to the daemon's default port
    // so starting the daemon after Vite just works on next reload.
  }
  return { target: "http://localhost:3737", stripApiPrefix: true };
}

const proxy = resolveServerTarget();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: proxy.target,
        changeOrigin: true,
        ...(proxy.stripApiPrefix ? { rewrite: (path: string) => path.replace(/^\/api/, "") } : {}),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
