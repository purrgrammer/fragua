---
title: Fan-out runs (Model M) — cross-run, run-level concurrency
summary: "Run-level fan-out: a parent step spawns N full child runs of a named workflow over a parameter sweep, waits (collect_settled), and joins by reading each child's typed outputs cross-run. Children are OPAQUE — normal independent runs the parent references by id, never embeds — which is why it avoids the §2.2 sub-run leak (that leak was embedding: descendant SSE, recursive rollup, branch tabs). The shipped run_state.schedule_id lineage pattern is the precedent (B5: resolved yes). This is the in-production consumer: the backend eval pipeline (eval_case + eval_aggregate) hand-rolls exactly this in bash + filesystem + a manual aggregate workflow today. Umbrella + shared framing: concurrency.md. NO CODE until frozen."
status: draft
maturity: specified
last-reviewed: 2026-05-29
---

# Fan-out runs (Model M)

Umbrella, durability line, and the spec reversal (A0): [concurrency.md](concurrency.md).
This is the **run-level** primitive — "run a named workflow over a parameter
sweep, combine the results." Each branch is a **full child run**: own worktree
(it writes), own budget, own log. Unlike Model A, M's demand is **shipping**.

## The in-production consumer

The backend eval pipeline *is* Model M, hand-rolled:

- **`eval_case`** has a step literally named `fan_out` — a `tool` step shelling to
  `run_iterations.sh`, launching **N full child runs of `codeowner_review`**
  (each writing its own `ai-codeowner-review.md`), then `score`/`grade`/`aggregate`
  joining over them.
- **`eval_aggregate`** is a *second, manually-sequenced* workflow fanning in
  across **M cases** via `summary.json` files.

It is the SPEC §3.1 sanctioned path (separate runs + shared artifacts) with a
**manual** cross-run join (an operator runs `eval_aggregate` after all cases
finish). M automates exactly that.

## Shape — reference, don't embed

**Authoring surface (shared with A, decided 2026-05-29):** M reuses the
`type: parallel` node — `map: { over, as, run: <workflow> }` (the `run:` keyword
is the M discriminator vs A's `branch:`), with the sink declared by the node's
ordinary `next:` (no new `join:` key). The IR stamps `unit: "run"`, which is
where the durability line lives — same surface as A, completely different
executor path. Full DSL/IR rules: [fan-out-nodes.md](fan-out-nodes.md) § DSL & IR.

- **Spawn:** the executor emits N `intent.run_enqueued` for child runs of
  workflow W over an author-declared parameter sweep, each tagged with
  `parent_run_id`, then parks the parent in `paused_auto{reason:fanout_pending}`
  (**no new status**). Executor-orchestrated (mirrors A's set-dispatch), so
  ground rule 9 holds — no `ctx` I/O in a handler.
- **Wait (`collect_settled`):** a new `wakeFanoutJoin` in `wake-pending` wakes the
  parent when all children are terminal. Partial failure is **data, not a halt** —
  eval excludes failed iterations from averages and lists missing cases.
- **Join:** a normal `llm`/`tool` node reads each child's typed outputs cross-run
  (`getOutputsForRun(childRunId)`) and combines — `score.py` *is* this node.
- **Opaque children:** navigable as normal top-level runs, listed like schedule
  runs — but the parent **never embeds** them. No descendant SSE, no branch tabs,
  no recursive cost rollup. Aggregate cost is a read-time
  `SUM(total_cost_usd) WHERE parent_run_id`, not a projection.

## B5 — opaque avoids the leak (resolved: yes)

§2.2 rejected run-level fan-out (sub-runs / R) for the +917/−15620 leak — but
that leak was **embedding**. `run_state.schedule_id` is **already** this pattern,
shipped and leak-free: a schedule spawns N runs tagged with its id, queried by
`selectScheduleRuns`, schema comment "*informational only … no `REFERENCES` by
design*," touching **none** of R's seven embedding layers. Lineage-by-column is
solved; R's mistake was embedding, not lineage.

| Need | Mechanism | New? |
|---|---|---|
| Spawn | reuse `enqueueRun` with `parent_run_id` (the scheduler already calls it with `scheduleId`, `store.ts:733`) | reuse |
| Lineage | one additive `parent_run_id` column (mirrors `schedule_id`) | 1 column, routine DDL |
| Read child outputs | `getOutputsForRun(childRunId)` — **already run-keyed, run-agnostic** | already works |
| Wait / join | new `wakeFanoutJoin` + `paused_auto{fanout_pending}` | new, small |
| Aggregate cost | read-time `SUM(total_cost_usd) WHERE parent_run_id` | query, no projection |

**Honest residual** (the only code-spike gap, defer until A9 ratifies): the
`wakeFanoutJoin` wait/join, and a **GC guard** — a child with a live
`parent_run_id` must not be GC'd before the parent joins (structured-outputs GC
protects output blobs, not the child run's lifetime).

## Cross-run output exposure — the structured-outputs unlock

M's join reads child typed outputs. The **store read already works**
(`getOutputsForRun`, any runId; export proved cross-run reads). The only missing
piece is the **authoring surface** `${{ children[*].outputs.f }}` (the aggregate
read, shared with A's `map` — A2b). This is the largest impact unlock for
structured outputs themselves: if `codeowner_review` declared `outputs:`
(SECURITY / QUALITY / REVIEWERS as typed fields), `eval_case`'s join stops
parsing `iter-*.md` / `summary.json` off disk and becomes a typed, fail-closed
`${{ children[*].outputs.security }}` read.

## What M needs that Model A forbids

Write-class branches; per-child worktree isolation; dynamic N (parameter sweep);
`collect_settled` as the default; nesting depth 2 (split → cases → iterations).
These are A's deliberate v1 scope-outs — for M they are **in-scope by
construction** (each child is a full, isolated, writing run).

## Freeze checklist (Model M)

- **A9 — RATIFIED (2026-05-29): adopt Model M.** B5 gate cleared, consumer ships
  today, surface ≈ the schedule feature's footprint + a wait/join wake fn. **Build
  order (umbrella): Phase 3 — after A sectioning (Phase 1) and the shared A2b
  aggregate read (Phase 2), which M's join consumes.** Remaining to freeze: the
  `wakeFanoutJoin` + GC-guard spike (the `${{ children[*].outputs.f }}` surface is
  Phase 2, shared with A).
- **B5 — RESOLVED** (opaque avoids the leak; `schedule_id` precedent). Code-spike
  residual: `wakeFanoutJoin` + the GC guard.
- **Authoring surface** `${{ children[*].outputs.f }}` — shared with A's `map`
  (A2b); the data plane (`getOutputsForRun`) is built, the binding is the work.

**Acceptance:** collapse `eval_case` + `eval_aggregate` from bash-orchestrated +
filesystem-joined + two manually-sequenced workflows into one declared Model-M
pipeline.
