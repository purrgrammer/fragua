---
title: Fan-in → Reduce migration
status: proposed
maturity: sketch
last-reviewed: 2026-05-18
---

# Fan-in → Reduce migration

> **Status: sketch.** Parked design. Maps today's `tripleoctagon`
> fan-in to the typed Graph model's `Reduce<Elem, O>` kind (see
> `docs/graph/kinds.md`), and proposes the small handler-level
> change that makes today's `prompt=` on `tripleoctagon` work the
> way the docs already say it does. Revisit alongside the
> canonical-IR flip in `./json-ir-canonical.md`.

## Why

Today's `tripleoctagon` (handler `parallel.fan_in`) silently
ignores `prompt=`. W015 warns when it's set. But:

- The `swarm-author` skill describes the prompt as driving LLM
  synthesis of branch outputs.
- `review.dot::collect`, `parallel-hitl-smoke.dot::combine`, and
  `showcase.dot::pick_best` all author `prompt=` on the
  tripleoctagon expecting synthesis.
- The W015 escape hatch ("add a downstream codergen referencing
  `$<branchId>.output`") forces every fan-in-with-synthesis workflow
  to spend two nodes instead of one.

The runtime's heuristic concatenator is correct as a *default*
function reducer; the gap is the missing LLM-reducer path. The
typed Graph model already names both — `Reduce<Elem, O>` has
`kind: 'function' | 'llm'`. This doc proposes the small change
that makes today's DOT honor what the docs say.

## Today's tripleoctagon

- **Shape**: `tripleoctagon`.
- **Discovery**: structural — the unique tripleoctagon reachable
  from every branch of a `component` parent. E007 catches
  ambiguity (no convergence, multiple candidates, no tripleoctagon
  reachable at all).
- **Behavior**: deterministic concatenator. Each branch's output
  is wrapped in a section header; `prompt=`, `allowed_tools=`,
  `fidelity=` on the tripleoctagon are silently ignored.
- **W015**: warns when `prompt=` is set, pointing at the
  "downstream codergen with `$<branchId>.output`" workaround.
- **HITL inside a branch**: not supported (`yield_hitl` coerces
  to fail). Out of scope here; see `./parallel.md`.

## Typed-model target

From `docs/graph/kinds.md`:

```ts
type ReduceAttrs<Elem, O> =
  | { kind: 'function'; ref: FunctionRef }
  | { kind: 'llm';      llm: LLMAttrs<readonly Elem[], O> };
```

- **`function`** — deterministic, hashable, replay-stable.
  Today's heuristic concatenator is the canonical default.
- **`llm`** — calls a model on `Elem[]` to synthesize structured
  `O`. This is what `prompt=` on `tripleoctagon` was meant to mean.

`Elem[]` flows into Reduce from one of two sources:

1. A `Map<I, Elem, O>`'s body output array (the natural fan-out
   form when branches are homogeneous).
2. Explicit fan-out edges (N branches → N nodes → `Reduce`),
   matching today's `component → branches → tripleoctagon`.

DOT keeps structural discovery (today's behavior); the typed model
adds the explicit `Map` alternative without removing the structural
one.

## Proposed change

In `packages/daemon/src/auto-dispatcher.ts`, fan-in dispatch picks
the reducer kind from `prompt=` presence:

```ts
// pseudocode in the fan-in branch of the dispatch switch
if (typeof attrs.prompt === "string" && attrs.prompt.length > 0) {
  return handler.makeFanInLlmReducer({
    label: attrs.label ?? nodeId,
    prompt: attrs.prompt,
    provider: resolveProvider(attrs, stylesheet),
    model:    resolveModel(attrs, stylesheet),
    // optional reasoning_effort / fidelity / max_cost_usd flow
    // through the same as for a codergen node
  });
} else {
  return handler.makeFanInHeuristicReducer();   // current behavior
}
```

Consequences:

- **W015 retires.** The validator's rule and its swarm-author skill
  callout both go away.
- **Three workflows start working as authored.** `review.dot::collect`,
  `parallel-hitl-smoke.dot::combine`, and `showcase.dot::pick_best`
  each currently author a `prompt=` on their tripleoctagon expecting
  LLM synthesis; today they get the heuristic concatenator.
- **The downstream-codergen workaround retires.** The SKILL.md §10
  "Fan-in synthesis — currently heuristic only" caveat goes; the
  pattern "add a downstream codergen referencing `$<branchId>.output`"
  becomes a legacy two-node form that workflows can collapse on edit.

The function reducer (heuristic) remains the default for unprompted
tripleoctagons — no behavior change for workflows that didn't set
`prompt=`.

## Open questions

1. **Explicit `reduce_kind=` attr.** Today's inference (prompt
   presence → llm) is implicit. An explicit
   `reduce_kind="llm" | "function"` could co-exist; absent → infer
   from prompt. Buys clarity when the author wants the function
   reducer but also wants a prose comment in `prompt=` for humans.
   Probably yes; cheap to add.

2. **Builtin function reducers.** Today there's one — the heuristic
   concatenator. Others worth naming as named refs in the function
   registry:
   - `majority_vote` — for parallel voting (homogeneous branches,
     same-task variance).
   - `json_merge` — deep-merge structured outputs.
   - `dedup_rank` — collect findings, dedup, rank by severity.
   These ship as the initial builtin registry; named via
   `reduce_function="majority_vote"` on the tripleoctagon (in DOT)
   or the corresponding TS-builder method.

3. **Branch-failure policy.** Today: a failed branch aborts the
   whole fan-in. The typed model exposes `Map.policy = wait_all |
   first_success | collect_settled`. Semantically the policy lives
   at the *fan-out* (the `component` / `Map`), not the fan-in
   reducer — the reducer receives whatever the policy delivered.
   The `join_policy=` attr on `component` (today) becomes the same
   knob; nothing to change here.

4. **Streaming reduce.** LLM reducers can stream output via
   `ctx.emit` (the same way codergens do today). Function reducers
   typically can't. No spec change needed — observability falls out
   of the existing streaming surface.

5. **Branch input typing for `Map.body`.** When `Map.body` is a
   sub-graph, the body's input is `Elem`. Today's component-shape
   branches receive the upstream node's output verbatim (via
   `$<id>.output` substitution or shared thread). Once typed,
   `Elem` is the explicit input. DOT keeps structural; the TS
   builder makes it explicit.

6. **Edge from Map/component to Reduce.** Today the edge is
   structural (discovery picks the convergent tripleoctagon). In
   the typed model with `Map`, the edge is explicit `Map → Reduce`
   with `select: identity`. One node fewer to discover.

## Properties (for property-based testing once typed)

- **Function-reducer associativity** (when `⊕` is associative):
  order of reduction is irrelevant. Replayable.
- **Empty input**: well-defined; either returns identity
  (associative case) or aborts per fan-out policy.
- **LLM-reducer determinism**: not deterministic in general but
  *replayable* — the logged tool-call result is the output.

## Touch list (when this lands)

- `packages/daemon/src/auto-dispatcher.ts` — fan-in dispatch branches
  on `prompt=` presence; resolve provider/model the same way codergen
  does.
- `packages/core/src/handler/handlers/parallel-fan-in.ts` — split
  the existing handler into `makeFanInHeuristicReducer` (current
  behavior, default) and `makeFanInLlmReducer` (new).
- `packages/core/src/engine/validator.ts` — retire W015.
- `.agents/skills/swarm-author/SKILL.md` §10 — drop the "Fan-in
  synthesis — currently heuristic only" caveat; remove the
  downstream-codergen workaround paragraph.
- `docs/handler-contract.md` — describe both reducer kinds under the
  `parallel.fan_in` section.
- `docs/ARCHITECTURE.md` §3 if any new event types are emitted for
  the LLM-reducer path.

## Status

**Parked.** Implementation is bounded — handler-level change in the
auto-dispatcher's fan-in dispatch, plus a small builtin function
registry for the default concatenator. Workflows that already author
`prompt=` on `tripleoctagon` become correct without source changes.

Revisit alongside the JSON IR canonical-form flip
(`./json-ir-canonical.md`), so the explicit `Reduce` kind lands as
part of the typed-extensions layer rather than as a stand-alone
DOT-attr change.
