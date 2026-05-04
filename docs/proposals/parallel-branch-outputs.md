---
title: Parallel branch outputs — substitution + UI awareness
status: proposed
maturity: sketch
last-reviewed: 2026-05-04
---

# Parallel branch outputs — substitution + UI awareness

> Today, when a `component` node fans out to N branches, only the parent
> component's "winner" output is addressable in substitution. The four
> branches that ran are first-class executions in the event log, but
> their artifacts are invisible to `$<branchId>.output` and to most of
> the web UI: the graph lights up the parent, the conversation collapses
> all branches into one stream, the step breakdown shows the parent as a
> single step. This blocks the most natural use of fan-out — *parallel
> reviewers feeding a synthesizer downstream* — and obscures what the
> run actually did.

## Motivation

Concrete: `~/.swarm/workflows/review.dot` was authored as parallel
4-lens review → opus synth (`PR 9812` test, 2026-05-04). The synth
node referenced `$lens_correctness.output`, `$lens_security.output`,
etc. All four resolved to empty strings, the synthesizer concluded "All
clear", and reported zero findings — when the lenses had actually flagged
6 medium issues. The workflow had to fall back to sequential execution
(2× wall-clock) to recover correctness.

Three layers are blind to branches:

- **Substitution.** `getNodeOutputs` reads `fact.node_completed.outputRef`
  events. Parallel branches don't emit `fact.node_completed` because the
  parallel handler invokes child handlers in-process (bypassing the
  executor's lifecycle) and only the parent emits a single
  `fact.node_completed` carrying the winner's artifact. Comment at
  `packages/store/src/store.ts:763-766` flags this as known: "the
  refNodeId may differ from the node that emitted the fact when handlers
  eventually surface child-node refs (e.g. parallel branches). Until that
  lands, both strings agree."
- **`tripleoctagon.prompt`.** The "LLM reduces branch outputs" branch of
  the spec (§4.9) is also deferred — `fan-in.ts:9` only runs the
  heuristic winner-picker. So neither downstream synthesis path nor
  in-fan_in synthesis works today.
- **Web UI.** Graph view: only the parent component shows active state;
  branches stay grey while they're running. Conversation: messages from
  all branches are interleaved by seq with no per-branch grouping. Step
  breakdown: branches collapse into a single parent step.

## Today's behaviour, per layer

| Layer | Today | Gap |
|---|---|---|
| `parallel` handler | calls `childSpec.handler(childCtx)` inline; emits one `parallel.completed` for parent | no `fact.node_started` / `fact.node_completed` per branch |
| `parallel.fan_in` handler | runs `foldFanIn` heuristic; emits `fan_in.completed` with `winner` + `rankedOrder`; `tokens=0, cost=0` | the "LLM-eval branch" (`prompt=` on tripleoctagon) is a TODO |
| Codergen child | runs normally, writes its output artifact under `(run_id, branchId, parentIteration, "output")` | the artifact exists; nothing emits the outputRef event for it |
| `getNodeOutputs` (store) | maps `fact.node_completed.outputRef` events into `Map<nodeId, NodeOutput>` | branches don't appear in the map |
| `substitution.ts` | reads from `nodeOutputs` map | empty for branches → `$lens_*.output` resolves to `""` |
| `run_state.currentNode` | single string, the active node | parallel parent shows; branches don't |
| `run_state.nodes[*]` (projection) | per-node state derived from events | only the parent transitions through running/completed |
| Web graph view | colours parent; branches stay default | branches never light up |
| Web conversation | messages flat by seq | interleaved across branches, no grouping |
| Web step breakdown | one step per `fact.node_*` envelope | branches don't have their own steps |

## Design dimensions

### D1. How do branches join the event lifecycle?

**(a) Reuse `fact.node_started` / `fact.node_completed` with optional
`parentNodeId`, `parallelIndex` fields.** Cleanest for substitution
(`getNodeOutputs` already keys by `nodeId`, so it picks branches up
automatically). But clashes with `run_state.currentNode` semantics
("the one active node") — that field would either need to become a set,
or we say `currentNode` keeps pointing to the parent during fan-out and
branch state lives on `run_state.nodes[*]` only.

**(b) New event types `fact.branch_started` / `fact.branch_completed`.**
Doesn't perturb the single-current-node invariant. Two parallel
taxonomies in events; reducers and projections need to handle both.
Substitution layer needs to learn to read branch events too.

**Recommend (a)** with the rule: `currentNode` is the parent component
during fan-out; branches go into `run_state.nodes[*]` (which already
tracks per-node state). Single taxonomy, single update path in the
substitution reader. The "active node" concept becomes "active node
*set*" only at the projection-API boundary — internal SQL stays simple
because `run_state.nodes` is already a list.

### D2. What does `$<parent>.output` mean when the parent is a fan-out?

Three options:

- **Keep as winner output** (today's behaviour). Useful for
  `pick-the-best-branch` flows (showcase.dot's `pick_best`); breaks
  nothing.
- **Concatenate all branches** — semantic shift; risk of surprising
  existing workflows.
- **Drop entirely** — force authors to address branches by id. Cleanest
  but most disruptive.

**Recommend keep as winner output.** Pre-release means we *could* drop
it (CLAUDE.md rule 11), but "the winning branch" is a useful default
for the showcase pattern. Authors who want all branches reference them
explicitly: `$lens_correctness.output`.

### D3. Iteration handling

Branches inherit the parent component's iteration. Artifact key is
`(run_id, branchId, parent.iteration, "output")`. On a §3.4 retarget
that re-fires the parent, branches get a fresh iteration; substitution's
"later iteration overwrites" rule (already documented in
`store.ts:762`) covers replays correctly. **No new design needed.**

### D4. Replay determinism

Branches finish in non-deterministic order (Promise.all races). The
event log preserves whatever order the branches completed in. Replay
re-applies the recorded order — projection rebuild is deterministic.
**No invariant breaks.** New runs are non-deterministic w.r.t. branch
order, but that's already true of the underlying scheduler; we just
make it visible.

### D5. UI surface — graph view

Per-branch `fact.node_started` / `fact.node_completed` (D1.a) gives the
projection per-branch state directly. Graph view changes:

- When the parent component is `running` and a branch is `running`,
  light up *both*. The parent indicates "fan-out in progress"; branches
  indicate "this lens is working."
- When a branch completes, mark it completed without changing the
  parent's state until all branches have completed.
- After fan_in: highlight the winner (already in `fan_in.completed`
  payload) in a distinguishing accent; non-winners stay completed but
  muted.

### D6. UI surface — run conversation split view

Today messages are flat by seq. With per-branch `nodeId` already on
each message (today), split rendering becomes a UI-only concern:

- **≤3 active branches**: side-by-side columns. Each column is the
  branch's message stream filtered by `nodeId`.
- **≥4 branches**: tabs above a single column, with a "all branches"
  overview tab listing only assistant final-text blocks per branch
  (no tool-call noise).
- After fan_in: collapse the columns/tabs into one stream again at the
  fan-in node and onwards.

The hardest UX question is the *transition*: as branches start firing,
when does the conversation pivot from "single column" to "N columns"?
**Recommend** detect at the parent-component event (already exists:
`fact.node_started` for the component); render N empty columns
immediately, fill them as branch messages stream in. Familiar pattern
from terminal multiplexers.

### D7. UI surface — step breakdown

`/runs/:id/steps` returns rows per (nodeId, iteration). With branches
emitting their own `fact.node_*`, each branch becomes its own step row.
Add `parentNodeId: string | null` and `parallelIndex: number | null` to
the step shape. UI groups child rows under their parent and shows the
parent as a non-leaf summary row (aggregated cost / tokens / status).

### D8. `tripleoctagon.prompt` — keep deferred or kill?

The "LLM reduces branches" branch can stay deferred indefinitely. Once
branches are addressable (this proposal), authors can place a regular
codergen (`box`) node downstream of the fan_in and reference each
branch by id — same outcome with one extra node, no new handler kind.

**Recommend** mark §4.9 LLM-eval branch as "won't implement; use
downstream codergen" and remove the TODO from `fan-in.ts:9-12`. The
heuristic-winner semantics of `tripleoctagon` stay as today (they're
useful for showcase-style "pick the best branch" workflows).

## Recommended path

### P0 — Runtime: per-branch lifecycle events

1. `packages/core/src/handler/handlers/parallel.ts`: emit
   `fact.node_started` before each child dispatch, `fact.node_completed`
   after, with optional `parentNodeId`, `parallelIndex`. Carry the
   child's outputRef on completion.
2. `packages/types/src/swarm-events.ts`: add optional `parentNodeId`,
   `parallelIndex` to the `fact.node_started` and `fact.node_completed`
   payload declarations.
3. `packages/store/src/reducers.ts`: when `fact.node_started` carries
   `parentNodeId`, do **not** update `currentNode` (keep it pointed at
   the parent). Same for completion. Only top-level node transitions
   touch `currentNode`.
4. `packages/store/src/store.ts:getNodeOutputs`: no change — it already
   keys by `nodeId` from the outputRef. Drop the "until that lands"
   comment.
5. `docs/ARCHITECTURE.md` §3: document the new optional fields.
6. Test: add a parallel test in `packages/core/test/handler/parallel.test.ts`
   showing `$<branchId>.output` resolves in a downstream codergen.
7. Validator (`packages/core/src/engine/validator.ts`): no change; the
   substitution-target check (E005) already passes if a downstream
   codergen references a branch id (it's a real node id).

### P1 — Web: graph view + step breakdown

1. `packages/server/src/store/steps.ts`: include `parentNodeId`,
   `parallelIndex` on step rows.
2. `packages/web/src/.../graph`: light up branches that are `running`
   alongside their parent component; accent the winner after fan_in.
3. `packages/web/src/.../steps`: indent / group child rows under
   their parent; show parent as a summary row.

### P2 — Web: conversation split view

1. `packages/web/src/.../conversation`: when the active node is a
   `component` parent, render columns (≤3 branches) or tabs (≥4) with
   per-branch message streams filtered by `nodeId`. Collapse back to a
   single column after the fan_in node.
2. Cost panel: per-branch breakdown under the parent's row.

### Out of scope (separate work)

- HITL inside a parallel branch (still coerces to fail).
- `tripleoctagon.prompt` LLM-eval branch — explicitly **won't
  implement**; use a downstream codergen instead.
- Cross-branch dependencies (one branch reads another's output mid-flight)
  — not needed; `parallel.fan_in` already serialises.

## Same-PR doc obligations

Per CLAUDE.md ground rule #1:

| Touched | Update in same PR |
|---|---|
| `packages/types/src/swarm-events.ts` (fact event field additions) | `docs/ARCHITECTURE.md` §3 |
| `packages/server/src/store/runs-routes.ts` / `steps.ts` (step row shape) | `.agents/skills/swarm-run/SKILL.md` cheat sheet; `ARCHITECTURE.md` §7 |
| `packages/core/src/handler/handlers/parallel.ts` (new event emits) | `docs/handler-contract.md` if the handler contract surface changes |

## Open questions

1. **Should `run_state.currentNode` ever surface a branch?** Recommend
   no — keep it parent-only for fan-out. UIs that want "what's running
   right now" read `run_state.nodes[*]` filtered by state.
2. **Fan_in emits `winner`; should branch `fact.node_completed` carry a
   `score` field too?** The parallel handler already collects scores
   (when branches surface `routingDelta.score`). Surfacing per branch
   makes the ranking debuggable from the event log alone.
3. **Conversation split: tabs vs. columns vs. hybrid threshold?**
   3-branch threshold is a guess. Could be a user setting under
   `~/.swarm/config.jsonc:web`.
4. **Should the proposal land in one PR or split P0 / P1 / P2?**
   Recommend P0 alone first (smallest unit that fixes the substitution
   correctness bug; UI work can follow without a runtime change).

## Smoke validation

Once P0 lands, re-run `~/.swarm/workflows/review.dot` against PR 9812
in parallel form:

1. Restore parallel structure: `component` fan-out → 4 lenses → fan_in
   (pure join) → synthesize codergen.
2. `bun run swarm run review --input="PR 9812"` from `~/frontend/`.
3. Synth output should contain the same medium findings the sequential
   form recovered (≥3 findings across correctness + architecture).
4. Web graph: all 4 lens nodes light up while running; winner accented
   after fan_in.
5. Web conversation: 4-column split during fan-out, single stream
   afterward.
6. Web steps: 4 child rows under the `explore` parent in step breakdown.
