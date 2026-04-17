# P5.06 — addendum (from human steering, 2026-04-17)

Layer on top of `tasks/p5/06-web-graph-view.md`. The primary task (data-first
graph view + active-node highlight) is unchanged, BUT the working tree
already contains substantial WIP from a prior run. Your first job is to
orient yourself to that WIP, not to re-scaffold from scratch.

## Orient first — there is existing WIP on disk

Run `git status` and `git diff --stat` before anything else. At time of
this addendum the working tree already has:

- `packages/web/src/components/GraphView.tsx` + `GraphView.module.css`
- `packages/web/src/components/ui/**` (empty-state, button, etc.)
- `packages/web/src/lib/router.tsx`, `lib/useSSE.ts`, `lib/cn.ts`, `lib/time.ts`
- `packages/web/src/routes/PipelinesList.tsx`, `PipelineDetail.tsx`
- `packages/web/src/types/**`
- Tests under `packages/web/test/{components,lib,routes}/**`
- Modified `App.tsx`, `api.ts`, `vite.config.ts`, `tailwind.config.ts`, etc.

Treat all of this as already-landed WIP. Integrate with it. Do NOT delete
files, rename modules, or replace hand-written components with fresh ones
unless they're genuinely broken. If something conflicts with your plan,
prefer adapting your plan.

Do NOT run the run with `--worktree` — this run is intentionally in the
main tree so you can build on the WIP.

## Already done on disk — do NOT redo

A prior run added `workflow_path` plumbing. Do not reinvent it:

- `packages/core/src/executor/execute.ts` — `ExecuteOptions.workflow_path`
  and `pipeline.started.data.workflow_path` emit.
- `packages/cli/src/commands/run.ts` — passes `workflow_path: opts.workflow`.
- `scripts/backfill-workflow-path.ts` — already patched every
  `.swarm/runs/*/events.jsonl` first event. Idempotent. Leave as-is.

## New requirements to fold into your plan

1. **Workflow label as canonical display name.** Extend the
   `pipeline.started` emit in `packages/core/src/executor/execute.ts` to
   also include `workflow_label: graph.attrs.label` when it is a
   non-empty string. The server's existing `deriveWorkflowName`
   (`packages/server/src/routes/pipelines.ts`) already prefers
   `workflow_label` over the path basename; wiring the emit is sufficient.
   Add a test that covers this precedence end-to-end from
   `deriveSummary`.

2. **Clean the build-feature label.** In `workflows/build-feature.dot`,
   change `label = "swarm self-hosting: build-feature"` to
   `label = "build-feature"`.

3. **`workflowName` must reach the client end-to-end.** Verify with tests
   that `GET /pipelines` and `GET /pipelines/:runId` actually return
   `workflowName`, and that `packages/web/src/lib/api.ts`'s `PipelineSummary`
   / `PipelineDetail` mirrors include it (they already do — re-read before
   touching). The web UI (`PipelinesList`, `PipelineDetail` header, and
   the graph view's title) must render `workflowName` with fallbacks to
   `workflow` basename, then short SHA. Never show the full 64-char SHA
   as a primary label; keep it in a hover/dim subtitle for debuggability.

4. **Configurable API base URL + robust dev proxy.** Today
   `packages/web/vite.config.ts` hard-codes `serverTarget = "http://localhost:3000"`
   and `packages/web/src/lib/api.ts` hard-codes `baseUrl = "/api"`. The
   user tried hitting the API from the Vite dev server and it didn't work
   cleanly. Fix by:
   - Reading `SWARM_SERVER_URL` (dev-only, node-side) in `vite.config.ts`
     as the proxy target, defaulting to `http://localhost:3000`. Log the
     resolved value at dev-server startup so misconfig is obvious.
   - Keep the client using relative `/api/...` URLs (the existing URL
     discipline comment in `api.ts` is load-bearing; do not regress it).
     For tests and preview environments, the `baseUrl` test-injection
     already exists — leave it.
   - Surface the server's actual bind port from `swarm serve` (see
     `packages/cli/src/commands/serve.ts`) so `SWARM_SERVER_URL` can be
     set correctly. If serve's port is dynamic/configurable, document the
     env-var pair in `packages/web/README.md` (or its equivalent) with a
     short "Development" section.
   - Verify with a fresh `bun --filter='@swarm/web' dev` + a running
     `swarm serve` that `/api/pipelines` loads without a 404 or CORS
     surprise.

5. **Header polish.** The PipelinesList + PipelineDetail header should
   show the workflow name prominently. Keep a dim subtitle line with
   runId (short) + startedAt relative time (use `lib/time.ts`). Do not
   add new columns to the list unless the primary task requires it.

## Out of scope for this run (still — don't creep)

- The pipeline conversation view (task 08) remains out of scope. Keep
  the existing `PipelineDetail.tsx` placeholder comment honest: render
  GraphView, leave room below, but do not implement 08.
- The CLI dashboard (task 09) is a separate track. Do not touch
  `packages/cli/src/commands/dashboard.ts` or invent Ink code here.

## Commit scope

All of the above is one logical feature ("graph view + workflow-name
display + dev-proxy configurability"). Tag `[P5.06]`. If doc updates are
warranted (dev-proxy env var, for example), they belong in the same
commit per AGENTS.md §Commit conventions.
