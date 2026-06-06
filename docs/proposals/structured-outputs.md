---
title: Structured step outputs (MVP) — typed `outputs:` on `llm` steps
summary: "An `llm` step declares typed `outputs:` with the same small type grammar used by `inputs:` (scalars, `choice`, records, arrays — a subset of JSON Schema sized to what provider strict-mode enforces; no recursion, no `$ref`). It emits through one force-included `emit_output` tool; any step consumes via `${{ outputs.X.f }}` interpolation (`llm` in prompt, `tool` in run, `human` in text). Reads fail closed — a reference the producer never populated halts the node (a recorded, replayable fact), never a silent \"\". The grammar compiles to TypeBox (already a dependency): TypeBox validates the emitted value and supplies the emit-tool schema, so author surface, our validation, and the provider's native strict-mode all agree. Oversized structs spill to the blob CAS via the input-spill path. Values interpolated into an `llm` prompt are wrapped in per-run nonce-delimited tags. MVP: only `llm` steps produce; `tool`/`human` consume."
status: proposed
maturity: designed
last-reviewed: 2026-06-07
supersedes: an earlier, broader cut (tool-step production via $FRAGUA_OUTPUT, route-carried outputs) — narrowed to llm-only production
---

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
- Nonce-delimited wrapping of output values interpolated into an `llm` `prompt:`
  (§6).
- Validator reachability checks: E035 (broken/dead reference), W015 (producer may
  not run on every path).

**Out:**

- `outputs:` on a step that also `routes:` — a routing step's terminal call is
  `route`, not `emit_output`; the two are mutually exclusive.
- Tool-step production (`$FRAGUA_OUTPUT`); `tool` steps consume, never produce.
- Native final-message JSON as an emit backend (`output_config.format` /
  `response_format`).
- `object`/`array` types in `inputs:` (the grammar admits them; the MVP keeps
  `inputs:` scalar-only).
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
records get `additionalProperties: false`, and an `optional: true` field lowers to
a nullable type that stays in `required` so OpenAI strict (all-fields-required)
still engages. Because the grammar is exactly the provider-supported subset, the
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
   into an `llm` `prompt:` is wrapped in a per-run nonce-delimited envelope, and a
   standing system-prompt rule marks delimited regions as data, not instructions:

   ```text
   <output_a3f9c1 name="review.findings">
   [ … the value (scalar verbatim, record/array as JSON) … ]
   </output_a3f9c1>
   ```

   The nonce (a per-run random suffix) makes the delimiter unforgeable by content
   the model saw before the nonce was chosen — so data containing a literal
   `</output>` can't end the envelope early. This applies to `llm prompt:` only:
   `tool run:` is shell injection (use `exec:`, §4) and `human text:` is read by a
   person. It closes one window — the shared `thread:` and the agent loop's raw
   tool/file/bash results still enter prompts un-delimited (§9).

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
| Substitution token | `core/src/engine/substitution.ts` | `${{ outputs.X.f }}` resolver; fail-closed; nonce-wrap on `prompt:` interpolation |
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
- **Prompt-injection scope.** Nonce-wrapping (§6.4) delimits output→prompt
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
5. **`object`/`array` types in `inputs:`** — the shared grammar already admits
   them; the CLI would JSON-parse a non-scalar `--input`.
6. **Richer type vocabulary** — constraint keywords enforced at our layer via
   TypeBox, and/or accepting raw JSON Schema documents.
7. **`blob` (binary/file) outputs** and **HITL outputs** (operator-supplied typed
   values from a `human` gate).

## Related

- The `route` tool + two-case edge selector (SPEC §3.6; `edge-selection.ts`;
  synthesis in `agent/src/backend.ts`) — unchanged; outputs sit alongside it.
- [`tool-exec-variant.md`](tool-exec-variant.md) — the `exec:` argv form for
  injection-safe interpolation into commands.
- [`workflow-ir.md`](workflow-ir.md) — `outputs:` is an IR-core attr; ships as an
  `ir_version` bump + converter.
