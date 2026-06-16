---
title: Structured step outputs (MVP) — typed `outputs:` on `llm` steps
summary: "An `llm` step declares typed `outputs:` with the same small type grammar used by `inputs:` (scalars, `choice`, records, arrays — a subset of JSON Schema sized to what provider strict-mode enforces; no recursion, no `$ref`). It emits through one force-included `emit_output` tool; any step consumes via `${{ outputs.X.f }}` interpolation (`llm` in prompt, `tool` in run, `human` in text). Reads fail closed — a reference the producer never populated halts the node (a recorded, replayable fact), never a silent \"\". The grammar compiles to TypeBox (already a dependency): TypeBox validates the emitted value and supplies the emit-tool schema, so author surface, our validation, and the provider's native strict-mode all agree. Oversized structs spill to the blob CAS via the input-spill path. Values interpolated into an `llm` prompt are wrapped in content-derived (hash-boundary) delimiters. MVP: only `llm` steps produce; `tool`/`human` consume."
status: implemented
maturity: shipped
last-reviewed: 2026-06-16
supersedes: an earlier, broader cut (tool-step production via $FRAGUA_OUTPUT, route-carried outputs) — narrowed to llm-only production
---

<!-- §§1–10 describe the shipped per-step MVP. §11 (run-level outputs) is the
     next increment — designed, not yet built; it carries its own callout. -->


# Structured step outputs (MVP)

> **Designed, narrow, additive.** Adds `outputs:` on **`llm` steps only**, plus
> the `${{ outputs.X.f }}` substitution token. Branching is unchanged (the
> `route` tool + `on:`/`next:`); no existing syntax changes. `tool` and `human`
> steps **consume** outputs; they do not produce them. Reads **fail closed** — an
> unpopulated reference is a node failure, not `""`. Ships as an `ir_version` bump
> + converter.

## 1. The principle

> **Reading an output a producer never populated is a loud, recoverable,
> replayable halt — never a silent `""`.**

If `${{ outputs.X.f }}` resolves and X emitted nothing on the path taken (it
never ran, or ran and failed before `emit_output`), the **consuming** node fails
closed: it halts to the operator with a named fault, it does not substitute the
empty string. That halt is itself a recorded `fact.*`, so it folds back
identically on every replay.

So outputs need **no static totality proof**. fragua's determinism is a property
of the folded event log, not of re-execution (SPEC §1, *Testable*): a faithfully
recorded runtime fault is exactly as trustworthy as a compile-time impossibility,
and it doesn't freeze the graph into being fully static. The validator's
reachability checks (§6) are advice, not a gate.

## 2. When to use `outputs:`

There are three channels for moving data between steps. Pick by what the data
*is* and what the consumer *does* with it:

| Channel | For | Cost |
|---|---|---|
| **Shared `thread:`** | steps that genuinely converse (plan ↔ implement ↔ review) | full transcript re-sent each step |
| **Environment re-derivation** | anything already on disk / in git | a fresh read; can't drift from truth |
| **Typed `outputs:`** | a consumer that needs a value *typed* — to run it, pass it verbatim, or aggregate several producers' results | a typed, validated hand-off |

Default to the **thread** for conversational context and the **environment** for
anything on disk. Reach for `outputs:` when the consumer benefits from the value
being *typed and addressable* rather than embedded in prose. Two patterns where
that benefit is real:

- **A mechanical consumer takes the value verbatim.** A `tool` step substitutes a
  computed scalar into its `run:` with no model in between; an `llm` passes a
  value through unchanged to a tool. Getting it wrong is a bug, not a re-read.

  ```yaml
    merge:
      type: tool
      run: gh pr merge ${{ outputs.scope.pr_number }} --auto --squash
  ```

- **A synthesizer aggregates several producers.** When multiple `llm` steps each
  produce a structured result and a downstream step combines them — e.g. several
  review lenses each emitting typed `findings`, fed to a `synthesize` step — typed
  outputs give the consumer clean per-source access. A shared thread would
  interleave the sources as prose the synthesizer has to disentangle; typed
  outputs keep each producer's result distinct and let the synthesizer run on a
  fresh context. This is a legitimate `llm → llm` hand-off — the consumer being an
  `llm` does not disqualify it.

  ```yaml
    synthesize:
      type: llm
      prompt: |
        Reconcile the lens findings into one verdict.
        Correctness: ${{ outputs.review_correctness.findings }}
        Security:    ${{ outputs.review_security.findings }}
  ```

Do **not** reach for `outputs:` when another channel already serves:

- **The steps converse** (plan ↔ implement ↔ review, or a producer and consumer
  that share a thread and read each other's prose) → the thread. Typing it
  mutilates the conversation, and the data is already present.
- **The value is already in the environment** (the diff a gate judges, the deps a
  bump moved) → re-derive it. Cheaper, and it can't drift.
- **A large prose body a tool consumes** (a review for `gh --body-file`) → a file
  the consumer reads, not a typed string.
- **Human display** (a report shown at a gate) → the thread shows prose; a gate's
  `text:` is not for typed JSON.
- **A single producer with no downstream consumer** → there's nothing to hand off.

The throughline: `outputs:` exists so a downstream step can act on a value
without locating and re-parsing it out of a transcript. Where the transcript
already serves the consumer, the thread is the better channel.

## 3. Scope

Additive; breaks nothing already authored.

**In:**

- `outputs:` on **`llm` steps only**, declared with the type grammar shared with
  `inputs:` (§5).
- `${{ outputs.X.f }}` substitution token (fail-closed): a scalar leaf
  interpolates as its value; a record/array as JSON; a dotted leaf reaches a
  scalar inside a structure. Consumed by `llm` (`prompt:`), `tool` (`run:`), and
  `human` (`text:`).
- `emit_output` — one force-included tool whose schema is the node's `outputs:`
  schema; a single call carries the whole struct. The only production mechanism.
- Native strict-mode enforcement of `emit_output` where the provider supports it,
  automatic via pi-ai (§7).
- Spill: an output rides inline on the fact when it fits the event-payload cap and
  spills to the blob CAS (`{$fragua_blob: sha}` ref, rehydrated on read) when it
  doesn't, over the same path run inputs use.
- Content-derived (hash-boundary) wrapping of output values interpolated into an `llm` `prompt:`
  (§6).
- Validator reachability checks: E035 (broken/dead reference), W015 (producer may
  not run on every path).

**Out:**

- `outputs:` on a step that also `routes:` — a routing step's terminal call is
  `route`, not `emit_output`; the two are mutually exclusive.
- Tool-step production (`$FRAGUA_OUTPUT`); `tool` steps consume, never produce.
- Native final-message JSON as an emit backend (`output_config.format` /
  `response_format`).
- ~~`object`/`array` types in `inputs:`~~ — was out of the original MVP cut;
  **shipped as a later increment (§12).**
- Routing on emitted values, binary/`blob` outputs, HITL (`human`-produced)
  outputs.

## 4. The model

Three step kinds, unchanged: `tool` (deterministic shell, exit code → outcome),
`llm` (a reasoner running its own bounded tool-use loop), `human` (an operator
gate). All three **consume** `${{ inputs.* }}` / `${{ outputs.X.f }}` by
interpolation. **Only `llm` steps produce** `outputs:`, and only when they do not
`route:`. Data flows forward only, typed, fail-closed on read.

> **Interpolating into a `tool` `run:` is a shell-injection surface** — the fix is
> the `exec:` argv form ([`tool-exec-variant.md`](tool-exec-variant.md)), which
> substitutes per-argument with no re-split. A `tool` step interpolating a
> generated value should use `exec:`. (Distinct from the prompt-injection surface
> in §6.4, which has its own fix.)

## 5. The type surface

`inputs:` and `outputs:` share **one type-declaration grammar** — same type
keywords, one parser, one compiler, one validator. The type vocabulary is
identical; only the presence modifiers differ, because providing a value and
producing one are different acts: a top-level input takes `required:` / `default:`,
a record field takes `optional:` (required by default).

The grammar is a small subset of JSON Schema — the structural core that provider
strict-mode enforces:

| Key | Means | Lowers to |
|---|---|---|
| `type: string \| number \| boolean` | scalar | the scalar type |
| `type: choice` + `options: [...]` | closed set | `enum` |
| `type: object` + `fields: { name: <decl>, … }` | record | `properties` + `required` + `additionalProperties: false` |
| `type: array` + `items: <decl>` | homogeneous list | `array` / `items` |
| `description:` | doc string | `description` |
| *(inputs only)* `required:`, `default:` | provide-time | — |

```yaml
inputs:
  ticket: { type: string, required: true, description: Bug ticket id }
  env:    { type: choice, options: [dev, staging, prod], default: dev }

outputs:
  findings:
    type: array
    items:
      type: object
      fields:
        severity:   { type: choice, options: [low, medium, high] }
        file:       { type: string }
        note:       { type: string }
        suggestion: { type: string, optional: true }
```

`fields:` and `items:` nest to any fixed depth. A record field is **required by
default**; mark one `optional: true` to let it be absent (it lowers to a nullable
type — see below). **No recursion and no `$ref`** — a tree type can't be enforced
by provider strict-mode and has no finite leaf path for dotted reads. **No
constraint keywords** (`minimum`/`maxLength`/`pattern`/`format`): the providers
don't enforce them in strict-mode, and they are predicates that belong as a check
in the producing step, not in the type.

**Validation: TypeBox.** The grammar compiles to a TypeBox schema
(`compileTypeDecl`); TypeBox's `Value.Check` validates the value, and the same
schema is the `emit_output` tool's `parameters`. `choice` lowers to `enum`,
records get `additionalProperties: false`, and an `optional: true` field is
omitted from `required` and lowered to a nullable type (`anyOf: [T, null]`) — so a
model may either omit it or emit an explicit `null`, and our post-emit +
read-time validation accepts both. (Keeping it out of `required` rather than
nullable-but-required avoids a strict provider rejecting a legitimately-omitted
field; validation, not provider strict-mode, is the guarantee — strict mode just
cuts retries.) Because the grammar is exactly the provider-supported subset, the
schema means the same thing to the author, to our validation, and to the
provider's native enforcement.

## 6. Enforcement and fail-closed reads

1. **Emission through one exit tool.** An `llm` node with `outputs:` exits via the
   force-included `emit_output` tool (ground rule 12), whose schema is the
   `outputs:` schema. The prompt instructs the model to call it; after the agent
   loop the backend reads the last `emit_output` call and validates its arguments
   against the schema (TypeBox). A node that declares `outputs:` and ends without
   a valid emission is a node failure (`outcome=fail`).

   pi-ai's `Context` exposes no `toolChoice`, so emission is prompt-instructed and
   validated post-hoc rather than provider-forced; a model that ignores the
   instruction fails the node (retryable). Provider strict-mode (§7) guarantees
   the arguments are schema-valid *if* the call happens.

2. **Fail-closed reads.** `${{ outputs.X.f }}` resolving to an unpopulated field
   throws in the substitution resolver; the handler turns it into a routable
   `outcome=fail`. The fault is recorded as a `fact.*` and folds back identically
   on replay. The populated-guarantee is enforced at read time.

3. **Reachability checks (advisory).** The validator extracts every
   `${{ outputs.X.f }}` reference and raises **E035** when X doesn't declare `f`,
   or when X can never reach the consumer (a dead reference). It raises **W015**
   when X can reach the consumer but isn't guaranteed to — the reference fails
   closed at runtime if X didn't run. W015 does not fire when the consumer is
   reached only on a path where X did run (e.g. a recovery step behind another
   node's `fail:` edge).

4. **Untrusted-content delimiting (prompt-consumption).** An output interpolated
   into an `llm` `prompt:` is wrapped in a tag whose boundary id — a **content
   hash** — lives in the *element name*, and a standing system-prompt rule marks
   those regions as data, not instructions:

   ```text
   <fragua_output_9c1f2a3b4d5e6f70>[ … the value (scalar verbatim, record/array as JSON) … ]</fragua_output_9c1f2a3b4d5e6f70>
   ```

   The hash sits in the name (not an attribute) so the open/close pair is
   well-formed markup: a markdown renderer — the web conversation view — treats it
   as an unknown element and hides the tags, instead of printing a broken
   `</tag attr="…">` literal.

   A **content-derived boundary** (not a random nonce) is the right fit: a value
   can't contain its own closing tag without a hash preimage, so the delimiter is
   collision-free by construction — and it's *deterministic*, so the same value
   renders identically on replay (a random nonce would have to be recorded). It's
   computed locally in the substitution resolver (a browser-safe synchronous
   hash), so no per-run state threads through the handler or agent. This applies
   to `llm prompt:` only: `tool run:` is shell injection (use `exec:`, §4) and
   `human text:` is read by a person. It closes one window — the shared `thread:`
   and the agent loop's raw tool/file/bash results still enter prompts
   un-delimited (§9). Best-effort defense-in-depth, not a cryptographic guarantee.

## 7. Provider-native enforcement

Anthropic and OpenAI both expose structured output in two forms over their chat
endpoint:

| Form | Anthropic | OpenAI | Constrains |
|---|---|---|---|
| Strict tool/function args | `strict: true` on a tool | `strict: true` on a function | the tool-call arguments |
| Final-message JSON | `output_config: { format: { type: json_schema, schema } }` | `response_format: { type: json_schema, json_schema: { strict } }` | the final assistant message |

Both accept only a subset of JSON Schema (objects with
`additionalProperties: false`, enums, arrays, scalars; no numeric/string/length
constraints, no recursion) — the subset the §5 grammar already is.

Our LLM layer is **pi-ai**, whose `Context` is `{ systemPrompt, messages, tools }`
— no `response_format`/`output_config` field, no `toolChoice`. Its only
structured-output surface is the **tool channel**: a `Tool` carries
`parameters: TSchema`, and the per-model `supportsStrictMode` flag (default
`true` for the direct Anthropic and OpenAI models) controls whether pi-ai sends
the `strict` field with the tool definition.

So defining `emit_output` with the §5 schema makes pi-ai apply the provider's
native strict-mode enforcement to it on Anthropic and OpenAI, with no
per-provider code. The tool channel is the native-backed path on those providers,
not a fallback.

Correctness does not depend on it. We validate the emitted struct ourselves
(TypeBox) and fail closed on read. On a strict-capable provider, native
enforcement means our validation rarely rejects — fewer retries. On a
non-strict / custom / OSS-via-openai-compat provider, an invalid struct is caught
by our validation and fails the node. Native strict-mode is an optimization
layered on a guarantee we own.

The final-message JSON form (typed output as the model's last message, no tool
round-trip) is a deferred backend (§10): pi-ai exposes no field for it, but its
`onPayload` hook can override the request body to inject the schema per
`model.api`. It would sit behind the same `outputs:` declaration, validation, and
fail-closed read; `emit_output` stays the universal floor.

## 8. Where it lands

The seams already exist; none is greenfield.

| Seam | File(s) | Change |
|---|---|---|
| Shared type grammar | `core/src/parser/yaml.ts`, `core/src/types/` | one declaration grammar; `compileTypeDecl` → TypeBox; `choice`→`enum`, `additionalProperties:false`, optional→nullable (E033/E034) |
| Substitution token | `core/src/engine/substitution.ts` | `${{ outputs.X.f }}` resolver; fail-closed; content-derived-boundary wrap on `prompt:` interpolation |
| Validator reachability | `core/src/engine/` | E035 / W015 |
| Emit tool synthesis | `agent/src/backend.ts` | build the `emit_output` schema like the `route` tool; post-loop read + validate |
| Outputs index | `store/src/outputs-queries.ts` | rebuildable `(run_id, node_id) → struct`, written same-transaction, off the `run_state` fold (a re-snapshot, not an `EVENT_CONTRACT_VERSION` bump) |
| Fact carries outputs | `daemon/src/result-to-facts.ts` | `fact.node_completed.payload.outputs` (inline, or `{$fragua_blob}` ref) |
| Spill | `store/src/` (input-spill path) | reuse the `{$fragua_blob: sha}` ref + scrubber + bundle export/import that run inputs already use |
| Schema/IR version | `store/src/migrations.ts`, IR converter | `ir_version` bump + converter; reversible migration step (the `outputs` index is rebuildable → non-lossy `down`) |

Most of this exists, built and tested, on the prior `feat/structured-outputs`
branch and is reusable as written:

- the type compiler `compileOutputsToTypeBox` + `validateOutputsValue` (generalise
  to `compileTypeDecl` so `inputs:` and `outputs:` share one grammar);
- the `emit_output` tool synthesis and post-loop transcript read;
- the `${{ outputs.X.f }}` resolver and the combined inputs+outputs single-pass
  substitution;
- the validator codes E033/E034/E035/W015;
- the outputs index table, the spill path, and the reversible migration step;
- the `yaml-outputs` / `outputs-profile` / `outputs-substitution` /
  `validator-outputs` / `emit-output` test suites.

Not carried over: `$FRAGUA_OUTPUT` (tool production) and the route-carried-outputs
schema augmentation.

## 9. Risks and non-goals

- **Over-use.** The failure mode is wiring `outputs:` where the thread or the
  environment already serves (§2). The MVP's narrowness (llm-only production, no
  routing) blocks the most tempting misuses; the rest is authoring discipline,
  carried by §2 and the `workflows` skill. A future advisory lint could flag an
  output consumed only by a single same-thread `llm`.
- **Emission is not provider-forced.** Without `toolChoice` (§6.1), a model can
  decline to call `emit_output`; the node then fails closed and retries. This is
  strictly safer than the silent `""` it replaces, and tightens to a hard force if
  pi-ai gains `toolChoice`.
- **Spilled outputs are refs, not inline.** A spilled struct is a `{$fragua_blob}`
  ref rather than inline event content — the same forensics tradeoff run inputs
  and artifacts already carry.
- **Outputs in exported bundles.** Inline outputs ride
  `fact.node_completed.payload.outputs`; the egress scrubber must walk nested
  string values there (it already redacts event-payload free-text). Confirm the
  walk covers `payload.outputs` during implementation.
- **Prompt-injection scope.** Output-wrapping (§6.4) delimits output→prompt
  interpolation only. The shared `thread:` and the agent loop's raw tool/file/bash
  results remain un-delimited; the cross-cutting mitigation is a separate effort
  (§10), and the wrap must not be presented as full injection protection.

## 10. Deferred follow-ups

Each rides its own proposal/PR; the MVP's contract admits each without a rewrite.

1. **Route-carried / fact-routing outputs** — let a routing `llm` step also hand
   off data, by making `route` a reserved field inside the outputs record (so
   `routes:` becomes sugar and a branch carries data only when it has data).
2. **Native final-message JSON emit backend** (§7) via pi-ai `onPayload`,
   capability-gated per `model.api`.
3. **Tool-step production (`$FRAGUA_OUTPUT`)** — the gather→judge composition (a
   `tool` emits structured evidence an `llm` judges).
4. **Cross-cutting untrusted-content delimiting** — extend §6.4 from
   output→prompt interpolation to the shared `thread:` and tool/file/bash results.
5. ~~**`object`/`array` types in `inputs:`**~~ — **promoted to §12** (designed).
6. **Richer type vocabulary** — constraint keywords enforced at our layer via
   TypeBox, and/or accepting raw JSON Schema documents.
7. **`blob` (binary/file) outputs** and **HITL outputs** (operator-supplied typed
   values from a `human` gate).

## 11. Run-level outputs (designed)

> **Designed, not yet built.** §§1–10 (per-step `outputs:`) are shipped; this
> is the next increment. Driver: a fragua run embedded as a single step in an
> outer engine ([`ernesto-interop.md`](ernesto-interop.md)) is a black box
> whose result the caller binds — a run exposing only thread text is a dead
> end in the caller's DAG. The same projection is what a future `fragua runs`
> verb would print as a run's typed result.

A workflow declares a top-level `outputs:` block that **projects** step
outputs into the run's typed result:

```yaml
outputs:
  verdict:  { from: review.verdict }
  findings: { from: review.findings }
  status:   { from: scan.status, default: skipped }   # default: deferred — §11.4
```

`from:` is a `<node>.<path>` reference — the same addressing as the
`${{ outputs.<node>.<field> }}` token, minus the wrapper. A bare `from: review`
projects the producer's whole struct; a dotted suffix selects a leaf or
sub-record. The run-output's **type is the referenced field's type** — the §5
grammar, no new type surface. (This mirrors Ernesto's
`WorkflowDeclaration.outputs` `{ from, pick }` with node and path folded into
one ref; the exact cross-engine key alignment is
[`ernesto-interop.md`](ernesto-interop.md) open decision #4, not settled here.)

**Why a projection, not the token.** `${{ outputs.X.f }}` is an in-graph
*consumer* read and **fails closed** (§1) — an unpopulated read halts the
reading node. The run-output block is not a consumer; it is the run's egress
report, and it must tolerate a declared output that the taken path never
produced (§11.1). Reusing the fail-closed token would turn every such run into
a halt. The two surfaces deliberately read with different semantics, so they
are different syntax.

### 11.1 The run-boundary contract — typed-partial

A run can reach `fact.run_completed` on a path that never ran a declared
producer: a `fail:` edge whose target is the `exit` sink is a sanctioned
completion (SPEC §3.6), not a halt. So the egress envelope is **typed-partial**
— it carries exactly the declared outputs whose producer ran; an unproduced
one is **absent** (its key is omitted from the envelope), never `""` and never
a halt.

This does not weaken §1's fail-closed principle. Fail-closed governs an
in-graph consumer's read; the run boundary is a different surface that reports
what the run produced to an *external* caller, which owns its own
absence-handling (an embedding engine's per-step fallback / skip). A
typed-partial envelope is a faithful report, not a silent substitution.

- **Absent vs. null are distinct.** Key omitted ⇒ the producer did not run on
  the taken path. Key present with `null` ⇒ the producer ran and emitted an
  `optional:` field as `null`. A consumer can tell the two apart. (A `from:`
  path that reaches through an `optional:` field the producer *omitted* is
  likewise absent — the same key-omitted shape; the per-step W016 advisory
  carries to such a run-output ref.)
- **Only `completed` has an envelope.** `halted` / `cancelled` carry no
  outputs (the run reached no sanctioned terminal); a `quarantined` (held,
  non-terminal) run has none until it resolves.

### 11.2 Producer multiplicity

- **A producer that ran more than once** (a goal-gate / `fail:`-edge loop, a
  retried node) resolves to its **latest** completed emission — identical to
  how an in-graph `${{ outputs.X.f }}` read already resolves.
- **A static `parallel` branch terminal** is an ordinary node with its own
  `nodeId` (SPEC §3.1.1); reference it directly, `from: scan_branch.findings`.
  There is no whole-fan-out aggregation on `main` — when dynamic fan-out lands,
  its `outputs.<body>[*].field` array addressing extends `from:` unchanged.

### 11.3 Where it lands

A read-plane projection, not a new fact or write path. The run already carries
its workflow IR (the `outputs:` block) and the rebuildable outputs index
(`(run_id, node_id) → struct`, §8). The read plane resolves each declared
output by looking up `(run_id, from-node)`: a row present ⇒ project the field
(rehydrating a `{$fragua_blob}` spill if the struct spilled); no row ⇒ the
output is absent. The result surfaces as `RunDetail.outputs` and rides the
export bundle for free (both inputs to the projection — the IR's `outputs:`
block and the outputs index — are already in it). The top-level `outputs:`
block is a new IR-core attr, so building it is an `ir_version` bump + converter
of its own (the per-step feature established the pattern); the read-plane
projection itself touches no schema and needs no migration.

### 11.4 Validation

Two checks, reusing the existing per-step machinery — one gate, one advisory:

- **E046 (broken projection) — hard error.** `from:` names a node that
  declares no `outputs:`, or a `<path>` the producer's schema doesn't declare.
  A definite authoring bug; gated exactly as the per-step E035 (a broken
  reference is not a reachability question).
- **W018 (may not produce) — advisory.** The producer can reach a completing
  terminal but is not guaranteed to on every such path — the W015 analog at
  the run boundary, reusing its path-analysis. Consistent with §1 (totality is
  advice, not a gate); a declared `default:` (§11.5) silences it.

### 11.5 `default:` — deferred-but-sound

A run-output may carry a typed `default:` — a **literal, validated against the
output's own type at parse time** — surfaced in place of absence. It turns a
typed-partial envelope total at the author's option and silences W018.

This is **deferred**, not v1: typed-partial is the floor, and an embedding
engine's own per-step fallback already absorbs absence downstream, so the
default is additive convenience. The MVP contract admits it without a rewrite
— a later `default:` only fills slots that were otherwise absent.

It is deliberately **a typed literal, not a fallback expression.** Ernesto's
step `fallback` is a runtime `${{ }}` expression that can itself read an
unpopulated output and fail; `default:` is a parse-time-checked constant, so
it cannot recurse or fail at runtime. Fail-closed survives: a producer-less
output with no declared default stays **absent**, and the system never
substitutes a value the author didn't write. (An author may write
`default: ""` — that empty string is then their explicit, recorded choice, the
opposite of the silent `""` §1 forbids.)

## 12. Object / array inputs (implemented)

> **Shipped.** A workflow may declare `type: object` (with `fields:`) and
> `type: array` (with `items:`) inputs over the SAME restricted grammar `outputs:`
> uses. The CLI coerces `--input name=<json>` by declared type and accepts a
> whole-object `--input-json '<json>'`; malformed JSON for a declared
> object/array input is a clean parse-/enqueue-time error. `${{ inputs.x }}`
> renders the whole value as JSON; `${{ inputs.x.field }}` dot-reads into it
> (leniently — unlike fail-closed outputs).

A workflow declares a non-scalar input over the same grammar `outputs:` uses:

```yaml
inputs:
  ticket: { type: string, required: true }
  config:
    type: object
    fields:
      env:   { type: choice, options: [dev, staging, prod] }
      flags: { type: array, items: { type: string } }
```

read as `${{ inputs.config.env }}` (dotted into the record) or
`${{ inputs.config }}` (the whole record as JSON) — both already resolve in
`substitution.ts`. Three small moves:

1. **Lift the scalar-only restriction** on `inputs:` declarations. The §5
   grammar already admits `object`/`array` (it *is* the `outputs:` grammar);
   the MVP merely gated `inputs:` to scalars.
2. **Type-directed coercion.** The CLI resolves `--input name=value` to a
   *string* and defers coercion to schema validation (`cli/src/commands/run.ts`
   — "type coercion is the server's job against the `inputs:` schema"). For a
   declared object/array input, `JSON.parse` that string before the TypeBox
   check. So `--input tags='["a","b"]'` and `--input config=@cfg.json` work
   with **no new flag** — composing with the existing `@<path>` / `@-`
   sourcing. Scalar inputs are unchanged (string verbatim).
3. **A whole-object form** — `--input-json '<json>'` (and/or `--inputs-file
   <path>`): the entire inputs object in one shot, validated against the same
   compiled `inputs:` schema. The ergonomic path for a **programmatic caller**
   — the [`ernesto-interop.md`](ernesto-interop.md) `kind: 'fragua'` handler
   holds its inputs as one object and would otherwise decompose + per-value
   JSON-encode across N `--input` flags; with this it is one
   `JSON.stringify`, and typed objects round-trip natively.

Validation is **free**: the `inputs:` declaration already compiles to a
TypeBox schema (§5); a parsed object flows through the same `Value.Check`. One
new failure mode: malformed JSON for a declared object/array input is a
**parse-time error** (the input analogue of the fail-closed emit; code
assigned at build), surfaced at enqueue before the run starts — never a silent
coercion. The `--input` surface gains a "scalar verbatim vs JSON-parsed-by-
declared-type" rule the `workflows` skill documents.

## Related

- The `route` tool + two-case edge selector (SPEC §3.6; `edge-selection.ts`;
  synthesis in `agent/src/backend.ts`) — unchanged; outputs sit alongside it.
- [`tool-exec-variant.md`](tool-exec-variant.md) — the `exec:` argv form for
  injection-safe interpolation into commands.
- [`workflow-ir.md`](workflow-ir.md) — `outputs:` is an IR-core attr; ships as an
  `ir_version` bump + converter.
