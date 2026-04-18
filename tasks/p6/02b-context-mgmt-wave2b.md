# P6.02b — Context-management hardening: Wave 2b (summariser + auto-title)

## Goal

Turn `fidelity=summary:medium` / `summary:high` from "falls back to
summary:low with a warning" (Wave 2) into real LLM-backed narrative
compression, and piggy-back on the same infra for a nice UX polish —
auto-generated, human-readable pipeline titles from `$ARGUMENTS`. Both
features share a single cheap-model backend so the cost of the UX
never rides on the primary coder model.

## Design choices (confirmed with user mid-wave)

- **Title emission is async** (option B): `pipeline.started` fires
  immediately with the raw `$ARGUMENTS` on `data.input`; a fire-and-
  forget summariser call emits `pipeline.title_generated` when it
  resolves. UIs show the raw input as a placeholder, then swap to the
  title when the event lands.
- **Summariser calls ride as synthetic nodes** — each call has a
  stable `node_id` prefixed with `__summary.` (reserved namespace that
  real DOT nodes can never produce). `pipeline.title_generated` rides
  under `__summary.title`; fidelity compressions ride under
  `__summary.<caller_node_id>` (plus `#<iter>` in a loop). The `cost.recorded`
  emitted by the summariser is stamped with the same synthetic node_id
  so cost bucketing is automatic.
- **Each summary gets its own cost line** — no new `source` discriminator
  on `cost.recorded`; attribution is entirely through `node_id`.

## Scope

Files touched:

- `packages/core/src/types/summariser.ts` *(new)* — `SummariserBackend`
  port + `SummariseInput` / `SummariseOutput` + `SummaryPurpose` type
  + `titleSyntheticNodeId()` / `fidelitySyntheticNodeId(caller, iter)`
  helpers. Lives in core so both `execute()` (title) and
  `PiCodergenBackend` (fidelity) can depend on it without a cross-
  package loop.
- `packages/core/src/types/events.ts` — new event types `summary.started`,
  `summary.completed`, `pipeline.title_generated`. Matching payload
  interfaces (`SummaryStartedData`, `SummaryCompletedData`,
  `PipelineTitleGeneratedData`).
- `packages/core/src/types/event-schemas.ts` — TypeBox schemas for the
  three new payloads; wired into `PAYLOAD_SCHEMAS` so the Wave-1
  `validateEvent` opt-in payload check covers them too.
- `packages/core/src/executor/execute.ts` — `ExecuteOptions` gains
  `summariser?: SummariserBackend` and `auto_title?: "on" | "off"`.
  `maybeStartPipelineTitle()` helper kicks off the title call and
  awaits it at end-of-run so `pipeline.title_generated` lands before
  `pipeline.completed`. `CodergenInput` gains `emitAt(type, data, node_id)`
  so backends can surface synthetic-node events without hacking their
  own envelope construction. Also carries `$ARGUMENTS` onto
  `pipeline.started.data.input` for UI / backfill.
- `packages/agent/src/summariser.ts` *(new)* — `PiSummariserBackend`
  wrapping `completeSimple` from `pi-ai`. `DEFAULT_SUMMARISER_MODEL_BY_PROVIDER`
  table gives cheap-tier defaults per provider (Haiku for Anthropic,
  4o-mini for OpenAI, etc.). Emits the three-event triple
  (`summary.started` → `cost.recorded` → `summary.completed`) under the
  synthetic node_id. Soft-fail on any error (returns
  `{ ok: false, error }` without throwing).
- `packages/agent/src/fidelity.ts` — `buildFidelitySeed` is now async
  and accepts the summariser. For `summary:medium|high` with a
  summariser wired, the narrative replaces the deterministic template;
  otherwise keeps Wave-2 fallback. Prior transcripts get flattened into
  a `[role] text` form before being handed to the summariser.
- `packages/agent/src/backend.ts` — wires `summariser` through from
  `PiCodergenBackendOptions`, forwards it (+ `emitAt`) to
  `buildFidelitySeed`.
- `packages/agent/src/mock.ts` — `createPiMockBackend` accepts
  `summariser` for integration tests.
- `packages/cli/src/config.ts` — `SwarmConfig.defaults.summariser`
  (`{provider, model}`) + top-level `auto_title: "on" | "off"`.
- `packages/cli/src/commands/run.ts` — constructs a `PiSummariserBackend`
  from explicit flags / config / per-provider cheap-tier default (in
  that order), passes it to `PiCodergenBackend` AND `execute()`. Maps
  `--no-auto-title` to `auto_title: "off"`.
- `packages/cli/bin/swarm.ts` — three new flags on `run`:
  `--no-auto-title`, `--summariser-provider`, `--summariser-model`.
- `.swarm/config.yaml` — adds `defaults.summariser.provider = openrouter`
  + `model = anthropic/claude-haiku-4.5` + `auto_title: on` per user
  direction.
- `packages/server/src/schemas.ts` — `PipelineSummary` + `PipelineDetail`
  gain optional `title` + `input`.
- `packages/server/src/lib/summary.ts` — `deriveSummary` picks the
  latest `pipeline.title_generated.title` and `pipeline.started.data.input`.
  New `deriveTitle(events)` export.
- `packages/server/src/routes/pipelines.ts` — detail route plumbs the
  new fields through.
- `packages/web/src/lib/api.ts` — mirror types on the client.
- `packages/web/src/components/PipelineRow.tsx` — two-line layout
  (title + subtle workflow name) when title/input are present, legacy
  single-line fallback otherwise. New `displayTitle()` /
  `displayTooltip()` / `hasTitleOrInput()` exports consumed by Home
  and PipelineDetail.
- `packages/web/src/routes/PipelineDetail.tsx` — `<h2>` heading uses
  `title || input` when present, falls back to the shortened run id.
- `packages/web/src/routes/Home.tsx` — running-pipeline cards render
  the same title-first layout.
- `scripts/backfill-titles.ts` *(new)* — one-off script that scans
  `.swarm/runs/*/events.jsonl` and appends a `pipeline.title_generated`
  event for any run that doesn't already have one. Source for the title
  is (in priority order) `pipeline.started.data.input`, then the first
  `llm.start.prompt` (with any Wave-2 `<swarm-context>` stripped).
  Idempotent + append-only; `--dry-run` flag for preview.
- `packages/agent/test/summariser.test.ts` *(new, 4 cases)* — pipeline
  auto-title wiring, `auto_title="off"` short-circuits the call,
  `fidelity=summary:medium` invokes the summariser under
  `__summary.<caller>` with its own `cost.recorded`, summariser failure
  falls back with a warning.
- `packages/server/test/lib/summary-title.test.ts` *(new, 5 cases)* —
  `deriveTitle` pick (including latest-wins for backfill), + title/input
  plumbing through `deriveSummary`.

Not in scope:

- Redaction of captured prompts (deferred — revisit alongside Wave 4
  per earlier direction).
- Streaming summariser output onto `summary.text_delta` events — the
  summariser currently awaits the full `AssistantMessage` before
  emitting `summary.completed`. Fine for titles; revisit if a UI wants
  the fidelity tail to appear progressively.

## Verification

- `bun run ci` — 691 pass (+9 over Wave-2 baseline: 4 summariser, 5
  title-summary).
- `bun run packages/cli/bin/swarm.ts validate workflows/*.dot examples/*.dot`
  — no regressions.
- Dry-run retrofit: `bun run scripts/backfill-titles.ts --dry-run` (with
  `OPENROUTER_API_KEY` set) prints a proposed title for each existing
  run under `.swarm/runs/` that lacks one.
- Manual: run any workflow with `$ARGUMENTS` set; confirm
  `events.jsonl` contains a `pipeline.title_generated` event under
  `node_id = "__summary.title"` plus a matching `summary.started` /
  `summary.completed` / `cost.recorded` triple, and the web UI renders
  the title in the pipelines list + detail header.
