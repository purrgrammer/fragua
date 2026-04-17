# P5.13 — Web: dashboard shell (sidepanel + home + stats)

## Goal
Turn the single-page pipelines list into a **control-panel-style dashboard
shell** with a persistent left sidepanel (Home / Workflows / Pipelines /
Settings) and a Home route that surfaces the live state of the swarm:
currently-running pipelines, recent completions, and overall stats (total
runs, success rate, total spend, total tokens, average duration). Every
other surface — graph, drilldown, steering — hangs off the same shell.

This is the canonical landing surface for "open the swarm UI". Detail URLs
remain permalinkable; the shell simply wraps them.

## Depends on
- P5.06 (pipelines list + detail — shipped)
- P5.12 (AI Elements adoption — shell reuses AI Elements `Panel` / `Toolbar`
  primitives for visual consistency)

## Scope

- Files to create:
  - `packages/web/src/components/AppShell.tsx` — persistent layout:
    left sidepanel + top bar + `<Outlet />`. Collapsible sidepanel on
    narrow viewports. Keyboard-reachable nav.
  - `packages/web/src/components/SideNav.tsx` — nav entries: Home (`/`),
    Workflows (`/workflows`), Pipelines (`/pipelines`), Settings
    (`/settings`, stub for now). Active-route highlight.
  - `packages/web/src/routes/Home.tsx` — landing page:
    - **Running strip** — one card per `status === "running"` pipeline,
      showing workflow name, short run id, elapsed time (from
      `lib/time.ts`), live event count. Click → `/pipelines/:id`.
    - **Stats tiles** — total runs, success rate, total spend (USD),
      total tokens, avg duration. Derived from the existing
      `GET /pipelines` list via the pure reducer below.
    - **Recent runs** — last 10 across all statuses (re-uses the
      `PipelinesList` row component or a compact variant).
  - `packages/web/src/routes/Workflows.tsx` — list `.dot` files known to
    the server (new endpoint below). Row: name, path, sha (short). Empty
    state when no workflows are configured.
  - `packages/web/src/routes/Settings.tsx` — placeholder route so the
    sidepanel entry isn't a dead link. Show the server URL, version, and
    any configured env var overrides.
  - `packages/web/src/lib/stats.ts` — pure reducer:
    `PipelineSummary[]` → `{ totalRuns, running, succeeded, failed,
    successRate, totalCostUsd, totalTokens, avgDurationMs }`.
    Running runs excluded from `avgDurationMs`.
  - `packages/web/test/routes/Home.test.tsx`
  - `packages/web/test/routes/Workflows.test.tsx`
  - `packages/web/test/components/AppShell.test.tsx`
  - `packages/web/test/lib/stats.test.ts`
  - `packages/server/src/routes/workflows.ts` —
    `GET /workflows` returning `[{ name, path, sha, label? }, …]`. Behind
    a `WorkflowReader` port so tests inject fixtures. Reads the configured
    workflows dir (`config.project?.workflows_dir ?? "workflows"`).
  - `packages/server/test/workflows-list.test.ts`

- Files to modify:
  - `packages/web/src/App.tsx` — wrap routes in `AppShell`.
  - `packages/web/src/lib/router.tsx` — routes:
    - `/` → `Home`
    - `/pipelines` → `PipelinesList`
    - `/pipelines/:id` → `PipelineDetail`
    - `/workflows` → `Workflows`
    - `/settings` → `Settings`
  - `packages/web/src/lib/api.ts` — add `listWorkflows()`.
  - `packages/server/src/index.ts` — mount `workflowsRoutes`.
  - `packages/server/src/ports.ts` — add `WorkflowReader` interface.

## UX notes
- **Sidepanel** is persistent; collapses to icon strip below ~768 px.
- **Home is the default landing** (`/`). The existing pipelines list now
  lives at `/pipelines`; a top-level redirect from the old `/` behaviour
  isn't needed (the UI has been live for one commit).
- **Running strip** refreshes on the same cadence as the pipelines list —
  no new SSE channel in this task. A future task can add a "swarm-wide"
  event stream if polling isn't sufficient.
- **Stats tiles** are derived client-side from the same list payload — no
  separate `/stats` endpoint yet.
- **AI Elements** primitives: use `Panel` for the sidepanel, `Toolbar` for
  the top bar when they fit naturally. Don't force them where a plain
  `<nav>` is clearer.

## Tests
- `stats.test.ts`:
  - Empty list → all zeros, `successRate === 0`.
  - Mixed statuses → counts, spend, tokens sum correctly.
  - `avgDurationMs` excludes running runs and returns `undefined` when
    no terminal runs are present.
- `Home.test.tsx`: injects an API returning fixtures; asserts running
  strip renders 0/1/N cards; stats tiles render the reducer output;
  recent runs render at most 10.
- `Workflows.test.tsx`: injected workflow list renders rows; empty state.
- `AppShell.test.tsx`: sidepanel links render; the link matching the
  current route carries an `aria-current="page"` attribute.
- `workflows-list.test.ts`: fixture `WorkflowReader` → `GET /workflows`
  returns the expected JSON; empty dir → `[]`.

## Verification
- `bun run ci` passes.
- Smoke: `bun --filter='@swarm/web' dev` + `swarm serve` — `/` shows
  Home; sidepanel navigation reaches Pipelines, Workflows, Settings and
  back. Kicking off a run in a second terminal makes the running strip
  pick it up on the next poll.
- Detail permalinks (`/pipelines/:id`) still resolve and render correctly
  inside the shell.

## Out of scope
- **Launching a run from the UI** — belongs in P5.14 (control panel ops).
- **Per-pipeline steering UI** — belongs in P5.14.
- **Long-term stats / trend charts** — pick a chart primitive in a later
  task; this one ships only single-value tiles.
- **Auth / multi-tenant** — not in P5.
- **A separate /stats endpoint** — derive client-side for now.

## Reusable patterns
- **One fetch, many views.** Home's running strip, stats tiles, and
  recent runs are all projections of the same `GET /pipelines` payload.
- **Formatting discipline stays.** Every timestamp goes through
  `lib/time.ts`; every number through `lib/format.ts`.
- **Stable routes.** Detail URL (`/pipelines/:id`) unchanged — external
  links keep working.
- **AI Elements first.** Prefer `Panel` / `Toolbar` over bespoke layout
  primitives. Only reach for custom markup when AI Elements doesn't fit.
