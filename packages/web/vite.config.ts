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
//   - Target selection: the primary path is the `FRAGUA_API_URL` env var
//     set by `fragua serve --dev` (the parent binds the API and tells Vite
//     where it is). Runtime server discovery otherwise lives in the store's
//     `server_endpoint` row, which the browser UI reads directly — the Vite
//     dev proxy can't open the store, so absent the env var it falls back to
//     the harness default port (6767) so starting the harness after Vite
//     just works on reload.
//
// Path alias:
//   - `@/` → `src/`. Required by shadcn/ui + AI Elements components,
//     which import from paths like `@/components/ui/button` and
//     `@/lib/utils`. Kept in lockstep with `tsconfig.json#paths`.
//
// Build: emits a static bundle into `dist/` that `fragua serve` can host.
// Test:  jsdom (see test/vitest.setup.ts + vitest.config.ts) — Radix portals
//        need its layout/focus shims, which happy-dom does not provide.

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
  // 2. Fallback: proxy to the harness's built-in HTTP on its default port
  //    (API at root, requires the `/api` rewrite). The live port lives in the
  //    store's `server_endpoint` row, which this config can't open, so use the
  //    default — override with `FRAGUA_API_URL` if the harness bound elsewhere.
  return { target: "http://localhost:6767", stripApiPrefix: true };
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
