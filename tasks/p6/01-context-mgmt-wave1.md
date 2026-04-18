# P6.01 — Context-management hardening: Wave 1 (capture completeness)

## Goal

Make `events.jsonl` alone enough to reconstruct "what the agent saw at
step N" for every LLM call. Close the capture gaps identified in the
context-management audit:

- **Missing**: pre-call `messages` snapshot on `llm.start`
- **Missing**: generation settings (`temperature`, `max_tokens`,
  `reasoning_effort`, `top_p`, `stop`)
- **Missing**: sha256 / byte / truncation metadata for `context_files`
- **Declared but never populated**: `llm.start.iteration`
- **Missing**: read-only `budget` snapshot on every step (shape only in
  Wave 1; Wave 4 wires a real `BudgetLedger`)
- **Missing**: `schema_version` on the event envelope + runtime
  validator (`@swarm/events.validateEvent`)

Downstream dependencies: Wave 5 UI drilldown (`tasks/p5/08`) needs the
snapshot fields to render per-step introspection; Wave 4 budgets read
`cumulative_*` off the same shape.

## Depends on

- Master plan `.claude/plans/let-s-review-the-core-goofy-acorn.md` for
  sequencing + rationale
- Existing `cost.recorded` event (unchanged by Wave 1)

## Scope

Files touched:

- `packages/agent/src/system-prompt.ts` — `loadContextFiles` now returns
  `files: ContextFileRecord[]` (path + sha256 + bytes + truncated +
  status) alongside text + warnings.
- `packages/agent/src/backend.ts` — `llm.start` emits the full Wave-1
  payload: `messages` (pre-`prompt()` snapshot, detached via JSON
  round-trip), `settings` (pulled from `node.attrs`), `context_files`
  records, `iteration` (forwarded from `CodergenInput`), `budget`
  (emitted only when `node.attrs.max_cost_usd` is set).
- `packages/core/src/executor/execute.ts` — `CodergenInput` gains
  `iteration?: { n, max }`; loop handler populates it per iteration.
  Every `emit` / `sink.append` stamps `schema_version`.
- `packages/core/src/types/events.ts` — new types (`ContextFileCapture`,
  `LlmSettings`, `MessageSnapshot`, `BudgetSnapshot`); `LlmStartData`
  extended; `EVENT_SCHEMA_VERSION` exported; `Event.schema_version`
  optional.
- `packages/core/src/types/event-schemas.ts` *(new)* — TypeBox schemas
  for the envelope + opt-in payload schemas for `llm.start`,
  `node.started`, `cost.recorded`. Permissive policy: envelope is strict
  on required fields, payloads pass `additionalProperties: true` so a
  future additive field doesn't invalidate old JSONL.
- `packages/events/src/validate.ts` *(new)* — `validateEvent(raw, opts)`
  + `validateEventStream(events, opts)` + `CURRENT_EVENT_SCHEMA_VERSION`
  re-export.
- `packages/events/package.json` — pin `@sinclair/typebox@0.34.41`
  (explicit per AGENTS.md "no silent deps"; was transitive).
- `packages/agent/test/llm-start-capture.test.ts` *(new)* — exercises
  the full backend path through the faux pi-ai provider; asserts every
  Wave-1 field populates (schema_version, context_files records,
  reasoning_effort → settings, loop iteration, budget gating).
- `packages/events/test/validate.test.ts` *(new)* — envelope + opt-in
  payload validation, including pre-versioned JSONL back-compat.
- `packages/agent/test/system-prompt.test.ts` — existing tests updated
  for the new `files` field on `ContextBlock`.
- `docs/SPEC.md §3.5` — documents the post-Wave-1 `llm.start` shape +
  `schema_version` + validator contract.
- `docs/PLAN.md` — Phase 6 section calls out the five-wave context-mgmt
  series; Wave 1 marked landed.
- `AGENTS.md` — new "Per-step agent context (introspection)" section
  aimed at UI / replay authors.

Not in scope for Wave 1 (deliberately):

- Actual fidelity transformations (`compact` / `truncate` / `summary:*`
  stay no-ops today — Wave 2).
- Real cumulative budget counters (Wave 4).
- Redaction of captured prompts (deferred by user direction; revisit
  alongside Wave 4).
- Workflow-author-visible changes to existing `.dot` files — Wave 1 is
  pure infra and transparent.

## Verification

- `bun run --filter='@swarm/core' typecheck` and every other
  package — 0 errors.
- `bun run ci` green. 640 baseline → 659 after Wave 1 (+19 tests: 7
  `llm-start-capture` + 11 `validate` + 1 `system-prompt` extras).
- `bun run packages/cli/bin/swarm.ts validate workflows/*.dot` — no
  regressions.
- Manual sanity: capture a run, confirm every `llm.start` line in
  `events.jsonl` has the new fields and `schema_version: 1`.
- Replay back-compat: a pre-Wave-1 `events.jsonl` parses through
  `validateEventStream` with the default (envelope-only) check.
