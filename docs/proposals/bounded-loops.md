---
title: Reject unbounded loops by construction
status: proposed
maturity: specified
last-reviewed: 2026-05-21
---

# Reject unbounded loops by construction

> A workflow with a cycle that has no iteration cap is a latent
> budget/time bomb — it only ever stops at a runtime backstop (budget
> pause, max-loops ceiling), and a budget pause is *operator-resumable*,
> so a flaky/unfixable loop never truly ends. The validator should make
> such workflows **un-authorable**: every cycle must carry a finite cap.

---

## Why now

The `work` workflow's `ci → fix → ci` cycle (plain `on.fail` / `next`
edges) had no cap. A flaky test made `fix` loop, budget-pause, get
resumed, loop again — escalating $0.30 → $0.80 → $1.00 → … and burning
$22 on one run before it was cancelled. The loop was bounded only by
operator patience. Capping `fix` with `max-retries` fixed *that* workflow,
but nothing stops the next author from writing the same unbounded cycle.

`retry:`-authored loops are already safe: **E031** requires `max_retries`
on every `retry:` step. The gap is **cycles formed by plain `next:` /
`on.success` / `on.fail` edges** — nothing requires them to terminate.

## The rule (engine-aligned)

`retry-policy.ts` is explicit: *"Attractor has no loop primitive. Loops
are backward edges, and iteration is bounded by `max_retries` on the
target node."* So termination of a cycle is guaranteed iff the cycle's
re-entry target carries a finite `max_retries`.

**New validator error (E032, "unbounded loop"):** for every cycle in the
edge graph (`next` + `on.*` + `retry` + goal-gate retargets), require at
least one node *on the cycle* to declare a finite `max_retries` (or be a
`goal_gate` with one — same cap mechanism). A cycle with no capped node is
rejected at validate time with the cycle's node list.

```
E032  unbounded loop: cycle [ci → fix → ci] has no max_retries / goal_gate
      bound — loops are bounded by max_retries on a node in the cycle
      (see retry-policy.ts). Add `max-retries: N` to one of: ci, fix.
```

## Algorithm

1. Build a directed edge set from the parsed graph: `next`, `on.*`
   targets, `retry` / `retry_target` / `fallback_retry_target`, and the
   graph-level goal-gate retargets.
2. Find strongly-connected components (Tarjan). Any SCC with >1 node, or a
   single node with a self-edge, is a cycle.
3. For each such SCC, pass iff **some** node in it has a finite
   `max_retries` (the cap that bounds re-entry of that node, breaking the
   cycle). Otherwise emit E032 listing the SCC's nodes.

SCC-level "some node is capped" is the right granularity: every cycle in
the component must pass through a capped node to make a full loop, so one
capped node on the component bounds all of its cycles. (A stricter
per-back-edge rule is possible but rejects valid multi-node loops that cap
at a single gate — the common shape.)

## Migration — the 7 in-repo workflows

- `work` — `reproduce` (retry+max), `implement` (retry+max), `ci↔fix`
  (now `fix.max-retries: 3`) → all bounded. ✓
- `review` — `review_full` retry+max ✓.
- `drift`, `doc-sync`, `analyze`, `health`, `rollup` — audit for plain-edge
  cycles; add a cap where any exist. Expectation: most are acyclic or
  `retry:`-bounded already; this rule surfaces any that aren't.

Run the new check across all bundled workflows in the same PR; fix any it
flags (the point of the rule).

## Same-PR obligations

- `packages/core/src/engine/validator.ts` — add E032 + the SCC check.
- `.agents/skills/workflows/SKILL.md` — validator-codes table gains E032
  (per `AGENTS.md` ground rule 1's validator-codes obligation).
- Tests: a plain-edge cycle with no cap → E032; the same cycle with
  `max-retries` on one node → clean; a `retry:`-bounded loop → clean
  (already covered by its own cap).

> Status: specified, ready to implement. Pulled out of the loop-bounding
> work on `work.yaml` (commit `5f9a0356`) — that fixed one workflow; this
> makes the whole class un-authorable.
