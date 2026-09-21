---
title: "`type: workflow` — a workflow invoked as a step"
summary: "A `type: workflow` step runs a named child workflow as one step of a parent run: the executor enqueues one child run tagged `parent_run_id`, parks the parent in `paused_auto{reason:fanout_pending}` (the ratified fan-out-runs.md literal), and joins by reading the child's run-level `outputs:` block cross-run via the read-plane's run-level output projection (the pure `projectRunOutputs` egress contract). It is the FIRST landing of the Model M spine ([fan-out-runs.md](fan-out-runs.md)) — the spine is unbuilt today, so this proposal builds its minimal subset itself (the `parent_run_id` lineage column + budget-SUM index, the level-triggered `wakeFanoutJoin`, the child-lifetime GC guard (a parent-lineage predicate on `getGcEligibleSnapshotRuns` honored by `fragua gc --snapshots`, released by a durable adoption-or-discard fact), the single-level `SUM(total_cost_usd)` roll-up over `parent_run_id` — v1 forbids nested `type: workflow` steps, E049, so descendants are exactly the direct children); the fan variant reuses them later. The join is level-triggered — each tick `wakeFanoutJoin` scans `paused_auto{fanout_pending}` parents and, on a derived child reaching terminal, emits only `fact.run_resumed`; the driver's ordinary re-dispatch then fabricates the step's `fact.node_completed` at its single, existing edge-selection site (S1) — so a child that terminates before the park fact commits is never a lost wakeup, and no edge-selection logic leaks into `wake-pending`. Children are OPAQUE — never embedded — so no descendant SSE, no recursive rollup, no I11 leak. There is ONE mechanism (child run); inline parse-time expansion is rejected because the motivating loop is write-class and each round must provision an isolated worktree from the prior round's produced tree via `base:`, which a single shared worktree cannot hand off. Input binding is two clean substitution passes; the child never sees the parent namespace. The fix→review chain threads its worktree by a `base: tip` key that pins the child's provision base to the running tree tip (`tip` is a reserved value of the `base:` key, not a reserved node id), over the `--base <ref>` feature; `base: <step-id>` is deferred behind a Door. `accept` on the parent cherry-picks the running tip. Only the parent-authored top-level `human` signoff ships (layer 1); child-internal HITL propagation is deferred behind a Door, and a child whose graph contains a `human` node is rejected at save and re-checked at dispatch (E053, direct-child — v1 forbids nesting, so no transitive walk is needed). Cost: an `EVENT_CONTRACT_VERSION` bump (the new `fanout_pending` pause reason plus the new `parentRunId` payload field both change the surface hash) plus a `schema_version` migration (the `parent_run_id` column + index); `MIN_COMPATIBLE_CONTRACT_VERSION` stays 1. Validator codes E047–E054, W019."
status: proposal
maturity: draft
last-reviewed: 2026-06-19
---

# `type: workflow` — a workflow invoked as a step

> **Status: draft, panel NOT converged.** Four `propose` revise→panel rounds; feasibility and scope lenses approve, adversarial/clarity/precedent still ask for revisions — see [`workflow-as-step.critique.md`](workflow-as-step.critique.md) for the five open blocking demands. Checked in so the design is not lost in a paused run. Additive. Adds one node kind, `type: workflow`, that runs
> a named child workflow as a single step of a parent run. It is the **first
> landing of the Model M spine** ([fan-out-runs.md](fan-out-runs.md)) — that spine
> is entirely unbuilt today (`parent_run_id`, `wakeFanoutJoin`, `fanout_pending`
> have zero matches in `packages/`), so this proposal *builds* its minimal subset
> itself; the fan variant reuses it later. It shares the ratified fan-out-runs.md
> park reason literal `fanout_pending` verbatim, so the two docs stay one spine.
> It reads the child's run-level `outputs:` block
> ([structured-outputs.md](structured-outputs.md) §11) cross-run through the
> read-plane's run-level output projection as the child→parent value return, and the
> in-flight `--base <ref>` provision pin as the worktree hand-off. The cost is
> honest: an `EVENT_CONTRACT_VERSION` bump (the `fanout_pending` pause reason and
> the `parentRunId` payload field both enter the surface hash) plus a
> `schema_version` migration (the `parent_run_id` column), and an `ir_version` bump
> plus a converter for the node kind. `MIN_COMPATIBLE_CONTRACT_VERSION` stays 1. v1
> **forbids nested `type: workflow`** (E049), keeping the budget roll-up, E053, the
> tree-producing classification, and the abort cascade all single-level; and it
> **routes the join through the driver** (`wakeFanoutJoin` emits only
> `fact.run_resumed`; the driver's one edge-selection site fabricates
> `fact.node_completed`), so no edge selection leaks into `wake-pending`. It changes
> nothing already authored.

## The problem

The operator loop we drive by hand is orchestration, not compute:

```
work → review → (fix = work, seeded with the review) → review (with the prior report) → ship when converged
```

The Sept 15–16 dogfood batch ran ~20 review rounds and ~15 fix runs across seven
branches. Each round was a manual sequence: answer the review signoff gate, prune
the worktree, check the branch out in `cwd`, enqueue a `work` run with the review
pasted into the task, poll until the worktree provisions, switch back, `accept`,
commit, enqueue `review` against the branch. Every step is a `fragua run` from a
shell with a human or an agent standing in as the scheduler.

fragua already runs each of `work` / `review` / `fix` as a first-class workflow.
What it cannot express is **the loop that sequences them** — the routing on the
review verdict, the seeding of `fix` with the prior report, the worktree carried
from one round to the next, and the single human signoff at the top. Today that
control flow lives in a person's head and a shell. This proposal makes it one
fragua workflow, `converge.yaml`, with the review signoff a top-level HITL.

The single decision this settles: **how a child workflow runs as a step.**

## The design

### Decision: one mechanism — a child run

A `type: workflow` step runs its child as a **full child run** of the named
workflow, over the Model M spawn/park/collect path at N=1. There is no second
mode. **Inline parse-time expansion is not built** (rejected below).

This is defensible against **two** SPEC §5 exclusions, both quoted in full. The
manager-loop bullet:

> **A manager-loop / supervisor-stack primitive.** Composition lives at the
> workflow level via separate runs sharing artifacts.

and — the more directly applicable text, since this feature *is* a cross-run graph
join — the fan-in bullet:

> Fan-*in* across runs is likewise out of scope: composition across runs stays
> artifact-sharing, not a graph join.

Both are **superseded** for the child-run path by the ratified Model M reversal
(**A9, 2026-05-29**) and its B5 resolution ([fan-out-runs.md](fan-out-runs.md) § B5),
which established that cross-run composition over `parent_run_id` lineage — spawn N
tagged children, park the parent, join by reading their typed outputs cross-run — is
legitimate composition, **not** the embedded sub-run leak §2.2 rejected (that leak
was *embedding*: descendant SSE, recursive rollup, branch tabs). `type: workflow` is
exactly that primitive at N=1 with a by-name child instead of a parameter sweep —
strictly simpler. The override is not implicit: **§5's fan-in and manager-loop
bullets must be updated on ship** to carve out the ratified cross-run join (both
`fan-out-runs.md`'s fan and this N=1 single child), the way §3.1.1 already had to be
reconciled with the A9 reversal.

A `type: workflow` step *is* "separate runs sharing artifacts," declared instead of
hand-driven. It adds no runtime supervisor: the child is an ordinary independent run
(its own `run_state`, log, worktree, budget); the parent does not drive it
imperatively — it enqueues one intent, parks as a pure fold, and wakes when the
level-triggered join sweep observes the child terminal.

The recovery-granularity axis ([concurrency.md](concurrency.md)) already names
this the `run:` model: a full child run of a named workflow, one state/log/OCC per
child, isolated per-child worktree, join by typed outputs read cross-run. The
axis line — *"there is deliberately no third off-log model"* — is why the inline
splice is not built: it would be exactly that third substrate, a write-class
sequential graph rewrite that is neither the on-log frontier (`parallel` branches
are read-class `llm`-only, E041/E042) nor a child run.

### Authoring surface — a distinct node kind, not `map:` at N=1

fan-out-runs.md ratified an authoring surface for Model M. Quoted exactly:

> **Authoring surface (shared with A, decided 2026-05-29):** M reuses the
> `type: parallel` node — `map: { over, as, run: <workflow> }` (the `run:` keyword
> is the M discriminator vs A's `branch:`), with the sink declared by the node's
> ordinary `next:` (no new `join:` key).

So the question is real: does `type: workflow` fork one ratified surface into two by
cardinality? **It does not — the two surfaces are a coherent, non-redundant split by
*shape*, not by N.** `map:` is a **parameter-sweep fan**: it takes `over` (the swept
collection) and `as` (the per-child binding name), materialises N children of one
workflow from that sweep, and joins them with the aggregate read
`${{ children[*].outputs.f }}`. Every one of those keys is meaningless for a single
named child: there is no collection to sweep, no `as` binding, and the join is a
scalar `${{ outputs.<step>.f }}` read, not an aggregate. Forcing the single child
through `map:` would mean a degenerate one-element `over` and an unused `as` — and,
decisively, it has **no place to hang the two keys `type: workflow` exists for**: the
`inputs:` bind map (a named child binds specific parent values, not a sweep row) and
`base:` worktree lineage (the sequential tip hand-off `map:`'s parallel, read-class
fan explicitly forbids). A fan's children run concurrently and read-only; a
`type: workflow` step's child is a single sequential writer that hands its tree to the
next step. These are different execution shapes that happen to share the *spine*
(spawn/park/collect, `parent_run_id`, `wakeFanoutJoin`), not the *surface*.

The split is therefore: **`type: parallel` + `map:` = the fan** (N over a sweep,
concurrent, read-class join by `${{ children[*].outputs.f }}`); **`type: workflow` =
the single sequential child** (one, `inputs:` bind map, `base:` lineage, scalar join
by `${{ outputs.<step>.f }}`). fan-out-runs.md's surface section is updated to name
this split (the N=1 single-child sequential case is `type: workflow`, not a
one-element `map:`), so the two docs describe one spine with two authoring surfaces,
not two claimants to one surface.

### What this proposal builds — the Model M spine, shipped first

The Model M spine does not exist yet. Grep finds **zero** matches for
`parent_run_id`, `wakeFanoutJoin`, or `fanout_pending` in
`packages/`; `--base` / `refs/fragua/heads`-based provisioning is not in the CLI.
So `type: workflow` cannot "reuse" the spine — it **builds the minimal subset** and
lands it first, at N=1 (the simplest cardinality), and the fan variant
([fan-out-runs.md](fan-out-runs.md)) reuses it later by adding only the parameter
sweep and the aggregate read. The subset this proposal owns:

1. **`parent_run_id` lineage column** — a nullable column on `run_state`,
   denormalized from `intent.run_enqueued.payload.parent_run_id` in the same
   projection transaction, mirroring the shipped `schedule_id` template
   (`store.ts:815`, `:849`; informational, **no `REFERENCES`** by design). It ships
   with the covering index the budget roll-up reads (below). This is a
   `schema_version` migration — a `SCHEMA_MIGRATIONS` entry plus the `schema.sql`
   column/index. (The paired `parentRunId` field on `RunEnqueuedPayload` is a
   *contract*-version concern — it is reducer-referenced and lives in `SURFACE_DECLS`,
   so it changes the surface hash; it folds into the `EVENT_CONTRACT_VERSION` bump
   already forced by the pause reason, at no additional cost. See the contract-cost
   section.)
2. **The level-triggered join wake (`wakeFanoutJoin`)** — a new sweep in
   `wake-pending.ts` (alongside `resume` / `human_input` / accept-discard). Each
   tick it scans `paused_auto{fanout_pending}` parents and, for each, derives the
   child run id and checks whether **that child is already terminal** — it does not
   wait to be triggered by the child's terminal fact. On finding a terminal child it
   appends **only** the parent's `fact.run_resumed` (S1 — the join proper is
   fabricated by the driver's ordinary re-dispatch, not here; see "No edge selection
   in `wake-pending`" below). Level-triggering is load-bearing: the child enqueue and
   the parent's park fact commit on *different* OCC lanes, so a child that reaches
   terminal *before* the park fact lands would be a lost wakeup under any
   edge-triggered (fact-driven) design — the parent would hang forever. Scanning for
   a terminal child on every tick closes that race by construction.
3. **The child-lifetime GC guard — a parent-lineage predicate on
   `getGcEligibleSnapshotRuns`, not a daemon-GC hook.** Ref reclamation is
   **operator-invoked**: `fragua gc --snapshots` (`cli/src/commands/gc.ts`) walks
   `getGcEligibleSnapshotRuns` (`store/src/store.ts:964`) and `git update-ref -d`s the
   eligible refs. The automatic daemon blob GC (`blob-gc.ts`) is **blob-CAS only and
   never touches refs**, so the guard cannot live there — it is a new **parent-lineage
   predicate on `getGcEligibleSnapshotRuns`** (`@fragua/store`, run-state-queries)
   honored by the CLI command (`@fragua/cli`, `commands/gc`). A child snapshot run
   whose `parent_run_id` names a parent that has **not** yet recorded a **durable
   terminal adoption-or-discard fact** is held: its `refs/fragua/{snapshots,heads}/<child>`
   are not yet reclaimable. The release keys on a **durable log fact**, not the live
   `refs/fragua/heads/<parent>` ref — on parent terminal the daemon records whether it
   adopted the tip as a durable marker on the parent's terminal fact, and `discard`
   records its own durable fact; either releases the guard. Keying on the live parent
   head instead would let a later `discard` (which *deletes* `heads/<parent>`) strand
   the child refs permanently, since "does `heads/<parent>` reach the tip?" can never
   again be true once the head is gone. (This drops the earlier draft's "(or its rows)"
   conflation — the predicate gates *ref* reclamation only.) **Test:** discarding a
   parent after it adopted its tip reclaims its children's refs on the next
   `fragua gc --snapshots`. This is the residual `fan-out-runs.md` names;
   `type: workflow` builds it.
4. **The single-level descendant cost roll-up** — a read-time
   `SUM(total_cost_usd) WHERE parent_run_id = ?` over the covering index shipped in
   (1). Because v1 **forbids nested `type: workflow` steps** (E049 — a child graph may
   not itself contain a `type: workflow` node), a parent's descendants are exactly its
   direct children: there is no grandchild to undercount, so the single-level `SUM` is
   exact — no `WITH RECURSIVE` walk. It is both the reporting aggregate and the value
   the driver's budget gate reads (below). (When the nesting Door opens this lifts to
   the `WITH RECURSIVE` walk the fan variant will also want; v1 does not pay for it.)

The spawn/park/collect *control flow* lives in the driver (`runOne`) and
`wake-pending`, never the pure core (I12) — mirroring `fan-out-runs.md`'s
"executor-orchestrated, ground rule 9 holds."

### Contract and schema cost — an honest accounting

The parking reason is a **new pause reason**, not a free diagnostic label. The
literal is **`fanout_pending`** — the exact reason the ratified
[fan-out-runs.md](fan-out-runs.md) already names for parking a parent on child
progress. The two docs share one spine, so they must share one literal; adopting
`fanout_pending` here (rather than minting a distinct `child_pending`) is what keeps
the "fan variant reuses this spine" claim true. Parking the parent on a child's
*terminal*, checked at each tick (not an `auto_resume_at` timer, not the child's
terminal *fact*), requires:

- `fanout_pending` added to the closed `PAUSE_REASONS` tuple
  (`types/events.ts:273`), with its classifier mapping — the pause-mapping test
  asserts the reducer's classified key set equals the tuple exactly, so the literal
  must be classified or the gate fails.
- A `Record<PauseReason, ReasonRenderer>` UI branch for it.
- **Membership in `AUTO_WAKE_PAUSE_REASONS`** (`types/events.ts:294`) so it projects
  to `paused_auto` rather than operator-blocking `paused`. That set is pinned in
  `store/test/contract-version.test.ts` `SURFACE_DECLS`, so adding a member
  **changes the surface hash**. Per ARCH §1.11, a prior-version daemon that folds
  this fact without the new membership projects it to `paused` (a *different*
  `run_state` than `paused_auto`) — so this **forces an `EVENT_CONTRACT_VERSION`
  bump**.
- The `parentRunId` field added to `RunEnqueuedPayload` (spine item 1). It is
  reducer-referenced (the projection reads it to denormalize the lineage column) and
  lives in `SURFACE_DECLS`, so it **also** changes the surface hash. It rides the
  same bump the pause reason forces, at no additional cost.

**Cite-and-override — SPEC §3.4.** As written, §3.4 defines `paused_auto` as "daemon
owes a clock tick": every listed reason carries a `resumeAt` and the sweeper wakes
"once `now >= resumeAt`." `fanout_pending` is the first **event-driven** member — no
`resumeAt`, woken by a level-triggered scan for a terminal child, not by a clock.
So §3.4's definition must be **explicitly broadened** from "owes a clock tick" to
"owes a daemon-side wake — either a clock tick (timer reasons) or a level-triggered
re-check (`fanout_pending`)." §3.4's reason table then gains a `fanout_pending` row:
trigger = a `type: workflow` step spawned a child; payload = `parentRunId`,
`childRunId`, `nodeId`, `dispatchSeq` (the child-id counter defined under crash
safety) and **no `resumeAt`**; wake = `wakeFanoutJoin` on the child reaching terminal. This is a doc change on §3.4, not a smuggled member
in a timer-only set.

So the earlier "no `EVENT_CONTRACT_VERSION` bump" claim is **retracted**. The full
cost:

- **`EVENT_CONTRACT_VERSION` bump** — the `fanout_pending` reason plus the
  `parentRunId` payload field, both surface-hash changes above. Emission moves to
  the new version; the reducer keeps folding the full compatible range.
- **`schema_version` migration** — the `parent_run_id` column + its budget-SUM
  index (spine item 1).
- **`ir_version` bump + converter** — the new node kind (`workflow-ir.md` §1).
- **`MIN_COMPATIBLE_CONTRACT_VERSION` stays 1** — the emission bump does not gate
  in-flight lower-version runs; nothing here retires a fold case. (Ground rule 11:
  never raise `MIN_COMPATIBLE` in lockstep.)

### Node shape

```yaml
- id: work
  type: workflow
  workflow: work            # a named workflow, resolved at enqueue like `fragua ci`
  inputs:                   # bind map over the CHILD's declared inputs:
    task: ${{ inputs.task }}
  base: tip                 # optional: provision from the running tree tip
  next: review
```

For a `type: workflow` step the **type-specific keys** are `workflow:` (required)
and `inputs:` (a bind map), plus optional `base:`. The per-child `budget:` key of
an earlier draft is **dropped** (below). General node attributes are **inherited**,
not re-declared here: `next:` / `on:` / `routes:`, and the loop/gate controls
`retry:`, `max-retries:`, `goal_gate:` compose on a `type: workflow` node exactly
as on any other (the worked example loops back to the signoff via a `next:`
back-edge bounded by a run-level `max-loops:` — not a `retry:` goal gate, and not
the signoff's `max-retries:`, because the back-edges are *success* edges whose
counter-bumping is ambiguous between SPEC §3.1 and ARCH §1.2; see "Joining on the
child's terminal" and the worked example for why the review verdict routes the loop
and never maps to a step `fail`).
Stating this explicitly so two implementers don't write incompatible validators —
"type-specific keys" governs only `workflow` / `inputs` / `base`; everything else
is the shared node grammar.

A `type: workflow` step **consumes** upstream values through the ordinary
`${{ inputs.* }}` / `${{ outputs.* }}` tokens and **produces** the child's typed
results as the step's own `outputs:`, addressable downstream as
`${{ outputs.<step-id>.<field> }}`. `outputs:` is not declared on the step — it is
*inherited* from the child workflow's run-level `outputs:` block (see below), the
way a `parallel` step inherits its branches' shape.

`type: workflow` is a write-class node by construction (its child writes), so it
is barred from `parallel` branch closures — E041 already rejects any non-`llm`
node in a closure; a `type: workflow` node is one more.

### Input binding — two clean substitution passes

Binding follows the [`ernesto-interop.md`](ernesto-interop.md) §5.1 rule exactly,
with no namespace leak:

1. **Parent pass.** Before the child is enqueued, the parent resolves the step's
   `inputs:` map over its own scope — `${{ inputs.* }}` (the parent's declared run
   inputs) and `${{ outputs.* }}` (any upstream step outputs) — to concrete
   values. This is the ordinary substitution pass, run in the driver at dispatch.
2. **Child pass.** The resolved values become the child run's typed run inputs
   (`intent.run_enqueued.routing.inputs`). The child then resolves its *own*
   `${{ inputs.X }}` over those values when it executes.

The child never sees the parent's namespace, and the parent never reaches into
the child's. The bind map is validated at parse time against the child's declared
`inputs:` types (E050): every required child input must be bound, no unknown key
may be bound, and each bound value's type must satisfy the child input's type.
Bound values respect the I6/I7 caps — a large bound value spills to blob CAS
through the same `$fragua_blob` path structured inputs already use (`structured-outputs.md`
§3 spill), routing to that path and not the oversize-reject path
(`GENESIS_INPUTS_MAX_BYTES`), so the `routing` payload stays under the 8 KB
tripwire.

### Output binding — the child's run-level `outputs:` are the step's outputs

The child workflow's run-level `outputs:` block (structured-outputs §11) *is* the
step's `outputs:`. **The read mechanism is the read-plane, not the store alone — and
this overrides fan-out-runs.md's stated read call.** fan-out-runs.md ratifies the
cross-run join read as, quoted exactly:

> **Join:** a normal `llm`/`tool` node reads each child's typed outputs cross-run
> (`getOutputsForRun(childRunId)`) and combines

This proposal **overrides that read mechanism**: `getOutputsForRun` returns per-node
`OutputRow[]`, which is ambiguous the moment a child has more than one producer node
and carries none of the run-level shaping (the typed-partial egress, the
`completed`-only gate). The run-level `outputs:` block is a *projection* — produced by
the read-plane's run-level output projection (the `runDetail` path), which takes the
child IR's `attrs.outputs` schema, folds the child's `getLatestOutputBatch` over its
distinct producer nodes, and applies the pure `projectRunOutputs(decls, status,
lookup)` egress contract. (The pure `projectRunOutputs` is *not* a `(childRunId)`
call; the runId-level entry point is the read-plane projection that loads the decls,
status, and output lookup for `childRunId` and calls it.) So the join spine
**touches the read-plane**, not just the store — a heavier dependency than
`getOutputsForRun` implied, stated here honestly. Two docs sharing one spine must
agree on the read: **fan-out-runs.md's join line must be updated to the read-plane
run-level projection**, since a multi-producer child is exactly the ambiguity its
`getOutputsForRun` line does not resolve. (This is a reconciliation of the *read
mechanism*, not a redesign of the spine.)

On the child's terminal, the join invokes the read-plane's run-level output
projection for `childRunId` (which loads the decls/status/lookup and calls the pure
`projectRunOutputs`) and attaches the result to the parent's
`fact.node_completed.payload.outputs` for the `type: workflow` step — the same fact
field, the same `outputs` index
(`idx_outputs_run ON outputs(run_id, node_id)`), and the same `${{ outputs.X.f }}`
resolver every producer uses. The typed-partial contract carries through **only for
a `completed` child**: `projectRunOutputs` returns a result *only* when the child's
status is `completed`, so an absent field of a completed child is absent (not `""`,
not a halt), and a completed child that took a `fail → exit` path reports cleanly.
A child that terminates **non-`completed`** (halted / cancelled) yields **no outputs
envelope at all** — see "Joining on the child's terminal" for how that maps to the
step's outcome and why the parent never reads a non-completed child's outputs on a
success edge.

A parent that reads `${{ outputs.<step>.f }}` for a field the child's run-level
`outputs:` does not declare is a broken reference — E051, the composition-boundary
analog of E035/E046. A child that declares no run-level `outputs:` at all while
the parent binds nothing from it is W019 (the child's result is unobservable —
usually a mistake, but legal for a pure side-effect child).

**Known gap, does not block the worked example.** Run-level outputs project from
`llm` producers only (structured-outputs §10 #3): a `tool`-terminal child cannot
surface typed results yet. `converge.yaml`'s `review` child is `llm`-terminal (it
emits a `verdict`), so this gap does not bite; it lifts when
[`tool-outputs.md`](tool-outputs.md) lands.

### Joining on the child's terminal — status → step outcome

The join **fabricates** the parent's `fact.node_completed` for the `type: workflow`
step **in the driver** (S1 — not in `wake-pending`; see below), so it must run edge
selection, and edge selection needs the step's `Outcome.status ∈ success | fail`. A
child run has ≥3 terminal statuses; every one maps:

| Child terminal status | Step outcome | Outputs envelope |
|---|---|---|
| `completed` | `success` | present (typed-partial) |
| `halted` (errored — budget-stop, `edge_no_match`, handler error) | `fail` | **none** (the projection returns nothing) |
| `cancelled` (aborted — operator `cancel` on the child, or the parent's abort cascade) | `fail` | **none** |
| *never minted* (dispatch-time — see below) | `fail` | **none** |

**The child can fail to mint at dispatch — that path maps too.** The child is
resolved-by-name, saved, and enqueued through the intent plane *at the moment the
`type: workflow` step dispatches*, not at the parent's save. Between the parent's
save and this dispatch the child file can be deleted or renamed (now unresolvable —
E048), edited to nest a `type: workflow` node (E049 no-nesting), edited to add a
`human` node (E053, the dispatch-time re-check), or edited so the parent's frozen bind
map no longer satisfies its `inputs:` (E050) — any of which makes the intent-plane
save reject and **no child run is ever minted**. The driver maps this to the
`type: workflow` step's `outcome=fail` with **no outputs envelope** (there is no
child to read), fabricating `fact.node_completed{outcome:fail}` directly — the parent
never parks in `fanout_pending`, because there is nothing to park on. Edge selection
then runs exactly as for a `halted` child: the author's `on: {fail: …}` handles it,
and its absence halts the parent with `edge_no_match`. The mint-rejection reason
(E048/E049/E050, and E053 for a child edited to add a `human` node after the parent's
save — the dispatch-time re-check) is recorded on the fabricated node_completed for
diagnosis, but the step outcome is uniformly `fail` — the author owns recovery, the
join never invents a fail edge.

There is no `retry` step outcome: `retry` is a non-terminal in-run outcome, and the
join only ever observes a *terminal* child. A child's own internal retries are the
child run's business, invisible to the parent frontier. The step outcome is
`success | fail`, full stop.

**No matching outcome edge → the parent halts.** If the child maps to `fail` and
the parent declares no `on: {fail: …}` edge for the `type: workflow` step, the join
fabricates `fact.node_completed{outcome:fail}` and edge selection finds no edge —
the parent halts with `edge_no_match`, exactly the existing "no implicit fail path"
discipline. The join never invents a fail edge; the author owns recovery.

**The review verdict is a field, not the outcome.** Critically, a `completed`
`review` child maps to `outcome=success` *regardless of its `verdict`* — `verdict:
iterate` and `verdict: ship` are both successful completions that differ only in an
**output field**. The loop is routed by the top-level `human` signoff reading
`${{ outputs.review.verdict }}`, never by mapping `iterate` to a step `fail`. This
is why `converge.yaml` loops with a `next:` back-edge to the signoff bounded by the
signoff's `max-retries:`, **not** a `retry: signoff` goal gate: a goal gate fires
on the *node's own failure*, but the review node succeeds every round; conflating
"verdict is iterate" with "the review step failed" would be wrong. (`retry:` against
a `human` target is therefore neither needed nor used here; the worked example
avoids the question entirely by routing on the human's own `route`.)

**No edge selection in `wake-pending` (S1).** The `fact.node_completed` fabrication
does **not** live in `wakeFanoutJoin`. The join is a two-step handoff on the log:
(1) `wakeFanoutJoin` observes the derived child terminal and appends **only**
`fact.run_resumed`; (2) the parent re-dispatches through the ordinary driver path
(`runOne`), which re-derives the child id, sees it terminal, and fabricates
`fact.node_completed` at the driver's **single, existing** edge-selection site — the
same site the operator-resume path (below) already uses to join a terminal child. So
`wake-pending.ts` loads no parent `Graph` and runs no edge selection; there is exactly
one edge-selection caller, unchanged. This **deletes** the earlier draft's self-flagged
maintenance hazard (two edge-selection sites, a graph load in a module that never
loads graphs) rather than merely mitigating it. The cost is one extra tick between
`run_resumed` and `node_completed`; in exchange a crash between them is recovered by
ordinary re-dispatch (level-triggering + idempotent child-id re-derivation), so the
earlier draft's "resume + join in one `appendFact`" atomicity is an unneeded
optimization, not a correctness requirement.

### Worktree lineage — `base:` and the running tree tip

Each child run gets its own isolated worktree (it writes). The fix→review chain
needs each round to start from the previous round's produced tree, not the
parent's branch HEAD. The mechanism is the in-flight `--base <ref>` provision pin,
surfaced in YAML as a `base:` key with two forms (v1 ships one; the other is
Door'd):

- **`base: tip`** — provision the child from the **running tree tip**: the head ref
  produced by the most recent **tree-producing** `type: workflow` step that
  **completed with `outcome=success`** *on the current execution path*. `tip` is a
  reserved **value of the `base:` key**, not a reserved node id: v1's `base:` accepts
  only the literal `tip` (or nothing), never a step id, so a step happening to be
  named `tip` can never collide with it — no new reserved-id parse rule or code is
  needed. (This corrects the earlier draft, which wrongly claimed E028/E029
  reserve `tip` the way they reserve `exit`/`start`; they do not, and with
  `base: <step-id>` cut there is nothing to reserve.) It resolves to
  `refs/fragua/heads/<that child's run id>`.

  **Runtime resolution is log-derived and replay-safe.** The driver resolves `tip` by
  scanning the parent's fold for the **most recent `fact.node_completed` of a
  tree-producing `type: workflow` step whose `outcome` is `success` and whose
  `childRunId` is populated**, reading that `childRunId`, and pinning
  `refs/fragua/heads/<childRunId>` as the child's provision base. Conditioning on
  `outcome=success` is load-bearing: a tree-producing dominator that *failed* (a
  `halted`/`cancelled` child, or a dispatch-time mint rejection) never produced a
  populated tip, so a `tip` resolver that scanned all dispatches could pin an
  unpopulated ref. Skipping failed/mint-rejected steps means `tip` resolves only to a
  ref that actually exists. The "current execution path" is precisely that folded
  `node_completed` sequence up to this dispatch — a pure function of the log, no
  ambient pointer state — so a replay reconstructs the identical tip. (Because a
  tree-producing `type: workflow` step cannot live in a `parallel` branch — E041 — the
  sequence is linear and "most recent" is unambiguous.)
- **No `base:`** — provision from the **parent run's** base (the parent's
  `baseGitRef` captured at provision) — branch HEAD, the default.

`base: <step-id>` (provision from a *named* prior step's head) is **cut from v1**
and Door'd (below): no worked example needs it, and the earlier draft's own bug
note — `base: work` was the *wrong* base for this loop — argues against shipping it
before a consumer forces its exact semantics. With it gone, **E052 collapses to a
single tip-existence check**: `base: tip` is valid iff at least one tree-producing
`type: workflow` step dominates this step on every path (so the tip is guaranteed
to exist at provision). Because a tree-producing dominator can still *fail* at
runtime and produce no populated tip, E052 is strengthened to **also forbid a
`fail`-edge from a tree-producing step into a `base: tip` target** — otherwise a
dominated `base: tip` step could be reached with the dominator failed and no tip to
pin. Together the two arms guarantee `tip` always resolves to a populated ref at
provision. (Runtime still skips failed/mint-rejected dominators when resolving `tip`,
per the resolution rule above — the static E052 check and the runtime resolver agree.)
**Test:** a mint-rejected tree-producing dominator routed by `on: {fail: …}` into a
`base: tip` step does not reach an unresolvable provision — either E052 rejects the
graph at save, or the fail edge routes away from the `base: tip` step.

**Tree-producing is a *static* graph property, inspectable through the catalog.**
This is decided deliberately, because the naive "read-only by convention" reading is
unenforceable: *every* terminal run snapshots its worktree, so a `review` child that
writes a scratch file still advances *its own* head ref — "it produces no tree" is
not true at the git layer. So the tip pointer is advanced by a **static
classification of the child graph**, not by "did the child physically snapshot":

- A `type: workflow` step is **tree-producing** iff its child workflow's graph
  contains at least one **write-class node** — the exact write-class classification
  E041/E042 already apply to `parallel` branch closures (a `tool` node, or an `llm`
  node with a write/edit/bash tool). This is a **direct, single-level** check — v1
  forbids a child graph from itself containing a `type: workflow` node (E049,
  no-nesting), so there is no nested `type: workflow` step to recurse into. This is
  decidable at save because the catalog (B6 below) hands the validator the child graph.
- A child whose graph is **read-class only** (all `llm`, read-only tools — like
  `review`, which just emits a `verdict`) is **not** tree-producing. It still
  snapshots its own head ref (unavoidable), but the parent's tip pointer **does not
  advance to it** — tip advancement follows the static classification, not the
  snapshot. The review's scratch writes live in its own ref (for its own
  accept/discard/debugging) and never become the next `fix`'s base.
- Consequence, stated plainly: if an author *does* give a `review` child a write
  tool, it becomes statically tree-producing and *will* advance the tip — a
  *declared*, statically-visible choice, not a silent runtime accident. That is the
  price of enforceability, and it is the right side of the trade.

So E052's tip-existence check and the tip-advance logic read the **same** static
property; there is no runtime-vs-static split to disagree about.

The exact ref lineage for the loop, round by round (`tip` written as the ref it
resolves to):

```
round 1:  parent.baseGitRef ─▶ work     produces refs/fragua/heads/<work>   ← tip = T1
          T1 ─▶ review#1  (read-class; verdict, tip stays T1)
round 2:  T1 ─▶ fix#1     produces refs/fragua/heads/<fix#1>                ← tip = T2
          T2 ─▶ review#2  (read-class; re-entered by the back-edge; tip stays T2)
round 3:  T2 ─▶ fix#2     produces refs/fragua/heads/<fix#2>                ← tip = T3
          T3 ─▶ review#3  …
```

The single `review` step is re-entered each round (`review#1`, `review#2`, …); it is
**statically read-class** — all-`llm`, verdict-only, no write tool — so `base: tip`
provisions each iteration from the current tip and the tip pointer never advances to
it (even though each iteration snapshots its own scratch tree). `work` and each `fix`
iteration are statically tree-producing and advance the tip. **The tip accumulates
across rounds** — round-2 `fix` starts from `work`'s tree, round-3 `fix` starts
from round-2 `fix`'s tree — so `accept` ships the *converged* tree, not one
round's edits. Tree lineage is strictly linear because a tree-producing
`type: workflow` step cannot live inside a `parallel` branch (E041), so there is
never more than one live tip.

> This closes the earlier draft's bug, where `fix` declared `base: work` and every
> iteration re-provisioned from `work`'s *original* tree — discarding all prior
> fixes. The running tip is the invariant that makes the loop correct.

### `accept` — the parent adopts the winning child's tree

The operator accepts once, at the top. The parent run's terminal snapshot must
therefore *be* the converged child's tree — the running tip at terminal.

**Which terminals trigger the repoint.** The repoint fires on **any** parent terminal
that has a tip to adopt — `completed`, `halted`, and `cancelled` alike — because
`accept` operates on any terminal run's snapshot, not only a clean `completed` one (an
operator may still want to adopt the partial converged tree of a halted or cancelled
parent). On terminal the daemon sets `refs/fragua/heads/<parent_run_id>` to the
running tip (deterministic: tree production is linear, so the tip is unambiguous), for
whichever of the three terminals landed. The repoint commits **before** the parent's
terminal fact (spine item 3's guard keys on it).

**No-tip fallback.** A parent can terminate before any tree-producing `type: workflow`
step ran — e.g. it halts on `edge_no_match` before `work`, or the graph produces no
tree at all. Then there is no tip: the daemon **skips the repoint**, leaving
`refs/fragua/heads/<parent_run_id>` at the parent's own worktree snapshot (its base,
since `converge.yaml`'s parent writes nothing directly). `fragua runs accept <parent>`
then cherry-picks the empty range `parent.baseGitSha .. heads/<parent_run_id>` — i.e.
it cherry-picks nothing.

When a tip exists, `fragua runs accept <parent>` cherry-picks
`parent.baseGitSha .. heads/<parent_run_id>` onto the operator's HEAD through the
unchanged `applyAccept` — it sees the child's commits with no knowledge that they
came from a child worktree. `discard` deletes the parent's refs as usual; the
child runs' own `refs/fragua/{snapshots,heads}/<child>` become reclaimable on the next
`fragua gc --snapshots` once the parent has recorded its **durable terminal
adoption-or-discard fact** (spine item 3) — the guard keys on that fact, not on the
live `heads/<parent>` ref, so a subsequent `discard` cannot strand them.

**Adoption ordering (crash-safe).** The parent head ref is repointed at the tip
**before** the parent records its durable adoption fact, which is what releases the
GC guard (spine item 3); so the tip commits are always reachable from
`heads/<parent_run_id>` before any child ref becomes reclaimable. The repoint is
idempotent (setting a ref to a value it already holds is a no-op), so a SIGKILL
between the repoint and the durable fact leaves a live tree that the re-run adoption
re-points harmlessly and `accept` still finds — and until the durable fact lands the
guard has not released, so nothing was collected.

v1 constraint, **enforced at save (E054)**: a parent that both writes in its own
worktree **and** adopts a child tree is out of scope — tree lineage flows only through
the `base:` chain of `type: workflow` steps. The shape is statically detectable (a
graph that contains both a direct write-class node — a `tool`, or an `llm` with a
write/edit/bash tool, the E041/E042 classification — **and** a tree-producing
`type: workflow` step has two conflicting tip sources), so it is **rejected at save
with E054** rather than left to undefined runtime tree behavior. `converge.yaml`
delegates all writes to children and never hits it; the mixed shape is Door'd (below)
until a consumer forces its exact merge/rebase semantics.

### HITL — the signoff is a top-level `human` node (layer 1 only)

**v1 ships one HITL shape: the parent authors the signoff.** `converge.yaml` owns a
`type: human` step that reads `${{ outputs.review.verdict }}` and takes the
operator's ship/iterate decision. This needs no propagation machinery: the child
`review` produces a verdict output; the parent's own `human` node surfaces it. This
is the idiomatic shape and satisfies "the review signoff is a top-level HITL" by
construction — the worked example uses only this.

**Child-internal HITL propagation is deferred behind a Door (below), and a child
whose graph contains a `human` node is rejected at save — E053 — and re-checked at
dispatch.** A child that pauses for a human would park in `paused_human` on the
*child's* lane while the parent parks on the *parent's* lane; answering it would
require a cross-lane `respond` reconciliation surface that v1 does not build. Rather
than ship that surface half-built, v1 forbids the shape. **E053 is a direct-child
check**, not a transitive walk: because v1 also forbids nested `type: workflow` steps
(E049 — a child graph may not contain a `type: workflow` node), a child's own graph is
the *entire* call-graph reachable from it, so scanning the direct child for a `human`
node is exactly a full-call-graph scan — there is no deeper level for a `human` to
hide in. E053 fires at save over the resolved catalog (B6) if the child graph contains
a `human` node. **The check is re-run at child enqueue/dispatch**, reusing the
mint-rejection→`outcome=fail` path ("Joining on the child's terminal"): a child edited
to add a `human` node between the parent's save and the step's dispatch is caught when
the intent-plane save rejects the child mint — the step maps to `outcome=fail`, the
parent never parks on a child that would deadlock in `paused_human`. This keeps every
human decision authored at the top level and removes the cross-lane reconciliation
entirely from v1's scope. (This is stricter than the `fragua ci` fail-fast analog:
`ci` fails at *runtime* on `paused_human`; E053 rejects at *validate/save* time and
again at *dispatch*, before a child that would pause ever mints.)

### Budget — child spend counts against the parent

Child spend is the parent's spend. Reporting is the read-time **single-level** roll-up
(spine item 4) — a `SUM(total_cost_usd) WHERE parent_run_id = ?`. Because v1 forbids
nested `type: workflow` steps (E049), a parent's descendants are exactly its direct
children, so the single-level sum is exact — no `WITH RECURSIVE` walk. Gating is
enforced in the driver at the spawn/collect boundary (I12 — effects in the driver,
never the pure core): before enqueuing a child and again at each join, the driver
computes that descendant sum (the parent's own plus its direct children's) and halts
the parent on budget if it exceeds the parent's `budget_usd` ceiling. Each child is
enqueued with the **parent's remaining budget** (the per-step `budget:` key is
dropped — see below), so a runaway child self-limits at its own ceiling before the
parent's boundary check fires. **A child that exhausts that budget must not strand the
parent** — see the `wakeFanoutJoin` classification below for how a `paused{budget}`
child is aborted-then-joined-as-fail rather than parked forever.

The parent ceiling is a **soft cap**: because the gate runs at the boundary and a
child spends between boundaries, total spend can overshoot the ceiling by at most one
actively-spending child's budget before the next boundary check halts the parent. The
bound holds at v1's single level: nesting is forbidden (E049), so the tree is exactly
one parent with one child spending at a time (the parent is parked in `fanout_pending`
while its child runs), and that single live child is the only spender past any
boundary. This bound is acceptable — the same post-hoc-check
discipline the daemon already applies to a run's own budget. (When the nesting Door
opens, the same recursive gate the fan variant needs restores the bound under depth.)

### Event log, SESE, and I11

The parent's log tells the whole orchestration story without embedding the child:

- **Spawn** — `intent.run_enqueued` tagged `parent_run_id`, carrying the resolved
  bind-map inputs and the resolved `base` ref.
- **Park** — `fact.run_paused{reason:fanout_pending}` → `paused_auto` (via the new
  `AUTO_WAKE_PAUSE_REASONS` membership; see the contract-cost section). Payload
  carries `childRunId` / `nodeId` / `dispatchSeq` and **no `resumeAt`**.
- **Resume** — `fact.run_resumed`, appended by `wakeFanoutJoin` **alone** once its
  level-triggered scan observes the derived child terminal (not edge-triggered on
  the child's terminal fact).
- **Join** — `fact.node_completed` for the `type: workflow` step, fabricated by the
  **driver's** re-dispatch (S1) from the child's terminal status ("Joining on the
  child's terminal"), with a `completed` child's outputs read via the read-plane's
  run-level output projection.

Resume and join are **separate commits on the parent lane** (S1 routes the join
through the driver, not `wake-pending`), so they are no longer a single `appendFact`.
This is safe by level-triggering, not atomicity: a SIGKILL after `fact.run_resumed`
but before `fact.node_completed` leaves the parent resumed with the `type: workflow`
node still pending — the driver simply re-dispatches, re-derives the *same* terminal
child id, and fabricates `node_completed`. No half-joined strand is possible because
the child id is idempotent and the child stays terminal.

The child's log is an independent, opaque top-level run — navigable like a
schedule run, never embedded. No descendant SSE, no branch tabs, no recursive cost
rollup (aggregate cost is the read-time single-level `SUM`). This is the fan-out-runs.md B5
result unchanged. (A new opaque `type: workflow` step still renders as a node in
the parent's step list in the Web UI — a small non-core rendering surface, noted
for scoping.)

I11 holds. Each `type: workflow` step is single-entry / single-exit: dispatch
spawns exactly one child, and the join is the single exit taken once the level-triggered
sweep observes that child terminal — so it composes like any node, and the parent's scalar `run_state.status`
stays the sole lifecycle authority. Loops, goal-gates, and budget dominance stay
run-scoped on the parent, exactly as I11's dominance argument requires; the child's
own loops/gates/budget are the child run's business, invisible to the parent's
frontier.

### The parent lifecycle against the real `wake-pending.ts` sweeps

A `fanout_pending` parent is a non-dispatching run, so its whole lifecycle is
driven by the `wake-pending.ts` sweeps — the same file that runs `wakeCancel` /
`wakeHuman` / `wakeResume` / `wakeAutoResume` / `wakeUnquarantine` today. Each sweep
must be specified against a `fanout_pending` parent, or the parent hangs or
double-spawns:

- **`wakeFanoutJoin` is level-triggered, and it classifies *every* non-terminal child
  class — no routine pause may strand the parent.** Each tick it scans
  `paused_auto{fanout_pending}` parents, derives the child id from the park fact's
  `(childRunId)` (equivalently `(parent_run_id, node_id, dispatchSeq)`), and reads the
  child's `run_state.status`. It does **not** wait for the child's terminal fact to
  trigger it (this closes the lost-wakeup race: a child that terminates before the
  park fact commits is observed on the next tick). The full status classification:

  | Child status class | Members | `wakeFanoutJoin` behavior |
  |---|---|---|
  | terminal | `completed`, `halted`, `cancelled` | emit **only** `fact.run_resumed`; the driver's re-dispatch joins (S1). |
  | auto-waking pause | `paused_auto` (`provider_retry`, `handler_retry`, `timeout_retry`) | leave parked — the child self-heals to a terminal on its own backoff clock; a later tick joins. Not a strand: the child is making progress without an operator. |
  | routine operator-blocking pause | `paused{budget}`, `paused{provider_error}`, `paused{provider_exhausted}`, `paused{operator}`, `paused{payment_required}` | **the parent is not stranded**: `wakeFanoutJoin` aborts the child (item 7's `fact.run_terminated{aborted}` committed directly for a paused child) → the child reaches `cancelled` (terminal) → the next tick joins the step as `outcome=fail`. The operator recovers on the parent's `on: {fail: …}` edge (which may route to a `human` node — e.g. "raise budget and retry"), never by hunting the descendant. |
  | quarantined | `quarantined` | a *genuine* unresolved fault (not routine): leave parked pending an operator decision **on the child** — `unquarantine` → resume → terminal → join; `cancel` → `cancelled` → join-as-fail. This is the one class where the child is the correct locus of the decision, so escaping via the descendant is right, not a hang. |
  | `paused_human` | — | **cannot occur**: E053 is re-checked at child enqueue/dispatch (below), so a child whose graph contains a `human` node is mint-rejected → `outcome=fail` before it can park in `paused_human`. |

  The aggressive auto-abort of a routine operator-blocking child (rather than leaving
  it resumable in place) is the v1 simplicity trade — it forecloses topping up a
  rate-limited or budget-exhausted child and re-running it, at the gain of never
  stranding the parent. Richer per-fault child-pause propagation (surface the pause on
  the parent, let the operator resume the child in place) is named as a Door.
  **Test (A2):** a child that pauses on `budget` does not leave the parent in
  `fanout_pending` indefinitely — the child is aborted and the parent reaches its
  `on: {fail}` edge.
- **E053 is re-checked at child enqueue/dispatch (A3).** The child is resolved,
  saved, and enqueued at the moment the `type: workflow` step dispatches. A child
  edited to add a `human` node between the parent's save and this dispatch is caught
  by re-running the direct-child E053 check at the intent-plane save of the child mint
  — the save rejects, and the driver maps that mint rejection to the step's
  `outcome=fail` through the same mint-rejection path E048/E050 use ("Joining on the
  child's terminal"). So a drifted `human` node deadlocks nothing; it fails the step
  cleanly at dispatch. **Test (A3):** a child edited to add a `human` node between
  parent save and dispatch is mint-rejected → `outcome=fail`, not stranded in
  `paused_human`.
- **Operator resume of a parked parent (`wakeResume`) must not double-spawn and must
  not spin.** `paused_auto` is swept by `wakeResume` on a pending `intent.resume`
  with no timer filter, so an operator can resume a `fanout_pending` parent directly.
  When the parent re-dispatches the already-spawned `type: workflow` node, the driver
  **re-derives the child id and joins-or-re-parks**: if the derived child is already
  terminal, it joins immediately (fabricates `fact.node_completed`); if the child is
  still live, `buildEnqueueChild` no-ops on the existing id (spawn idempotency,
  above) and the parent re-parks in `fanout_pending`. It is **never** a duplicate
  spawn.

  **The re-park must `advanceAppliedTo` past the consumed `intent.resume`, or
  `wakeResume` re-fires every tick.** `wakeResume` deliberately does *not* advance
  applied itself — it relies on the *subsequent dispatch's* commit to consume the
  resume intent (the module warns about exactly this resume→repause loop). For the
  still-live-child case the "subsequent dispatch" is the **re-park**: the driver's
  `fact.run_paused{fanout_pending}` commit must carry `advanceAppliedTo` past the
  resume intent's seq. If it does, the resume is consumed once and the parent sits in
  `fanout_pending` until `wakeFanoutJoin` observes the child terminal — no re-fire. If
  it did not, `wakeResume` would re-emit `run_resumed` → re-dispatch → re-park every
  tick, the exact spin the module warns of. **Test:** resuming a parent whose child is
  still live emits `run_resumed` + `run_paused{fanout_pending}` **exactly once** and
  the parent stays parked with no further wake activity across subsequent ticks (the
  `wakeResume` no-double-fire assertion, extended to the re-park path).
- **`wakeAutoResume` correctly ignores `fanout_pending`.** Its candidate query
  filters `autoResumeBefore` against `routing.internal.auto_resume_at`, which a
  `fanout_pending` park never writes (no `resumeAt`), so the timer sweep skips it —
  the event-driven reason is not spuriously woken by the clock.

### Crash safety across spawn / park / join / accept

The spine `type: workflow` owns is a cross-run handshake landed across two separate
transactions on separate rows, so it must survive a SIGKILL at every seam. Three
concrete guarantees:

- **Spawn idempotency (I11) — and its collision with the intent-plane invariant.**
  The child enqueue (`intent.run_enqueued`, always-appendable — not OCC-checked, per
  I3) and the parent's park fact land in *separate transactions on separate rows* — a
  SIGKILL after the enqueue commits but before the park fact commits leaves the parent
  folded "running," and naive re-dispatch would mint a *second* child. The fix rests
  on a **caller-derived child id** — derived deterministically from
  `(parent_run_id, node_id, dispatchSeq)`, not `newRunId()` — plus an idempotent
  enqueue that no-ops when that id already exists.

  **`dispatchSeq` is a distinct child-id counter — NOT `fact.node_completed.iteration`
  (ARCH §1.2's per-node retry counter).** It is defined as
  **`count(prior fact.node_completed for this node_id in the parent fold)`** — the
  number of times this `node_id` has *already completed* in the parent run's event
  fold — with **no "+ in-flight park" addend.** Two reasons it cannot reuse
  `iteration`: (1) ARCH §1.2's `iteration` is the *retry* counter, not bumped on a
  *success* redo, and the worked example loops over *success* back-edges — so keying
  the child id on `iteration` would collide every `review` dispatch at `iteration=0`
  and mint one child for the whole loop; (2) `iteration` already keys the
  `outputs`/`artifacts` PKs and `fact.node_completed.iteration`, so aliasing it would
  entangle unrelated scopes. `dispatchSeq` instead advances by one on each *completed*
  re-entry (round 1's `review` completes → round 2's `review` sees count 1), giving
  distinct child ids across loop rounds, and is a pure function of the log (no ambient
  state, replay-safe). **Dropping the "+ in-flight park" addend is what makes operator
  resume idempotent:** a live-child re-dispatch counts the *same* prior completions (the
  child has not completed, so no `fact.node_completed` was added), re-derives the
  *identical* `dispatchSeq` and thus the identical child id, and `buildEnqueueChild`
  no-ops. Had the count included the in-flight park, a re-dispatch would read count+1,
  derive a *different* id, and double-spawn. **Test:** resuming a live-child parent
  re-derives the identical child id and `buildEnqueueChild` no-ops (no second child).

  **The concrete derivation** is a name-based **UUIDv5** over a fixed fragua
  namespace UUID over the canonical string `"${parentRunId}/${nodeId}/${dispatchSeq}"`
  — i.e. `childRunId = uuidv5(FRAGUA_CHILD_NS, parentRunId + "/" + nodeId + "/" + dispatchSeq)`.
  It is deterministic (same triple → same id across replay and re-dispatch),
  collision-free within a parent (the triple is unique per completed dispatch), and
  pinned in **one** helper so the driver's callers cannot derive it differently. (The
  exact hash is not a cross-implementation contract — one codebase is self-consistent
  regardless of the scheme — but naming *a* concrete derivation removes the
  implementer ambiguity the earlier draft left.) **This is a genuine conflict with
  a shipped invariant, and closing it is real work, not a footnote.** Two facts
  block the naive version:
  1. `makeIntentPlane`'s enqueue path hard-codes `deps.newRunId()`
     (`intent-plane/plane.ts:318`, commented "always minted — no operator/client
     -supplied ids"): the operator/client surface deliberately refuses a supplied id
     so a client cannot forge or collide a run id.
  2. `run_state.run_id` is a `PRIMARY KEY` — a second insert of the same id
     **throws**, it does not silently no-op. So even a supplied id doesn't give
     idempotency for free.
  The resolution is a **new, driver-only spawn surface** on the intent plane —
  `buildEnqueueChild` / `commitEnqueueChild` — distinct from the operator enqueue:
  it **accepts a caller-derived id**, and it **existence-checks `run_state` for that
  id inside the same write transaction and no-ops (returns the existing run)** when
  present, rather than colliding on the primary key. It coexists with the invariant
  because the invariant governs the *operator/client* path (untrusted, ids always
  minted); the child-spawn path is *driver-internal* (I12 — effects in the driver),
  never reachable from the server's client surface, and derives its id from data the
  driver already holds. The "no supplied ids" rule is thus scoped to its actual
  threat (client-forged ids), not broadened to the trusted spawn path. Ordering: the
  child enqueue commits **first** (the child's row); the park fact commits **second**
  (the parent's row); on crash between the two, re-dispatch re-derives the child id,
  `buildEnqueueChild` sees the child already present and no-ops, and the park fact
  lands — converging to exactly one child. If a supplied-id spawn surface is judged
  too large for v1, the crash-safe alternative is a `UNIQUE(parent_run_id, node_id,
  dispatchSeq)` partial index over `run_state` plus a pre-enqueue
  `SELECT … WHERE parent_run_id = ? AND …` guard that dedups without any supplied id
  — but that needs `node_id` / `dispatchSeq` denormalized onto `run_state`, a wider
  schema change than the single derived-id surface, so the derived-id surface is the
  chosen path and the index is the named fallback.
- **Abort / halt cascade — from *every* path that terminates a parked parent, not
  just `runOne`.** `cancel <parent>` writes `fact.run_terminated{aborted}`; a live
  child tagged with that `parent_run_id` must not keep spending against a dead
  parent. The critical subtlety: the *primary* cancel target is a parent **parked in
  `paused_auto{fanout_pending}`**, and a parked parent is not dispatching — it is
  terminated by **`wakeCancel`** in `wake-pending.ts`, which today emits
  `fact.run_terminated{aborted}` with **zero child-abort logic**. So the cascade
  cannot live only in the `runOne` driver; it must fire from `wakeCancel` and from
  every wake-pending path that can terminate a `fanout_pending` parent. Concretely,
  each such termination site aborts every **live child** with `parent_run_id = <parent>`
  (found on the same `parent_run_id` index the roll-up reads) before/as it appends the
  parent's terminal fact. "Live child" = any child whose `run_state.status` is **not
  terminal** (not in `{completed, halted, cancelled}`) — `queued`, `running`, every
  `paused_*`, and `quarantined`. **The abort event type depends on the child's
  status**, because only a *dispatching* child has a running fiber to interrupt:
  - a **`running`** child — `intent.cancel` (its executor fiber is holding the
    `AbortSignal`; the intent trips it, and the child's own driver folds it to
    `fact.run_terminated{aborted}`).
  - a **`queued` / `paused_*` / `quarantined`** child — there is no dispatcher fiber to
    fold an intent, so the sweep commits **`fact.run_terminated{aborted}` directly** in
    its own transaction on the child's row (the same shape `wakeCancel` uses to
    terminate a non-dispatching run).

  `wakeFanoutJoin` firing against an **already-terminal** parent is a no-op — it finds
  the parent terminal, appends nothing, resurrects nothing, and leaves no stray pending
  wake.

  **A child that outlives its cascade is caught by a reconciliation sweep, not by
  GC.** A SIGKILL between the parent's terminal-fact commit and the child abort (an
  `intent.cancel` for a `running` child, or a directly-committed
  `fact.run_terminated{aborted}` for a non-dispatching one) — and the edge race the
  cascade admits — leaves a **live** orphan with no pending cancel or committed
  terminal. The earlier draft's "reclaimed by the GC guard" was wrong:
  **GC does not stop a running child** — it only reclaims refs/rows, and a live child
  keeps spending against a dead parent. The correct mechanism is a dedicated sweep,
  **`wakeOrphanedChildren`**, run on daemon startup and on every wake-pending tick: it
  scans for any **non-terminal** child (`queued`/`running`/any `paused_*`/`quarantined`)
  whose `parent_run_id` names a **terminal** parent (over the same `parent_run_id`
  index the roll-up reads) and aborts it by the **same per-status rule** as the in-line
  cascade (`intent.cancel` for a `running` child; `fact.run_terminated{aborted}`
  committed directly for a `queued`/`paused_*`/`quarantined` child). Ordering vs
  `wakeCancel`: they never fight — `wakeOrphanedChildren` only *adds* a missing abort
  (it repoints no refs and touches no parent), and a child already carrying a pending
  cancel or a committed terminal from the in-line cascade needs none. So every path
  that terminates a parent aborts its live children promptly via the in-line cascade,
  and the crash window where that cascade never ran is the sweep's backstop. Once the
  orphan reaches its own terminal, its refs fall to ordinary GC once the parent's
  durable adoption-or-discard fact has landed (so the guard has released).
- **`accept` adoption ordering** — specified above: repoint before the durable
  adoption fact, idempotent repoint, GC guard holds child refs until the parent has
  recorded that durable terminal adoption-or-discard fact.

### Identity, IR, and recursion

`type: workflow` is one literal added to the parser's `KNOWN_TYPES` and the IR
graph types — an `ir_version` bump with a converter ([`workflow-ir.md`](workflow-ir.md) §1).

The child is referenced **by name**. Resolving that name is **not** a core-local
operation: `resolveWorkflow` (`cli/src/workflow-path.ts`) is a CLI/`node:fs`
cascade that `@fragua/core` cannot import, and the core validator
(`engine/validator.ts`) inspects a *single* parsed `Graph` with no by-name catalog
of other workflows. So E048 (unresolvable child), E049 (no-nesting — a child graph
contains a `type: workflow` node), E050 (input-bind mismatch), E051 (output ref), and
E053 (direct child graph contains a `human` node) **cannot be raised by the pure graph
validator** — they all require a **workflow catalog**.
This proposal adds that surface; the "one literal + a converter" framing of the node
kind is honest only about the *IR* change, not the *validator* change, which is
larger.

**The catalog surface, concretely.**

- **Type.** `WorkflowCatalog = ReadonlyMap<string, Graph>` — a resolved workflow
  *name* to its already-parsed `Graph` (the same `Graph` the core validator
  consumes). No `node:fs` inside it; it is a plain in-memory map the *caller*
  populates.
- **Where it is constructed.** By the two callers that have filesystem reach and are
  the enum-consumer/validate authorities: (1) the CLI `validate` / `run` path, which
  already runs `resolveWorkflow` and resolves each named direct child into the map
  (no transitive descent — E049 forbids a child from nesting a `type: workflow` step);
  (2) the **intent-plane save** (`buildSaveWorkflow`, SPEC §2 Planes),
  which is where a run mints and therefore the enforcement point — it resolves the
  parent's `type: workflow` targets into a catalog before validating. v1 forbids
  nesting (E049 — a resolved child graph may not itself contain a `type: workflow`
  node), so the catalog only ever needs the parent's **direct** children; there is no
  transitive resolution. The core validator never resolves; it only *reads* a catalog
  handed to it.
- **Signature.** The core validator gains an optional catalog parameter —
  `validateGraph(graph, { catalog?: WorkflowCatalog })`. Absent a catalog (a
  bare-graph lint with no resolution context), the catalog-dependent codes
  (E048–E054) are **not** raised — they are raised only where a
  catalog is supplied (CLI validate/run, intent-plane save), which is exactly where
  a run can actually mint. The one single-graph code, E047, fires with or without a
  catalog.
- **When each fires.** E047 (missing `workflow:`) is single-graph, purely syntactic,
  parse/validate-time. Every other code is **catalog-dependent** — E052 (`base: tip`
  with no tree-producing dominator) and E054 (mixed direct-write + tree-producing
  step) both read the *tree-producing* classification, which needs each child's graph
  from the catalog, so they are catalog-dependent too (an earlier draft mislabelled
  E052 single-graph). E048 (name not in catalog), E049 (a resolved child graph itself
  contains a `type: workflow` node — the no-nesting rule), E050 (bind map vs child
  `inputs:`), E051 (output ref vs child run-level `outputs:`), E052, E053 (direct child
  graph contains a `human` node), and E054 all fire at CLI validate and at intent-plane
  save, over the resolved catalog. E053 is **additionally re-checked at child
  enqueue/dispatch** (a child edited to add a `human` node after the parent's save is
  mint-rejected → `outcome=fail`; see "The parent lifecycle" above).

**E051 validates over the resolved catalog — nothing extra is stored in the parent
IR.** An earlier draft snapshotted the child's run-level `outputs:` type block into
the parent IR (tagged with the child's `workflow_sha`) to keep E051 "stable." That is
**cut.** E051 fires over the *resolved catalog* at exactly the two points a catalog
exists — CLI validate and intent-plane save (see the catalog surface above) — just
like E048 (name resolution) and E050 (bind-map type check). The catalog is present
precisely when the check runs, so there is nothing to pre-store: the parent IR carries
**no** child-output snapshot. The runtime read is fail-closed (an unpopulated
`${{ outputs.<step>.f }}` is a node failure, never a silent `""`), so there is no
silent corruption a snapshot would guard against. And accepting save→enqueue drift
here is the *same* stance E049/E053 already take: a child edited between save and
enqueue (to remove field `f`, to add a `human` node, or to nest a `type: workflow`
node) is not re-checked at the parent's save, but a runtime read of the missing `f`
fails closed, and the child's own mint re-runs its validation against the then-current
source. Snapshotting would in fact **contradict** that accepted-drift posture; cutting
it keeps them consistent. The child's *source* is still pinned as
its own `workflow_sha` on the child run (the parent's `sha` does not cover the child's
bytes, matching Ernesto's §9.4 file-based, security-gated resolution) — that pin
stays; only the redundant parent-IR *output-schema* snapshot is removed.

**Recursion — E049 — collapses to the no-nesting rule.** v1 forbids a `type: workflow`
step whose resolved child graph itself contains a `type: workflow` node. Because a
child can never nest another `type: workflow` step, a cycle (self-reference or a longer
loop across the catalog) is *structurally impossible* — the no-nesting rule subsumes
the whole recursion check, so E049 needs no cycle walk, just a direct one-level scan of
each resolved child graph. It is rejected by the intent-plane save before the run
mints. One plainly-stated behavior: **the check runs at save, over the catalog as it
resolves at save.** The child is re-resolved by name at enqueue, and a child edited
between save and enqueue to introduce a nested `type: workflow` node is not re-checked
at the parent's save-time — but that edited child mints through the same intent-plane
save, which re-runs E049 against the then-current source and rejects it. So a nested
(and therefore any recursive) shape can never actually execute; the only gap is that
the rejection may surface at the child's mint rather than the parent's. This is
low-severity and self-consistent, not a hole. (The general nested-composition Door
reopens multi-level `type: workflow`, at which point E049 grows back into the full
catalog cycle walk the fan variant also needs.)

### Validator codes

Next free after E046 / W018:

| Code | What it means |
|---|---|
| E047 | A `type: workflow` step has no `workflow:` target. |
| E048 | A `type: workflow` step's `workflow:` names a child that can't be resolved in the workflow catalog (a new surface reachable from the validate/save path — not the pure graph validator). |
| E049 | Nested composition — a `type: workflow` step whose resolved child graph itself contains a `type: workflow` node. v1 forbids nesting (Door'd), which structurally subsumes the recursion/cycle check (a child that can't nest can't recurse); no cycle walk is needed, just a one-level scan of each resolved child graph. |
| E050 | The step's `inputs:` bind map doesn't satisfy the child's declared `inputs:` — a required child input is unbound, an unknown key is bound, or a bound value's type mismatches. |
| E051 | A `${{ outputs.<step>.f }}` reference reads a field the child's run-level `outputs:` doesn't declare (composition-boundary analog of E035/E046). |
| E052 | `base: tip` has no tree-producing `type: workflow` step dominating this step on every path — the tip isn't guaranteed to exist. (Collapsed to the tip-existence check only; `base: <step-id>` is cut from v1, so its named-step / dominance arms are gone.) |
| E053 | A `type: workflow` step's **direct** child graph contains a `human` node — checked over the catalog. Direct-child, not transitive: E049's no-nesting rule means the direct child is the entire reachable call-graph, so a one-level scan is a full scan. **Re-checked at child enqueue/dispatch** (a `human` node added after the parent's save is mint-rejected → `outcome=fail`). Child-internal HITL propagation is deferred (v1 authors the signoff in the parent). |
| E054 | A workflow contains **both** a direct write-class node (a `tool`, or an `llm` with a write/edit/bash tool — the E041/E042 classification) **and** a tree-producing `type: workflow` step — two conflicting worktree-tip sources. Rejected at save; the mixed parent-writes-plus-child-tree-adoption shape is Door'd until a consumer forces its merge/rebase semantics. |
| W019 | A `type: workflow` step's child declares no run-level `outputs:` and the parent binds nothing from it — the child's result is unobservable. Legal for a pure side-effect child; usually a mistake. |

### Worked example — `converge.yaml`

Assumes in flight and landing: `fragua run --base <ref>`; `work.yaml` gaining a
`review` input. `review.yaml` declares run-level
`outputs: { verdict: choice[ship, iterate], report: string }` and contains **no
`human` node** (E053 would reject its graph as a child).

**One `review` step, re-entered by a back-edge — not two review steps and not a goal
gate.** The loop uses a *single* `review` producer so the signoff always reads the
*current* verdict (`${{ outputs.review.verdict }}` always resolves to the latest
iteration); a design with a separate `rereview` would leave the signoff reading a
stale `outputs.review` on every round ≥ 2. The loop is bounded by a **run-level
`max-loops:` ceiling**, **not** by `review`'s `max-retries:` and **not** a
`retry: signoff` goal gate: the review step *completes successfully* every round (its
verdict is an output field, not its outcome — see "Joining on the child's terminal"),
so a goal gate would never fire, and `retry:` against the `human` signoff is neither
needed nor used.

> **Why `max-loops`, not `max-retries` — and the dependency it sidesteps.** The
> convergence back-edges (`fix → review`, `signoff —iterate→ fix`) are all *success*
> edges. Whether re-entering a node over a *success* back-edge bumps the retry counter
> that `max-retries:` bounds is **ambiguous** between SPEC §3.1 and ARCH §1.2 (the
> counter is unambiguous only on a *failure* redo). Rather than let the worked example
> silently depend on the unresolved reading, it bounds the loop with the run-level
> `max-loops:` ceiling, which counts every dispatch regardless of edge class and is
> therefore unambiguous here. The SPEC/ARCH success-back-edge ambiguity itself should
> be pinned independently; this proposal does not depend on its resolution.

```yaml
max_loops: 12                        # run-level convergence bound (unambiguous over success back-edges)

inputs:
  task: { type: string }

steps:
  - id: work
    type: workflow
    workflow: work
    inputs:
      task: ${{ inputs.task }}
    next: review

  - id: review
    type: workflow
    workflow: review
    base: tip                        # review the running tip (work's tree, then each fix's)
    inputs:
      task: ${{ inputs.task }}
    next: signoff

  - id: signoff                      # the ONE top-level human decision
    type: human
    text: |
      Review verdict: ${{ outputs.review.verdict }}
      ${{ outputs.review.report }}
    routes: [ship, iterate]
    on:
      route:
        ship: exit
        iterate: fix

  - id: fix
    type: workflow
    workflow: work
    base: tip                        # start the fix from the running tip (accumulates)
    inputs:
      task: ${{ inputs.task }}
      review: ${{ outputs.review.report }}   # seed the fix with the latest review report
    next: review                     # back-edge: re-review the fix (loop bounded by run-level max_loops)
```

The loop runs entirely in one parent run: `work` → `review` → the single
top-level `signoff` → on `iterate`, `fix` (seeded with the latest report,
provisioned from the running tip) → back to `review` (which re-reviews the tip
`fix` just produced) → `signoff` again → … → on `ship`, `exit`. Each child
completion maps to `outcome=success` (the review's `iterate`/`ship` distinction is
the `verdict` *field*, routed by the human at `signoff`); the loop is bounded by the
run-level `max_loops: 12` ceiling (chosen over `review`'s `max-retries:` because the
back-edges are success edges whose counter-bumping is ambiguous). Because every
write-class child bases on `tip`, the tip accumulates: round-2 `fix` starts from `work`'s tree, round-3 `fix` from round-2
`fix`'s tree; the read-class `review` provisions from the tip but never advances it.
The operator answers exactly one HITL per round, at the top level. On `ship`, the
parent reaches `exit`; its terminal head adopts the running tip (the last `fix`, or
`work` if the first review shipped), and `fragua runs accept <parent>` cherry-picks
it. What was ~20 rounds of shell scheduling is one
`fragua run converge.yaml --input task=…`.

## Doors

**What this permits now.** Any hand-driven `run → decide → re-run → converge` loop
becomes a declared workflow. `converge.yaml` is the first; the pattern generalizes
to any "produce, judge, iterate, ship" pipeline where the judge's verdict routes
the loop and a human owns the signoff. Because the child is a full run, its own
loops, gates, budgets, and worktree isolation come for free — the parent composes
whole workflows, not nodes.

**Model M (N > 1) is the same spine, opened wider.** `type: workflow` is Model M at
N=1 with a by-name single child; the fan variant (`map: { over, as, run: W }`,
N children over a parameter sweep, joined by `${{ children[*].outputs.f }}`) is
[`fan-out-runs.md`](fan-out-runs.md). This proposal *builds* the shared spine
(`parent_run_id` column + index, `wakeFanoutJoin`, GC guard, single-level budget SUM,
opaque child) at its simplest cardinality; the fan **reuses** it, adding only the
sweep, the aggregate read, and — with the nesting Door — the `WITH RECURSIVE`
descendant walk.

**Nested `type: workflow` stays closed (E049).** v1 rejects at save any
`type: workflow` step whose resolved child graph itself contains a `type: workflow`
node — no stated consumer nests (`converge.yaml` is depth 1), and forbidding it
collapses five otherwise-recursive mechanisms to single-level checks: the budget
roll-up (`SUM` not `WITH RECURSIVE`), E053 (direct-child not transitive), the
tree-producing classification (direct write-class scan), the recursion check (E049
subsumes cycles), and the abort cascade (one level of children). The door reopens
when a real consumer needs a child that itself composes children; at that point each
of those five checks grows back into the recursive form the fan variant also needs,
and the depth budget-bound is restored by the same recursive gate.

**`base: <step-id>` (provision from a named prior step's head) stays closed.** v1
ships `base: tip` and no-`base:` only; the named-step form is cut (E052 collapses to
the tip-existence check). The door that reopens it is a consumer that needs a child
provisioned from a *specific* prior step's head rather than the running tip — at
which point its dominance and multi-iteration semantics (which iteration's head
under a loop?) get pinned against that real need, rather than guessed now. The
earlier draft's own bug (`base: work` re-provisioned every fix from `work`'s
original tree, discarding prior fixes) is the cautionary case: the named-step form is
easy to author wrong, so it waits for a demand that forces its exact meaning.

**Child-internal HITL propagation stays closed (E053, direct-child).** A child whose
graph contains a `human` node is rejected in v1 (and re-checked at dispatch); because
nesting is forbidden (E049), the direct child is the whole call-graph, so this is a
full check. The door that reopens it is the cross-lane
`respond` reconciliation surface — mirror a child's `paused_human` onto the parent,
route the operator's `intent.human_input` to the child, and reconcile a crash between
the parent's mirror and the child's unblock. That is the in-store analog of
[`hitl-channel.md`](hitl-channel.md)'s cross-boundary resume; deferred until a
consumer needs a child that itself pauses for a human, since the worked example (and
the "signoff at the top" requirement) is fully served by the parent-authored `human`
node.

**Per-child author-set budget ceilings stay closed.** v1 enqueues each child with
the parent's remaining budget; a `budget:` step key that sets a tighter per-child
ceiling is deferred behind a Door. The driver-boundary aggregate gate plus the
per-child default already bound total spend (soft cap, one child's overshoot); an
author-set ceiling is an optimization, not a correctness need.

**Richer child-pause handling stays closed.** v1's `wakeFanoutJoin` aborts a child
that enters a *routine* operator-blocking pause (`budget`, `provider_error`,
`provider_exhausted`) and joins the step as `fail`, so the parent is never stranded
— but this forecloses topping up a rate-limited or budget-exhausted child and resuming
it in place. The door that reopens it is a per-fault propagation surface: mirror the
child's pause onto the parent so the operator can act on the parent, top up, and
resume the child on its own lane. Deferred until a consumer needs an interruptible
resource pause rather than a clean step fail; a `quarantined` child (a *genuine*
fault, not routine) already keeps its wait-for-operator semantics in v1.

**Inline expansion stays closed.** A future need for a genuinely shared worktree
and one event log across composed graphs would want the parse-time splice this
proposal rejects. The door that reopens it is a proven demand for read-class,
side-effect-free graph reuse that the on-log `parallel` frontier can't already
serve — not present today, and named here rather than left ajar.

**Tool-terminal children stay closed until `tool-outputs` lands.** A child whose
last node is a `tool` cannot surface typed run-level outputs (structured-outputs
§10 #3), so it can't return a value to the parent — only a side effect. When
[`tool-outputs.md`](tool-outputs.md) lifts the `llm`-only producer gate, run-level
outputs project from tool producers too and tool-terminal children join like any
other. `converge.yaml` doesn't wait on this (its `review` is `llm`-terminal).

**Parent-and-child both writing the worktree stays closed.** v1 tree lineage flows
only through the `base:` chain of `type: workflow` steps; a parent that also writes
directly in its own worktree and then adopts a child tree has two tips to
reconcile. **Rejected at save in v1 (E054)**, not left as undefined runtime behavior.
Deferred until a consumer needs it; the mechanism would be an explicit merge/rebase
step, not an implicit tip race.

**Cross-store children stay closed.** Both parent and child live in one store, which
is what makes the cross-run outputs read cheap. A child that is a *different
engine's* run is [`ernesto-interop.md`](ernesto-interop.md)'s `kind: fragua`
subprocess — the same shape across an engine boundary, with the fail-fast HITL and
subprocess result envelope that boundary forces.

## Rejected alternatives

- **Inline expansion at parse time.** Splice the child graph into the parent's node
  set under a namespace prefix — one run, one log, one worktree; loops/gates/budgets
  run-scoped; recursion rejected at validate time. **The single decisive killer: the
  motivating loop is write-class, and each round must provision an isolated worktree
  from the prior round's *produced* tree via `base: tip`.** A single shared
  worktree structurally cannot hand a tree off between rounds — there is one working
  tree, so `fix` round 2 cannot start from `fix` round 1's committed tree while the
  parent still holds the working directory; the accumulating-tip lineage the loop
  depends on has no expression in one worktree. That alone sinks inline expansion for
  the loop this proposal exists to encode.

  **The read-class closer (so the door can't be narrowed back open).** One might
  argue inline expansion for *read-class* children only, where a shared worktree is
  fine. It still loses, on the substrate/axis bar: a write-class *sequential* splice
  is neither the on-log `parallel` frontier (branches are read-class `llm`-only,
  E041/E042) nor a child run, so it is the "third off-log model" the
  recovery-granularity axis ([concurrency.md](concurrency.md)) deliberately refuses.
  Admitting inline expansion for read-class children *only* would fork the mechanism
  by node class — the exact split the next rejection ("Both") loses on. So the axis
  bar closes the read-class narrowing that the worktree argument leaves open, and the
  two together shut the door from both sides. Inline expansion's one advantage
  (parent `sha` naturally covers the child) does not outweigh inventing a substrate
  the axis rules out.

- **Both (inline for read-class children, child run for write-class).** A rule —
  read-class deliberation children inline, write-class children as runs — was
  available. Lost to core value #1, simplicity: it doubles the mechanism, forces
  every author and reader to know which substrate a given `type: workflow` step uses,
  and splits the validator, worktree, budget, and HITL stories across two paths. It
  is also the read-class narrowing the inline-expansion closer above already rules
  out on the substrate/axis bar — so "Both" is not a middle path, it is the same
  third substrate admitted for half the node classes. The read-class case it would
  optimize (`review`) is served fine as a child run — a read-only child provisions
  from a `base:` ref, produces no tree, and returns a verdict, at the cost of one
  extra run record. One mechanism, always a child run.

- **A new `paused_child` status.** A distinct lifecycle status for "parked on a
  child" was available. Lost because `paused_auto` already carries an auto-waking
  park with the right lifecycle shape; a `fanout_pending` *reason* reuses it. A new
  *status* is strictly heavier — a schema CHECK, the `RUN_STATUSES` tuple, every
  `?status=` and `WHERE status IN (…)` consumer, the enum-consumer lint sweep — for
  no behavior the reason doesn't carry, and it would risk the `MIN_COMPATIBLE` floor.
  Note this does **not** make the reason free: `fanout_pending` is still a new
  `PAUSE_REASONS` literal whose `AUTO_WAKE_PAUSE_REASONS` membership (plus the
  `parentRunId` payload field) forces an `EVENT_CONTRACT_VERSION` bump (see the
  contract-cost section). Reusing the status avoids the *status*-level cost; it does
  not avoid the *reason*-level contract bump. (The literal is `fanout_pending`, the
  ratified fan-out-runs.md name, so the shared spine stays one reason — not a
  divergent `child_pending`.)

- **A per-child author-set `budget:` step key (v1).** An earlier draft let a
  `type: workflow` step declare a tighter per-child ceiling. Dropped from v1: the
  worked example never sets one, and the parent-remaining-budget default plus the
  driver-boundary aggregate gate already bound total spend (soft cap, bounded by one
  child's overshoot). Kept behind a Door for when a consumer needs to cap a
  particular child below the parent's remaining budget. The cut has a known cost:
  the only way to bound a single expensive child below the parent's remaining budget
  is to lower the parent's ceiling, which is coarser than a per-step cap. The trade
  favors the cut — shipping an unused knob violates simplicity, the coarseness costs
  nothing until a real consumer appears, and the Door reopens it exactly then.

- **Layer-2 child-internal HITL propagation (v1).** Propagating a child's
  `paused_human` to the parent and routing the operator's answer back to the child
  was in scope in an earlier draft. Cut from v1 (E053 rejects a child with a `human`
  node) because it introduces a cross-lane `respond` reconciliation — the parent
  mirrors on its lane, the child unblocks on its lane, and a crash between the two is
  a recovery surface v1 does not build. The cut has a known cost: a generic reusable
  child that legitimately pauses for its own human decision is a real shape, and E053
  forbids it outright (direct-child — and since nesting is forbidden, E049, that is
  the whole call-graph) rather than degrading gracefully. The trade favors the cut — the worked example and the "signoff at the
  top" requirement are fully served by the parent-authored `human` node (layer 1),
  and shipping the cross-lane reconciliation half-built is worse than a clean
  validate-time rejection with a named Door. When a consumer needs a self-pausing
  child, the Door specifies the full reconciliation rather than leaving it to a
  runtime surprise.

- **The operator answers the child run directly.** Instead of any propagation, let
  the operator `fragua runs respond <child>` on the navigable child run. Lost to the
  stated requirement — the review signoff must be a *top-level* decision — and to
  ergonomics: it would make the operator hunt the blocked descendant instead of
  answering the run they started. v1 sidesteps the whole question by authoring the
  signoff `human` node in the parent and forbidding a child `human` node (E053).

- **A subprocess child via `fragua ci`.** The black-box-run mechanism already exists
  as `fragua ci --json`, and `ernesto-interop.md`'s `kind: fragua` uses it. Lost for
  the *in-store* case because it fails-fast on `paused_human` (CI has no responder),
  runs the child in a separate process against an ephemeral store, and returns
  outputs over a subprocess envelope rather than the store's typed cross-run read. In
  one store, the child's pause fact, outputs, and worktree refs are all directly
  addressable — read `projectRunOutputs`, pin `--base` on a real ref, cascade an abort
  on the `parent_run_id` index — so the subprocess boundary buys only isolation the
  parent doesn't need. The subprocess remains the right tool across an engine
  boundary; in-store, the child is a child run.

- **Fabricating the join in `wake-pending`.** An earlier draft had `wakeFanoutJoin`
  append both `fact.run_resumed` **and** the step's `fact.node_completed` in one
  atomic `appendFact`, running edge selection inside the sweep. Cut: it forks edge
  selection out of the pure decision core into `wake-pending.ts` (a module that today
  never loads a `Graph`), creating a *second* edge-selection caller that must not
  drift from the driver's. The chosen path (S1) has `wakeFanoutJoin` emit **only**
  `fact.run_resumed` and lets the driver's *existing* re-dispatch site fabricate
  `node_completed` — the same site the operator-resume path already uses, so there is
  exactly one edge-selection caller and no graph load in the sweep. The lost atomicity
  is an optimization, not correctness: level-triggering plus idempotent child-id
  re-derivation make a crash between the two facts recoverable by ordinary
  re-dispatch. The extra tick of latency is the price, and it is cheap.

- **Transitive E053 with nesting permitted.** An earlier draft allowed nesting
  `type: workflow` steps and made E053 a *transitive* walk of the whole child
  call-graph (to catch a `human` node several levels down). Cut in favor of forbidding
  nesting outright (E049): no stated consumer nests (`converge.yaml` is depth 1), and
  the flat rule collapses E053 to a direct-child scan, the budget roll-up to a
  single-level `SUM`, the tree-producing classification to a direct write-class check,
  and the abort cascade to one level — five recursive mechanisms become flat. The known
  cost is that a legitimately-composed multi-level pipeline is rejected at save until
  the nesting Door opens; the trade favors the flat rule because every one of those
  five recursive forms is unbuilt complexity no v1 consumer needs, and the Door names
  exactly when to pay for it.

- **Keying the GC guard on the live parent head ref.** An earlier draft held a
  child's refs until `refs/fragua/heads/<parent>` pointed at the running tip — a
  *ref-state* predicate. Cut: a later `discard` **deletes** `heads/<parent>`, after
  which "does `heads/<parent>` reach the tip?" can never again be true, so the child
  refs would be stranded forever. The chosen predicate keys on a **durable terminal
  adoption-or-discard fact** in the log instead — once that fact exists the guard
  releases regardless of any subsequent ref mutation. The guard also moves off the
  automatic daemon GC (blob-CAS only, never touches refs) onto the operator-invoked
  `fragua gc --snapshots` predicate over `getGcEligibleSnapshotRuns`, which is the
  only path that reclaims refs.
