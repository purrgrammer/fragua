---
title: Concurrency — parallel fan-out on the log (umbrella + decision record)
summary: "fragua needs to run N units of work concurrently inside one run and combine them. The hardened conclusion: branches are nodes in one run, and their durable writes linearize through the run's single committer — so a fan-out is N concurrent EXECUTIONS whose COMMITS serialize, exactly the model fragua already runs. This makes per-sub-node durability on one log not just possible but the default: the active set is a lineage-tagged frontier folded from the log, multi-node branches advance independently to a single join barrier, and crash/resume re-dispatches the exact in-flight frontier. The earlier 'N durable concurrent writers are impossible' framing conflated concurrent execution with concurrent commits; a run has one writer fiber, so OCC never contends intra-run. Detailed spec: fan-out-nodes.md. Structured outputs (shipped) are the fail-closed join. A second, cross-run primitive (child runs over a parameter sweep, fan-out-runs.md) is the other end of the recovery-granularity axis and stays future."
status: implemented
maturity: shipped
last-reviewed: 2026-06-07
supersedes: the off-log recursion addendum (2026-06-01) and the active-set-only single-node MVP — both folded into the on-log frontier below
---

# Concurrency — parallel fan-out on the log

The need: fan out N units of work inside one run, then combine. The recurring,
high-value shape is **fresh, parallel, read-only sessions over shared state** —
multi-lens review, parallel collectors, same-task-K-times for confidence. The
deliverable is the **node-level** primitive: a `parallel` node opens a set of
branches that run concurrently through the same durable loop and converge at one
join, which reads their typed outputs fail-closed.

> A second primitive — **cross-run** fan-out (N full child runs of a named
> workflow over a parameter sweep, isolated worktrees, joined by reading each
> child's outputs) — is the other end of the recovery-granularity axis. It stays
> future; see [`fan-out-runs.md`](fan-out-runs.md). This doc and
> [`fan-out-nodes.md`](fan-out-nodes.md) are about the intra-run primitive.

## The invariant that makes this sound — linearization, not isolation

A fan-out runs K branches concurrently. The question that sank two earlier
attempts is *where a concurrent unit sits relative to the run / log / OCC
boundary.* The hardened answer:

> **All durable writes for a run linearize through one committer.**

This is the model fragua already runs — "concurrent I/O, serialized commit." A
fan-out does not change it; it only produces *more* commits through the same
single committer (the executor fiber for that run). Specifically:

- Branches execute concurrently and stream on **non-version-bumping lanes** —
  `appendMessage` mints an event seq but never touches `run_state.version` and
  never goes through `tryAppendFact`; observability is explicitly no-bump. So K
  in-flight branches produce **zero** OCC contention mid-flight.
- Each branch's **terminal** `fact.node_completed` is version-bumping. These are
  `await`-ed one at a time through the executor's commit lane (re-reading the
  live version each append). Two branches never truly contend on `version`,
  because a run has exactly one writer fiber (`daemon_lock` is single-owner). OCC
  exists for **cross-process** safety (operator intents via the server vs. the
  daemon), not for intra-run branches.

The earlier "you cannot have N durable concurrent writers on one projection
slot, so durable per-sub-node facts are arithmetically impossible" framing
**conflated concurrent execution with concurrent commits.** The version counter
is the *linearization point*, never a contended resource intra-run. Single-node
fan-out commits K terminal facts; multi-node fan-out commits K×depth facts
continuously — same invariant, more writes.

## One intra-run model — the on-log frontier

Branches are **nodes in one run** (one `run_state`, one event log, one OCC
space). The "what is running" projection is not the single `current_node`
scalar — it is a **lineage-tagged active set** (a `run_state.routing` key,
foldable from the log). `current_node` stays pinned to the `parallel` node; the
frontier is the truth.

- A branch is a **sub-pipeline** — one node, or several distinct-named read-class
  nodes that route among themselves and converge on the join. Each sub-node
  completion is an ordinary durable `fact.node_completed` (+ outputs +
  transcript). The executor computes its successor via the **existing**
  `planTransition` and dispatches it; the frontier advances one node at a time,
  per branch, independently.
- **Replay is deterministic, and trivially so:** the single committer assigns one
  monotonic seq order to every fact, so replay folds *that one linear log* and
  reconstructs the identical frontier at every seq. Cross-branch interleaving is
  frozen in the log. The only non-replay-stable datum is the global message
  `ordinal` (UI ordering only; nothing keys correctness on it). Outputs and
  per-node transcripts key on `(nodeId, iteration)`, stable regardless of arrival
  order.
- **Resume is per-sub-node by construction:** the frontier folds from the log;
  after a crash, re-dispatch exactly the in-flight nodes. A 3-node branch that
  crashed on node 3 re-runs only node 3 — node 1/2 outputs are durable and feed
  node 3's reads. This is strictly finer recovery than re-running the whole
  branch, and it never leaves the log as source of truth.

This is the design's own original Phase-2 frontier ("each chain dispatches the
instant its predecessor completes; no barrier between steps, only the join"),
promoted to the default and proven to hold under durability.

## The recovery-granularity axis (author's choice)

The design variable is *what recovery granularity you buy, and where coordination
sits.* Two points, chosen at authoring time:

| | `branch:` — **on-log frontier** (this doc) | `run:` — **child run** (fan-out-runs.md) |
|---|---|---|
| Unit | nodes in the parent run | a full child run of a named workflow |
| Recovery | per-sub-node (re-dispatch the in-flight frontier) | per-node within the child (a child is a normal run) |
| State / log / OCC | one of each (shared) | one per child |
| Worktree | shared, read-class (deliberation) | isolated per child (children write) |
| N | static, or `map` (dynamic) | dynamic (parameter sweep) |
| Join | typed outputs, fail-closed, in-run | child typed outputs, read cross-run |

There is deliberately **no third "off-log ephemeral" model.** An off-log branch
(run the sub-pipeline against an in-memory backend, re-run the whole branch on
crash) was considered and rejected as the default: it trades the log-as-truth
story and per-sub-node resume for "nesting and exotic join policies fall out for
free," and the frontier delivers both of those soundly (below) without that
trade. Off-log remains available later only as a transparent *optimization* of a
`branch:` (skip durable sub-node facts to save log writes) if a real case ever
justifies it — never as a separate authoring concept.

## The join is already built

Structured outputs (shipped) are the fail-closed join for the frontier: the sink
is an ordinary `llm`/`tool` node reading `${{ outputs.<branch-terminal>.f }}` by
name. A branch that didn't produce fails the read — the "all clear / 6 findings"
bug is structurally impossible. No reducer-kind registry, no winner-picker. The
one piece still to build for `map` (homogeneous K-copy fan-out) is the aggregate
read `${{ outputs.<map>[*].f }}`; static sectioning needs only by-name reads,
which ship today.

## The spec reversal (A0)

SPEC §3.1 ("one handler to completion") and §5 ("no fan-out/fan-in… no concurrent
dispatch of any kind") are overturned **deliberately**. The replacement
invariant: *within a run, either one handler is in flight, or one fan-out's
frontier is advancing toward a single join barrier before any successor
dispatches.* The amendments (SPEC §3.1 node table, §3.9 budget at frontier
commits, §5 entry; ARCHITECTURE §3 facts, §6.1 executor decomposition) land with
the implementation.

## Doors this substrate opens (and how each stays sound)

The frontier is the substrate; these are capabilities it admits. Each is
**deferred** for the MVP but the substrate is designed so adding it is additive,
not a rewrite. Stated here so soundness is established, not discovered later.

- **Multi-node branches — IN the MVP.** A branch is a sub-pipeline of
  distinct-named read-class nodes. No new identity machinery (distinct ids key
  the existing `(nodeId, iteration)` paths); the frontier advances each branch
  via `planTransition`. This is the testing ground (review lenses gain a verify
  step).
- **Bounded concurrency (semaphore) — IN the MVP.** A `concurrency:` cap on the
  `parallel` node, enforced by a semaphore the frontier loop acquires before each
  sub-node dispatch. Required for `map`; cheap insurance for static sets. See
  fan-out-nodes.md § Bounded concurrency.
- **HITL inside a branch — sound, deferred.** A `human` node in a branch is a
  *durable* yield (the on-log frontier can represent a pending-input slot in the
  frontier while siblings keep running — the run stays `running`, not `paused`).
  The off-log model forecloses this entirely; the frontier only needs a
  frontier-scoped pending-input state, not a new invariant. MVP forbids it
  (E-code); the door is open.
- **Nested `parallel` — sound, deferred.** A branch containing a `parallel`
  becomes deeper lineage prefixes in the same flat frontier; a nested join fires
  when its lineage-prefix sub-frontier drains. Representable as a pure fold over a
  lineage-tagged set. MVP forbids it (E040) but **carries lineage tags from day
  one** so enabling it is additive.
- **`map` + `collect_settled` / `first_success` — sound, deferred.** `map` is K
  copies of one sub-pipeline over a runtime array; identity is the `#k` id-prefix
  over a materialized-and-recorded `over` list. `collect_settled` records a
  present `{succeeded[], failed[]}` split in the frontier; `first_success` aborts
  siblings via the per-run AbortController set and records their `node_aborted`
  (durable — the loser-retirement "corner" is just facts). Needs the aggregate
  read; static sectioning ships first.

## Decision record

**Ratified (2026-06-07):**

- **A0** — the spec non-goal is overturned; fragua has node-level fan-out.
- **The linearization invariant** replaces the "N durable writers impossible"
  framing. Intra-run commits serialize through one committer; OCC is for
  cross-process only.
- **The on-log frontier is the single intra-run model.** Per-sub-node durable
  resume; lineage-tagged active set folded from the log; one join barrier.
- **Multi-node branches and the semaphore are in the MVP** — to prove the shape
  before it ossifies, not bolt it on later. The MVP is static sectioning with
  multi-node read-class branches.
- **No off-log model** as a first-class concept (demoted to a possible future
  optimization).
- **`map`, nested `parallel`, HITL-in-branch, child-run M** are deferred; the
  frontier is designed to admit each additively (§ Doors).

**Open (confirm at build):** the exact `concurrency:` default; whether a branch
may include a read-class `tool` node in v1 or stay `llm`-only; `dispatches` /
`max_loops` accounting across a deep frontier (lean: count each sub-node, like
any node).

## Relationship to other proposals

- [`fan-out-nodes.md`](fan-out-nodes.md) — the Model A spec (DSL, frontier
  execution, semaphore, validator, MVP scope, doors).
- [`fan-out-runs.md`](fan-out-runs.md) — the cross-run primitive (`run:`); future.
- [`deterministic-thread-id.md`](deterministic-thread-id.md) — prerequisite: a
  thread is a single-writer log; concurrent branches each run on their own
  synthetic thread (E043). Ships with the frontier.
- [`structured-outputs.md`](structured-outputs.md) (shipped) — the fail-closed
  join data plane.
- [`workflow-ir.md`](workflow-ir.md) — `parallel` is a graph-shape change; land
  before the IR-sha freeze.
