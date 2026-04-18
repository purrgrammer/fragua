# Web UI

The React + Vite client lives in `packages/web/`. The app sits inside a persistent `AppShell` (sidebar + breadcrumb header + connection badge) and routes to:

- `/` — Home dashboard (stats tiles from `GET /stats` + recent runs)
- `/pipelines` — full pipelines list (the table-shaped view)
- `/pipelines/:id` — per-run detail with graph + active-node highlight
- `/workflows` — workflow catalog
- `/settings` — client settings

Metrics (cost, input/output tokens, duration) are derived server-side from `cost.recorded` events and rendered in both the list and the detail header. The sidebar reads connection status from `HealthContext`, so the route tree stays stable across health-status flips (tests rely on this).

The web surface standardizes on **Vercel AI Elements** end-to-end (`Workflow` for the graph, Chatbot family for drilldown, human-in-the-loop set for steering). P5.08 (pipeline Conversation view) and P5.12 (AI Elements adoption) are landed; P5.07 (raw event timeline) was dropped in favour of the Conversation view. P5.13 (dashboard shell) is landed. P5.09 (Ink TUI) is landed — `swarm dashboard [--run-id <id>]` renders an ASCII graph with the active node highlighted, a cost/token ticker, and a rolling event stream, with `s` to steer, `a` to abort, `q` to quit (falls back to a one-shot snapshot on non-TTY stdout). Remaining P5 work: P5.10 (`swarm replay` feeds TUI + web), P5.11 (Playwright visual regression + cost reconciliation).

The `<StepInspector>` component fetches `StepSnapshot[]` and renders collapsible sections per step (prompt · system prompt · messages · tools · context files · settings · budget · cost · final text). Toggle between `Conversation` and `Steps` tabs on `/pipelines/:id`.

## Dev proxy

```sh
# Terminal A — start the HTTP/SSE server
bun run packages/cli/bin/swarm.ts serve --port 3000

# Terminal B — start the Vite dev server on :5173 (proxies /api → :3000)
bun run --filter='@swarm/web' dev
```

Open http://localhost:5173 — the sidebar footer flips to **connected** once the proxy reaches `/health`. Build a static bundle with `bun run --filter='@swarm/web' build` → `packages/web/dist/`.

The Vite dev server proxies `/api/**` to the swarm server. The target defaults to `http://localhost:3000`; override with `SWARM_SERVER_URL` if the server is on a different port or host:

```sh
SWARM_SERVER_URL=http://localhost:4000 bun run --filter='@swarm/web' dev
```

The client code always uses the relative `/api/...` prefix (see `packages/web/src/lib/api.ts` — the URL discipline comment there is load-bearing). See `packages/web/README.md` for more detail.

## Locale-aware helpers

**User-facing timestamps and numbers** flow through the locale-aware helpers in `packages/web/src/lib/time.ts` (dates, relative "3 min ago") and `packages/web/src/lib/format.ts` (USD cost, token counts via `Intl.NumberFormat`). Never render a raw ISO string or bare number to the user — add a helper there if one is missing.
