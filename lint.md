# Lint: closing the rule gap

## Context

Attractor §7 defines thirteen built-in lint rules. Swarm implements
eleven of them, with mostly-correct semantics but drift on one
(missing-edge-source check via `E004` covers part of what spec
prescribes).

Current rules in `packages/core/src/engine/validator.ts`:

| Code | Severity | Spec equivalent | Behaviour |
|---|---|---|---|
| E001 | error | `start_node` (count == 1, present) | Mdiamond required |
| E002 | error | `start_node` (count == 1, unique) | Multiple Mdiamond rejected |
| E003 | error | `terminal_node` (present) | Msquare required |
| E004 | error | `edge_target_exists` | Source AND target node refs validated |
| E005 | error | partial: `$nodeId.output` references | Substitution refs resolve |
| E006 | error | (extension) | Cycle without reachable exit |
| E007 | error | (extension) | parallel/fan_in shape correctness |
| E008 | error | (extension) | tool node has `tool_command` |
| E009 | error | (extension) | wait.human (hexagon) has ≥1 outgoing edge |
| E010 | error | (extension) | wait.human outgoing edges have unique accelerator keys |
| W001 | warning | (extension) | orphan: no incoming edges |
| W002 | warning | `reachability` | unreachable from start |
| W003 | warning | (extension) | no fail-edge fallback |
| W005 | warning | (extension) | duplicate edges |

E006/E007/E008/E009/E010/W001/W003/W005 are swarm extensions — useful, keep
them.

E009/E010 catch the two HITL construction errors at validate-time
instead of at first dispatch (auto-dispatcher catches them too as
defense-in-depth).

## Gap vs §7.2

Six rules from the spec are missing entirely. Two more have caveats.

### Missing (six)

| Spec rule | Severity | What it checks |
|---|---|---|
| `start_no_incoming` | error | The start node has no incoming edges |
| `exit_no_outgoing` | error | The exit node has no outgoing edges |
| `condition_syntax` | error | Edge `condition` parses (valid keys, operators) |
| `stylesheet_syntax` | error | `model_stylesheet` parses (only relevant if §8 lands — see `stylesheet.md`) |
| `fidelity_valid` | warning | `fidelity` value is one of `full`, `truncate`, `compact`, `summary:{low,medium,high}` |
| `retry_target_exists` | warning | `retry_target` / `fallback_retry_target` references exist |
| `goal_gate_has_retry` | warning | `goal_gate=true` node has a retry target somewhere in chain |
| `prompt_on_llm_nodes` | warning | codergen-typed nodes have non-empty `prompt` or `label` |
| `type_known` | warning | Node `type` attribute is registered in the handler registry |

### Caveats on existing rules

- **E001 vs `start_node`** — Spec accepts either `shape=Mdiamond` or
  id matching `start`/`Start`. Swarm requires `Mdiamond` only
  (`validator.ts:50`). Either tighten the spec or loosen the lint;
  current state is a real behaviour drift for authors copying spec
  examples.
- **E003 vs `terminal_node`** — Same drift on `Msquare` vs
  `exit`/`end` id fallback (`validator.ts:51`). Spec also requires
  `terminal_node` to be unique; swarm only checks presence.

## Plan

One PR, one new file `packages/core/src/engine/lint-rules.ts`
extracting per-rule helpers from the monolithic `validator.ts`.
Existing rules keep their codes. New rules are added as separate
exports the main `validate()` function calls in sequence.

### 1. Trivial structural rules (cheap)

`start_no_incoming` and `exit_no_outgoing` are one-pass scans over
edges:

```ts
function checkStartIsolation(graph, starts): Diagnostic[] {
  if (starts.length !== 1) return [];
  const startId = starts[0]!.id;
  return graph.edges
    .filter(e => e.to === startId)
    .map(e => ({
      severity: "error", code: "E011",
      message: `start node "${startId}" has incoming edge from "${e.from}"`,
      edge: { from: e.from, to: e.to },
    }));
}
```

Same shape for `exit_no_outgoing` (E012).

### 2. Attribute-value rules (cheap)

`fidelity_valid` (W007) walks nodes, checks `node.attrs.fidelity`
against the enum at `packages/core/src/types/fidelity.ts:1-7`. Same
for graph `default_fidelity`. Edge fidelity overrides too.

`type_known` (W008) walks nodes, checks `node.attrs.type` against
the registered handler types. The registry is currently inline in
`packages/daemon/src/auto-dispatcher.ts`; expose its key set via a
`registeredHandlerTypes(): string[]` accessor and feed it into the
linter through `ValidateOptions`.

### 3. Cross-reference rules

`retry_target_exists` (W009) — for every node and the graph,
`retry_target` and `fallback_retry_target` reference an existing
node id. Use the same `nodeIds` set already built in `validate()` at
`validator.ts:49`.

`goal_gate_has_retry` (W010) — every node with `goal_gate=true` has
*some* retry target reachable: its own, or the graph's. Cheap
attribute check.

`prompt_on_llm_nodes` (W011) — every node that resolves to the
codergen handler (default for `box` shape, no explicit `type`
override pointing elsewhere) has a non-empty `prompt` or `label`.
Mirrors §2.6's "Falls back to `label` if empty for LLM stages".

### 4. Condition syntax (the harder one)

`condition_syntax` (E013) parses every edge's `condition` against
the grammar at `packages/core/src/types/condition.ts`. The condition
parser is already separable — wire it into the linter, surface parse
errors as `Diagnostic` with `loc` pointing at the edge.

This rule prevents the worst-feeling failure mode in swarm today: a
typo in a condition (`outccome=success`) silently fails to match,
the edge is skipped, the run takes a different path, and the author
has no idea why.

### 5. Stylesheet syntax (conditional)

`stylesheet_syntax` (E014) only matters if `stylesheet.md`
implements §8. If we rip the attr instead, this rule is dead. Skip
for now; ship with the stylesheet PR.

### Code-allocation summary

Codes E009/E010 are taken (HITL rules, already shipped). Pass-one
new rules occupy E011/E012 + W007–W011. Pass two takes E013. The
stylesheet rule (E014) rides with whatever PR resolves the §8
implement-or-rip decision.

## Renumbering

Spec uses descriptive rule names; swarm uses E### / W###. Keep the
codes for stable diagnostics, add the spec name as `Diagnostic.rule`
alongside `Diagnostic.code`. Backward-compatible: existing consumers
keep reading `code`; new consumers can match on `rule`.

```ts
export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;          // existing: E001, W003, …
  rule: string;          // new: "start_node", "fidelity_valid", …
  message: string;
  // …
}
```

## Out of scope

- **Custom rule registration API.** Spec §7.4 defines a `LintRule`
  interface for plugins. Useful eventually; not blocking. Add when a
  caller actually needs it.
- **`info`-severity rules.** Spec mentions `INFO` but defines no
  specific rule at that level. Skip until there's a concrete use.
- **Renumbering existing codes.** E### / W### codes are presumably
  referenced in test fixtures and possibly user docs. Leave alone.
- **Strict mode improvements.** `validate(graph, { strict: true })`
  already promotes warnings to errors (`validator.ts:249-251`). No
  changes needed.

## Conclusion

The rule set is a confidence-building feature. Every missing rule
maps to a real failure swarm has hit or will hit: typo'd conditions
that route to the wrong branch, references to nodes that no longer
exist, fidelity values that get silently coerced to `compact`. Each
rule is a few lines and the linter architecture already supports
them.

Recommendation: **ship in two passes**. Pass one: trivial structural
and attribute-value rules (E011, E012, W007, W008, W009, W010,
W011) — small, no parser changes, lands in a day. Pass two:
condition-syntax rule (E013), gated on the condition parser being
exposed cleanly outside `engine/`. Stylesheet syntax (E014) rides
with whatever PR resolves the §8 implement-or-rip decision.
