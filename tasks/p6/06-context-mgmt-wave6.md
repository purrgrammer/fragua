# P6.06 — Context-management hardening: Wave 6 (wrap-up)

## Goal

Close the three items the earlier waves left marked "deferred":
streaming summariser so UIs render titles / narratives as they arrive,
end-to-end checkpoint-resume that actually exercises Wave 3's
`degradeOnResume` building block, and a cleanup pass converting the
legacy `deriveSummary` / `deriveDetail` / `/stats` code paths onto the
Wave-5 `Projection<T>` + `foldAll` + `projectRun` helpers. Also lands
a `NO INLINE IMPORTS` ground rule in AGENTS.md so future refactors
don't regress against it.

## Scope

### Streaming summariser

- `packages/core/src/types/events.ts` — new `summary.text_delta` event
  type + `SummaryTextDeltaData` interface.
- `packages/core/src/types/event-schemas.ts` — `SummaryTextDeltaDataSchema`
  wired into `PAYLOAD_SCHEMAS` so Wave-1's opt-in validator covers it.
- `packages/agent/src/summariser.ts` — `PiSummariserBackend.summarise`
  switches from `completeSimple` to `streamSimple`. Per-call sequence
  is now `summary.started → summary.text_delta × N → cost.recorded →
  summary.completed`. The final `AssistantMessage` comes off the
  stream's `done` / `error` event.
- `packages/server/src/lib/steps.ts` — `eventsToSteps` now opens a
  step on `summary.started`, folds `summary.text_delta` deltas into
  `finalText`, and closes on `summary.completed` (falls back to
  `output_text` when no deltas streamed).
- `packages/server/test/lib/steps-summary.test.ts` *(3 cases)* —
  summariser step opens + streams + closes; output_text fallback;
  distinct steps for summariser + codergen calls.

### Checkpoint-resume end-to-end

- `packages/core/src/types/checkpoint.ts` — `CheckpointStore` port
  with `save` + `load`. Matches the shape a future Postgres adapter
  implements without changes.
- `packages/events/src/checkpoint.ts` *(new)* —
  `JsonlCheckpointStore` writes `<runsDir>/<runId>/checkpoint.json`
  atomically via rename-over-tmp; `load` returns undefined for
  missing files (never throws).
- `packages/core/src/executor/execute.ts`:
  - `CodergenBackend` gains optional `serialiseSessions` /
    `hydrateSessions` hooks. Executor calls them so `pi_sessions` on
    the checkpoint carries the agent's per-thread transcript.
  - `ExecuteOptions` gains `checkpointStore` + `resume: true`. On
    resume, state rehydrates from the checkpoint and
    `resumeDegradedNodes` receives `current_node` for `degradeOnResume`.
  - Checkpoint saves fire via `onNodeCompleted(nextNode)` AFTER edge
    selection so `current_node` reflects "what to run next", not
    "what just finished". Resume therefore never re-runs the
    completed tail.
  - `codergenHandler` consults `resumeDegradedNodes` once per node
    and degrades fidelity per SPEC §3.6.
- `packages/agent/src/message-store.ts` — `serialise()` +
  `hydrate(snapshot)` for JSON-safe round-trip into `pi_sessions`.
- `packages/agent/src/backend.ts` — implements the two bridge
  methods on `PiCodergenBackend`.
- `packages/core/test/executor/checkpoint-resume.test.ts` *(3 cases)*
  — mid-run abort → resume picks up at last-saved `current_node`;
  `resume: true` with no saved checkpoint is a silent no-op; resume
  degrades the first resumed node's fidelity (full → summary:high)
  and leaves subsequent nodes unchanged.
- `packages/events/test/checkpoint.test.ts` *(3 cases)* —
  JsonlCheckpointStore round-trip; missing run → undefined;
  overwrite leaves no `.tmp` files behind.

### Cleanup: Projection-based routes

- `packages/server/src/lib/summary.ts` — new `summaryProjection:
  Projection<Omit<PipelineSummary, "runId">>` (runId-agnostic; folder
  reattaches it) + `SUMMARY_PROJECTION_KEY = "summary"`.
- `packages/server/src/routes/pipelines.ts` — new
  `detailProjection(runId): Projection<PipelineDetail>` +
  `DETAIL_PROJECTION_KEY = "detail"`. `/pipelines` uses `foldAll`
  to build the list; `/pipelines/:runId` uses `projectRun` — the
  route handler is now "not found or here's the projection result".
- `packages/server/src/routes/stats.ts` — `/stats` also folds
  `summaryProjection` through `foldAll`; per-run metrics read off the
  projected object instead of re-replaying events manually.
- `packages/server/src/ports.ts` — `sourceFromRunReader(reader)`
  bridge so routes that still hold a `RunReader` can adopt
  `EventSource` helpers without an adapter refactor.

### AGENTS.md rule

- New ground rule #6: **NO INLINE IMPORTS.** No `await import(…)`
  inside functions, no `require(…)` inside conditionals. Dynamic
  imports hide dependency graphs and break refactors. Hoist to the
  top; guard the call, not the import.
- `packages/events/src/jsonl.ts` — hoisted the sole pre-existing
  dynamic `readFile` import in the codebase.

## Not in scope / still deferred

- Prompt redaction (user deferred again after Wave 2b).
- Converting `/pipelines/:id/events.json` to a projection. It's a
  raw passthrough of the event stream — no fold shape to adopt.
- Virtualisation for the step list when step counts get large. Fine
  today.
- Postgres / OTel-backed `EventSource` + `CheckpointStore` adapters.
  The ports are shaped so they drop in cleanly — no executor changes
  needed when they ship.

## Verification

- `bun run ci` → 757 pass, 0 fail (baseline 748).
- `bun run packages/cli/bin/swarm.ts validate workflows/*.dot
  examples/*.dot` — no regressions.
- Manual: run a pipeline with `--auto-title` on OpenRouter/Haiku;
  observe streaming `summary.text_delta` events in `events.jsonl`
  between `summary.started` and `summary.completed`.
- Manual: interrupt a run mid-execution (Ctrl-C); re-run with `swarm
  run <workflow> --resume`; confirm the run picks up at the
  checkpointed `current_node` and the first codergen call's fidelity
  is observed as degraded in `llm.start.data.fidelity`.

_Note: a `swarm run --resume` CLI flag isn't wired yet — callers pass
`checkpointStore` + `resume: true` through `execute()` directly. Adding
the flag is a small follow-up._
