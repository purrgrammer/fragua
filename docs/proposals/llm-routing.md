---
title: LLM-directed routing + unified human-node authoring (and edge-selection cruft removal)
summary: "Promote LLM-directed routing to a first-class primitive: a node declares `routes=\"a,b,c\"`, an ephemeral `route` tool synthesised per-node by the backend exits the turn with the chosen branch, edges discriminate by `route` or `outcome` only. The same primitive replaces the legacy `wait.human` shape — `kind=human` (alias `shape=hexagon`) reuses `routes=`. The condition DSL, edge weights, preferred-label matching, suggested-next-id matching, and the `partial_success` / `skipped` outcome statuses are all removed; edge selection collapses to a two-case algorithm. Wire vocabulary moves `hitl` → `human` top to bottom. Sits within a deliberate simplification arc (DOT → YAML, thread + optional summary= replaces the 5-value fidelity enum, no graph transforms) — converging the model on outcome/route routing only."
status: proposed
maturity: designed
last-reviewed: 2026-05-19
---

# LLM-directed routing + unified human-node authoring

> Before: routing happens via a 5-step edge-selection priority — condition DSL → preferred-label → suggested-next-ids → weight → lexical. LLMs cannot direct control flow (only `goal_gate=true` + `retry_target=<node>`, which is binary and statically named). Human-in-the-loop nodes use a separate authoring shape (`shape=hexagon` + `[K] Label` accelerator parsing).
>
> After: a node opts in by declaring `routes="a,b,c"`. The codergen backend synthesises an ephemeral `route` tool whose `name` parameter is enum-constrained to those values; the agent layer never sees a statically-registered `route` tool. The LLM exits the turn with `route({name:"b"})`; the engine fires the edge keyed `route=b`. Human nodes reuse the same vocabulary. Edge selection collapses to two cases (route on routing nodes, outcome elsewhere); the entire 5-step priority machinery — condition DSL, weights, preferred-label matching, suggested-next-id matching — is deleted.

## Problem

Two pain points the existing primitives can't address, surfacing one underlying issue: the workflow model accreted too many ways to express the same routing decision.

1. **No LLM-directed routing.** `change.dot` and `feature.dot` are 90% identical workflows that differ only in scope. The discriminator (small change vs. multi-package feature) is exactly what an LLM is good at deciding, but today the only way to express it is two parallel files. Same shape repeats across `fix-bug.dot` (would route on `localised|need_info|not_a_bug`), `merge.dot` (would route on `clean|conflicts_expected|risky_main_drift`), `review.dot` (would route on `tiny|standard|huge`). Today these all collapse into prose inside the first node.

2. **Human-node authoring is brittle.** `wait.human` uses edge labels of shape `"[K] Display text"` parsed by `parseAcceleratorKey` at `packages/core/src/handler/handlers/wait-human.ts:88`. Duplicate accelerators throw at handler construction; the `[K]` prefix conflates UI vocabulary with routing wiring; the `prompt=` attribute is misleading (no LLM runs); only `doc-sync.dot::signoff` uses it today and the rest of the codebase has scrubbed human-checkpoint nodes out rather than fight the shape.

**The simplification arc.** This proposal lives alongside two other planned cleanups: DOT → YAML and the 5-value `fidelity` enum collapsing to `thread`-presence + optional per-node `summary=low|medium|high`. Together they push the workflow model toward a narrow, format-agnostic spine: nodes with three primitives (llm, human, tool); edges discriminated by exactly one of `outcome` or `route`; threads with binary inheritance plus an explicit opt-in summariser knob; no DOT-specific niceties (model stylesheets, graph transforms, condition DSLs). A unified `routes=` primitive both lands the LLM-routing feature and removes a large block of edge-selection machinery whose only consumer was the conditional-edge pattern this proposal eliminates.

## Design

Locked through design conversation 2026-05-19. Numbered for citation from the implementation surface below. Field names below describe the model; DOT examples show the current authoring surface (YAML lowering is a separate proposal).

### D1 — Route declaration

Nodes opt into routing by declaring `routes`: a closed enum of identifier-shaped names.

```dot
triage [
  routes = "small,feature,blocked"
  prompt = "..."
]
```

No free-form route names; no implicit `default`; no per-route metadata (use `label="…"` on the edge — see D4).

### D2 — Route signal: ephemeral `route` tool synthesised per-node

The codergen backend (`packages/agent/src/backend.ts`) synthesises a tool definition *per node invocation* when the executing node declares `routes=`. The tool schema:

```ts
{
  name: "route",
  description: "Exit this node with the chosen route. Call exactly once when decided.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", enum: ["small", "feature", "blocked"] } },
    required: ["name"],
  },
}
```

The enum is materialised from the node's `routes` declaration. Provider enforces it at the tool-call layer — off-list values are rejected before the handler sees them.

The tool exists only for the lifetime of one codergen step. The agent layer (`packages/agent/src/tools/`) has no `route.ts`; there is no static tool registration; the handler module list never grows. The route tool's effect, end-to-end:

1. Backend starts the agent loop for a routing node. Sees `node.routes`; appends the synthesised tool to the request's tool definitions.
2. LLM eventually calls `route({name:"hard"})`.
3. Backend's tool dispatcher recognises this as the route exit, captures the choice, terminates the loop with a sentinel.
4. Codergen handler reads the sentinel, returns `HandlerResult { kind: "transition", outcome: "success", route: "hard" }` (new optional `route` field on the transition result).
5. Engine's edge selection (D10) picks the edge whose `route=hard` matches.

No `route` tool registered globally; the codergen handler's transition result gains exactly one optional field.

### D3 — Terminator semantics

`route(...)` ends the agent loop. After the call commits, no further LLM turn is requested. The exploration phase before the call is unbounded (subject to `max_cost_usd` / `max_tokens` / `max_ms`); the call itself is the exit.

If the response containing `route` also contains other tool calls, the response is rejected: `outcome=fail`, halt reason `route_call_not_isolated`. The model must issue `route` on a response of its own. Rationale: prevents side effects in the same response as the exit (e.g. a `bash` whose result the model never sees because the loop ended), preserves the audit invariant "every route choice has its own provenance."

If the agent loop ends without `route` ever being called (natural stop, abort, watchdog), `outcome=fail` with halt reason `route_not_picked`.

### D4 — Edge attributes (the entire set)

After this proposal, an edge has exactly these fields:

| Field | Type | Meaning | Source nodes |
|---|---|---|---|
| `outcome` | `"success" \| "fail"` | Fires when handler reports this outcome | non-routing nodes only |
| `route` | string (one of source node's declared routes) | Fires when handler reports this route | routing nodes only |
| `label` | string | Pure UX: rendered on the edge in the graph view; on human-node edges, overrides the derived button text | any |

`condition`, `weight`, `preferred_label`, `suggested_next_ids` — all gone (see "What this also removes" below).

Rules (enforced by validator at upload; graph is pinned per run, so runtime trusts these):

- Every edge has exactly one of `outcome` or `route`. Unannotated → `outcome=success`.
- Edges from a routing node (declaring `routes=`) must carry `route=X` where X is in `routes`. `outcome=` from a routing node = E017. Unannotated edge from a routing node = E020.
- Edges from a non-routing node must carry `outcome=` (success or fail) or be unannotated (defaults to success). `route=` from a non-routing node = E019.
- From any single source, every (outcome|route) discriminator value appears at most once. Two `outcome=success` edges from one source, or two `route=X` edges = E024.
- `label` on any edge is optional pure UX; never participates in edge selection.

### D5 — Subgraphs stay visual

Subgraph clusters remain pure visual grouping (today's behaviour). Routes target nodes by name. To route into a cluster, target its entry node directly.

### D6 — Human nodes: `kind=human` reuses `routes=`

A human node declares `kind=human` (with `shape=hexagon` as a DOT-era authoring alias — both lower to the same node kind, the alias goes away with the YAML migration). Attributes:

- `text` — operator-facing prompt (no `prompt=`; a human node doesn't run an LLM).
- `routes` — comma-separated route names. Each becomes a button.
- Button label = the outgoing edge's `label="..."` if set, else `humanize(route)` (`output_only` → "Output Only").

Wire shape:

```dot
signoff [
  kind   = human
  text   = "Drift report ready. Choose how to proceed."
  routes = "apply,output_only,reject"
]

signoff -> apply [route=apply,        label="Apply edits"]
signoff -> done  [route=output_only,  label="Output only — preserve report"]
signoff -> done  [route=reject]
```

The first two buttons render their `label`; the third falls back to `humanize("reject") = "Reject"`. This preserves the `[K] Label` ergonomics for custom button text without re-introducing the accelerator-parsing mechanism.

Runtime path: largely unchanged from today's `wait.human`. The node yields a pause to the executor; the executor commits `fact.run_paused_human`; the operator POSTs to `/runs/:id/human`; the resume folds `intent.human_input` into `ctx.humanInput` for the next handler invocation, which fires the `route=X` edge. The `kind=human` name echoes the legacy `wait.human` handler kind — the runtime shape was already correct; only the authoring vocabulary changes.

### D7 — Wire-level rename: `hitl` → `human`

Pre-release, the wire-level intent / status / event / endpoint vocabulary moves to `human` to match the authoring vocabulary:

| Before | After |
|---|---|
| `intent.hitl_input { selected, note? }` | `intent.human_input { route, note? }` |
| `paused_hitl` (RunStatus) | `paused_human` |
| `fact.run_paused_hitl` | `fact.run_paused_human` |
| `POST /runs/:id/hitl` | `POST /runs/:id/human` |
| `ctx.hitlInput` | `ctx.humanInput` |
| `HitlInput` / `HitlOption` (types) | `HumanInput` / removed |

Two changes folded into one pass: (a) the field name `selected` → `route` for vocab uniformity with the LLM-routing surface; (b) the prefix `hitl` → `human` so authoring (`kind=human`) and wire names match. Per CLAUDE.md rule 1's enum-consumer warning, `rg '"selected"|\.selected\b|"hitl"|paused_hitl|hitl_input|hitlInput|run_paused_hitl' packages/` before merging — TypeScript exhaustiveness won't catch string-literal consumers in payload validators, web POST bodies, recorded event fixtures, debug-skill checklists, or schema CHECK constraints.

### D8 — Event taxonomy: extend `fact.node_completed`, don't add

`fact.node_completed.payload` gains an optional field:

```ts
payload: {
  outcome: "success" | "fail";
  route?: string;          // present iff the node declared `routes=` AND chose one
  // ...existing fields
}
```

New halt reasons:

- `route_not_picked` — turn ended without a `route` call from a routing node.
- `route_call_not_isolated` — `route` shared a response with other tool calls.
- `edge_no_match` — handler returned a route/outcome and no outgoing edge matched. Validator should prevent this statically; halt reason is a runtime backstop (one shape for both the unmatched-route and unmatched-outcome cases since the graph is pinned per run).

No new fact type; no event-store schema change beyond updating the status-enum CHECK constraint (`paused_hitl` → `paused_human`).

### D9 — Goal-gate ⊥ routes (validator error)

`goal_gate=true` and `routes=` are mutually exclusive. Goal-gate implies binary success/fail routing with `retry_target` retargeting on fail; `routes=` is the N-way alternative. Both on one node = E023 `goal_gate_with_routes`.

### D10 — Edge selection: two cases, no priorities

The new algorithm replaces the entire 5-step priority machinery at `packages/core/src/engine/edge-selection.ts:60-124`:

```
selectEdge(source, handlerResult):
  if source.routes is non-empty:                                      # routing node
    return edge from source where edge.route == handlerResult.route   # exactly one (validator)
  else:                                                               # non-routing node
    return edge from source where edge.outcome == handlerResult.outcome
    # unannotated edges count as outcome=success; validator enforces ≤1 per outcome
```

If no edge matches: handler reports halt with reason `edge_no_match`. Validator should make this unreachable for any pinned graph; the halt reason exists as a defense-in-depth surface.

The `EdgeSelection` event payload's `rule` field collapses from a 5-value union (`"condition" | "preferred_label" | "suggested_next_ids" | "weight" | "lexical"`) to a 2-value union (`"route" | "outcome"`).

### D11 — Visualisation

Web layer changes anchored against current file:line:

| Surface | Today | After |
|---|---|---|
| Edge label source (`packages/web/src/components/ai-elements/edge.tsx`) | Reads `attrs.condition` and `attrs.label` | Reads `attrs.label` first; if absent, derives from `attrs.outcome` (`"success"` / `"fail"`) or `attrs.route` (route name, via `humanize`) |
| Outcome accent (`edge.tsx:179-187`) | Existing `outcome=success/fail` colour map | Unchanged for `outcome=` edges. Route edges get a third treatment — `var(--sw-accent-route)` (new token) or share the existing `--sw-accent-idle` used by `isHitlEdge` |
| Human-edge flag (`edge.tsx:226`) | `isHitlEdge` | Renamed `isHumanEdge`; flag set when either endpoint is `kind=human` |
| Routing-node cue (`packages/web/src/components/GraphView.tsx`) | None | A small badge / chip listing route count on routing-node bodies; routing codergens stay box-shaped, badge is the only differentiator |
| Node inspector (`packages/web/src/components/NodeInspector.tsx`) | Lists node attrs | Lists declared routes for routing nodes; lists `text` for human nodes |
| Active-route highlight (run-detail) | Engine emits `selectedEdges`; UI animates the chosen edge | Unchanged: edge-selection D10 populates `selectedEdges` for the route case the same way it did for the condition case. UI animation is wire-compatible. |
| Event log (`packages/web/src/lib/humanize.ts`) | Renders `fact.node_completed.outcome` | Also renders `route` when present (`→ small`) and the two new halt reasons + `paused_human` status. |

Graphviz `dot -Tsvg` output (if used by the docs pipeline) renders `label="..."` natively. Custom attrs (`route`, `outcome`) remain invisible to graphviz unless a pre-render pass synthesises a derived `label` — out of scope; the web dashboard is the operator-facing surface.

## What this also removes

This proposal is a cruft removal as much as a feature add. Concretely:

**Code files deleted entirely:**
- `packages/core/src/engine/condition.ts` — DSL parser + evaluator (the `outcome=success && context.x > 5` grammar).
- `packages/core/src/types/condition.ts` — AST type definitions; only `condition.ts` consumes them.
- `packages/core/src/accelerator.ts` — `parseAcceleratorKey`, `stripAcceleratorPrefix`. No consumer after `wait-human.ts` deletion.
- `packages/core/src/handler/handlers/wait-human.ts` — replaced by `human.ts` (D6).

**Code files largely rewritten:**
- `packages/core/src/engine/edge-selection.ts` — from 124 lines (5-step priority) to ~30 lines (two cases). `normalizeLabel`, `pickBestByWeightThenLexical`, the condition import — all gone.

**Type fields deleted:**
- `Outcome.preferred_label` (`packages/core/src/types/outcome.ts:20`) — was Step-2 input.
- `Outcome.suggested_next_ids` (`outcome.ts:21`) — was Step-3 input.
- `Outcome.context_updates` — sole consumer was the condition DSL's `env.context`. Deleted; if any observability code still reads it (it shouldn't post-cleanup), that's a same-PR fix.
- `Outcome.next_node_override` — escape-hatch for bypassing edge selection; no consumer remains under D10.
- `HandlerResult.transition.preferredLabel` (`packages/core/src/handler/types.ts:252`) — no producer after `wait-human.ts` deletion.
- `HandlerResult.transition.suggestedNextIds` (`types.ts:255`) — no consumer after edge-selection rewrite.
- `Edge.attrs.weight` (`packages/core/src/types/graph.ts:112`) — no consumer in the two-case algorithm.
- `Edge.attrs.condition` — DSL gone.
- `EdgeSelectionRule` union (`edge-selection.ts:16`, `events.ts:290`) — collapses to `"route" | "outcome"`.

**Outcome status values deleted:**
- `partial_success` — never had a load-bearing consumer; the routing model is binary by design (success or fail).
- `skipped` — orphan after the simplification (nothing downstream branches on it).
- `OutcomeStatus` union collapses to `"success" | "fail" | "retry"`. `retry` stays — `retry-policy.ts` consumes it.

**Parser / validator allowed-attribute lists:**
- `packages/core/src/parser/parser.ts:394` — remove `weight` from allowed edge attrs.
- `packages/core/src/engine/validator.ts:61` — remove `weight` from allowed edge attrs.
- Remove all validator rules that parse / evaluate `condition` syntax.

**Test deletions:**
- `packages/core/test/parser/parser.property.test.ts:67` — weight property test.
- `packages/core/test/parser/parser.test.ts:80` — weight-coercion test.
- Any `test/engine/condition.test.ts`, `test/engine/edge-selection.test.ts` files — rewritten or deleted; new tests cover the two-case algorithm.
- Any test asserting on `Outcome.status === "partial_success" | "skipped"` — deleted with the values.

**Doc deletions:**
- `docs/SPEC.md §3.8` — rewrite around the two-case algorithm. Drop the condition DSL grammar reference, the 5-step priority prose, and the worked examples that use condition expressions.
- `docs/SPEC.md §3.7` (Outcome) — drop `partial_success`, `skipped` from the status enum; drop `preferred_label`, `suggested_next_ids`, `context_updates`, `next_node_override` from the Outcome shape.

## Worked examples

### W1 — `work.dot` (collapses `change.dot` + `feature.dot`)

See the conversation transcript for the full DOT. Shape:

```
start
  -> triage  (routes = "small,feature,blocked")
  -> plan    (small | feature merge here; shared thread carries scope)
  -> implement
  -> review  (goal_gate)
  -> format
  -> needs_human  (routes = "yes,no" — small LLM classifier)
  -> approve | ci  (human-node gate iff needs_human said yes)
  -> ci
  -> commit
  -> done
```

`triage` is opus, decides scope. `needs_human` is haiku, decides whether the diff is contract-touching enough to warrant a human approver. `approve` is the human node (`kind=human`). The original `cluster_dev` subgraph for `implement` + `review` stays visual.

After this lands, `change.dot` and `feature.dot` are deleted.

### W2 — `doc-sync.dot::signoff` migration

```dot
// before
signoff [shape=hexagon, prompt="..."]
signoff -> apply [label="[A] Apply"]
signoff -> done  [label="[O] Output only"]
signoff -> done  [label="[R] Reject"]

// after
signoff [kind=human, text="Drift report ready. Choose how to proceed.", routes="apply,output_only,reject"]
signoff -> apply [route=apply,        label="Apply edits"]
signoff -> done  [route=output_only,  label="Output only — preserve report"]
signoff -> done  [route=reject]
```

`prompt=` → `text=`; label parsing → `routes=` + per-edge `label=` for the button text. The third button derives "Reject" from `humanize("reject")`.

### W3 — Drift cadence escalation (future, separate proposal)

A natural follow-up: `structural-drift.dot` and `narrative-drift.dot` add a routing node after `review` that classifies findings by max severity (`silent|low|medium|critical`). Critical routes to a human node ("page operator"); everything else routes straight to done. Lets daily cadence run unattended but escalate when it matters. Not in this proposal's scope.

## Edge cases

| Case | Behaviour |
|---|---|
| LLM calls `route(name)` with valid name, isolated response | `outcome=success`, route fires, loop ends. |
| LLM calls `route(name)` alongside other tool calls in same response | `outcome=fail`, halt reason `route_call_not_isolated`. |
| LLM finishes turn without calling `route` | `outcome=fail`, halt reason `route_not_picked`. |
| LLM calls `route` twice across separate responses | First call wins; second response never requested (loop ended at first). |
| LLM calls `route` with off-list name | Provider rejects the tool call (enum violation). Counts as a malformed tool call → standard provider-error recovery applies. |
| Node declares `routes=` but no edge handles route X | Validator E021 at upload. Runtime backstop: `edge_no_match` halt. |
| Edge declares `route=Y` but source node doesn't have Y in `routes=` (or has no `routes=` at all) | Validator E019 at upload. |
| Routing node has an unannotated edge | Validator E020 at upload (routing nodes require explicit `route=` on every outgoing edge). |
| Node declares `routes=` AND `goal_gate=true` | Validator E023 at upload. |
| `outcome=fail` and `route=X` on same edge | Validator E018 at upload. |
| Two `outcome=success` edges (or two `route=X` edges) from the same source | Validator E024 at upload. |
| `kind=human` without `routes=` | Validator E022 at upload. |
| `kind=` and `shape=` set to non-aliased values | Validator E025 at upload. |
| `text=` on a non-human node | Validator E026 at upload. |
| Operator POSTs `/human` with off-list route | Server validation rejects (400); reads paused node's `routes=` from run state. |
| Sub-agent (via `agent` tool) declares `routes=` internally | Allowed mechanically; the route choice does not propagate to the parent's edge selection (parent only sees the sub-agent's last message). Out of scope to expose. |

## Implementation surface

Grouped by package; file:line references where edits anchor.

**`packages/core/src/parser/`**
- New attributes: `routes` (string, comma-split), `kind` (string, `"codergen" | "tool" | "human"` enum), `text` (string).
- New edge attributes: `route` (string), `outcome` (string, `"success"|"fail"`). Remove `condition` and `weight` from allowed edge attrs (`parser.ts:394`).
- `shape=hexagon` → `kind=human` alias resolution.

**`packages/core/src/types/graph.ts`**
- `Node.routes?: string[]`, `Node.kind?: "codergen"|"tool"|"human"` (today inferred from `shape`; promote to first-class), `Node.text?: string`.
- `Edge.outcome?: "success"|"fail"`, `Edge.route?: string`. Drop `Edge.condition` and `Edge.weight` (line 112).
- `hexagon: "wait.human"` mapping at `packages/core/src/types/graph.ts:20` becomes `hexagon: "human"`.

**`packages/core/src/types/outcome.ts`**
- `OutcomeStatus` union: `"success" | "fail" | "retry"`. Drop `partial_success`, `skipped`.
- Delete `Outcome.preferred_label`, `Outcome.suggested_next_ids`, `Outcome.context_updates`, `Outcome.next_node_override`. Update factory functions (`ok`, `fail`, `failProvider`) accordingly.

**`packages/core/src/types/condition.ts`**
- Delete the file (AST type definitions, only consumed by the now-deleted `condition.ts`).

**`packages/core/src/engine/condition.ts`**
- Delete the file (DSL parser + evaluator).

**`packages/core/src/engine/edge-selection.ts`**
- Rewrite around the D10 two-case algorithm. Delete `normalizeLabel`, `pickBestByWeightThenLexical`, the condition import. `EdgeSelectionRule` collapses to `"route" | "outcome"`.

**`packages/core/src/engine/validator.ts`**
- Remove `weight` from allowed edge attrs (line 61). Remove all condition-syntax validation rules.
- Codes (contiguous, E017–E026; current head is E016):
  - E017 `routing_node_has_outcome_edge` — node declares `routes=` AND has outgoing `[outcome=…]` edge.
  - E018 `edge_has_both_outcome_and_route` — edge with both attributes.
  - E019 `edge_route_undeclared` — edge `[route=X]` where source node's `routes=` doesn't include X, or where source has no `routes=` at all.
  - E020 `routing_node_unannotated_edge` — edge from a routing node lacks `route=` (routing nodes require explicit route on every outgoing edge).
  - E021 `route_unhandled` — node declares route X but no outgoing edge keys on it.
  - E022 `human_missing_routes` — `kind=human` node without `routes=`.
  - E023 `goal_gate_with_routes` — both `routes=` and `goal_gate=true`.
  - E024 `duplicate_discriminator` — multiple edges from same source with the same `outcome=` value or the same `route=` value.
  - E025 `kind_shape_contradiction` — `kind=` and `shape=` set to non-aliased values (e.g. `kind=codergen shape=hexagon`).
  - E026 `text_on_non_human_node` — `text=` set on a node whose `kind` is not `human`.
- Remove E014 (legacy `context.hitl.*` condition warning — dead after migration).
- Update E009 message to reference `routes=` not "outgoing edges."

**`packages/core/src/handler/handlers/`**
- Rename `wait-human.ts` → `human.ts` and rewrite around the new shape (yields a pause → resume → `transition` with the route the operator chose). No label parsing, no preferred_label / suggested_next_ids.
- Delete `accelerator.ts`.

**`packages/core/src/handler/types.ts`**
- `HitlInput { selected, note? }` → `HumanInput { route, note? }` (rename + field rename).
- `HandlerResult` for the human node: `kind: "yield_human"` with `routes: string[]` and `text: string`. `HitlOption` type deleted.
- `HandlerResult.transition` gains optional `route?: string`. Drops `preferredLabel`, `suggestedNextIds` (lines 252, 255).

**`packages/agent/src/backend.ts`**
- When the executing node declares `routes=`, append a synthesised tool definition (D2) to the agent loop's tools.
- Tool dispatcher: recognise the route tool call, capture `{ route: name }`, terminate the loop with a sentinel result.
- "Route call not isolated": if the assistant message contains the route tool call alongside other tool calls, terminate with `outcome: "fail", haltReason: "route_call_not_isolated"`.
- "No route picked" on natural loop end from a routing node: terminate with `outcome: "fail", haltReason: "route_not_picked"`.
- No static `packages/agent/src/tools/route.ts` file; everything lives inline in the backend.

**`packages/types/src/events.ts` / `swarm-events.ts`**
- Rename intent: `intent.hitl_input { selected, note? }` → `intent.human_input { route, note? }`.
- Rename status: `paused_hitl` → `paused_human` in `RunStatus`.
- Rename fact: `fact.run_paused_hitl` → `fact.run_paused_human`.
- Add halt reasons: `route_not_picked`, `route_call_not_isolated`, `edge_no_match` to `HaltReason`.
- Extend `fact.node_completed.payload` with optional `route?: string`.
- `EdgeSelection` event payload's `rule` field union collapses from 5-value to `"route" | "outcome"` (`events.ts:290`).

**`packages/store/`**
- Schema CHECK constraint at `packages/store/src/schema.sql:95` updates the status enum: `'paused_hitl'` → `'paused_human'`.
- No table/column changes. `fact.node_completed.payload` is a JSON blob; the new `route` field is additive.
- Pre-release: dev DBs with `paused_hitl` rows must be reset; no migration path.

**`packages/server/src/store/routes.ts`**
- Endpoint rename: `POST /runs/:id/hitl` → `POST /runs/:id/human`. Payload: `{ route, note? }`.
- Server-side enum validation: read paused node's `routes=` from run state, reject off-list routes with 400.
- `runs-routes.ts:VALID_STATUSES` updates `paused_hitl` → `paused_human`.

**`packages/daemon/src/result-to-facts.ts`**
- Propagate `route` from handler result onto `fact.node_completed.payload.route`.
- Propagate the three new halt reasons.
- Emit `fact.run_paused_human` (renamed) on human-node pause.

**`packages/web/`**
- Per D11. Human-node form: read `routes` + per-edge `label`; render one button per route; POST `{ route, note }` to `/runs/:id/human`. `humanize/labels` map gains the new halt reasons + `paused_human` status. `GraphView` adds the routing-node chip; `NodeInspector` surfaces `routes` / `text`. `edge.tsx` reads `attrs.label` / `attrs.route` / `attrs.outcome` (drops `attrs.condition`); `isHitlEdge` → `isHumanEdge`.

## Doc and skill updates (per CLAUDE.md rule 1)

Same-PR obligations triggered by the contract surfaces touched above:

| Touched | Same-PR update |
|---|---|
| `packages/store/src/schema.sql` (status enum CHECK: `paused_hitl` → `paused_human`) | `ARCHITECTURE.md` §2 (schema — status enum row). |
| `packages/types/src/swarm-events.ts` (new halt reasons; `fact.node_completed.payload.route?`; intent / status / fact rename `hitl` → `human`; field rename `selected` → `route`; `EdgeSelectionRule` union collapse) | `ARCHITECTURE.md` §3 (event taxonomy — fact payload extension, halt reasons, intent/status/fact rename, edge-selection rule union); `SPEC.md` §3.4 status table; `SPEC.md` §3.7 Outcome shape (drop `partial_success` / `skipped` / `preferred_label` / `suggested_next_ids` / `context_updates` / `next_node_override`); `SPEC.md` §3.8 (rewrite around the two-case algorithm — drop the 5-step priority entirely); `.agents/skills/swarm-debug/SKILL.md` §4.1 (new fact-payload field; rename across status / fact / intent strings) and §8 (three new halt reasons + `paused_human` status); `STATUS.md` "What swarm delivers today" gains an `llm_directed_routing` capability line. |
| `packages/core/src/handler/types.ts` (`HumanInput` type; `yield_human` shape; `transition.route` field; remove `preferredLabel`/`suggestedNextIds`) | `docs/handler-contract.md` — human-node section rewrites around `routes` / `text`; transition-result section drops the deleted fields, adds `route?`. |
| `packages/core/src/engine/validator.ts` (codes E017–E026; remove E014; update E009) | `.agents/skills/swarm-author/SKILL.md` validator-codes table — add ten new errors, drop E014, update E009 wording. |
| `packages/core/src/engine/edge-selection.ts` (rewrite to two-case D10) | `SPEC.md` §3.8 (algorithm prose); `.agents/skills/swarm-author/SKILL.md` "Edge selection" section. |
| `packages/core/src/engine/condition.ts`, `packages/core/src/types/condition.ts` (deleted) | `SPEC.md` — drop the condition-DSL grammar reference; `.agents/skills/swarm-author/SKILL.md` — drop any `condition=` worked examples. |
| `packages/server/src/store/routes.ts` (`/hitl` → `/human`; payload `{selected}` → `{route}`) | `.agents/skills/swarm-run/SKILL.md` cheat sheet — endpoint + payload rename; `ARCHITECTURE.md` §7 web-server routes table. |
| `packages/agent/src/backend.ts` (synthesised `route` tool per routing node) | `.agents/skills/swarm-author/SKILL.md` — new "Routing" section showing the pattern (`routes=` + `route` tool + edge `route=X` + isolation rule); cross-reference from §"Tool nodes vs LLM nodes". |
| `.swarm/workflows/change.dot`, `.swarm/workflows/feature.dot` | Deleted (collapsed into `work.dot`). |
| `.swarm/workflows/doc-sync.dot` | `signoff` node migrated per W2. |

Additional skill updates that don't trigger from a contract file but are load-bearing:

- `.agents/skills/swarm-author/SKILL.md` — update "DOT primitives" overview to mention `kind=human`; add "Authoring routing nodes" subsection (prompt-writing pattern: "classify with route(); end with a single isolated route call"); update validator-codes diagnostics; document the edge attribute set (drop `condition=`, `weight=`; use `[outcome=…]` / `[route=…]` / `label=`); rewrite the "Edge selection" section around the two-case algorithm; replace `wait.human` worked examples with `kind=human` + `routes=`.
- `.agents/skills/swarm-debug/SKILL.md` — §4.1 gains a note on diagnosing `route_not_picked` (final assistant message likely showed decision paralysis or off-list naming) and `edge_no_match` (validator drift — graph may be older than current code); §8 covers the three new halt reasons; rename references from `paused_hitl` / `fact.run_paused_hitl` / `intent.hitl_input` to the `human` equivalents; drop any references to `partial_success` / `skipped` outcome statuses.
- `.agents/skills/swarm-run/SKILL.md` — pause-resume cheat sheet: endpoint `/runs/:id/human`, payload `{ "route": "approve", "note?": "..." }`; note the field + endpoint renames so external-tool migrators see the change.
- `.agents/skills/backend/SKILL.md` — `/human` validation enforces the paused-node's enum.
- `.agents/skills/frontend/SKILL.md` — human-node form data shape changed; update any worked example referencing the old `{ selected }` shape.
- `README.md` — no change (no CLI/port/storage shifts).
- `docs/proposals/README.md` — index entry for this proposal.
- Drift-lint (`bun run lint:docs`) — update token-match patterns for the renamed status / event / endpoint, and for the deleted condition-DSL surface so the linter doesn't keep looking for references that no longer exist.

## Migration plan

1. **Land the primitive** (parser + types + backend route-tool synthesis + validator codes + handler types + intent/status/fact/endpoint rename + new halt reasons + fact extension + server validation + edge-selection rewrite + dead-code deletions + Outcome status / field deletions). Behind a feature gate? No — pre-release, all consumers update in lockstep.
2. **Migrate `doc-sync.dot::signoff`** as the first concrete user. Lightest possible migration; validates the round-trip.
3. **Add `work.dot`**, delete `change.dot` + `feature.dot`.
4. **Update STATUS.md** "What swarm delivers today" to claim `llm_directed_routing` and `unified_human_node_authoring`.
5. **Apply the doc + skill updates** per the table above. Drift-lint will catch anything missed.
6. **Regenerate test fixtures** under `packages/core/test/` and `packages/store/test/` that reference the renamed status / event / intent tokens, or assert on the deleted outcome statuses.
7. **Opportunistic follow-ups** as workflows hit their pain points: severity-aware escalation on `structural-drift` / `narrative-drift` / `rollup` (separate proposal), routing in `review.dot::scope`, `fix-bug.dot::reproduce`, `merge.dot::preflight`.
8. **Out-of-scope follow-up:** DOT → YAML migration ports this routing primitive to the YAML authoring form. Field mapping is 1:1 (no semantic change).

## Considered alternatives

- **Free-form route names with no `routes=` declaration on the node.** Rejected: validator can't statically verify edge coverage; off-list LLM routes silently halt; provider can't enum-constrain the tool. Worse predictability for zero flexibility win.
- **`route` as a side-effect tool (turn ends naturally).** Rejected: lets the LLM commit side effects in the same response as the exit; "last call wins" is implicit state; multiple reasonable-looking responses produce surprises. Terminator semantics align with `return` / `goto` in every language.
- **`route` as a statically-registered tool module.** Rejected: routing nodes are the only consumer, the enum is per-node, and the tool's effect is a loop terminator — none of which fit the static module pattern. Ephemeral per-node synthesis is simpler.
- **Routes-and-outcome-edges-coexist with most-specific-edge-wins.** Rejected: too many ways for two reasonable-looking edges to surprise the author. Forcing "routes replace outcome edges on routing nodes" is the same insight as ML enums vs. free-form strings — a closed set wins.
- **Keep the 5-step priority for non-routing nodes (just bolt route on as Step 0).** Rejected: this proposal is also a simplification arc. The 5-step machinery exists to serve the condition DSL; removing the DSL removes the need. Two-case algorithm is the prize.
- **Keep `weight=` for fan-out / load-balancing in some future world.** Rejected: no current consumer; the YAML migration would carry it forward as dead weight. Re-introduce if a real use surfaces.
- **Keep `partial_success` / `skipped` outcome statuses for forward-compat.** Rejected: same argument as `weight=`. No consumer today, no design need under the simplified routing model; YAML migration shouldn't carry orphan enum members.
- **Unify `intent.human_input` and a hypothetical `intent.route_chosen` under one type for both LLM and operator.** Considered, deferred. Vocab is already uniform after the field + prefix renames; the bigger refactor (intent fold, server endpoint, debug skill, web UI) buys little.
- **Subgraph clusters as route targets with an `entry=` declaration.** Rejected: adds a primitive most workflows don't need; routes can target the entry node directly with the same effect and lower conceptual cost.
- **`default=` fallback on routing nodes for the no-call case.** Rejected: silent decisions for two very different reasons (model skipped vs. model timed out) — better to halt loudly with `route_not_picked`.
- **Keep the `[K] Label` accelerator vocabulary on human nodes for backwards compat.** Rejected: pre-release; the `[K]` prefix conflated routing wiring with operator UI labels — removing it is part of the win. Per-edge `label="..."` (D6) covers the custom-button-text need without the parsing mechanism.
- **Keep the wire prefix `hitl` while authoring uses `human`.** Rejected: split vocabulary (authoring says `kind=human`, wire says `intent.hitl_input`, debug skill says `paused_hitl`) is exactly the kind of drift that makes the existing system hard to learn. One word, top to bottom.

## Related proposals

- [LLM-emit HITL via `<ask>` marker](./llm-emit-hitl.md) — complementary, not overlapping. That proposal extends the paused-human flow so a codergen mid-turn can ask the operator a clarification question (no new node type); this proposal adds the structured human routing node. The two compose: a codergen node can `<ask>` for mid-step input; a downstream human node can offer a structured choice between paths. The filename keeps the `hitl` token for historical continuity; its body updates to the `human` vocabulary when it lands.
- [Agent tool — LLM-spawned sub-agents](./agent-tool.md) — shipped. Worth contrasting: `agent` is a statically-registered tool whose schema is shared; `route` is the opposite end of the spectrum (ephemeral per-node synthesis with a node-derived enum). The codebase ends up with both patterns, deliberately.
