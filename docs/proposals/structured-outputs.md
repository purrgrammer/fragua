---
title: Structured step outputs — typed `outputs:` on `llm` steps (scalars, records, arrays)
summary: "One-directional typed data flow: `llm` steps declare `outputs:` over a restricted JSON-Schema profile (scalars + records + arrays), emit them via a single force-included `emit_output` tool, and downstream steps consume them by `${{ outputs.X.f }}` interpolation — reads fail closed, so referencing a field its producer never emitted halts loudly (a recorded, replayable fact) instead of silently collapsing to \"\". Collapses the data-plumbing half of shared-thread usage into typed, validated hand-offs. STRICTLY ADDITIVE and llm-only-production: keeps the `tool` kind, keeps `routes:`/`on:` routing and the `route` tool unchanged; tools and humans CONSUME outputs but do not produce them. Tool output production, transparent spill for oversized structures, fact-routing, and binary blobs are deferred. Post-0.1.0, via an `ir_version` bump."
status: proposed
maturity: designed
last-reviewed: 2026-05-28
---

# Structured step outputs

> **Designed, not scheduled — strictly additive, llm-only production.** Adds
> `outputs:` on `llm` steps (a restricted JSON-Schema profile: scalars, records,
> arrays) plus the `${{ outputs.X.f }}` token. It **changes no routing**
> (branching stays on the existing `route` tool + `on:`/`next:`) and **breaks no
> existing syntax**. Tools and humans **consume** outputs but do not produce
> them. Lands **post-0.1.0 as an `ir_version` bump + converter**
> ([`workflow-ir.md`](workflow-ir.md) §5) — not a 0.1.0 freeze item.

## 1. The two load-bearing principles

Everything below is in service of two sentences. If the design is cut to the
bone, keep these:

- **Why the substrate exists.** Its job is to make correctness a property of the
  *topology between an `llm` step and a `tool` step*, not of trusting either
  half. An `llm` produces candidates a `tool` executes (it can't be
  overconfident); a `tool` produces evidence an `llm` consumes (it can't
  hallucinate the facts). Typed outputs are the edge that makes those
  compositions trustworthy. **This cut ships the first half** — `llm` produces,
  `tool` consumes; the second (`tool` produces structured evidence) waits on tool
  output production (§2.1).
- **Why a reference is safe.** *Reading an unpopulated output is a loud,
  recoverable, replayable halt — never a silent `""`.* If `${{ outputs.X.f }}`
  resolves and X emitted nothing (it never ran on the taken path, or it failed
  before `emit_output`), the consuming node **fails closed**: it halts to the
  operator, it does not substitute the empty string. That halt is itself a
  recorded `fact.*`, so it folds back identically on every replay. This is the
  populated-guarantee the old `$node.output` hand-wave lacked — that token
  silently collapsed to `""`. We get the same safety *without* proving totality
  statically, because fragua's determinism is a property of the folded log, not
  of re-execution (SPEC §1, *Testable*): a faithfully-recorded runtime fault is
  exactly as trustworthy as a compile-time impossibility, and it doesn't freeze
  the graph into being fully static.

## 2. Problem

`work.yaml` and `review.yaml` lean on shared `thread:` to move data between
steps. That's two smells wearing one coat:

- **Conversation / revision loops (keep the thread).** `plan → implement →
  review → (REJECT) → implement`. The thread *is* the conversation. Structured
  outputs can't and shouldn't replace this.
- **Data hand-off dressed as conversation (the actual smell).** `scope` emits a
  `TARGET/PR/PATHS/LOC` block every downstream step re-reads;
  `pr_approve`/`pr_feedback` scrape the PR number back out of the thread; the
  dependency `update` step hands a bump list to `fix` through a thread. Structs
  cosplaying as prose — carried at full transcript cost, read nondeterministically.

Today the only substitution token is `${{ inputs.<name> }}` (ground rule 13).
`$node.output` was banned because the old hand-wave silently collapsed an
unpopulated reference to `""`. A typed schema + fail-closed reads (§3) is exactly
what retires that reason — the unpopulated case now halts loudly instead.

**The material win is step elimination, not context trimming** — collapsing the
data-hand-off threads into typed, validated outputs, and letting bare `tool`
steps consume them.

## 2.1 Scope — what lands, what's out

Additive; breaks nothing already authored.

**In:**
- `outputs:` block **on `llm` steps** (new key). Types are a **restricted
  JSON-Schema profile**: scalars (`string`/`number`/`boolean`/`choice`),
  **records** (`object` with typed fields), and **arrays** (`array` of a type).
  See §3 for the profile boundary and *why a profile, not full JSON Schema*.
- `${{ outputs.X.f }}` substitution token (new token, fail-closed): a scalar
  leaf interpolates as its value; a record/array interpolates as JSON; dotted
  leaf access reaches a scalar inside a structure. An unpopulated reference is a
  node failure, not an empty string.
- **`emit_output`** — a single force-included tool whose schema is the node's
  whole `outputs:` profile; one call closes the turn (the only emission
  mechanism).
- Fail-closed reads, plus a static reachability **W-code** (an undeclared field
  or an entirely-unreachable producer stays a hard error).

**Out (deferred / non-goal):**
- **Tool output production.** Tools and humans **consume** outputs (interpolation
  / gate text) but do not declare `outputs:`. The `$FRAGUA_OUTPUT` channel and
  the tool→`llm` *gather→judge* half of §1 are a later layer — they arrive
  together (a tool emitting structured, validated evidence an `llm` judges).
- **Transparent spill for oversized structures.** A record/array must fit the
  event-payload cap (ARCH P12); one that exceeds it is a node failure. Spilling
  large structures to the artifact store (rehydrated on read) is a follow-on.
- **Routing on emitted values (`when:`/`edges:`).** Branching stays on the
  `route` tool + `on:`/`next:`. A separate future proposal if ever wanted.
- **Binary / file (`blob`) outputs**, the `tool`→`script` rename, and
  dropping/unifying the `route` tool.

## 3. The model — one-directional typed data flow

Three step kinds:

- **`tool`** — a deterministic shell node (`run:`); exit code → outcome.
- **`llm`** — a probabilistic reasoner running its own bounded tool-use loop.
- **`human`** — an operator gate.

All three **consume** `${{ inputs.* }}` / `${{ outputs.X.f }}` by interpolation —
`tool` in `run:`, `llm` in `prompt:`, `human` in its operator-facing `text:`
(the gate shows upstream context at first paint). **Only `llm` steps produce**
`outputs:`. Data flows **forward only**, typed, fail-closed on read.

```yaml
  scope:                                    # llm — produces a record
    type: llm
    outputs:
      pr_number: { type: string }
      loc:       { type: number }
    routes: "skip,quick,full"               # unchanged — the route tool

  update:                                   # llm — produces an array of records
    type: llm
    outputs:
      bumps:
        type: array
        items:
          type: object
          fields:
            pkg:  { type: string }
            from: { type: string }
            to:   { type: string }
            kind: { type: choice, options: [patch, minor, major] }

  merge:                                    # tool — consumes a leaf, produces nothing
    type: tool
    run: gh pr merge ${{ outputs.scope.pr_number }} --auto --squash
```

### The type profile — why a profile, not full JSON Schema

Output (and input) types are a **restricted profile** of JSON Schema:
`type` (string/number/boolean/object/array), `enum` (→ `choice`),
`properties`+`required` (records), `items` (arrays). fragua schemas *are* valid
JSON Schema — they lower straight to `emit_output`'s provider-validated tool
schema (TypeBox `Type.Object`/`Type.Array`) — but the validator **rejects**
everything outside the profile (`pattern`/`format`/min·max, `oneOf`/`if`/`allOf`,
`$ref`/recursion, cosmetic `title`). Three reasons, in force order:

1. **Canonicalization for the freeze.** Under [`workflow-ir.md`](workflow-ir.md)
   (B) the schema is hashed into `sha`. Full JSON Schema has many syntactic forms
   per meaning (`const` vs `enum`, `$ref`, `oneOf` orderings, draft differences) —
   canonicalizing *arbitrary* schema for a stable hash is its own hard problem,
   the "ambiguous shape" §8.0 warns against freezing. The profile has a tiny fixed
   canonicalization (sort `properties`, `required`, `enum`).
2. **Provider-enforcement honesty.** `emit_output` is validated by the provider's
   tool-use validator, which enforces only the structural core. (`backend.ts`
   already uses a bare `{type, enum}` because `anyOf:[{const}]` isn't enforced.)
   Admitting only enforced constructs makes "validated as a unit" true.
3. **Logic belongs in steps.** Combinators, regexes, numeric bounds are
   predicates — they compute in the producing step, not in the type.

### Enforcement — runtime totality, static warning

1. **`emit_output` forces emission.** A single force-included tool
   (ground rule 12) whose schema is the node's whole `outputs:` profile;
   one call, validated as a unit, closes the turn. Never partial. Synthesised
   *additively* — the existing `route` tool is untouched; a node declaring both
   `routes:` and `outputs:` carries both. A node that declares `outputs:` and ends
   without a valid `emit_output` is a node failure, not a silent `""`.
2. **Fail-closed reads.** `${{ outputs.X.f }}` resolving to an unpopulated field
   — X never ran on the path taken, or ran and failed before `emit_output` — is a
   **node failure**, not a silent `""`. The fault halts to the operator and is
   recorded as a `fact.*`, so it folds back identically on replay. The
   populated-guarantee is enforced *at read time*, not proven at validate time —
   the half the old `$node.output` hand-wave got wrong.
3. **Static reachability — a warning, not a gate.** The validator extracts every
   `${{ outputs.X.f }}` (the same machinery as `inputReferences()` → E030) and
   hard-errors when X doesn't declare `f`, or when X is unreachable from entry on
   *any* path (a dead reference — always a typo). When X is reachable on some
   paths to N but not all, it emits a **W-code**: "X may not have run on every
   path to N; the reference fails closed at runtime if it didn't." No dominator
   analysis, no disposition-edge colouring — authoring keeps its typo-catch, the
   graph keeps its freedom.

**The populated-guarantee is enforced at read time and total over the log** —
every fault is a recorded fact, so it survives replay identically. That is why
outputs carry no static-graph assumption and compose with future runtime-spawned
topology, rather than locking the engine into a fully-static graph.

### Consumption and size

A reference yields: a **scalar** leaf → its value; a **record/array** → its JSON;
a **dotted leaf** (`${{ outputs.scope.pr_number }}`, `${{ outputs.X.rec.field }}`)
→ the inner scalar. The dominant pattern is a record/array as JSON into an `llm`
prompt; leaf scalars into `tool` commands. Outputs ride
`fact.node_completed.payload.outputs` inline, bounded by the event-payload cap
(ARCH P12) — a structure that exceeds it is a node failure (transparent spill is
deferred, §2.1). Assembly: the substitution resolver reads from a **rebuildable
outputs index** — `(run_id, step_id) → struct`, written same-transaction (ground
rule 5), last-write-wins for re-entry (§7), **off the `run_state` fold** (like
`messages`), so it's a re-snapshot, not an `EVENT_CONTRACT_VERSION` bump.

> **Injection note.** Interpolating an output into a `run:` shell string is a
> shell-injection surface — the general fix is the `exec:` argv form in
> [`tool-exec-variant.md`](archive/tool-exec-variant.md), which substitutes per-argument
> with no re-split. Steps interpolating generated outputs should prefer `exec:`.

> **Event-contract impact — verified re-snapshot, NOT a bump.** Adding `outputs`
> to `fact.node_completed` trips the §3.3 contract-surface hash (field shapes are
> in scope), forcing the decision by design. It resolves to a `// contract:
> no-bump` re-snapshot: only `packages/store/src/reducers.ts` folds the fact into
> `run_state`, reading cost/token/model + `nodeId` + `nextNode` — never `outputs`.
> The outputs index and the read-plane read it off the fold contract. (Flips to a
> real bump only if a reducer ever folds `outputs` into `run_state`.)

## 4. Consuming outputs — the step-elimination win

A `tool` or downstream `llm` consuming an upstream output replaces an `llm` step
that would otherwise scrape data from a thread:

- **`gh pr merge ${{ outputs.scope.pr_number }}`** — `scope`'s text block becomes
  a typed record; downstream reads `pr_number` directly, not "it's above, go find
  it." (llm produces, tool consumes — the half this cut ships.)
- **typed pipelines** — `update` emits a `bumps` array a downstream `fix` reads;
  `drift`'s `analyze`→`propose`→`verify` each emit a validated array the next
  consumes, dissolving most of `thread: drift`. (The `collect`→`analyze` snapshot
  hand-off stays a filesystem read until tool production lands — `collect` is a
  `tool`.)

The GHA correspondence, way less general (data-flow only):

| This proposal | GHA |
|---|---|
| `outputs:` on a step | `jobs.<id>.outputs` |
| `${{ outputs.X.f }}` | `${{ needs.<job>.outputs.<name> }}` |
| fail-closed read at runtime | the `needs:` DAG (a *static* gate) — fragua deliberately diverges here |
| typed `inputs` = the trigger event | `github.event.*` |

## 5. The seams are already the right shape

- **Edge selection is untouched** — no new routing; `selectEdge` and the
  outcome/route model are unchanged.
- **Substitution is already a tokenizer** — `INPUT_REF_RE` handles
  `${{ inputs.x }}`; `${{ outputs.X.f }}` is a sibling regex, and
  `inputReferences()` → E030 is the pattern for output-ref extraction + the
  reachability W-code. No dominator pass is needed — that greenfield is avoided.
- **`emit_output` mirrors the `route` tool's synthesis** — `backend.ts` already
  builds a per-node provider-validated schema at dispatch; `emit_output` builds
  the (profile) struct schema the same way.

## 6. Generalisation, non-goals, and what it changes

**SDLC sweep:** the recurring data-flow vocabulary is `inputs` (event) +
forward `outputs` (record/array hand-off) + bare-`tool` action, with `thread:`
reserved for genuine conversations. The `llm`-produces compositions land now
(scope records, dependency-bump arrays, drift's findings/edits pipeline). The
*gather→judge* composition (a `tool` emits structured evidence an `llm` judges —
`compliance-evidence`, `adversarial-red-team`) waits on tool output production.

**Non-goals:** tool output production, transparent spill, fact-routing, binary
blobs (§2.1); dynamic graph multiplicity (in-node or cross-run); deep loops
(`llm`-node-internal); durable cross-run state (external + re-derived).

**What it changes (all additive):** evolves ground rule 13 (cross-node
substitution allowed when the field is declared, with the read failing closed if
the producer didn't run on the taken path); rewrites the "No `$node.output`"
SKILL teaching → allowed, with unpopulated reads halting loudly instead of
silently resolving to `""`. `tool` steps still feed nothing downstream (only
`llm` steps declare `outputs:`) — so that teaching is unchanged, and the kind is
not renamed.

## 7. Open questions + freeze-facts

- **The `work::review` REJECT loop.** Detaching `review` from the `build` thread
  (to judge `${{ outputs.implement.plan_realised }}` fresh) used to force a
  back-edge question under dominance. Fail-closed reads dissolve the safety half:
  a back-edge reading an output that *was* populated on the taken path just works;
  one that wasn't fails closed. What remains is a design call, not a correctness
  one — whether `review`'s REJECT reason rides an output or the existing retarget
  mechanism. Settle before touching `work.yaml`.
- **Re-entry semantics.** A re-entered node re-emits and overwrites its outputs;
  `${{ outputs.X.f }}` reads "most recent X" — correct across revision loops, and
  natural once reads are a runtime fold rather than a static promise.
- **The deferred layers, in likely order:** (1) **tool output production**
  (`$FRAGUA_OUTPUT` + the gather→judge half of §1) — highest corpus value
  (drift's `collect`, anti-hallucination); (2) **transparent spill** for oversized
  records/arrays; (3) **`blob`** (binary/file, mime, `.path`) — niche, only if a
  workflow ever produces a file. Each rides its own `ir_version` step.

**Freeze-facts** (only bite if [`workflow-ir.md`](workflow-ir.md) (B) hashes the
IR):
1. **`route` is the single routing field** for both `llm` and `human` — one
   hashed field, not two.
2. **`label` is cosmetic → excluded from the IR hash.**
3. **The type profile is the closed JSON-Schema subset of §3** — fixed
   canonicalization (sort `properties`/`required`/`enum`); reject the rest. With
   no fact-routing, edges stay outcome/route — order-independent — so §8.1's
   edge-sort is correct and needs no carve-out.

## Related

- **The `route` tool + two-case edge selector** (SPEC §3.6; `edge-selection.ts`;
  synthesis in `packages/agent/src/backend.ts`) — shipped and **unchanged**; this
  adds typed, fail-closed outputs *alongside* it.
- [`tool-exec-variant.md`](archive/tool-exec-variant.md) — the `exec:` argv form that
  makes interpolating outputs into commands injection-safe.
- [`workflow-ir.md`](workflow-ir.md) — `outputs:` (and the shared input/output
  type profile) is an IR-core attr; lands as an `ir_version` bump + converter,
  honouring the freeze-facts above.
