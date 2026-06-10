# Validator codes

Errors fail validation; warnings are strong hints. Source of truth: `packages/core/src/engine/validator.ts`. An *unknown step `type:`* or malformed YAML is a **parse error** (thrown by `packages/core/src/parser/yaml.ts`), not a validator code.

## Errors

| Code | What it means |
|---|---|
| E001 | Graph has no start node. The YAML parser synthesizes `start` from the first step, so a normal workflow never hits this. |
| E002 | Multiple start nodes. |
| E003 | No exit node reachable — nothing flows to the graceful sink, so the run can't complete. |
| E004 | An edge targets a step id that doesn't exist. Typo in a `next:` / `on:` / `routes:` target. |
| E006 | Cycle with no reachable exit — the run can't terminate. |
| E008 | `tool` step has an empty `run:` (the executor has nothing to spawn). |
| E009 | `human` step has no outgoing edges and no `routes:` — the operator would have no choices. |
| E011 | `retry:` (goal-gate `retry_target`) references a step that doesn't exist. |
| E012 | The start node has incoming edges. |
| E013 | The exit sink has outgoing edges. |
| E017 | A routing step (declares `routes:`) has an outgoing edge keyed by `outcome` — routing steps discriminate by `route` only. |
| E018 | A single edge sets both `outcome` and `route`. Exactly one discriminator per edge. |
| E019 | An edge's `route=X` isn't one of the source step's declared `routes:`. |
| E020 | A routing step has an outgoing edge annotated with neither `route` nor `outcome`. |
| E021 | A `routes:` entry has no matching outgoing edge — undischarged route (missing edge or renamed value). |
| E022 | A `human` step declares no `routes:` — needs at least one named route. |
| E023 | A step combines `retry:` (goal-gate) and `routes:` — mutually exclusive exit strategies. |
| E024 | Two edges from the same step share the same `outcome` value, or the same `route` value. Shadowed edge. |
| E026 | A step sets `text:` but isn't a `human` step — `text:` is only meaningful on human steps. |
| E027 | `summary: low\|medium\|high` set on a step without a `thread` — summarising nothing has no effect. |
| E028 | Step id `exit` is reserved for the graceful sink — target it (`next: exit` / `on: {fail: exit}`), don't declare a regular step named `exit`. |
| E029 | Step id `start` is reserved for the synthesized entry node — rename the step. |
| E030 | `${{ inputs.x }}` references an input not declared in the workflow's `inputs:` block (scans `prompt` / `text` / `run`). Add it to `inputs:` or fix the typo. |
| E031 | A goal-gate step (uses `retry:`) has no `max-retries:` — the per-gate retarget cap is required on every `retry:` gate. Add `max-retries: N` to the gate step. |
| E032 | A step declares no success successor. Flow is explicit — there is no linear fall-through to the next declared step. Add `next:` / `on: {success: …}` / `routes:`, or `next: exit` to finish a branch. |
| E033 | An `outputs:` declaration uses a construct outside the restricted profile — most commonly a `choice` field with no `options`. (Out-of-profile JSON-Schema keys like `pattern`/`minimum`/`oneOf`/`$ref` are rejected earlier as a parse error.) |
| E034 | Malformed `outputs:` declaration — an empty block (no fields) or an output key that isn't a valid identifier (must start with a letter, then letters/digits/underscore). |
| E035 | A `${{ outputs.X.f }}` reference is broken (scans `prompt` / `text` / `run`): producer `X` doesn't exist, declares no `outputs:`, doesn't declare the field/path `f`, or can never reach the consumer (a dead reference). Fix the producer name, the field path, or the wiring. |
| E036 | A `parallel` step declares fewer than 2 `branches:` — fan out or use a plain step. |
| E037 | A `parallel` step's branch entry is a duplicate or names a step that doesn't exist. |
| E038 | A `parallel` step's `join:` is missing or names a step that doesn't exist. |
| E039 | A branch closure doesn't reach the join — every branch sub-pipeline must converge on `join:`. |
| E040 | A `parallel` node inside a branch closure — fan-outs don't nest. |
| E041 | A non-`llm` step inside a branch closure (tool / human / exit). Branches are deliberation-only. |
| E042 | A branch-closure `llm` step requests write-class tools (`write` / `edit` / `bash`) — branches are read-class. |
| E043 | A branch-closure step sets an explicit `thread:` — branch transcripts are per-branch synthetic threads. |
| E044 | A step is shared by two branches' closures — closures must be disjoint. |
| E045 | A `parallel` step's serialized branch list exceeds the 4 KiB event-payload budget (~hundreds of branches) — the seed fact embeds it whole. Split the fan-out. |

## Warnings

| Code | What it means |
|---|---|
| W001 | Orphan step (no in-edges, not start). Usually a copy/paste leftover. |
| W002 | Step unreachable from start. Dead code. |
| W005 | Duplicate edge. |
| W007 | A goal-gate (`retry:`) with no `retry_target` — failure can only halt. |
| W009 | An `llm` step with empty `prompt` and empty label — the call has nothing to do. |
| W013 | Unrecognised attribute on a step / edge / graph. The parser passes unknown keys through silently; this catches typos (`goalgate: true`, `max_seconds:`). Canonical list: `packages/core/src/types/graph.ts`. |
| W014 | A step's `retry-policy:` or the graph-level `default-retry-policy:` names an unknown preset. Expected one of `none` / `standard` / `aggressive` / `linear` / `patient`. Unknown values silently fall back to `none` at runtime. |
| W015 | A `${{ outputs.X.f }}` reference where producer `X` can reach the consumer but doesn't dominate its success path — on some run path the producer didn't run, so the read fails closed at runtime (a node failure, never a silent `""`). Advisory: re-wire so the producer always precedes the consumer, or accept the fail-closed branch. Suppressed when `X` is reached only on a path where it did run (e.g. a recovery step behind another node's `fail:` edge). |
| W016 | A `${{ outputs.X.f }}` reference that reaches *through* an `optional:` field (the leaf, or any record segment along the path). The producer dominates the consumer (so W015 is silent), but it may legitimately emit without that field — and a direct read of the absent value fails closed at runtime. Advisory and mutually exclusive with W015 (one ref never draws both). Fix by modelling it as a **required field with a sentinel** (e.g. `"none"`) when you always read it, or by reading the enclosing record/array **whole** (an `optional:` field inside a whole-read structure is safe — it just renders as omitted/`null` JSON). A direct optional read is only ever safe where the taken branch guarantees the field; there's no fallback syntax yet, so until then this stays a warning. |

## Removed codes — these no longer fire

These codes were retired at the YAML cutover; you won't see them, but old workflows / docs may mention them:

- **E010** — duplicate accelerator keys on a human node. The `[K] Label` accelerator vocabulary was replaced by named `routes:` (labels are free-form button text), and `accelerator.ts` was deleted.
- **E014** — edge `condition=` parse failure. The condition DSL is gone; use `outcome` / `route`.
- **E015** — `model_stylesheet` syntax error. Replaced by the `defaults:` block.
- **E016** — unknown `type:`. Now a **parse error**, not a validator code.
- **E025** — `kind=` vs shape mismatch. Shapes are gone.
- **W003 / W004** — condition-DSL catch-all / legacy `context.hitl.*` rules. Gone with the condition DSL.
- **W008** — superseded by **W014** (re-introduced under a new code). Preset-name validation is active again.
- **W012** — `type=` vs shape divergence. Shapes are gone.

`--strict` makes warnings fail the command. The CLI doesn't expose it yet; the API (`validate(graph, {strict:true})`) does.
