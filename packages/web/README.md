# @fragua/web

Vite + React + Tailwind client for the fragua HTTP/SSE server.

At the current phase this package is a **scaffold**: it renders a shell with
a health-check badge that confirms the React app can reach `@fragua/server`
through the Vite dev proxy. Runs sidebar, graph view, timeline, and
step drilldown land in follow-up tasks (P5.06 – P5.08).

## Commands

```sh
# Install deps (from repo root)
bun install

# Dev server (expects @fragua/server on :3000 — see below)
bun run --filter='@fragua/web' dev          # Vite on http://localhost:5173

# Production build → packages/web/dist
bun run --filter='@fragua/web' build

# Typecheck / tests
bun run --filter='@fragua/web' typecheck
bun run --filter='@fragua/web' test
```

## Local dev loop

Two terminals:

```sh
# A: start the server
bun run packages/cli/bin/fragua.ts serve --port 3000

# B: start Vite
bun run --filter='@fragua/web' dev
```

Open http://localhost:5173 — the header badge should flip to **connected**.
Requests to `/api/**` are proxied to the server on :3000 with the `/api`
prefix stripped, so the client can use relative URLs in both dev and
(future) production builds served by `fragua serve`.
