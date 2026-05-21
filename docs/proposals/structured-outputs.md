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

- **Why the substrate exists (P6).** Its job is to make correctness a property
  of the *topology between an `llm` step and a `script` step*, not of trusting
  either half. A `script` produces evidence an `llm` consumes (it can't
  hallucinate the facts); an `llm` produces candidates a `script` executes (it
  can't be overconfident). Typed, dominance-guaranteed outputs are the edge
  that makes those compositions trustworthy instead of vibes-over-a-thread.
- **Why the model stays small (P1).** *Predicates compute in steps; edges only
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
  *(Renamed from `tool` — see §10.)*
- **`llm`** — a probabilistic reasoner running its own bounded tool-use loop
  over its in-node tools (`bash`/`read`/`edit`/…).
- **`human`** — an operator gate.

Both `script` and `llm` steps **produce** `outputs:` and **consume**
`${{ inputs.* }}` / `${{ steps.X.outputs.f }}` by interpolation (`script` in
`run:`, `llm` in `prompt:`). A `human` step emits its chosen route as a typed
enum output; it cannot read upstream. Data flows **forward only**, typed, gated
by dominance.

```yaml
  scope:
    type: llm
    outputs:
      pr_number: { type: string }
      has_pr:    { type: boolean }
      paths:     { type: string }
      loc:       { type: number }
    routes: { skip: …, quick: …, full: … }     # judgment via the route tool

  merge:
    type: script
    run: gh pr merge ${{ steps.scope.outputs.pr_number }} --auto --squash
```

### Enforcement — two layers, both with precedent

1. **Runtime — a forced `emit_output` tool.** Schema-validated, synthesised
   per-node from the `outputs:` block, exactly like the `route` tool is
   synthesised today (`llm-routing.md`; force-include per AGENTS.md ground rule
   12). A node that declares `outputs:` must emit them; a missing/ill-typed
   field is a node failure, not a silent `""`. For `script` nodes the outputs
   are parsed from stdout (JSON, or a scalar via convention) — same schema, same
   validation.
2. **Static — dominance + field-existence in the validator.** A reference
   `${{ steps.X.outputs.f }}` at node N is valid iff (a) X declares output `f`,
   and (b) **X dominates N** — every entry→N path crosses X. New E-code,
   composing with the existing `inputReferences()` → E030 machinery in
   `substitution.ts`.

**Dominance is the populated-guarantee** and it is *total*, because the graph is
fully static (§6). It self-selects the safe cases: `implement` can't reference
`${{ steps.plan.outputs… }}` because `triage`'s `small`/`bugfix` routes bypass
`plan` — plan doesn't dominate implement. That's precisely why `implement`
hand-handles "plan present / failing test present / neither" in prose today.

### Scalars interpolate; blobs go by path

Scalar outputs interpolate into commands and prompts directly. **Blob outputs
are materialised by the runtime to a temp file; you interpolate the `.path`**
(`--body-file ${{ steps.synthesize.outputs.review_body.path }}`). This keeps
shell lines scalar-only (no markdown-blob-into-a-shell-line injection) and
sidesteps the 4 KB payload cap — GHA's `$GITHUB_OUTPUT`-vs-artifacts split.
Blob storage reuses the tool-node artifact path (`docs/handler-contract.md`),
keyed `${nodeId}:output:<field>`.

## 4. `when:` — equality-only fact-routing

`route` (the tool) stays the mechanism for *judgments* (skip/quick/full,
small/feature/bugfix). For *facts* — deterministic given a declared output or
input — a node's edges carry a `when:` guard:

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
  `contains`. (P1: richer predicates compute in the producing step and surface
  as a derived bool/enum.)
- The read scope is **`inputs ∪ dominating-outputs ∪ outcome`** — `when:` reads
  the trigger event too (§9), not just upstream steps.
- Selection is **first-match, top-to-bottom, mandatory default** (an edge with
  no `when:`). Totality is a finite check because the domain is closed (two
  bools, or N enum values). A validator pass warns on provably-overlapping
  guards and errors on missing coverage.
- A node is **`route`-tool-driven XOR `when`-driven**, never both; `human`
  routes stay the named-map form. One mode per node, validator-enforced.

The full unification — collapse `route` into a single `output` mechanism that
both emits and routes, removing the `route` tool — is **deferred**. It is
elegant but re-opens routing surface `llm-routing.md` deliberately deleted, and
no workflow needs it. Equality-only `when:` + the kept `route` tool covers every
case in §8.

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
lacks. The recurring vocabulary is exactly: `inputs`(event) + `route`(judgment)
+ `when`(fact, bool/enum) + bare-`script`(action) + `thread`(only the genuine
conversations). Representative cases by composition:

- **gather → judge (anti-hallucination).** `compliance-evidence`: a `script`
  gathers machine evidence (IAM/config/logs), an `llm` judges each control
  against it. The `llm` consumes a dominating `script` output, so it
  structurally cannot fabricate evidence.
- **propose → adjudicate (anti-overconfidence).** `adversarial-red-team`: an
  `llm` generates novel attacks, a `script` executes them, the gate routes on
  `has_landed`. Creativity filtered by deterministic execution.
- **predicates-in-steps (P1).** `coverage-gate`: the coverage `script` emits
  `band: low|warn|ok` (the threshold from `inputs`); edges match the band. The
  numeric comparison never reaches an edge.
- **completeness gate (P7).** `fix-the-class`: a `script` search emits the
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

## 10. Non-goals and boundaries

- **The graph is static; multiplicity lives in-node or across runs (P8).** Fixed,
  named fan (2-3 steps, e.g. dual-model adjudication) is structured-output
  territory and dominance holds. Dynamic multiplicity (N branches/lenses) is an
  `llm` node iterating internally, or re-triggering — never dynamic graph edges.
- **Deep loops are `llm`-node-internal (P9).** A judgment↔evidence probe loop
  lives in the node's tool-use cycle; the graph captures entry evidence + exit
  verdict. Structured outputs are the *interface to* an `llm` loop, not a
  replacement.
- **Runs are stateless; durable state is external + re-derived (P10).** Outputs
  are intra-run. "Loop until done" is an `llm` tool-loop or a re-trigger.
- **No `llm` step, no substrate (P11).** A graph of only `script`/`human` is a
  worse GHA; the substrate earns its keep on the `llm`↔`script` seam.
- **Deferred:** ordered comparisons (`<`/`>`), boolean combinators, node-level
  `if`/`unless` skip, and the `output`-replaces-`route` unification.

## 11. What it changes

This **evolves** AGENTS.md ground rule 13 (cross-node substitution allowed iff
the producer dominates the consumer and the field is declared), and rewrites
three teachings in the `workflows` SKILL:

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
  here, `> 90` there). Resolvable by enum bucketing today. **If this becomes
  common, that is the trigger to revisit numeric `when:` — not before.**
- **Blob materialisation API.** Confirm the artifact-store key + `.path` surface.

## Related

- [`llm-routing.md`](./llm-routing.md) — established the `route` tool + the
  two-case edge selector this builds on; this proposal is a *premise-changed*
  extension (typed/dominated outputs), not a contradiction of its DSL deletion.
- [`parallel-branch-outputs.md`](./parallel-branch-outputs.md) — archived; the
  parallel runtime is gone, but its downstream-substitution shape is the same
  idea.
