# P5.13 — Web: dashboard shell (sidebar + home + stats tiles)

## Goal
Turn the current single-page pipelines list into a **control-panel-style
dashboard shell**: a persistent, collapsible sidebar (`shadcn/ui Sidebar`)
with Home / Workflows / Pipelines / Settings routes, and a Home route that
shows the live state of the swarm — currently-running pipelines, recent
completions, and overall stats tiles (total runs, success rate, total
spend USD, total tokens, avg duration).

Every other surface (graph "map", per-run conversation, drilldown,
steering) hangs off the same shell. Detail URLs stay permalinkable.

## Depends on
- P5.06 (pipelines list + detail — shipped)
- P5.12 (AI Elements adoption — Tailwind 4 + shadcn/ui + the AI Elements
  components are wired up by the time this task runs)

## Scope

- Files to create:
  - `packages/web/src/components/AppShell.tsx` — persistent layout using
    `SidebarProvider` + `Sidebar` + `SidebarInset`. Cookie-backed
    collapsed state so the user's choice survives reloads. Renders a
    `Breadcrumb` + any top-right header actions above the routed
    `<Outlet />`.
  - `packages/web/src/components/AppSidebar.tsx` — sidebar content:
    header with the "swarm" wordmark, a `SidebarMenu` grouping the four
    nav entries, and a footer slot for the connection-status badge
    (reuse the existing `connected` indicator from the current App.tsx
    header — move it here).
  - `packages/web/src/routes/Home.tsx` — landing:
    - **Running strip** — a horizontal row of `Card`s, one per pipeline
      with `status === "running"`, showing workflow name, short run id,
      elapsed time (from `lib/time.ts`), live event count. Click → the
      detail route. Use an AI Elements `Shimmer` on the "running" badge
      for a subtle live-indicator. Empty state: AI Elements' nothing —
      use shadcn `Empty` with an `icon` (lucide `Play`).
    - **Stats tiles** — 5 `Card`s in a responsive grid: total runs,
      success rate, total spend (USD), total tokens, avg duration. All
      derived client-side from the `GET /pipelines` list via the pure
      reducer below. Loading: shadcn `Skeleton`.
    - **Recent runs** — last 10 across all statuses, compact variant of
      the `PipelinesList` row component (reuse, don't re-skin).
  - `packages/web/src/routes/Workflows.tsx` — list `.dot` files known to
    the server via the new endpoint below. Columns: name, path, short
    sha. shadcn `Table`. Empty state: `Empty` with lucide `FileCode2`.
  - `packages/web/src/routes/Settings.tsx` — placeholder route so the
    nav entry isn't a dead link. Show the configured server URL, the
    web bundle version, and any `SWARM_*` env vars observed at build
    time. shadcn `Card`-based layout.
  - `packages/web/src/lib/stats.ts` — **pure reducer**:
    `PipelineSummary[]` → `{ totalRuns, running, succeeded, failed,
    successRate, totalCostUsd, totalTokens, avgDurationMs? }`.
    Running runs excluded from `avgDurationMs`; `avgDurationMs` is
    `undefined` when no terminal runs exist.
  - `packages/web/test/routes/Home.test.tsx`
  - `packages/web/test/routes/Workflows.test.tsx`
  - `packages/web/test/components/AppShell.test.tsx`
  - `packages/web/test/lib/stats.test.ts`
  - ~~`packages/server/src/routes/workflows.ts`~~ — **already shipped**
    in commit `1f4bbff` (P5.12) along with `FsWorkflowReader`. Do not
    rewrite; import and mount as-is. If the shape doesn't match what
    Home needs, extend it; don't replace it.
  - `packages/server/src/routes/stats.ts` —
    `GET /stats` returning a server-side aggregate across ALL runs under
    `runsDir` (not just the first page). Shape:
    ```ts
    type StatsPayload = {
      totalRuns: number;
      running: number;
      succeeded: number;
      failed: number;
      successRate: number;         // 0..1; 0 when totalRuns === 0
      totalCostUsd: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      avgDurationMs?: number;      // omitted when no terminal runs
      updatedAt: string;           // ISO — lets the client decide whether to poll
    };
    ```
    Derive by streaming each run's events and reusing `aggregateCost`
    from `@swarm/events` + the existing `deriveSummary` status logic
    (`packages/server/src/routes/pipelines.ts`). Behind the existing
    `RunReader` port — no new port method needed; iterate `listRuns()` +
    `readEvents(id)`. Short-term fine to re-compute on each request;
    cache with a TTL in a later task if it matters. Optional query
    param `?workflow=<name>` filters by workflow name (match against
    `deriveWorkflowName` output) — scaffold the arg but default to all.
  - `packages/server/test/stats.test.ts` — inject a `RunReader` fixture
    with 0 / 1 / N runs and a mix of statuses; assert aggregates match
    the client-side `lib/stats.ts` reducer given the same inputs
    (parity test keeps the two honest against each other).

- Files to modify:
  - `packages/web/src/App.tsx` — wrap routes in `<AppShell>`, drop the
    existing ad-hoc header (it migrates into AppSidebar + AppShell).
  - `packages/web/src/lib/router.tsx` — add routes:
    - `/` → `Home`
    - `/pipelines` → `PipelinesList`
    - `/pipelines/:id` → `PipelineDetail`
    - `/workflows` → `Workflows`
    - `/settings` → `Settings`
    (Old landing at `/` was `PipelinesList`; no redirect needed — the UI
    has been live one commit.)
  - `packages/web/src/lib/api.ts` — add `listWorkflows()`.
  - `packages/server/src/index.ts` — mount `workflowsRoutes`.
  - `packages/server/src/ports.ts` — add `WorkflowReader` interface.

## Library directives (baked in — no skills/MCP fetch required)

### Use `shadcn/ui` for the shell (collapsible Sidebar is load-bearing)

Install via `cd packages/web && npx shadcn@latest add <component>`. The
existing shadcn/ui initialization (done in P5.12) is reused; this task
installs the specific components listed below.

- **`sidebar`** — the whole reason to pick shadcn for the shell. It
  ships `SidebarProvider`, `Sidebar`, `SidebarTrigger`, `SidebarInset`,
  `SidebarContent`, `SidebarGroup`, `SidebarGroupLabel`,
  `SidebarGroupContent`, `SidebarMenu`, `SidebarMenuItem`,
  `SidebarMenuButton`, `SidebarRail`, plus keyboard shortcut (`⌘ / Ctrl + b`)
  and cookie-backed persistent collapsed state out of the box.
  Use `collapsible="icon"` so the sidebar collapses to a thin rail of
  icons instead of disappearing — critical for a control-panel shell.
  Docs: https://ui.shadcn.com/docs/components/sidebar
- **`breadcrumb`** — above the routed outlet. Derive from the current
  route: `Home` → `Workflows` / `Pipelines / <short-run-id>` / etc.
- **`card`** — running strip, stats tiles, Settings sections.
- **`table`** — Workflows list.
- **`skeleton`** — loading state for Home's stats tiles and running strip
  (before the first `/pipelines` response).
- **`empty`** — empty states for Home's running strip (no runs yet) and
  Workflows route (no `.dot` files configured).
- **`badge`** — status chips in the running strip (reuse the existing
  one in `packages/web/src/components/ui/badge.tsx` if already present).
- **`separator`** — subtle dividers inside Settings cards.
- **`tooltip`** — on icon-collapsed sidebar entries so the full name
  shows on hover.

Minimal layout scaffold (illustrative — adjust to actual needs):

```tsx
// AppShell.tsx
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Outlet } from "react-router-dom";

export function AppShell() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem><BreadcrumbPage>Home</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <main className="flex-1 overflow-auto p-4">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

// AppSidebar.tsx
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel,
  SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuButton,
  SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar";
import { Home, Workflow, ListChecks, Settings } from "lucide-react";
import { NavLink } from "react-router-dom";

const NAV = [
  { to: "/",          label: "Home",      icon: Home },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/pipelines", label: "Pipelines", icon: ListChecks },
  { to: "/settings",  label: "Settings",  icon: Settings },
];

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>{/* wordmark */}</SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Surface</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton asChild tooltip={label}>
                    <NavLink to={to}>
                      <Icon />
                      <span>{label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>{/* connection status */}</SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
```

### Use `lucide-react` for all icons (already transitively installed)

shadcn/ui and AI Elements both consume `lucide-react` — it's already in
the node_modules. Import icons directly:

```tsx
import { Home, Workflow, ListChecks, Settings, Play, FileCode2, Activity, DollarSign, Timer, Hash } from "lucide-react";
```

Rules:
- **No emoji** anywhere in the shell (including running strip / stats
  tiles / empty states). Emoji look fine in the conversation view — not
  here. Use lucide exclusively for iconography.
- Size via the `className` prop (`className="size-4"` for the common
  16px size that shadcn menus use, `size-5` for stats tile accents).
- Never import `@lucide/*` (the monorepo name) — always `lucide-react`.

### Icon picks for this task
| Surface                | Icon                |
| ---------------------- | ------------------- |
| Sidebar: Home          | `Home`              |
| Sidebar: Workflows     | `Workflow`          |
| Sidebar: Pipelines     | `ListChecks`        |
| Sidebar: Settings      | `Settings`          |
| Running strip card     | `Play`              |
| Stat: total runs       | `Hash`              |
| Stat: success rate     | `CheckCircle2`      |
| Stat: total spend      | `DollarSign`        |
| Stat: total tokens     | `Coins` or `Hash`   |
| Stat: avg duration     | `Timer`             |
| Empty: no workflows    | `FileCode2`         |
| Empty: no runs         | `Play`              |
| Connection: connected  | `Plug` / `Zap`      |
| Connection: offline    | `PlugZap` (red)     |

## Components that already exist — don't rewrite

- `packages/web/src/components/ui/{badge,button,card,empty-state,table}.tsx`
  — reuse as-is; don't re-skin. If shadcn's versions conflict, prefer
  shadcn's (it's the canonical source) and remove any duplicate.
- `PipelinesList` row — factor out its row markup as a compact component
  the Home recent-runs list can reuse; do not create a second row renderer.

## UX notes

- **Sidebar** is persistent; uses `collapsible="icon"` so the narrow
  state still shows icons. The toggle is keyboard-accessible (`⌘ + b` /
  `Ctrl + b` — shadcn wires this automatically).
- **Home is the default landing** (`/`).
- **Running strip** refreshes on the same cadence as the pipelines list
  — no new SSE channel. A future task can add a swarm-wide event stream
  if polling isn't enough.
- **Stats tiles** are derived client-side from the same list payload —
  no `/stats` endpoint.
- **AI Elements stay in their lane**: `Panel` / `Toolbar` from AI
  Elements are for the Workflow canvas only; the dashboard chrome uses
  shadcn primitives. Don't mix the two vocabularies in the same surface.

## Tests

- `stats.test.ts`:
  - Empty list → all zeros; `successRate === 0`; `avgDurationMs === undefined`.
  - Mixed statuses → counts, spend, tokens sum correctly.
  - `avgDurationMs` excludes running runs; returns `undefined` when no
    terminal runs exist.
- `Home.test.tsx`: injects an API returning fixtures; asserts running
  strip renders 0 / 1 / N cards; stats tiles render the reducer output;
  recent runs render at most 10; loading state shows skeletons.
- `Workflows.test.tsx`: injected workflow list renders rows; empty state.
- `AppShell.test.tsx`: sidebar renders the four nav entries with lucide
  icons; the link matching the current route carries
  `aria-current="page"` (or shadcn's `data-active="true"`, whichever the
  component exposes); `⌘ + b` toggles the collapsed state.
- `workflows-list.test.ts`: fixture `WorkflowReader` → `GET /workflows`
  returns expected JSON; empty dir → `[]`.

## Verification

- `bun run ci` passes.
- Smoke: `bun --filter='@swarm/web' dev` + `swarm serve` — `/` shows
  Home with running strip + stats tiles + recent runs. Sidebar collapses
  to the icon rail via the trigger or keyboard shortcut and the choice
  persists after a refresh. Launching a pipeline in a second terminal
  makes the running strip pick it up on the next poll. Detail permalinks
  (`/pipelines/:id`) still resolve and render inside the shell.

## Out of scope

- **Launching a run from the UI** — belongs in P5.14.
- **Per-pipeline steering UI** — belongs in P5.14.
- **Long-term stats / trend charts** — pick a chart primitive later
  (shadcn `chart` over recharts is the obvious default). This task ships
  only single-value tiles.
- **Auth / multi-tenant** — not in P5.
- **Conversation view** on the detail route — owned by P5.08.
- **Graph "map" sidebar collapse behavior** on detail route — owned by
  P5.08.
- ~~A separate `/stats` endpoint~~ — **now in scope** (see "Files to
  create" above). Client-side reducer stays too, as a fallback + for
  projections / tests.

## Reusable patterns

- **One fetch, many views.** Home's running strip, stats tiles, and
  recent runs are all projections of the same `GET /pipelines` payload.
- **Formatting discipline stays.** Every timestamp through `lib/time.ts`;
  every number through `lib/format.ts`. No inline `Intl` calls, no
  `.toFixed(2)` in JSX.
- **Stable routes.** Detail URL (`/pipelines/:id`) unchanged.
- **Two vocabularies, one app:** shadcn for the shell (sidebar, cards,
  tables, skeletons), AI Elements for the AI-native surfaces (graph
  canvas, per-run conversation, reasoning, tools). Don't bleed them.
