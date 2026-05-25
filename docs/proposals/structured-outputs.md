---
title: Structured step outputs — typed `outputs:`, `${{ steps.X.outputs.f }}`, and `when:` fact-routing
summary: "One-directional typed data flow over the script/llm/human graph: typed per-step outputs (mirroring inputs), interpolation gated by dominance, and equality-only `when:` fact-routing — collapsing the data-plumbing half of shared-thread usage and enabling deterministic, bare-script action paths for repo-triggered runs"
status: proposed
maturity: designed
last-reviewed: 2026-05-21
---

# Structured step outputs

> **Designed, not scheduled.** Strictly additive; the engine already has the
> seams (§7). The demand gate (§2) is tripped by `review.yaml` + every
> repo-triggered automation in the pipeline (§8) — but no code starts until
> the repo-trigger roadmap commits, because that roadmap is the forcing
> function, not any single existing workflow.

## 1. The two load-bearing principles

Everything below is in service of two sentences. If the design is cut to the
bone, keep these:

- **Why the substrate exists.** Its job is to make correctness a property
  of the *topology between an `llm` step and a `script` step*, not of trusting
  either half. A `script` produces evidence an `llm` consumes (it can't
  hallucinate the facts); an `llm` produces candidates a `script` executes (it
  can't be overconfident). Typed, dominance-guaranteed outputs are the edge
  that makes those compositions trustworthy instead of vibes-over-a-thread.
- **Why the model stays small.** *Predicates compute in steps; edges only
  match values.* Conjunction, numeric thresholds, ranges, set-membership — all
  resolve by computing the predicate in the producing step and emitting a typed
  `bool`/`enum` the edge matches by equality. The edge language therefore never
  needs to grow: "can we route on X" always answers "emit X as an output."

## 2. Problem

`work.yaml` and `review.yaml` lean on shared `thread:` to move data between
steps. That's two smells wearing one coat:

- **Conversation / revision loops (keep the thread).** `plan → implement →
  review → (REJECT) → implement`. The thread *is* the conversation — the second
  `implement` pass wants the whole back-and-forth, not a
  `${{ review.outputs.reason }}` scalar. Structured outputs can't and shouldn't
  replace this.
- **Data hand-off dressed as conversation (the actual smell).** `scope` emits
  `TARGET/PR/PATHS/LOC/FOCUS/CHECKOUT` as a text block every downstream step
  re-reads; `pr_approve`/`pr_feedback` scrape the review body + PR number back
  out of the thread ("the PR number is above in this thread, go find it"). A
  struct cosplaying as prose — carried at full transcript cost, read
  nondeterministically.

Today the only substitution token is `${{ inputs.<name> }}` (AGENTS.md ground
rule 13). `$node.output` / `${context.*}` were deliberately banned — but the
ban's *reason* was that the old hand-wave had no guarantee the referenced
output was populated. A typed schema + a reachability guarantee is exactly what
retires that reason.

**The material win is step elimination, not context trimming.** Prompt caching
already blunts the cost of carrying a thread (and where it doesn't, turning
caching on is cheaper than this feature). The unambiguous, uncached savings come
from collapsing LLM steps into bare `script` steps (§5) and from a fact-route
replacing an LLM if-statement. Lead with "fewer `llm` calls," not "smaller
context."

## 3. The model — one-directional typed data flow

Three step kinds, and the data model is kind-agnostic:

- **`script`** — a deterministic shell node (`run:`); exit code → outcome.
  *(Renamed from `tool` — see §11.)*
- **`llm`** — a probabilistic reasoner running its own bounded tool-use loop
  over its in-node tools (`bash`/`read`/`edit`/…).
- **`human`** — an operator gate.

All three kinds **consume** `${{ inputs.* }}` / `${{ steps.X.outputs.f }}` by
interpolation — `script` in `run:`, `llm` in `prompt:`, and `human` in its
operator-facing `text:` (the gate shows dominating context — PR number, blocking
summary — at first paint, no scrolling the thread to find it). `script` and
`llm` steps also **produce** `outputs:`; a `human` step's only output is the
operator's chosen route (a typed enum). Data flows **forward only**, typed, gated
by dominance.

```yaml
  scope:
    type: llm
    outputs:                                    # one emit_output call carries the whole struct…
      pr_number: { type: string }
      has_pr:    { type: boolean }
      paths:     { type: string }
      loc:       { type: number }
    routes: "skip,quick,full"                   # …sugar: adds a 5th field `route: enum[skip,quick,full]` (§4)
    # ≡ outputs.route: { type: enum, values: [skip, quick, full] } + `when: route == …` out-edges

  merge:
    type: script
    run: gh pr merge ${{ steps.scope.outputs.pr_number }} --auto --squash
```

### Enforcement — two layers, both with precedent

1. **Runtime — emission is forced, by producer kind.** One contract, three
   mechanisms:

   - **`llm` → a single terminal `emit_output` tool.** Its schema is the node's
     **entire `outputs:` struct** (the routing enum, if any, is just one field),
     synthesised per-node and force-included (AGENTS.md ground rule 12). It
     *replaces* the per-node `route` tool — the backend stops synthesising
     `buildRouteTool` (`packages/agent/src/backend.ts`, SPEC §3.6) and always
     synthesises `emit_output` from the (sugar-expanded, §4) outputs block.
     **One call, validated as a unit, closes the turn** — today's
     `route`-closes-the-turn semantics, generalised. Never partial: you cannot
     emit some fields and route, or route before deciding a field. The discipline
     that buys is gather-then-emit-once — the `llm` decides everything in its tool
     loop, then emits; it cannot emit early and keep working (if it must act
     irreversibly *after* deciding, that's a second node, and the dominance edge
     between them is the typed hand-off this proposal is for).
   - **`script` → a dedicated `$FRAGUA_OUTPUT` channel.** The runtime injects a
     file path; the script writes `field=value` / JSON to it — **not** scraped
     from stdout. This mirrors GHA's `$GITHUB_OUTPUT`, and the reason is
     fragua-specific: `tool.ts` already conscripts stdout/stderr as the
     operator-facing log surface (the `tool_node` message RunConversation
     renders), so overloading stdout as the data contract would force every
     output-emitting script to be silent on stdout. The dedicated channel keeps
     the log pair human-facing and the output contract clean.
   - **`human` → the operator's choice.** The chosen route arrives via
     `intent.human_input` and is recorded as the node's enum output — no tool, no
     file.

   The contract is identical across all three: a node that declares `outputs:`
   and ends without producing them — no `emit_output` call, an empty
   `$FRAGUA_OUTPUT`, a missing or ill-typed field — is a node failure, not a
   silent `""`. Same schema, same validation, regardless of kind.
2. **Static — dominance + field-existence in the validator.** A reference
   `${{ steps.X.outputs.f }}` at node N is valid iff (a) X declares output `f`,
   and (b) **X dominates N by successful completion** — every entry→N path
   crosses X *and* reaches N only via X's success disposition. Plain dominance is
   not enough: a node that fails (or a `script` that exits non-zero) emits no
   outputs, so an `outcome=fail → … → N` edge that bypasses X's `emit_output`
   leaves the field unpopulated despite X being topologically on the path. The
   validator therefore rejects a reference whose only paths to N include a
   non-success exit of X. New E-code, composing with the existing
   `inputReferences()` → E030 machinery in `substitution.ts`.

**Dominance-by-success is the populated-guarantee** and it is *total*, because
the graph is fully static (§6). It self-selects the safe cases: `implement`
can't reference
`${{ steps.plan.outputs… }}` because `triage`'s `small`/`bugfix` routes bypass
`plan` — plan doesn't dominate implement. That's precisely why `implement`
hand-handles "plan present / failing test present / neither" in prose today.

### Scalars interpolate; blobs go by path

Scalar outputs interpolate into commands and prompts directly and ride
`fact.node_completed.payload.outputs` — which keeps them under the 5 KB
event-payload cap (ARCH property P12), the reason scalars stay small and bulk
goes elsewhere.

> **Event-contract impact — verified re-snapshot, NOT a bump.** Adding `outputs`
> to `fact.node_completed` trips the contract-surface hash
> ([`event-contract-version.md`](event-contract-version.md) §3.3 — field shapes
> are in scope), which *forces the decision* — by design. It resolves to a
> `// contract: no-bump` re-snapshot, not an `EVENT_CONTRACT_VERSION` bump:
> auditing every `fact.node_completed` consumer confirmed that **only**
> `packages/store/src/reducers.ts` folds the fact into `run_state`, and it reads
> cost/token/model fields + `nodeId` + `nextNode` — never `route`,
> `outcomeStatus`, or (the future) `outputs`. The read-plane
> (`core/src/read-plane/{projections,steps}.ts`) reads the fact at display time,
> which is off the fold contract. So an old daemon folds the stream to an
> identical `run_state`; the new field is consumed only by substitution/routing
> at execution and by the read-plane for display. (Flip condition: this becomes a
> real bump only if a reducer arm ever folds `outputs` into `run_state`.) **Blob outputs are materialised by the runtime to a temp file;
you interpolate the `.path`** (`--body-file
${{ steps.synthesize.outputs.review_body.path }}`). This keeps shell lines
scalar-only (no markdown-blob-into-a-shell-line injection) and keeps the blob
out of the event payload. Blob storage reuses the tool-node artifact path
(`docs/handler-contract.md`), keyed `${nodeId}:output:<field>`; the fact payload
carries the artifact ref, not the bytes.

## 4. `when:` — equality-only routing, and `route` as sugar over it

A node's edges carry a `when:` guard that matches a declared **bool/enum**
output or input by equality:

```yaml
  signoff:
    type: human
    routes:
      approve: …
      keep:    …
  # after approve, a fact decides the action — no LLM:
  post:
    routes:
      - { to: request_changes, when: has_blocking }       # bool, truthy
      - { to: comment }                                    # default (no when)
```

- `when:` takes **one** comparison: `field`, `field == lit`, or `field != lit`,
  over a declared **bool/enum** output or input. No `<`/`>`, no `&&`/`||`, no
  `contains`. (Richer predicates compute in the producing step and surface
  as a derived bool/enum.)
- The read scope is **`inputs ∪ dominating-outputs ∪ outcome`** — `when:` reads
  the trigger event too (§9), not just upstream steps.
- Selection over the *success* disposition is **first-match, top-to-bottom,
  mandatory default** (an edge with no `when:`). Totality is a finite check
  because the domain is closed (two bools, or N enum values). A validator pass
  warns on provably-overlapping guards and errors on missing coverage. A node's
  **fail disposition is a separate axis**: a node that can exit non-zero still
  needs its own `on: {fail: …}` edge (§5) — the closed-domain totality check
  covers the success branch, not the failure of the node itself.

### `route` is sugar over `emit_output` + `when:`

`route` is **not a second mechanism** — it desugars to "emit one required enum
output, then `when:` on the emitting node's own out-edges":

```yaml
  scope: { type: llm, routes: "small,feature,blocked" }   # surface sugar
```

≡ an `outputs: { route: { type: enum, values: [small, feature, blocked] } }`
declaration plus three `when: route == …` edges. There is **no separate `route`
tool** — the routing enum is just one field of the single terminal
`emit_output` (§3.1). This is *why* the engine already needs no change (§7):
the chosen value feeds the same `outcome.route`/field match in `selectEdge`.
Keeping the `routes:` surface buys terseness and a node-level "this branch is a
judgment" signal; it does **not** buy a separate routing language.

Consequently there is **no `route`-XOR-`when` rule** — `route` *is* `when` over a
required enum, so the validator has one routing model, not two. The
judgment-vs-fact distinction survives in *what produces the matched field*: a
`when:` over an `llm`-emitted enum is a judgment branch; over a `script`-emitted
or `input` field, a fact branch. That also pins down determinism precisely: edge
selection is always deterministic **at replay** (the field is a recorded fact);
**at first run** it is deterministic iff the field's producer is a `script` or
`input`, probabilistic iff an `llm`.

The deeper unification — dropping the synthesised `route` tool entirely and
authoring even judgment branches as a bare enum `output:` — is **deferred** for
ergonomics only (the `routes:` shorthand is terser than an enum decl + N edges),
not because it re-opens any routing surface: it stays strictly equality-only and
re-introduces none of the deleted condition DSL.

## 5. The bare-`script` action path

With `scope.outputs.pr_number` (scalar) and `synthesize.outputs.review_body`
(blob), `pr_approve`/`pr_feedback` collapse from `llm` steps that scrape the
thread into bare `script` nodes. Net result for `review.yaml`:

```
signoff → [when: has_pr]      → [when: has_blocking] → bare gh call
        → [default: no PR]    → exit
```

Zero `llm` steps in the post-review action path; the `human` still gates. This
is the step-elimination win of §2.

Caveat: `script` nodes are exit-code-only. `gh` fails on auth / closed PR /
race; a bare node just exits non-zero where the current `llm` step aborts with a
readable reason. So these want an explicit `on: {fail: …}` edge.

## 6. Why dropping `agent` makes this *sounder*

Removing the `agent` tool removes the only source of runtime-spawned graph
structure, with three consequences that compound with this proposal:

- **The `llm` primitive already is the bounded agent loop** (it iterates over
  its in-node tools). Orchestrator-workers and deep probe loops collapse into
  "an `llm` node with tools" — no fourth concept.
- **The graph is fully static, so dominance and totality are total** at
  validation time. There is no runtime-spawned topology over which the
  populated-guarantee would be undefined. Structured outputs *want* a static
  graph; removing `agent` is what delivers it. Synergistic, not independent.
- **Dynamism separates into three clean layers:** the **static graph**
  (nodes/edges/dominance/replay); **in-node agency** (an `llm` step's tool-use
  loop, where deep loops live); **cross-run triggering** (re-fire on
  event/schedule, where "loop until the queue is empty" lives).

## 7. The core is already the right shape

Adoption is purely additive:

- **Edge selection is decoupled from the route tool.** `selectEdge` matches on
  `outcome.route`, a string (`edge-selection.ts`); the source of that string is
  not baked into the resolver. `when:` populates the same match from a resolved
  output/input field — zero engine change to the selector.
- **Substitution is already a tokenizer.** `INPUT_REF_RE` handles
  `${{ inputs.x }}`; `${{ steps.X.outputs.f }}` is a sibling regex family, and
  `inputReferences()` → E030 is the exact pattern for an output-ref + dominance
  E-code.

## 8. Does it generalise? — SDLC sweep

23 workflows across plan → triage → implement → review → integrate → release →
operate → maintain, six chosen to *break* the model. None needed a primitive it
lacks. The recurring vocabulary is exactly: `inputs`(event) + `route`/`when`
(judgment vs fact — one equality match, two authoring intents, §4) +
bare-`script`(action) + `thread`(only the genuine conversations).
Representative cases by composition:

- **gather → judge (anti-hallucination).** `compliance-evidence`: a `script`
  gathers machine evidence (IAM/config/logs), an `llm` judges each control
  against it. The `llm` consumes a dominating `script` output, so it
  structurally cannot fabricate evidence.
- **propose → adjudicate (anti-overconfidence).** `adversarial-red-team`: an
  `llm` generates novel attacks, a `script` executes them, the gate routes on
  `has_landed`. Creativity filtered by deterministic execution.
- **predicates-in-steps.** `coverage-gate`: the coverage `script` emits
  `band: low|warn|ok` (the threshold from `inputs`); edges match the band. The
  numeric comparison never reaches an edge.
- **completeness gate.** `fix-the-class`: a `script` search emits the
  instance set, `implement` emits the fixed set, a gate routes on
  `covered == complete` — a set comparison impossible over thread prose.
- **near-term concrete pulls.** `review.yaml` (`scope.outputs` → quick/full/
  verify; bare-`script` `pr_*`; `has_pr`/`has_blocking` `when:` edges — `scope`
  dominates all). `work.yaml::review` detached from the `build` thread to judge
  `git diff` + `implement.outputs.plan_realised` — no transcript, no
  implementer-narrative bias (the harder case; see Open questions re: the
  REJECT loop).

Numerics (flaky rate, perf delta, coverage %) and conjunctions (PR-lint,
breaking∧public) appeared repeatedly; **every one** resolved to a derived
bool/enum in the producing step. Equality-only held against the whole SDLC.

## 9. Inputs are the trigger payload (the GHA mirror)

The end goal is repo-action-triggered runs. The webhook/event payload arrives as
typed **`inputs:`** — and `inputs` are **source-agnostic** (GitHub, Zendesk,
metrics, schedule all proved it in the sweep). `when:` reading `inputs` is
load-bearing, not polish: `dep-bump` routes on `semver_bump`, `incident` on
`severity` — both event payload, not step outputs.

| This proposal | GHA |
|---|---|
| `outputs:` on a step | `jobs.<id>.outputs` |
| `${{ steps.X.outputs.f }}` | `${{ needs.<job>.outputs.<name> }}` |
| **dominance** | **the `needs:` DAG** |
| scalar interpolate / blob → `.path` | `$GITHUB_OUTPUT` / `actions/upload-artifact` |
| `when:` (equality) | `if:` |
| typed `inputs` = event | `github.event.*` |

Mutatis mutandis, way less general — adopt the shape, drop GHA's expression
sprawl. The one-sentence model: **`inputs` = the event, `outputs` = `needs`,
`when` = `if`, dominance = the `needs` DAG; the differentiator is `llm` judgment
steps + bare-`script` action steps in one replayable graph.**

### `when:` reads inputs only when they are closed-domain — bucketing is explicit

`when:` is equality-only over **bool/enum**, so it can route on an input *only if
that input is already closed-domain at the trigger boundary*: `severity == high`
works when the webhook delivers `severity` as a label, `is_breaking` when it
delivers a bool. A **raw scalar** event field (`severity: 7`, `coverage_delta:
-3.2`, a free-form `title`) is **not routable directly** — and there is no
pre-entry exception to "predicates compute in steps," because inputs precede
every step. Bucketing therefore has exactly one in-graph home: **an explicit
step.** Two placements, by who owns the threshold:

- **Structural enums the source already labels** (event type, action, a severity
  *label*) — the trigger adapter delivers them typed; the graph reads them as-is.
- **Any threshold the workflow wants to own** (`coverage < 80`, `severity ≥ 8`)
  — an **entry normalizer node** reads the raw input and emits a typed
  `band`/`bump` output; routing reads *that output*, not the raw input.
  It dominates everything, so the reference is always valid.

No magic, no threshold-mapping DSL in the `inputs:` block: a threshold the
workflow cares about *is* a predicate, and predicates compute in steps —
inputs included. (This is the input-boundary instance of the multi-threshold
question in §12.)

## 10. Non-goals and boundaries

- **The graph is static; multiplicity lives in-node or across runs.** Fixed,
  named fan (2-3 steps, e.g. dual-model adjudication) is structured-output
  territory and dominance holds. Dynamic multiplicity (N branches/lenses) is an
  `llm` node iterating internally, or re-triggering — never dynamic graph edges.
- **Deep loops are `llm`-node-internal.** A judgment↔evidence probe loop
  lives in the node's tool-use cycle; the graph captures entry evidence + exit
  verdict. Structured outputs are the *interface to* an `llm` loop, not a
  replacement.
- **Runs are stateless; durable state is external + re-derived.** Outputs
  are intra-run. "Loop until done" is an `llm` tool-loop or a re-trigger.
- **No `llm` step, no substrate.** A graph of only `script`/`human` is a
  worse GHA; the substrate earns its keep on the `llm`↔`script` seam.
- **Deferred:** ordered comparisons (`<`/`>`), boolean combinators, node-level
  `if`/`unless` skip, and the `output`-replaces-`route` unification.

## 11. What it changes

This **evolves** AGENTS.md ground rule 13 (cross-node substitution allowed iff
the producer dominates the consumer *by successful completion* and the field is
declared), and rewrites three teachings in the `workflows` SKILL:

- "No `$node.output`" → allowed under dominance.
- "`tool` steps don't feed data forward — the exit code is the entire result"
  → `script` steps produce typed outputs (this inverts the kind's defining
  property, which is *why* the rename in §3 is timed with this work).
- "Split heavy collectors into a thread step so a retarget doesn't re-run them"
  → a collector emits a blob output: addressable, retarget-safe by construction,
  no thread membership.

The `tool` → `script` rename (kind name + the `run:` discriminator) lands in the
same pass: it removes the collision with the *in-node tools* an `llm` step calls,
and the old name was partly earned by "side-effect-only," which stops being true
here.

## 12. Open questions

- **The `work::review` REJECT loop.** Detaching `review` from the `build` thread
  for bias/cost forces the back-edge question: `review` doesn't dominate
  `implement` (the first pass reaches implement without review), so the one-line
  REJECT reason can't ride a dominated output — it must travel via the retarget
  mechanism, not the thread. Settle this before touching `work.yaml`; it's the
  case that stress-tests re-entry semantics.
- **Re-entry semantics.** A re-entered node re-emits and overwrites its outputs;
  `${{ steps.X.outputs.f }}` reads "most recent X," so a `when:` route can *flip*
  across passes (correct, but state it).
- **Multi-threshold reopen-signal.** The one strain on equality-only: many
  consumers wanting *different* thresholds on the same scalar (`coverage > 80`
  here, `> 90` there). Resolvable by explicit enum bucketing in the producing
  step today — same shape as the input-boundary bucketing in §9 (a threshold is
  a predicate; predicates compute in steps). **If this becomes common, that is
  the trigger to revisit numeric `when:` — not before.**
- **`route` overloaded across `llm` and `human`; `routes:` key shape-overloaded.**
  Both an `llm` routing node and a `human` node currently surface a
  `route`/`routes` enum, but they are different authoring concepts: an `llm`
  *route* is a bare branch name the reasoner picks (no label — the prompt carries
  the meaning); a `human` *choice* is operator-facing (rendered as buttons, wants
  labels). Same `when:`-matching mechanism, different provenance and declaration
  shape — and a downstream `when:` site sees only the field name, not the
  producer kind, so the name is the only provenance signal there. Separately, the
  `routes:` key is shape-overloaded (bare-name string vs name→target map vs
  `{to, when}` edge list). Proposed split: **`routes:`** (`llm`, bare-name string)
  → field `route`; **`choices:`** (`human`, name→label map) → field `choice`; the
  bare `{to, when}` list becomes **`edges:`**. One key per concept, no
  shape-overload; preserves §4's single *matching* model (equality on an enum
  output) while making provenance legible at the consumer. Decide before pinning
  the YAML surface.
- **Blob materialisation API.** Confirm the artifact-store key + `.path` surface.

## Related

- **The `route` tool + two-case edge selector** (SPEC §3.6;
  `packages/core/src/engine/edge-selection.ts`; route-tool synthesis in
  `packages/agent/src/backend.ts`) — shipped; this proposal is a
  *premise-changed* extension of it (typed/dominated outputs), not a
  contradiction of the condition-DSL deletion that landed alongside it.
  (The originating `llm-routing.md` proposal has been pruned now that it
  ships — git history holds it.)
- **The scrapped parallel/`fan_in` primitive** (removed in `faeb1f4d`; proposal
  `parallel-branch-outputs.md` pruned with it) — its downstream-substitution
  shape was the same idea, but the parallel runtime is gone; §10 keeps
  multiplicity in-node or across runs instead.
