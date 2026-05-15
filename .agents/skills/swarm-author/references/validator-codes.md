# Validator codes

Errors fail validation; warnings are strong hints. Source: `packages/core/src/engine/validator.ts`.

## Errors

| Code | What it means |
|---|---|
| E001 | No start node (missing `shape=Mdiamond`). |
| E002 | Multiple start nodes — pick one. |
| E003 | No exit node (`shape=Msquare`). |
| E004 | Edge references a node id that doesn't exist. Typo in source or target. |
| E005 | `$<id>.output` references an unknown node id. |
| E006 | Cycle with no reachable exit — the run can't terminate. |
| E007 | `component` node without valid `fan_in=` (missing or wrong shape). |
| E008 | `parallelogram` node without `tool_command=`. |
| E009 | `hexagon` node has no outgoing edges — operator's selection has nowhere to route. |
| E010 | `hexagon` outgoing edges produce duplicate accelerator keys (e.g. two `[A] …`). |
| E011 | `retry_target` / `fallback_retry_target` references an undefined node. |
| E012 | Start node has incoming edges (attractor §11.2). |
| E013 | Exit node has outgoing edges (attractor §11.2). |
| E014 | Edge `condition` failed to parse — most often a literal containing whitespace. Quote the literal or use an underscored sentinel (e.g. `RANK_CLEAN`). |
| E015 | `model_stylesheet` syntax error. Surfaces parse failures at validate-time. |
| E016 | Node `type=` names a handler outside the known set (`start | exit | codergen | conditional | wait.human | parallel | parallel.fan_in | tool`). Typo or invented type — there is no extension surface. |

## Warnings

| Code | What it means |
|---|---|
| W001 | Orphan node (no in-edges, not start). Usually a copy/paste leftover. |
| W002 | Node unreachable from start. Dead code. |
| W003 | Node has only conditional edges, no `outcome=fail` catch-all. |
| W004 | Hexagon outgoing edge uses legacy `context.hitl.*` condition. Structured HITL routes by `[K] Label` accelerator (see SKILL §12). |
| W005 | Duplicate edge. |
| W006 | Reserved / unused. |
| W007 | `goal_gate=true` node has no retarget at any level — failure can only halt. |
| W008 | `retry_policy` / `default_retry_policy` is not a known preset (`none|standard|aggressive|linear|patient`). |
| W009 | Codergen (`box`) node has empty `prompt` and empty `label`. |
| W010 | `fidelity` value not recognised — runtime falls back to `compact`; surfaces typos like `compcat`. |
| W011 | Codergen (`box`) node declares bare `model` / `provider` without the `llm_` prefix. The agent backend reads only `llm_model` / `llm_provider`; bare keys are silently dropped and the run falls through to the daemon default. Suppressed when the prefixed form is set OR a graph `model_stylesheet` rule covers the node. |
| W012 | Node `type=` and shape resolve to different handlers. `type=` wins at dispatch (attractor §2.6 + §4.2); the warning flags the divergence. Suppress by aligning shape with `type=` or by dropping `type=` when it duplicates the shape's canonical handler. |
| W013 | Unrecognised attribute name on a node, edge, or graph. The parser passes unknown attributes through silently (`NodeAttrs[extra: string]`); this lint catches typos like `goalgate=true` or `max_ms=…` (the runtime expects `maxMs`). Canonical list: `packages/core/src/types/graph.ts` (`NodeAttrs` / `EdgeAttrs` / `GraphAttrs`). |
| W014 | Attractor-only attribute that swarm intentionally does not honor (currently `auto_status` on nodes, `loop_restart` on edges). See SPEC.md §6.5 for rationale. Drop the attribute or accept the no-op. |

`--strict` makes warnings fail the command. The CLI doesn't expose it yet; the API (`validate(graph, {strict:true})`) does.
