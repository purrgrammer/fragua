---
title: Structured step outputs — typed `outputs:` + `${{ steps.X.outputs.f }}` substitution
summary: "Declare typed per-step outputs (mirroring `inputs:`), enforce via a forced `emit_output` tool, and interpolate them downstream where the producer dominates the consumer — collapsing the data-plumbing half of shared-thread usage"
status: proposed
maturity: sketch
last-reviewed: 2026-05-20
---

# Structured step outputs

> **Sketch.** Strictly additive; the engine already has the seams
> (see §5). No demand-gated work should start until the plumbing half of
> shared-thread usage actually hurts — `review.yaml` is the first concrete
> pull (see §3). Captured now so the core stays the right shape.

## Problem

`work.yaml` and `review.yaml` lean heavily on shared `thread:` to move data
between steps. That's two different smells wearing one coat:

- **Conversation / revision loops (keep the thread).** `plan → implement →
  review → (REJECT) → implement`. The thread *is* the conversation — the
  second pass of `implement` wants the whole back-and-forth, not a
  `${{ review.outputs.reason }}` scalar. Structured outputs can't and
  shouldn't replace this.
- **Data hand-off dressed as conversation (the actual smell).** `scope`
  emits `TARGET/PR/PATHS/LOC/FOCUS/CHECKOUT` as a text block that every
  downstream step re-reads; `pr_approve`/`pr_feedback` scrape the review
  body + PR number back out of the thread ("the PR number is above in this
  thread, go find it"). This is a struct cosplaying as prose.

Today the only substitution token is `${{ inputs.<name> }}` (AGENTS.md
ground rule 13). `$node.output` / `${context.*}` were deliberately banned
— but the ban's *reason* was that the old hand-wave had no guarantee the
referenced output was populated. A typed schema + a reachability guarantee
is exactly what retires that reason.

## Proposal

Mirror `inputs:` with a per-step `outputs:` block, and let downstream steps
interpolate `${{ steps.<id>.outputs.<field> }}`.

```yaml
  scope:
    type: llm
    outputs:
      pr_number: { type: string }
      has_pr:    { type: boolean }
      paths:     { type: string }
    routes: { skip: …, quick: …, full: … }
```

Two enforcement layers, both with existing precedent:

1. **Runtime — a forced `emit_output` tool.** Schema-validated, synthesised
   per-node from the `outputs:` block, exactly like the `route` tool is
   synthesised today (`docs/proposals/llm-routing.md`; backend force-include
   per AGENTS.md ground rule 12). A node that declares `outputs:` must emit
   them; a missing/ill-typed field is a node failure, not silent `""`.
2. **Static — dominance + field-existence in the validator.** A reference
   `${{ steps.X.outputs.f }}` at node N is valid iff (a) X declares output
   `f`, and (b) **X dominates N** — every entry→N path crosses X. New E-code,
   composing with the existing `inputReferences()` → E030 machinery in
   `substitution.ts`.

The dominance check is the load-bearing idea: it *self-selects the safe
cases and rejects the unsafe ones*. `implement` can't reference
`${{ steps.plan.outputs… }}` because `triage`'s `small`/`bugfix` routes
bypass `plan` — plan doesn't dominate implement. That's precisely why
`implement` hand-handles "plan present / failing test present / neither" in
prose today.

## Where it applies (and where it must not)

| Surface | Today | With outputs |
|---|---|---|
| `review::scope` emit block | text block on the thread | `outputs: { pr_number, has_pr, paths, loc, focus, checkout }` |
| `review::review_quick` / `verify` | read scope's text from thread | `${{ steps.scope.outputs.paths }}` (scope dominates both) |
| `review::pr_approve` / `pr_feedback` | llm step scrapes PR# + body | typed edge on `has_pr` + bare `tool` node (see §4) |
| `review` lenses → `synthesize` | thread fan-in | **stays thread** — dispatch prunes the lens set at runtime; you can't statically name `lens_security.outputs` |
| `work::plan/reproduce/implement/review` | shared `build` thread | **stays thread** — genuine conversation + revision loop; `implement` is a post-branch merge where context is path-dependent |

So this cleans up `review.yaml` substantially and barely touches `work.yaml`
— which is the point. Threads remain correct for conversations, revision
loops, post-branch merges, and dynamically-chosen fan-in.

## Adjacent wins this unlocks

### Fact-routing via `routes:` (no condition DSL)

`route` today is for *judgments* (skip/quick/full, small/feature/bugfix).
PR-or-not is a *fact*, deterministic given `scope.outputs.has_pr`. Let
`routes:` key off a declared enum/boolean output as well as a `route` tool
call — same routing mechanism, two sources. The edge-selection engine
already matches `edge.attrs.route` against `outcome.route`, a plain string
the agent boundary happens to set (`edge-selection.ts`); fact-routing means
populating that string from a resolved output field. Keep conditions to
"match a declared enum/bool field" — no `==`/`!=`/expression language, no
context-KV bag.

### Bare-tool action path — scalar vs blob

With `scope.outputs.pr_number` (scalar) and `synthesize.outputs.review_body`
(blob), `pr_approve` collapses to a `type: tool` node. The design constraint
that wants to exist: **scalars interpolate into commands; blob outputs are
materialised by the runtime to a temp file and you interpolate the *path***
(`--body-file ${{ steps.synthesize.outputs.review_body.path }}`). That keeps
shell interpolation to scalars (no markdown-blob-into-a-shell-line injection)
and sidesteps the 4 KB payload cap — GHA's `$GITHUB_OUTPUT`-vs-artifacts
split. Net result: `signoff → [has_pr edge] → [has_blocking edge] → bare gh
call`, zero LLM steps in the post-review action path, human still gates.

Caveat: `tool` nodes are exit-code-only. `gh` fails on auth / closed PR /
race; a bare tool node just exits non-zero where the current llm step aborts
with a readable reason. So these want an explicit `fail:` edge.

## Why the core is already the right shape

Both seams exist today, so adoption is purely additive:

- **Edge selection is decoupled from the route tool.** `selectEdge` matches
  on `outcome.route`, a string (`edge-selection.ts`); the source of that
  string is not baked into the resolver. Fact-routing slots in with zero
  engine change.
- **Substitution is already a tokenizer.** `INPUT_REF_RE` handles
  `${{ inputs.x }}`; `${{ steps.X.outputs.f }}` is a sibling regex family,
  and `inputReferences()` → validator E030 is the exact pattern for an
  output-ref + dominance E-code.

## The rule it evolves

AGENTS.md ground rule 13 bans `$node.output`. This proposal **evolves** that
rule rather than violating it: cross-node substitution is allowed iff the
producer **dominates** the consumer (so the value is provably populated) and
the field is declared in the producer's `outputs:` schema. The
shared-`thread:` channel stays the right tool for conversation, revision
loops, post-branch merges, and dynamic fan-in.

## Open questions

- **Re-entry semantics.** On a revision loop a re-entered node re-emits and
  overwrites its outputs — `${{ steps.X.outputs.f }}` reads "most recent X",
  not "first X". That's the predictable path, but it means fact-routing can
  *flip* across passes (correct, but state it).
- **Title seed.** Now that the free-form positional is description-only
  (`routing.input`, not substituted), a future `outputs:`-aware title seed
  could derive from declared inputs/outputs rather than the positional.
- **Blob materialisation API.** Where do blob outputs live — artifacts store
  keyed `${nodeId}:output:<field>`, surfaced as a `.path`? Reuses the
  existing tool-node artifact path (`docs/handler-contract.md`).

## Related

- [`llm-routing.md`](./llm-routing.md) — established the `route` tool + the
  two-case edge selector this builds on.
- [`parallel-branch-outputs.md`](./parallel-branch-outputs.md) — archived;
  its `$<branchId>.output` substitution targeted the removed parallel
  runtime, but the downstream-substitution shape is the same idea.
