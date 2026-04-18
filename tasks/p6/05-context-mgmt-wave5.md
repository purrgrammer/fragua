# P6.05 — Context-management hardening: Wave 5 (server + UI introspection)

## Goal

Render the per-step context Waves 1–4 captured. Introduce a read-side
event abstraction alongside `EventSink` so route handlers stop
hand-rolling the "read events → project → render" dance and DB-backed
sinks have an opinionated upgrade path when they ship.

## Scope

### `@swarm/events` — read-side abstractions

- `packages/events/src/projection.ts` *(new)* — `EventSource` (inverse
  of `EventSink`; `listRuns + readRun`), `Projection<T>` type, helpers
  `projectRun(source, runId, projection)` and `foldAll(source,
  projection, folder, init)`, `MaterializedProjectionStore<T>`
  interface for future DB adapters, and `migrateAllRuns(source, sink)`
  for operators moving an archive between stores.

### `@swarm/server` — /pipelines/:runId/steps route

- `packages/server/src/lib/steps.ts` *(new)* — `StepSnapshot`
  interface + pure `eventsToSteps` reducer + `stepsProjection:
  Projection<StepSnapshot[]>` wrapper + `STEPS_PROJECTION_KEY = "steps"`
  cache identifier. Folds `llm.start` with companion events
  (`llm.text_delta`, `llm.done`, `cost.recorded`) into one snapshot
  per call. Each step carries the fields Wave 1 captured on
  `llm.start.data` plus an assembled `finalText` and computed
  `durationMs`.
- `packages/server/src/schemas.ts` — `StepSnapshot` + nested TypeBox
  pieces (`StepSnapshotContextFile`, `StepSnapshotMessage`,
  `StepSnapshotSettings`, `StepSnapshotBudget`, `StepSnapshotCost`)
  shared with `@swarm/web`.
- `packages/server/src/ports.ts` — kept `RunReader` as an alias for
  back-compat; added `runReaderFromSource(source)` bridge so new
  adapters target `EventSource` and slot in via the helper until the
  next refactor pass unifies the names.
- `packages/server/src/routes/pipelines.ts` — `GET
  /pipelines/:runId/steps` route: 404 on missing run, 200 with
  `StepSnapshot[]` (empty array on a valid run with no `llm.start`
  events yet).
- `packages/server/test/lib/steps.test.ts` *(10 cases)* — reducer
  unit tests: empty input, single step with all fields, text-delta
  folding, duration from `llm.start → llm.done`, cost attachment,
  context_files pass-through, budget + settings + iteration,
  loop-iteration distinct steps, `stepsProjection` wrapper, stable
  cache key.
- `packages/server/test/pipelines-steps.test.ts` *(3 cases)* — route
  contract: 200 with TypeBox-valid array; 404 + `code: "not_found"` on
  missing run; empty run returns `[]`, not 404.

### `@swarm/web` — StepInspector panel

- `packages/web/src/lib/api.ts` — `StepSnapshot` mirror interface,
  `getPipelineSteps(id): Promise<StepSnapshot[]>`, soft validator
  `isStepSnapshot` (required triple: `stepIdx`, `nodeId`,
  `startedAt` + the two strings the UI crashes on: `prompt`,
  `systemPrompt`).
- `packages/web/src/components/StepInspector.tsx` *(new)* — fetches
  snapshots, renders one `<details>` per step with collapsible
  sections: Prompt · System prompt · Prior messages · Tools ·
  Context files (with truncated / missing / sha256-prefix badges) ·
  Settings · Budget · Final assistant text. Refetches on
  `totalEvents` transitions so the panel stays live.
- `packages/web/src/routes/PipelineDetail.tsx` — new `Conversation /
  Steps` tab toggle; `<StepInspector>` shows under the `Steps` tab.
  Rules-of-Hooks fix: moved `useState` above the early-return branch.
- `packages/web/test/components/StepInspector.test.tsx` *(4 cases)* —
  loading → ready transition, empty-state on `[]`, prompt + system
  prompt rendered verbatim, truncated + missing badges on
  context_files.
- Existing test harnesses (`App.test.tsx`, `AppShell.test.tsx`,
  `PipelineDetail.test.tsx`, `Home.test.tsx`, `PipelinesList.test.tsx`,
  `Workflows.test.tsx`) updated: their `makeClient` helpers now
  satisfy `ApiClient` by providing a no-op `getPipelineSteps`.

## Design notes

- **Projection<T> as a first-class contract.** The server's existing
  `deriveSummary` / `deriveStatus` / `deriveDetail` helpers are
  effectively projections already; Wave 5 formalises the shape so
  future reducers (Wave 6+ stats reworks, budget summaries, per-tool
  drilldowns) all ride the same plumbing. Converting the existing
  reducers to the new type is out of scope for Wave 5 — a cleanup
  ticket.
- **Sink migration.** `migrateAllRuns` is intentionally thin — it
  reads every run from the source and appends it to the sink.
  Idempotency is the sink's responsibility. The docstring flags that
  the current `JsonlSink` does NOT dedupe, so repeated migrations
  would duplicate; a future Postgres sink with a unique index on
  `(run_id, timestamp, type, workflow_sha)` makes that safe.
- **No streaming source yet.** `EventSource.readRun` loads the whole
  run into memory. For very large runs (23K-event self-host runs) this
  is fine today; a future `tailRun(runId, sinceSeq)` hook can land
  when a DB adapter ships.

## Not in scope

- Converting `deriveSummary` / `deriveDetail` / `/stats` to use
  `Projection<T>` + `foldAll`. They still work end-to-end.
- Virtualisation for the step list — 10–200 steps fit in unoptimised
  React render budgets. Revisit if a user reports jank on 1000+ step
  runs.
- Prompt redaction (still deferred per earlier direction).
- `GET /pipelines/:runId/steps/:idx` single-step endpoint — the array
  is small enough that a whole-list fetch + client-side selection is
  simpler than paginating.

## Verification

- `bun run ci` → 748 pass, 0 fail (baseline 731).
- `bun run packages/cli/bin/swarm.ts validate workflows/*.dot
  examples/*.dot` — no regressions.
- Manual: `swarm serve --port 3000` + `bun run --filter='@swarm/web'
  dev`, open `/pipelines/:id`, switch to the `Steps` tab, confirm
  each step card shows the relevant sections (skip sections the run
  didn't capture — e.g. no `context_files` on an older run).
