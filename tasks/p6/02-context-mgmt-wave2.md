# P6.02 — Context-management hardening: Wave 2 (make declared knobs work)

## Goal

Kill the "declared API, no implementation" class of bug in context
management. Before Wave 2 a workflow author could write
`fidelity="compact"` and it did nothing — every `backend.run()` started
with an empty transcript, and `fidelity` was only used for event
metadata. After Wave 2:

- `MessageStore` owns per-thread transcripts in `@swarm/agent`, so
  `fidelity=full` *actually* restores prior turns across nodes.
- Non-`full` fidelities (`truncate`, `compact`, `summary:low`) prepend a
  deterministic `<swarm-context>` seed to the user prompt. The seed
  carries `graph.goal`, `run_id`, and (for `compact` / `summary:*`) a
  digest of the transcript that `full` would have restored.
- `summary:medium` / `summary:high` soft-warn via `agent.warning` and
  fall back to `summary:low`'s deterministic template until the
  summariser backend (Wave 2b) lands.
- Node-level `context = "fresh"` and per-node `system_prompt` overrides
  flow through cleanly.
- Goal-gate retry becomes two-phase: `retry_target` spends up to
  `max_goal_gate_retries`, then `fallback_retry_target` (when distinct)
  gets its own fresh budget.
- `sessionId` (provider cache hint) is bucketed per-fidelity so
  different modes on the same thread don't clobber each other's cache.

## Depends on

- Wave 1 (P6.01) — the `llm.start` capture that already records
  `fidelity`, `thread_id`, `messages`, etc. The Wave 2 behaviour
  changes what those captured values mean but not their shape.
- Master plan `.claude/plans/let-s-review-the-core-goofy-acorn.md`.

## Scope

Files touched:

- `packages/agent/src/message-store.ts` *(new)* —
  `Map<thread_id, AgentMessage[]>` with `get`/`set`/`has`/`delete` and a
  `threadIds()` enumerator for future checkpoint serialisation.
- `packages/agent/src/fidelity.ts` *(new)* — pure policy module:
  `shouldHydrateFromStore`, `shouldPersistToStore`, `resolveSessionId`
  (per-fidelity cache bucketing), `buildFidelitySeed` (deterministic
  seed strings for `truncate` / `compact` / `summary:low` +
  diagnostic-carrying fallback for `summary:medium` / `summary:high`).
- `packages/agent/src/system-prompt.ts` — gains `buildSystemPrompt`
  combinator so the per-node `system_prompt` override lives next to the
  context-files merge logic, not scattered through the backend.
- `packages/agent/src/backend.ts` — `PiCodergenBackend` now owns a
  `MessageStore` (exposed as `backend.messages` for tests + future
  checkpoint). `run()` resolves fidelity / `context=fresh` / per-node
  `system_prompt` / `sessionId` policy and calls the helpers above.
  `initialState.messages` is hydrated from the store for `full`,
  persisted back after the run; the fidelity seed is prepended to the
  user prompt for non-`full` modes.
- `packages/core/src/types/graph.ts` — `NodeAttrs.system_prompt?: string`.
- `packages/core/src/executor/execute.ts` — two-phase goal-gate retry
  using `primaryRetryTarget` + `distinctFallbackRetryTarget`. Failure
  reason disambiguates primary-vs-fallback exhaustion.
- `packages/agent/test/fidelity.test.ts` *(new)* — unit tests for the
  policy helpers + seed builder (12 cases).
- `packages/agent/test/fidelity-apply.test.ts` *(new)* — integration
  tests via the faux pi-ai provider: `full` restores prior turns,
  `truncate` carries only the goal, `compact` digests without restoring,
  `context="fresh"` opts out even under full, per-node `system_prompt`
  wins, `summary:medium` emits the deferred-summariser warning (6 cases).
- `packages/core/test/executor/fallback-retry-target.test.ts` *(new)* —
  primary exhausts → fallback runs with a fresh budget; without fallback
  the old single-phase behaviour; fallback alone is single-phase (3 cases).
- `packages/agent/test/llm-start-capture.test.ts` — existing test
  updated: the "single-turn captures raw prompt" case now pins
  `fidelity="full"` so the Wave-2 seed doesn't bleed in.
- `docs/SPEC.md §3.3` — documents Wave-2 semantics (store-based hydration,
  per-fidelity `sessionId` buckets, node overrides).
- `docs/PLAN.md` — Phase 6 series: Wave 2 marked landed, Wave 2b
  (summariser backend) called out separately.
- `AGENTS.md` — new "Fidelity modes" section aimed at workflow authors.
- `workflows/*.dot` + `examples/*.dot` — explicit fidelity annotations
  where the defaults are now actively wrong. See sweep notes below.

Not in scope for Wave 2 (deliberately deferred):

- **Wave 2b** — the summariser backend that makes `summary:medium` /
  `summary:high` mean more than `summary:low`. Today they emit a soft
  `agent.warning` and use the deterministic template.
- Tier-1/2 tool-result placeholder extraction for `compact` — the Wave 2
  digest captures role census + latest assistant text, which is
  sufficient for the observed pain point. Full Attractor-style tier
  extraction rides with the summariser in Wave 2b.
- Checkpoint serialisation of the `MessageStore` (into `pi_sessions`).
  The store is in-process only; resume-from-checkpoint still degrades
  `full` to `summary:high` per existing rule.

## Workflow sweep

Re-reviewed `workflows/*.dot` + `examples/*.dot` after fidelity started
actually doing something:

- `workflows/build-feature.dot` — already uses `thread_id="dev"` on
  `implement_and_review` + `verify`. With Wave 2 these now actually
  share a transcript; no attribute change needed. The other nodes run
  on fresh threads (correct, matches the Wave-1 audit that narrowed the
  thread).
- `workflows/add-tool.dot`, `workflows/fix-bug.dot` — unchanged. They
  don't share threads today and `compact` (the default) is a safe
  choice with the new deterministic digest.
- `examples/iterate.dot`, `examples/parallel-review.dot` — unchanged.
  Both are illustrative; adding fidelity annotations just for show
  would obscure what the examples are trying to demonstrate.

No `.dot` edits landed this wave; the behaviour sweep is captured here
so Wave 3 (test coverage) can reference the set of in-scope workflows.

## Verification

- `bun run --filter='@swarm/core' typecheck` and every other package — 0 errors.
- `bun run ci` green. Wave-1 baseline 659 → Wave-2 680 (+21 tests:
  12 fidelity policy, 6 fidelity-apply integration, 3
  fallback-retry-target).
- `bun run packages/cli/bin/swarm.ts validate workflows/*.dot examples/*.dot` — no regressions.
- Manual: run `workflows/build-feature.dot` on a toy change; confirm
  via `events.jsonl` that the second call on the shared thread has a
  non-empty `llm.start.messages` array (Wave 1 could never show this,
  it was always empty).
