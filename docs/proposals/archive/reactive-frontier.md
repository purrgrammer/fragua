---
title: Reactive fan-out frontier — implementation gameplan
summary: "The shipped `runFanout` dispatches a superstep's whole frontier with one `Promise.all` and commits every branch completion together at a barrier — so a slow/hung/failed branch blocks the commit of its already-finished siblings (head-of-line blocking, confirmed in a live post-mortem: two finished verify branches sat uncommitted for ~15 min behind a runaway correctness_scan). Replace the batch with a `Promise.race` POOL that commits each branch as it settles and dispatches its successor immediately, so one bad branch can't dam the rest. This is the model fan-out-nodes.md already specifies; the MVP simplified it to a batch. The reactive frontier fixes head-of-line blocking but is NOT a liveness guarantee on its own — a genuinely hung unbounded branch still keeps the join unreachable, so this plan also closes the two gaps the post-mortem exposed: the fan-out watchdog skipping unbounded branches, and the abort-loop counter resetting on sibling success. Pick up in a fresh session; this doc is self-contained."
status: shipped
maturity: shipped
last-reviewed: 2026-06-08
---

# Reactive fan-out frontier — gameplan

> **Status: SHIPPED** on `feat/parallel-fanout`. `runFanout` is now the
> `Promise.race` pool (Step 1); the per-branch abort-loop (Step 2) and per-branch
> timeout backstop + supervisor change (Step 3) landed with it. Live-validated by
> a real multi-node review run, including repeated pause/resume mid-fan-out (the
> frontier held only the unfinished sub-nodes across every cycle) and the
> per-commit budget gate. Step 0 (the `executeNode` kernel extraction) and §7 (the
> resume-after-cap-pause guard) remain open follow-ups. The realized design lives
> in [`fan-out-nodes.md`](fan-out-nodes.md) § Execution + the executor.

> Self-contained implementation plan. Branch: **`feat/parallel-fanout`** (the
> fan-out MVP is landed + committed there). Design context: [`fan-out-nodes.md`](fan-out-nodes.md)
> § Execution. This doc is the *how* for the reactive-frontier upgrade + the two
> liveness gaps a live post-mortem exposed.

## 1. The problem (with evidence)

`runFanout` (`packages/daemon/src/executor.ts`) runs one superstep per call as a
**batch**:

```
active = readActiveNodes(routing)                       // the frontier
outcomes = await Promise.all(active.map(executeBranchNode))   // ← waits for ALL
for (success) commitFanoutFact(node_completed + bundled dispatch_started{successor})
for (abort)   commitFanoutFact(node_aborted)            // stays in frontier
... budget re-check, abort-loop, return continue
```

The `Promise.all` is the flaw: **no branch's `node_completed` commits until every
branch in the batch settles.** A slow/hung/failed sibling holds the whole
superstep open.

**Live post-mortem — run `01ktk140wz91zcndq86qa292m4` (review fan-out):**
- `security_scan`/`performance_scan` finished and advanced to their verifies;
  `correctness_scan` was a **runaway unbounded llm branch** (1.68M tokens, never
  self-terminated — both its terminations were external: a daemon SIGTERM, then
  the operator cancel).
- In the next superstep `[correctness_scan, security_verify, performance_verify]`,
  the two verifies **stopped streaming at 00:20:44 / 00:21:24** but their
  `node_completed` did not land until **00:36:49** — ~15 minutes late, and only
  because the operator cancelled (which tripped the batch). They were dammed
  behind the runaway branch in the same `Promise.all`.
- `fanout_joined` never fired; the run sat "running" with no forward progress.
- Two secondary gaps (see § 5): the supervisor watchdog **skipped** the set
  because a branch was unbounded; the abort-loop counter **never climbed**
  because each superstep had ≥1 sibling success (reset to 0 every time).

## 2. Target model

A **reactive pool** within one `runFanout` call: dispatch the frontier, then as
*each* branch settles, commit it immediately and dispatch its successor — never
waiting on siblings. From the log it's identical (same facts, same order
relative to each branch's own work); only the *latency* of a sibling's commit
changes (no longer gated on the slowest branch).

```
seed (fanout_started) if fresh; if frontier empty → fanout_joined; else:
  sem = Semaphore(concurrency)
  pool = Map<nodeId, Promise<{nodeId, outcome}>>           // in-flight branches
  dispatch(nodeId): acquire sem; pool.set(nodeId, executeBranchNode(nodeId, …).then(o => ({nodeId, o})))
  for f in frontier: dispatch(f)
  while pool not empty:
    { nodeId, outcome } = await Promise.race(pool.values())
    pool.delete(nodeId); sem.release()
    commit outcome SERIALLY (same commitFanoutFact lane — the linearization point):
      success → node_completed (+ outputs); successor = planTransition's nextNode
                if successor !== join: commit bundled dispatch_started{successor}; dispatch(successor)
                else: branch done
      abort   → node_aborted (stays in active set); record for disposition
      leak    → halt the run, return terminal
    apply per-commit budget gate (now cheap + frequent — see § 6)
  // pool drained
  if a run-level disposition was captured (budget halt/pause): commit it, return terminal
  if any branch aborted (no progress): bump per-branch abort-loop (§ 5b); maybe pause; else return continue (re-drive the still-active aborts)
  else: fanout_joined → return continue   // next turn dispatches the join
```

Key invariants to preserve (do NOT regress — they're what makes the MVP correct):
- **Serialized commits through one committer** (the linearization invariant,
  concurrency.md). `commitFanoutFact` stays the single commit lane; only the
  *dispatch* side becomes a race pool. Concurrent execute, serialized commit.
- **`current_node` pinned to the parallel node** until `fanout_joined`; sub-nodes
  ride `dispatch_started` (never `node_started`, which would unpin it).
- **Frontier folds from the log** (`internal.active_nodes`): a crash mid-pool
  resumes by re-reading the active set and re-dispatching it — the pool is
  in-memory and rebuilt on resume. So resume granularity stays per-sub-node.
- **Replay determinism**: the committer assigns one seq order; replay folds it.
  The pool's race order = the live commit order = the logged order. Nothing new.
- **Bundled `node_completed{F} + dispatch_started{successor}` stays ONE commit**
  (I1 — a crash in the gap must not orphan the successor).

## 3. Build steps (ordered)

**Step 0 — Extract the dispatch kernel (prereq, also a /simplify finding).**
`executeBranchNode` is a ~130-line near-copy of `dispatchOne`'s ctx assembly
(recorder, the seven `total*` accumulators, the `accounting.addUsage` closure,
the `emitObservability` `cost.recorded` mirror, `ctxOpts`, `buildHandlerContext`,
`invokeHandler`, the abort/leak/success interpretation). Factor a shared
`executeNode(nodeId, state, decision, routing, { reactiveBudget?: boolean }) →
Outcome` that BOTH the linear `dispatchOne` and the fan-out path call. The branch
path passes `reactiveBudget: false` (deliberation-only, budget at the barrier);
the linear path keeps its reactive gate + budget snapshot + humanInput/steering.
This removes the drift risk (an accounting edit had to be made twice) and makes
the pool loop small. Gate: full daemon suite green, behavior-identical.

**Step 1 — Rewrite `runFanout`'s dispatch as the reactive pool (§ 2).** Replace
the `Promise.all` + batch-commit with the `Promise.race` pool. Reuse
`commitFanoutFact` verbatim (serialized commit lane). Fold in the /simplify
cleanups here while you're in this code:
- Drop the dead `fact.run_completed` member from `RUN_LEVEL`; replace the `Set`
  with a direct `f.type === "fact.run_halted" || f.type === "fact.run_paused"`.
- Fold the inert `else if (f.type === "fact.node_started") {}` arm into the
  filter predicate (`… else if (f.type !== "fact.node_started") branchFacts.push(f)`)
  with one rationale comment.
- Hoist the budget-recheck `getState` to reuse the last commit's folded state;
  compute successor `nodeRetryCount` once from `freshState`.

**Step 2 — Per-branch abort-loop counter (§ 5b).** Replace the single run-wide
`consecutiveAborts` (reset whenever ANY branch succeeds) with a per-branch
counter: a branch that aborts N supersteps in a row pauses the run
(`run_paused{reason: abort_loop, nodeId}`) regardless of sibling outcomes. Keep
the run-wide ceiling as a backstop.

**Step 3 — Per-branch watchdog / deadline (§ 5a).** Make a hung unbounded branch
reclaimable. Two options (pick one; A is smaller):
- **A. Per-`parallel` `timeout:` → AbortSignal.timeout per branch.** A branch
  that exceeds it aborts (its `executeBranchNode` throws AbortError → abort
  outcome → re-drive bounded by Step 2). Document a sane default. Workflow-side,
  let lens nodes carry `max_ms`.
- **B. Supervisor: stop skipping the set on an unbounded branch.** Today
  `supervisor.ts` `continue`s if ANY active branch is unbounded. Instead track
  per-branch `startedAt` (the AbortRegistry already has per-entry `startedAt`)
  and trip only the branch that exceeds a fan-out deadline, not the whole set.
  Bigger, but it's the "right altitude" fix (per-branch, cross-restart).

Note: even with the reactive frontier, `wait_all` means the JOIN can't complete
while a branch is stuck — so Step 3 is what actually makes a runaway branch
terminable. The reactive frontier turns "everything dammed" into "one branch
stuck, the rest done + visible"; Step 3 turns that into "the stuck branch aborts
→ re-drive or pause." Both are needed for liveness.

## 4. Test matrix (add to `packages/daemon/test/executor.fanout.test.ts`)

- **Head-of-line (the regression):** two branches, one fast + one slow (a handler
  that resolves after a long fake delay / N awaits). Assert the FAST branch's
  `node_completed` commits (and its successor dispatches) BEFORE the slow branch
  settles — i.e. the fast commit's seq precedes the slow branch's completion.
  This fails on the batch model, passes on the pool.
- **Resume mid-pool:** stop after some branches committed and others are still
  in-flight (the pool is in-memory); re-drive; assert only the un-committed
  branches re-run, completed ones don't, replay matches.
- **Replay equivalence:** `deriveRunState(log)` == live projection after a
  multi-branch run (already covered; keep it).
- **Per-branch abort-loop:** one branch aborts every superstep while a sibling
  succeeds; assert the run PAUSES on `abort_loop{nodeId}` (today it loops forever
  — the post-mortem's masking bug).
- **Hung-branch deadline (Step 3):** a branch that never resolves + a `timeout:`;
  assert it aborts and the run re-drives/pauses rather than hanging.

## 5. The two liveness gaps (post-mortem, in scope here)

These are NOT fixed by the reactive frontier alone — they're why the run still
wedged after siblings finished. Both are small and belong with this work.

**5a. The fan-out watchdog skips the whole set on one unbounded branch.**
`supervisor.ts` (the stuck-node watchdog): during a fan-out it walks the active
branches and `continue`s without tripping if ANY is unbounded (`maxMs 0`). lens
llm nodes are unbounded, so a runaway branch is invisible to it. Fix = Step 3.
(The per-branch `invokeHandler` `Promise.race(setTimeout(maxMs+grace))` watchdog
does NOT help here — unbounded llm sets no `maxMs`, so no timeout arms.)

**5b. The abort-loop ceiling resets on sibling success.** `runFanout`'s
`if (successes.length > 0) consecutiveAborts = 0; else consecutiveAborts++` means
a branch that aborts every superstep alongside ≥1 healthy sibling never climbs
the counter → the run never auto-pauses. Fix = Step 2 (per-branch counter).

## 6. Notes / preserved behavior

- **Budget**: with per-commit gating the overshoot bound TIGHTENS (each
  `node_completed` advances the durable cumulative, so the next dispatch sees
  fresh spend) — strictly better than the batch's once-per-superstep re-check.
  Keep the barrier re-check too (belt + suspenders).
- **OCC**: unchanged — intra-run commits serialize through the one committer;
  `commitFanoutFact` re-reads version + retries the append on a benign
  cross-process (server intent) conflict. The race is on *dispatch*, not commit.
- **Concurrency cap**: the `Semaphore` already bounds in-flight sub-nodes; the
  pool acquires before each dispatch, releases on settle. `map` (deferred) needs
  this unchanged.
- **Deferred /simplify items NOT in this plan** (separate follow-ups): a shared
  `branchClosures(graph)` helper in `@fragua/core` to dedup the validator's twin
  closure walks + the web `fanout-topology` helper (web already shares one as of
  commit cec1ffc); a validator guard (E04x) rejecting `max_cost_usd` on branch
  nodes (today silently ignored — executeBranchNode has no per-node cap).

## 7. Separate but related: the resume-after-cap bug (do NOT conflate)

The OTHER cancelled run (`01ktk0mznz5j8s5n9z704c8mfv`, the *sequential* review)
exposed an independent bug, documented here so it isn't lost — it is NOT part of
the reactive frontier: a goal-gate (`verify`, `max-retries: 2`) exhausted its cap
and paused `reason: goal_gate`; an operator `intent.resume` with **no cap bump**
re-dispatched the gate anyway (`fact.dispatch_started{verify, resumeOf:paused}`
5ms after resume), which re-evaluated `__retries(2) >= cap(2)` BEFORE any new
work and immediately re-paused — a no-progress pause↔resume loop until cancel.
Root: `goal_gates.__retries` (`engine/goal-gate-policy.ts`) only ever increments
(written at `transition-planner.ts` retarget); `intent.resume` is a no-op fold
(`intent-fold.ts`); nothing refuses a bare resume on a spent cap. **Fix (separate
PR):** at the resume/wake seam, for cap-class pauses (`goal_gate`, `max_loops`;
`max_retries` already has a defensible naked-resume since work re-runs), refuse a
bare `intent.resume` unless the matching override was raised above the spent
count — emit a dropped-intent note ("raise the cap first") instead of a silent
re-pause. General to cap-class pauses, one guard keyed on `reason`.
