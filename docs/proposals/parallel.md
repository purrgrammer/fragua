---
title: Parallel branches as first-class executor citizens (sub-runs)
status: proposed
maturity: specified
last-reviewed: 2026-05-15
---

> **Status:** proposed (specified). Successor to [`parallel-branch-outputs.md`](./parallel-branch-outputs.md), which fixed observability (`$<branchId>.output` substitution, per-branch lifecycle events, UI rendering). This proposal addresses the deeper architectural gap surfaced by those fixes: parallel branches are second-class citizens of the executor and inherit none of its per-turn services.

# Parallel branches as first-class executor citizens

## Motivation

In `packages/core/src/handler/handlers/parallel.ts:126`, the parallel handler invokes each child branch **inline**:

```ts
result = await childSpec.handler(childCtx);
```

That one handler call **is the entire branch**. Branches today are **single-node, opaque to the executor's dispatch loop**, and inherit none of the executor's per-turn services (watchdog, budgets, retries, intent fold, HITL, goal gates, edge selection). The parent's `Promise.all` is the branch lifecycle.

Concrete production symptoms, observed on `~/.swarm/workflows/review.dot`:

- A lens with `max_cost_usd=0.30` spent **$1.72** before completing (5.7× over its cap) — the per-branch budget gate doesn't exist.
- Step durations for completed branches showed `0ms` or `null` before commit `292267b` patched the symptom in `steps.ts`.
- A `wait.human` node inside a branch coerces to fail (`parallel.ts:220-225`).

The shipped patches (`292267b` durationMs stamp, `a4739fc` summary aggregation) addressed downstream display. The structural gap is wider:

| Service | Where in `executor.ts` | Branch impact |
|---|---|---|
| Watchdog timeout (`max_ms`) | `573, 801-808` | Branch inherits parent's signal; per-branch `max_ms` parsed but not enforced. |
| Reactive budget gate | `720-745` | Reads `graph.nodes[currentNode].attrs` where `currentNode = parent`. Branch's per-event `cost.recorded` flies past. |
| Post-handler budget gate | `1077-1097` | Fires once per parent turn against parent's attrs. Branch caps never consulted. |
| Retry policy (`outcomeStatus="retry"`) | `1194-1260` | Branch results feed `parallel.results` for fan_in ranking; the retry/halt decision is never entered. |
| Provider retry (429/5xx → paused_auto) | `1274-1405` | Only parent path. A 429 inside a branch propagates as an error → branch fails. |
| Handler retry backoff | `1470-1471` | Only parent emits `pause_provider` / `retry`. |
| Goal-gate retarget chain | `1113-1160` | Branches don't participate. `goal_gate=true` on a branch is inert. |
| Edge selection (5-rule) | `1012-1052` | Branches hardcode `nextNode = fanInNode`. `retry_target` / conditional edges on branches not honored. |
| Per-node failure routing | `1031-1042` | Branch failure → fan_in; not `retry_target`. |
| Intent fold per dispatch | `376-387` | Operator steer/pause/cancel cascades via signal but per-branch targeting doesn't exist. |
| `fact.dispatch_started` | `547-554` | Not emitted per branch. |
| `max_loops` counter | `521-534` | Run-wide; branches don't increment. |
| OCC version bump per dispatch | `266-316` | One version space per run; branches don't transact. |

## Desired end state

- Branches can be **multi-node subgraphs** (`component -> nodeA -> nodeB -> tripleoctagon`).
- **HITL inside a branch works** — one branch pauses without aborting siblings; operator resumes; rest of run unaffected.
- **Per-branch retry across the subgraph** — `outcomeStatus="retry"` on any branch node behaves identically to a top-level retry.
- **Per-branch budgets / watchdog / fidelity / provider-retry** — automatic, inherited from the same machinery top-level nodes use.

## Decision

**Path B — sub-runs.** Each branch becomes a child `run_state` row with `parent_run_id` linking it back. The parent run pauses in a new `running_children` status while its sub-runs dispatch. Each sub-run is a normal run: own OCC space, own pause/resume, own event log, own projection. Fan_in is a cross-run wait.

Alternatives considered:

- **Path A — recursive executor.** Extract `dispatchOne` and recurse for each branch's nodes. Pros: single run, single event log, single OCC space. Cons: re-entrance is invasive; branches share parent's version space and need sub-OCC; event ordering across branches needs reconciliation; intent fold needs per-branch awareness. **Rejected** for re-entrance complexity.
- **Path C — cooperative scheduling.** One executor loop interleaves dispatches across N branch threads via a fiber scheduler. **Rejected** as a fundamental architecture rewrite incompatible with the pure-async handler contract.
- **Path D — patch each symptom inline** (budget gate per branch, watchdog per branch, retry loop per branch in `parallel.ts`). **Rejected**: `parallel.ts` becomes a mini-executor that we'd have to tear out later.

Why sub-runs:

1. **Operator semantics compose for free.** Every existing intent endpoint (`/runs/:id/pause`, `/cancel`, `/hitl`, `/budget`, `/max_retries`, `/resume`) works on sub-runs unchanged. No new vocabulary.
2. **Per-branch pause-class breach Just Works.** A sub-run hitting `budget_policy="pause"` transitions to `paused{reason:"budget"}`. Sibling sub-runs unaffected. Operator raises the cap on the specific sub-run and resumes. Today's pause taxonomy covers this 1:1.
3. **HITL inside a branch Just Works.** A `wait.human` in a sub-run transitions it to `paused_hitl`. `POST /runs/<sub_run_id>/hitl` answers it.
4. **Multi-node branches Just Work.** Sub-run dispatches through its branch subgraph via the executor's normal edge-selection + dispatch loop.
5. **Replay determinism preserved.** Each sub-run has its own event log; replaying it is identical to replaying a top-level run.

Schema cost is real (additive `parent_run_id`, `parent_node_id`, `parallel_index`, `subgraph_root_node_id`, `subgraph_terminal_node_id` columns on `run_state`) but it's all additive, not breaking. The "child runs" concept is useful for other future work (spawned sub-tasks, scheduled child runs).

## What gets correct for free

After cutover, branches inherit:

- Per-branch watchdog (`max_ms` per branch).
- Per-branch reactive + post-handler budget gates (with all three policies: `warn` / `stop` / `pause`).
- Per-branch handler retry (`outcomeStatus="retry"` with `max_retries`, backoff presets, `non_retryable` short-circuit, `allow_partial`).
- Per-branch provider retry (429/5xx → `paused_auto{reason:"provider_retry"}` on the sub-run, wake-pending re-queues).
- Per-branch goal-gate retarget chain within the branch's subgraph.
- Per-branch HITL via `wait.human` nodes inside the subgraph.
- Per-branch edge selection (conditional edges inside a subgraph evaluate normally).
- Per-branch operator surface (`/runs/<sub_run_id>/<verb>` for every intent endpoint).

## Required executor refactor (P0)

The current dispatch loop in `packages/daemon/src/executor.ts` is a single monolithic function with implicit state. To support sub-runs without rewriting everything:

1. **`dispatchOne(state, currentNode, spec): DispatchOutcome`** — per-turn services (watchdog, intent fold, budget gates, retry resolution, OCC commit of `node_completed`) as a re-callable function. The outer loop becomes "while not terminal: dispatchOne". Sub-runs reuse it unchanged.
2. **`claimAndAdvance(runFilter): RunState | null`** — run-picker parameterized by eligibility filter. Sub-run-aware claim adds parent-status check.
3. **Decouple `state.metrics` accumulation from OCC commit** — separate "metrics-only delta" pathway that doesn't fire `fact.*` events, for cost rollup.
4. **`foldIntents` as a pure function** — mostly there; finish removing runtime-state reads.

Each refactor lands as its own PR with green CI. No externally observable behavior change.

## Phasing

### P0 — Executor refactor (prep, no user-visible behavior change)

- **P0.0** This proposal (`docs/proposals/parallel.md`) at status `proposed`, maturity `specified`.
- **P0.1** Extract `foldIntents` as a pure function.
- **P0.2** Extract `dispatchOne` from the executor's main loop. Top-level dispatches use it; behavior identical.
- **P0.3** Decouple `state.metrics` updates from OCC commit; introduce a metrics-only delta pathway.
- **P0.4** Parameterize the run-picker (`claimAndAdvance`) by an eligibility filter.

### P1 — Sub-run shape (additive schema, no parallel changes yet)

- **P1.1** Schema: `run_state.parent_run_id NULL`, `parent_node_id NULL`, `parallel_index NULL INTEGER`, `subgraph_root_node_id NULL`, `subgraph_terminal_node_id NULL`. Indexes on `(parent_run_id)`.
- **P1.2** New `running_children` status. Reducer: a parent enters this when its parallel handler emits `fact.fanout_started { childRunIds, fanInNode }`. Wake condition: all `childRunIds` are in a terminal status (`completed`, `cancelled`, or `halted`); paused or quarantined sub-runs block convergence until resolved.
- **P1.3** Events: `intent.fanout_requested`, `fact.fanout_started`, `fact.fanout_completed`, `fact.subrun_completed`. Daemon-scoped, not per-sub-run.
- **P1.4** Cost rollup: parent's `total_cost_usd` projection adds sub-run totals on `fact.subrun_completed` (the fact carries the inline outcome). Running-children gate queries `parent.totalCostUsd + parent.totalSubrunCostUsd + SUM(in-flight subrun.totalCostUsd)` at gate-check time.
- **P1.5** Cancel propagation: cancelling a parent in `running_children` emits `intent.cancel_requested` on every child sub-run.

### P2 — `parallel.ts` uses sub-runs (single-node branches first, behavior parity)

- **P2.1** `parallel.ts` enqueues N sub-runs (one per branch). Sub-run's `workflow_sha = parent.workflow_sha`; `subgraph_root_node_id = branchNodeId`; `subgraph_terminal_node_id = fanInNode`. Dispatcher slices the parent's parsed graph for the sub-run.
- **P2.2** Parent's parallel handler returns `HandlerResult.fanout_pending { childRunIds, fanInNode }`. Executor transitions parent to `running_children`.
- **P2.3** Wake-pending sweep promotes the parent out of `running_children` when all sub-runs are terminal. Parent re-dispatches the parallel node (collect phase); reads sub-run outcomes from `getRun(subRunId)`; builds the `ParallelBranchResult[]`; writes them to `routing.parallel.<id>.results`; transitions to fan_in.
- **P2.4** Parity tests against a fixed workflow corpus (including `review.dot`). Event-log byte-identity modulo `run_id`; cost rollup match; fan_in input shape match.

**Direct cutover. No feature flag.** Pre-release means no backwards-compat boundary; flag-gating is dead code we'd later rip out.

P2 unlocks per-branch pause, per-branch HITL, per-branch budgets, per-branch retries — automatically, by virtue of branches being normal runs through the dispatch loop.

### P3 — Multi-node branch subgraphs

- **P3.1** `parallel-discovery.ts` validates the FULL branch subgraph (BFS from branch root to fan_in convergence; no cycles, no cross-branch edges, no orphans).
- **P3.2** Sub-run dispatches through the subgraph from root to `subgraph_terminal_node_id`'s predecessor.
- **P3.3** Validator W017: branch subgraph well-formedness.

### P4 — `first_success` cancellation

When one sub-run completes successfully under `first_success`, parent emits `intent.cancel_requested` on the others with `reason: "first_success_won"`. Standard cancel semantics.

### P5 — Operator surface polish

Per-sub-run intents already work; the web UI needs to know about sub-runs: run-detail page renders sub-run rows under parent's parallel section, cost panel shows each sub-run as a top-level line, events tab gains a "child runs" view, graph view lights up branches via sub-run state.

## Design decisions

### D1. Sub-run `workflow_sha` derivation

Sub-runs reference the parent's `workflow_sha` plus `subgraph_root_node_id` + `subgraph_terminal_node_id` columns on `run_state`. Top-level runs leave both NULL.

Synthetic SHAs would pollute the `workflows` table with non-runnable entries. The dispatcher slices the parent's parsed graph on demand. The slice is pure-functional given `(parent_graph, root, terminal)`, so caching is straightforward. Sub-run's `specForNode` consults the slice and rejects edges that escape `subgraph_terminal_node_id`.

### D2. Event-log readability

Events stay per-run. `SELECT * FROM events WHERE run_id = ?` stays cheap and unsurprising.

Opt-in: `GET /runs/:id/events?include=descendants` runs a recursive CTE following `parent_run_id`, merge-sorts by `(ts, seq)`, returns a unified stream tagged with the originating `run_id` per row. Operator UI's "Events" tab uses this; per-run drill-downs use the simple query.

### D3. Cost rollup timing

Lazy on-read aggregation. Parent's `state.metrics.totalCostUsd` is the parent's OWN spend. Budget gates evaluate `parent.totalCostUsd + parent.totalSubrunCostUsd + SUM(in-flight subrun.totalCostUsd)` at gate-check time via a SQL query.

`fact.subrun_completed` carries the inline final outcome; parent's projection folds it into `total_subrun_cost_usd` so completed sub-runs don't need re-aggregation.

Per-event propagation would multiply writes (4-branch fan-out × 50 cost events/branch = 200 parent writes). Per-terminal lagging would let a parent overshoot `budget_usd` by the in-flight sum. Lazy on-read is the right trade.

### D4. Sub-run cwd / worktree

Sub-runs inherit parent's `cwd` AND the parent's worktree directory. No new worktree per branch.

Branches stay deliberation-only (read-class tools). Worktree-per-branch would multiply git operations N× per fan-out and break the model that fan-out is "N opinions over the same state, picked by fan_in." A future use case for write-isolated branches can revisit with a `branch_isolated_worktrees: true` opt-in.

Validator W019: warns when a branch node (reachable only from a `component`'s outgoing edges) declares write-class tools (`write`, `edit`) in `allowed_tools`. Informational; doesn't block.

### D5. Replay determinism

Parent's `fact.subrun_completed` event carries the sub-run's final outcome (status, costUsd, tokens, outputRef, fanInScore) inline. Parent's replay reads only its own event log. Sub-runs are independently replayable from their own logs but the parent doesn't recurse.

Event shape:

```ts
{
  type: "fact.subrun_completed",
  payload: {
    subRunId: string,
    parentNodeId: string,        // the component node
    parallelIndex: number,
    status: "completed" | "halted" | "cancelled" | "quarantined",
    finalStatus: OutcomeStatus,  // success/fail/etc., from the sub-run's final outcome
    costUsd: number,
    tokens: number,
    outputRef?: { nodeId: string, key: string },  // for $<branchId>.output substitution
    fanInScore?: number,
  }
}
```

### D6. Pre-existing `goal_gate` / `retry_target` on branch nodes

Silently flip. No backwards-compat warning.

Per AGENTS.md ground rule #11 (no prior-state references), swarm is pre-release. Workflows that set `goal_gate=true` or `retry_target` on a branch node today get silent no-op; after P2, those attributes are honored within the sub-run's lifecycle. Authors who set them without intent will observe the effect and fix it.

The existing W007 (`goal_gate=true` with no retarget chain) will start firing on branch nodes that previously slipped through — that's a fair surface.

### D7. `fact.fanout_completed`

The wake-pending sweeper, on detecting all sub-runs terminal/paused, emits `fact.fanout_completed { childRunIds, outcomes: [{ subRunId, finalStatus, costUsd, … }] }` on the parent's log. Parent transitions from `running_children` to `queued` and re-dispatches the component in "collect phase." OCC normal.

### D8. Sub-run quarantine blocks the parent

If a sub-run enters `quarantined` (orphan `fact.side_effect_intent`), the parent stays in `running_children` until the operator resolves the sub-run's quarantine via `POST /runs/<sub_run_id>/unquarantine`. No special parent-state — same semantics as top-level quarantine.

### D9. Sub-run pause does NOT cascade to parent

A sub-run hitting `paused{reason:"budget"}` keeps the parent in `running_children`; siblings continue running. Operator targets the sub-run via `POST /runs/<sub_run_id>/budget` + `/resume`. Parent's `running_children` waits exactly as it does for in-flight siblings.

### D10. Cancel parent cascades to children

`POST /runs/<parent>/cancel` emits `intent.cancel_requested` on every active sub-run via the reducer. Each sub-run unwinds normally and emits `fact.run_cancelled`. The wake-pending sweeper transitions the parent to `cancelled` once all sub-runs are terminal. New helper: `IEventStore.activeChildRuns(runId)` returning sub-run IDs in non-terminal states.

### D11. fan_in handler unchanged

`fan_in` reads `routing.parallel.<id>.results` exactly as today. The collect-phase of the parent's parallel handler writes the same structure by reading sub-runs' projections (status, fanInScore, branchId). fan_in is unchanged.

## Critical files

- `packages/daemon/src/executor.ts` — extract `dispatchOne`, `claimAndAdvance` (P0).
- `packages/core/src/handler/intent-fold.ts` — make pure (P0).
- `packages/store/src/schema.sql` — additive columns + indexes (P1).
- `packages/store/src/reducers.ts` — `running_children` status, fanout / subrun_completed reducers, cost rollup (P1).
- `packages/types/src/swarm-events.ts` — `intent.fanout_requested`, `fact.fanout_started`, `fact.fanout_completed`, `fact.subrun_completed`, `HandlerResult.fanout_pending` (P1).
- `packages/core/src/handler/handlers/parallel.ts` — replace inline dispatch with sub-run enqueue + collect-on-resume (P2).
- `packages/core/src/engine/parallel-discovery.ts` — validate the full branch subgraph (P3).
- `packages/core/src/engine/validator.ts` — W017 (subgraph well-formedness), W019 (write-class tools on a branch node) (P3 / P2).
- `docs/SPEC.md` — §3 sub-runs subsection; §3.4 `running_children` status; §3.5 confirm intents work on sub_run_id; cost rollup semantics.
- `docs/ARCHITECTURE.md` §2 (schema), §3 (event taxonomy: fanout family), §1 (invariants).
- `.agents/skills/swarm-author/` — branch subgraph patterns, HITL-inside-branch example.
- `.agents/skills/swarm-debug/` — debugging a sub-run vs. its parent.
- `.agents/skills/swarm-run/` — per-sub-run operator surface (mostly: "same as runs, target sub_run_id").

## Same-PR doc obligations

Per AGENTS.md ground rule #1:

| Touched | Update in same PR |
|---|---|
| `packages/store/src/schema.sql` (P1.1) | `ARCHITECTURE.md` §2 |
| `packages/types/src/swarm-events.ts` (P1.3 — fanout / subrun_completed) | `ARCHITECTURE.md` §3 (event taxonomy); `swarm-debug/SKILL.md` informational-fact section |
| `packages/core/src/handler/types.ts` (P2.2 — `HandlerResult.fanout_pending`) | `handler-contract.md` |
| New status `running_children` (P1.2) | `SPEC.md` §3.4; `STATUS.md` if behaviour visible to operators |
| `packages/server/src/store/routes.ts` (no expected change — intents target sub_run_id which is already a normal `:id`) | none |
| `packages/core/src/engine/validator.ts` (W017, W019) | `swarm-author/SKILL.md` validator-codes table |

## Verification

Per phase:

- **P0**: existing 2200-test suite stays green. No new behaviour.
- **P1**: schema migration test (round-trip parent + sub-run through serialize/deserialize). Reducer test for `fact.subrun_completed` correctly rolling cost into parent.
- **P2**: parity test — fixed workflow corpus (including `review.dot`) runs through both inline and sub-run paths; event-log shapes match byte-identically modulo `run_id`; cost rollup matches; fan_in input shape matches.
- **P3**: workflow with `component -> nodeA -> nodeB -> tripleoctagon` where `nodeA` is a codergen producing input for `nodeB`. End-to-end test that nodeB sees nodeA's output and fan_in sees nodeB's.
- **P4**: `first_success` test where one branch wins fast; siblings get `intent.cancel_requested` and emit `fact.run_cancelled { reason: "first_success_won" }`.
- **P5**: web UI snapshot tests for sub-run rendering.

End-to-end: re-run `review.dot` against `~/backend` PR 9362. After P2:

- Each lens is a sub-run; cost panel shows it as such.
- A lens hitting its `max_cost_usd` enters `paused{reason:"budget"}` on its own sub-run; siblings continue; operator raises that lens's cap and resumes.
- A lens with `wait.human` mid-subgraph (P3) pauses just that lens; operator answers via `POST /runs/<sub_run_id>/hitl`.

## Out of scope (until further design)

- **Sibling cross-talk.** One branch reading another's mid-flight output. Branches stay independent; fan_in is the only convergence point.
- **Dynamic branch count.** The component's branch count is determined at graph-construction time (= number of outgoing edges). No "fan out to N where N is runtime-decided."
- **Cross-run side effects.** A sub-run writing external state that another sibling reads. Idempotency keys today scope per-run; cross-run coordination is its own problem.
- **Per-branch worktree isolation.** Branches inherit parent's worktree (deliberation-only). Future opt-in if needed.
- **Per-branch intent targeting via parent (e.g. "steer just `lens_correctness` via `POST /runs/<parent>/steer/<branchId>`").** Operator targets the sub-run directly; no parent-rewrite layer.

## Notes from the immediate-fix path (rejected)

A patch-in-place stopgap was considered for the production overspend bug (`review.dot`'s `lens_correctness` at $1.72 vs $0.30 cap). It would have added per-branch budget gates and watchdog wrappers inside `parallel.ts` using `evaluateBudget` and `resolveMaxMs` directly.

Explicitly rejected: it would build a parallel mini-executor that we tear out in P2. The overspend is acknowledged in SPEC.md §5 as a known limit until P2 lands.


## UI walkthrough — parallel sub-runs first class

Live operator's path through a fan-out from enqueue to completion.
Use the smoke workflow at `.swarm/workflows/parallel-hitl-smoke.dot` —
three branches, one each of: HITL gate, straight codergen, tight
budget cap.

```sh
bun run swarm harness
bun run swarm run parallel-hitl-smoke
```

**Inbox** — open http://localhost:6767/inbox. The parent surfaces
with reason "branch: awaiting input" / "branch: needs operator"
even though the parent itself is in `running_children`. The
`?includeChildAttention=true` server flag widens the filter; the
parent is the operator-facing row, the branch is the cited reason.
Server-side: `GET /runs?status=paused_hitl,paused,quarantined&includeChildAttention=true`.

**Run detail header** — the run's status pill reads "running" (the
`running_children` enum collapses) with a `BranchDigestChip`
glyph row alongside: "▶1 ⏸1 ❓1" (one running, one budget-paused,
one HITL-paused). Hover reveals the per-status breakdown.

**Sub-runs list** — sticky card above the tabs. Each row carries:
ordinal, status badge, branch label, live cost, and inline
`BranchActions` (Resume / Cancel / Manage →). Rows are
non-clickable; sub-runs are an executor implementation detail.

**Conversation tab** — the parent's transcript flows top-to-bottom.
Where the workflow fans out, a "spawn" section opens with one
collapsed `BranchCard` per branch. Each card's header carries the
child's status badge, live cost, message count, and the same
`BranchActions`. Expanding the card reveals the child's actual
transcript — merged in via `GET /runs/:id/messages?include=descendants`
(every row stamped with `originRunId`). Fractal: the card body is
itself rendered by the same node-grouping logic as the parent, so
multi-node subgraph branches Just Work once the underlying handler
exposes them.

**Graph tab** — branch nodes light up live. `RunDetail.effectiveActiveNodes`
unions the parent's own running nodes with each non-terminal
descendant's `current_node`, so `branch_hitl` glows while the
HITL is open, `branch_budget` glows then dims at the cap, and
`branch_quick` glows briefly then completes.

**Cost tab** — `CostInspector` groups steps by parent component
`(parallel.broadcast)` with indented child rows per branch. Each
row carries `data-origin-run-id` so test selectors can pin to a
specific sub-run's spend.

**Activity log (home Activity / global feed)** — sub-run events
render with a `[branchNodeId]` prefix chip in their title link;
`data-origin-run-id` is stamped on the row's link so test selectors
can distinguish child events from parent events.

**Direct child URL** — paste a child run id into the URL bar
(`/runs/<childId>`). `RunDetail` reads the child's `parentRunId`
+ `branchNodeId` from its detail snapshot and redirects to
`/runs/<parentId>/<view>?branch=<branchNodeId>`. `?orphan=true`
disables the redirect for debugging (shows the child page directly).

**Operator actions on a paused branch** — from the parent's detail
page (no navigation needed):
- HITL: open the child via Manage → answer via the standard
  `HitlChoice` panel on the child's page. The parent's view
  updates via the invalidation cascade in `useGlobalEventStream`.
- Budget: same — Manage → opens the `RunPausedNotice` with
  Raise & Resume. Inline lighter-weight Resume / Cancel are
  available directly on the row.
- Cancel: cancels just the child; the parent's other branches
  continue.

**SSE descendant invalidation** — when a sub-run emits a lifecycle
event, `useGlobalEventStream` reads the cached child `RunDetail`
to find its `parentRunId` and invalidates the parent's
`queries.runs.detail` + `queries.runs.children` caches. Result:
the parent's run-detail page updates in real-time without a
parent-level SSE descendant multiplex.

See the integration test for the deterministic assertion path:
`packages/daemon/test/parallel-hitl-smoke.integration.test.ts`.
