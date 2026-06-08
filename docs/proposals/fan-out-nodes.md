---
title: Fan-out nodes (Model A) — intra-run parallel fan-out on the log
summary: "A `parallel` node opens a take-all set of branches that run concurrently within one run and converge at a single join. A branch is a sub-pipeline — one node, or several distinct-named read-class nodes routing among themselves to the join. Execution is an on-log reactive frontier: the active set is a lineage-tagged set of in-flight nodes folded from the log; each sub-node completion is a durable fact whose successor the executor dispatches via the existing planTransition; a semaphore bounds in-flight sub-nodes. Commits serialize through the run's single committer (the linearization invariant — concurrency.md), so replay is deterministic over one linear log and resume re-dispatches the exact in-flight frontier (per-sub-node recovery). The join reads each branch terminal's typed outputs fail-closed (structured outputs, shipped). MVP: static sectioning with multi-node read-class branches + a bounded-concurrency semaphore. Deferred-but-sound: map, nested parallel, HITL-in-branch."
status: proposed
maturity: designed
last-reviewed: 2026-06-07
---

# Fan-out nodes (Model A)

Umbrella, the linearization invariant, and the spec reversal (A0):
[concurrency.md](concurrency.md). This is the **node-level** primitive — "N
fresh, parallel, read-only sessions over shared state, combined."

## Shape (DSL)

A `parallel` node is a bodyless control node (alongside `start` / `exit`). It
names its branch **entry** nodes (`branches:`) and, via its ordinary `next:`, the
**join** they converge on (an ordinary `llm`/`tool` node — its join-ness is only
that `parallel` points `next:` at it; making it a `type: join` would revive the
obsoleted merge-reducer-registry smell).

```yaml
review_lenses:
  type: parallel
  branches: [correctness_scan, security_scan, performance_scan]  # take-all: branch ENTRY nodes
  next: synthesize                                               # select-one: the join
  concurrency: 3                                                 # optional: max in-flight sub-nodes

# single-node branch
security_scan: { type: llm, allowed-tools: [read, grep], next: synthesize, outputs: { findings: {…} } }

# multi-node branch (a sub-pipeline): scan -> verify -> join
correctness_scan:
  type: llm
  allowed-tools: [read, grep]
  next: correctness_verify            # routes WITHIN the branch
  outputs: { findings: {…} }
correctness_verify:
  type: llm
  allowed-tools: [read, grep]
  next: synthesize                    # branch terminal -> the join (the barrier edge)
  outputs: { findings: {…} }

synthesize:                            # ordinary llm node; reads each branch TERMINAL by name
  type: llm
  prompt: "Combine ${{ outputs.correctness_verify.findings }} / ${{ outputs.security_scan.findings }} …"
  next: exit
```

**A branch is a sub-pipeline, unified across single- and multi-node.** A branch's
*subgraph* is the closure reachable from its entry via `next:`/`routes:` that does
not pass through the join. Every edge leaving that closure must target the join
(`parallel.next`) — that edge is the barrier edge. A single-node branch is the
degenerate case: its closure is one node whose `next:` is the join.

- **Entry nodes** are listed in `branches:` (≥2, distinct).
- **Internal nodes** route freely *within* the closure.
- **Terminal nodes** (closure exits) point at the join.
- Branch nodes read upstream context via typed outputs / inputs and pass results
  downstream via typed `outputs:`. The join reads each branch's **terminal**
  outputs by name.

**IR normalization** (sugar → IR; freeze in `workflow-ir.md` before the IR-sha
hash): a `parallel` IR node `{ members: [entry…], next, concurrency }`. Edges:
`parallel → entry` (take-all, `EdgeAttrs.fanout = true`); the author-declared
intra-closure edges; each closure-exit `terminal → join` (barrier,
`EdgeAttrs.fanout = true`). The executor derives branch membership (the closure
per entry) from `attrs.branches` + the fan-out edges. Member order = declared
order, so any future `[*]` aggregate is replay-deterministic.

## Execution — the on-log reactive frontier

`current_node` is pinned to the `parallel` node; the **active set** (a
lineage-tagged set of in-flight sub-node ids, stored under the
`internal.active_nodes` routing key) is the truth. The executor runs a reactive
pool, reusing `executeNode` / `planTransition` / the serialized commit lane
unchanged:

```
on a `parallel` node:
  emit fact.fanout_started { nodeId, branches }      # seeds the frontier with the entry nodes
  sem ← Semaphore(concurrency)
  pool ← {}
  for each frontier node f: await sem.acquire(); pool += executeNode({...state, currentNode: f})
  while pool not empty:
    outcome ← await race(pool); sem.release()
    commitFanoutFact(outcome)                        # node_completed + outputs + transcript; re-reads version
    succ ← planTransition(outcome)                   # EXISTING pure edge-selection, per branch
    if succ is the join: mark this branch done
    else: await sem.acquire(); pool += executeNode({...state, currentNode: succ})   # node_started adds it to the frontier
  # all branches reached the join → frontier drained
  re-check run budget against the now-folded cumulative
  emit fact.fanout_joined { nodeId, nextNode: join } # clears the frontier, advances current_node to the join
```

Key properties, each load-bearing:

- **Concurrent execute, serialized commit.** Branch handlers run at once; each
  terminal commit is `await`-ed one at a time through `commitFanoutFact`
  (re-reads the live version, appends, retries the *append* — never re-executes —
  on a benign sibling-moved-version conflict). The linearization invariant
  (concurrency.md) holds.
- **The frontier advances per branch, independently.** `correctness_verify`
  dispatches the instant `correctness_scan` commits, regardless of how far the
  `security` branch has gotten. No inter-step barrier; the only barrier is the
  join.
- **Replay-deterministic over one linear log.** The committer assigns the seq
  order; replay folds it and rebuilds the identical frontier. Set-valued, so
  cross-branch interleaving doesn't matter; the global message `ordinal` is the
  only non-stable datum (UI-only).
- **`current_node` stays pinned.** A sub-node's `fact.node_started` /
  `fact.node_completed` updates the frontier, *not* `current_node` (reducer
  decoupling). Only `fact.fanout_joined` advances `current_node` to the join.

### Resume — per-sub-node, by construction

`startupSweep` preserves `current_node` (pinned to the `parallel` node) on
requeue. On re-entry the frontier is non-empty (folded from the log), so the
executor skips `fanout_started` and re-dispatches **only the nodes still in the
frontier**. A completed sub-node recovered its outputs + transcript via the
existing per-`(nodeId, iteration)` path (distinct ids — no new plumbing). A
3-node branch that crashed on node 3 re-runs only node 3; nodes 1–2 outputs feed
its reads.

### Bounded concurrency — the semaphore

A `concurrency: <n>` field on the `parallel` node caps **in-flight sub-nodes**.
The frontier loop acquires a slot before each `executeNode` and releases on
completion; excess dispatches queue. Default: a configured global
(`fanout.max_concurrency`, default 8) so a wide static set or a `map` can't open
N agent loops + provider connections at once; `concurrency:` overrides per node.
This is `map`'s prerequisite (dynamic N), and cheap insurance for static sets —
so it is built in v1, not deferred.

## The join — fail-closed typed outputs

The join is an ordinary `llm` (synthesize) or `tool` (deterministic) node reading
each branch **terminal** by name: `${{ outputs.correctness_verify.findings }}`.
Fail-closed (shipped substitution): a branch that didn't produce fails the read.
No reducer kind, no `concat`/`majority_vote` registry. Static N (named
producers) is what makes the read by-name; `map`'s aggregate `[*]` read is the
one deferred piece.

## Validator codes (well-formedness)

A branch entry is a distinct, existing, read-class node; its closure is a clean
DAG terminating at the join.

- **E036** — a `parallel` declares ≥2 branches.
- **E037** — branch entry ids are distinct and exist.
- **E038** — the join is a defined step (declared in `steps:`).
- **E039** — a branch closure is acyclic, stays inside `{closure ∪ join}` (no
  edge escapes to a node outside it), and every path terminates at the join (no
  goal-gate / self-edge / loop that re-enters the fan-out — an identity and
  liveness hazard).
- **E044** — branch closures are **disjoint**: no node belongs to two branches.
- **E040** — no nested `parallel` inside a branch closure (v1; lineage reserved).
- **E041** — branch closure nodes are `type: llm` (deliberation; `tool`/`human`
  deferred — see § Open).
- **E042** — no branch closure node can reach a write-class tool
  (`bash`/`write`/`edit`); branches share the worktree **read-only** (concurrent
  writes corrupt the shared snapshot nondeterministically and won't replay).
  Scope a branch read-class via `allowed-tools` / `denied-tools`.
- **E043** — no branch closure node declares an explicit `thread:` — a thread is
  a single-writer log; each branch runs on its own synthetic thread
  (deterministic-thread-id.md). Concurrent writers on one thread interleave
  `tool_use`/`tool_result` into a history no provider accepts.

The join reading branch outputs reuses **E035** (broken ref) and suppresses
**W015** (the take-all barrier guarantees every branch ran, so the join's reads
are dominant).

## Schema & contract delta

- **Facts:** `fact.fanout_started` / `fact.fanout_joined` added to the
  `FactEvent` union — two new fold-path facts. **Bump `EVENT_CONTRACT_VERSION`
  1→2** (`MIN_COMPATIBLE` stays 1: v1 runs carry no fan-out facts → still
  resume). Re-snapshot the contract-surface hash.
- **Projection:** the active set is a `run_state.routing["internal.active_nodes"]`
  key (lineage-tagged), **not a new column** — `ALTER TABLE run_state DROP
  COLUMN` is unavailable (SQLite can't rewrite that generated-column table), so a
  column has no clean reversible `down`; a routing key is foldable from the log
  and trivially reversible.
- **Thread id:** `messages.thread_id` column + index (v_n→v_{n+1} with a `down`
  table-rebuild) — prerequisite, deterministic-thread-id.md.

## MVP scope (frozen)

**Static sectioning with multi-node read-class branches + bounded concurrency.**

**In:**
- `type: parallel { branches: [entry…], next: <join>, concurrency? }`.
- Branches are sub-pipelines of distinct-named **`type: llm`, read-class**
  nodes; closures are DAGs terminating at the join.
- Semaphore-bounded in-flight sub-nodes.
- Lineage-tagged frontier projection; `fanout_started` / `fanout_joined` facts.
- Per-sub-node crash/resume; budget re-checked at the join (overshoot bounded to
  the in-flight set).
- Replay-deterministic (one linear log; reads by name).

**Out (deferred, each sound per § Doors):** `map:` / dynamic cardinality and the
`${{ outputs.<map>[*].f }}` aggregate read; `first_success` / `collect_settled`;
nested `parallel` (E040); `human`/HITL or write-class or per-branch-isolated
branches; cross-run `run:` (Model M).

### Acceptance / testing ground — review lenses gain a verify step

`review.yaml`'s full tier becomes three **2-node** branches running
concurrently, each filtering its own hallucinated findings before the join:

```
review_lenses (parallel, branches: [correctness_scan, security_scan, performance_scan]) → synthesize
  correctness_scan → correctness_verify → synthesize
  security_scan    → security_verify    → synthesize
  performance_scan → performance_verify → synthesize
```

Each `*_scan` emits raw typed `findings[]`; each `*_verify` reads its scan's
findings, re-checks every `path:line` against the actual code, drops
unverifiable/hallucinated ones, and emits the filtered `findings[]`. `synthesize`
reads the three **verify** terminals. This exercises multi-node branches,
intra-branch typed data flow (`verify` reads `scan`), heterogeneous concurrent
sub-pipelines, the semaphore, and per-sub-node resume — all read-only. Definition
of done: this workflow runs end-to-end, a mid-branch crash resumes re-running
only the unfinished sub-node, and `deriveRunState` replay matches the live
projection.

## Doors — capabilities the frontier admits (deferred, sound)

Established here so the substrate is known-sufficient, not retrofitted.

- **HITL inside a branch.** A `human` node in a branch is a durable yield. The
  frontier can hold a pending-input slot while siblings keep running — so the run
  stays `running` (modelling a live fan-out as `paused` is the classic mistake).
  Adding it needs a frontier-scoped pending-input state + a "the run is paused
  only when the frontier cannot advance and nothing else is runnable" rule — no
  new invariant. MVP forbids it (extends "deliberation-only").
- **Nested `parallel`.** A branch containing a `parallel` becomes deeper lineage
  prefixes in the same flat frontier; the nested join fires when its
  lineage-prefix sub-frontier drains — a pure prefix-scoped fold. Lineage tags
  ship in v1 so enabling it is additive (relax E040 + recursive barrier logic).
- **`map` (dynamic homogeneous).** K copies of one sub-pipeline over a runtime
  array. Identity: lift the index into the node-id namespace (`${M}#${k}` /
  `${M}#${k}/${sub}`) so the existing `(nodeId, iteration)` machinery works
  per-copy unchanged. The one new durable obligation: materialize `over`
  deterministically and record it in `fanout_started`, so resume re-derives the
  same K and `k→item` mapping from the fact. Joined by the `[*]` aggregate read.
- **`collect_settled` / `first_success`.** `collect_settled` records a present
  `{succeeded[], failed[]}` split in the frontier (optionality in the data, never
  in the read). `first_success` ends the frontier early, aborting siblings via
  the per-run AbortController set and recording their `node_aborted` (durable —
  loser-retirement is just facts). Both are `map`-scoped.

## Semantics digest

- **Failure policy:** `wait_all` (default, sole v1 policy for the heterogeneous
  named set). Any branch sub-node failing re-drives **only that sub-node** (it
  stays in the frontier); a persistently-failing sub-node parks the run at the
  run-wide abort-loop ceiling. Completed siblings are committed and never re-run.
- **Budget:** one run-wide cumulative. The frontier checks budget at **each
  sub-node commit** (the durable cumulative advances per commit, so the next
  dispatch sees fresh spend) and re-checks at the join. Peak in-flight overshoot
  is bounded by the semaphore width, not branch depth. A branch budget breach
  parks the run; resume re-applies the operator's raise and re-dispatches only
  the unfinished frontier (per-sub-node continue).
- **OCC:** intra-branch commits serialize through the single committer; no
  intra-run contention (linearization invariant). The cross-process OCC retry
  (`commitFanoutFact`) handles a server-side operator intent landing mid-frontier.
- **Worktree:** shared, read-class only. Write-class on a branch is E042.
- **Thread:** each branch sub-node runs on its own synthetic thread
  (`syntheticThreadId(nodeId, iteration)`); the join reads via `outputs`, never a
  shared thread (E043). This is why replay is sound — no concurrent writers on
  one thread.
- **`dispatches` / `max_loops`:** each sub-node dispatch counts (a fan-out of a
  deep branch is real durable work); `max_loops` is the runaway guard, applied
  run-wide. (Confirm at build.)

## Build plan

Bottom-up; each step lands green on its own.

1. **Facts + reducer + contract v2.** `fanout_started`/`fanout_joined` in the
   `FactEvent` union; reducer arms seed/advance the lineage-tagged frontier and
   decouple sub-node lifecycle from `current_node`; bump the contract; re-snapshot.
   Behavior-identical with no `parallel` dispatched (first green PR).
2. **Thread-id prerequisite.** `messages.thread_id` column + migration +
   thread-filtered reads; `ctx.threadId` single-source; E043. (deterministic-thread-id.md.)
3. **Parser + validator.** `type: parallel`; synthesize take-all + barrier edges;
   E036–E043 (closure-based); `fragua validate` recognizes it.
4. **Executor execute/commit split.** Factor the terminal commit out of the
   per-turn handler turn so K execute halves run concurrently while commits
   serialize (`executeNode` + `applyOutcome` + `commitFanoutFact`).
5. **The frontier loop + semaphore.** The reactive pool over the lineage-tagged
   frontier; budget at commits + join; the join barrier.
6. **Resume.** Frontier folds from the log; re-dispatch the in-flight set;
   mid-branch crash test + replay-equivalence assertion.
7. **Acceptance.** The verification-step `review.yaml` runs end-to-end; docs
   reconciled (SPEC §3.1/§3.9/§5, ARCHITECTURE §3/§6.1, CHANGELOG).

## Open (confirm at build)

- `concurrency:` default value and whether it's per-node-required for `map`.
- Read-class `tool` node in a branch in v1, or `llm`-only (E041)? Lean: allow a
  read-class `tool` (it's deterministic and side-effect-free by classification),
  but keep the MVP test on `llm` branches.
- `dispatches`/`max_loops` accounting across a deep frontier (lean: per sub-node).
