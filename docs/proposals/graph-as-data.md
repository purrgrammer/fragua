---
title: Graph-as-data — TypeScript workflow authoring as a peer front-end to YAML
summary: "A graph() function that takes a plain data structure and returns the literal Graph IR — a true peer of the YAML front-end (both lower to the same IR and feed the same validate()), not a builder. Depends on the NodeAttrs→discriminated-union refactor (workflow-ir §8.4): a typed front-end is only worth having if Node is discriminated by kind (LlmNode | HumanNode | ToolNode | …), so tsc checks valid-kind + correct-attrs-per-kind + edge-endpoints-reference-real-node-ids; global/semantic invariants (dominance, when-totality) stay in validate() on the shared IR. The real justification is composability (factored node-builders, parameterized workflows, graphs-as-code you can test), not that any single workflow reads nicer. Unifying principle: every reuse hazard is a name used where a reference was meant (node ids, route values, thread membership) — promote the string to a typed handle. HAND-WAVY: the generics (route-union threading, edge-endpoint inference) and the sugar-vs-escape-hatch surface need a real cut before this is more than a sketch; the NodeAttrs union must land first."
status: draft
maturity: sketch
last-reviewed: 2026-06-03
---

# Graph-as-data

> **Sketch — hand-wavy, and blocked on the IR cleanup.** This captures a design
> conversation's conclusions so they don't evaporate. It is **not** ready to
> build: the type-level generics and the authoring surface need a real cut, and
> it depends on the `NodeAttrs`→discriminated-union refactor
> ([`workflow-ir.md`](workflow-ir.md) §8.4) landing first — a typed front-end
> over a flat attr bag is no safer than a YAML string.

## 1. The idea

A `graph()` function that takes a **plain data structure** and returns the
literal `Graph` IR. A TypeScript peer to the YAML front-end: both lower to the
**identical IR** and feed the **same `validate()`**. This is the per-repo
custom-workflow story — workflows authored, factored, and tested as code.

## 2. Architecture (would defend all of it)

- **Plain data, not a builder.** The graph is a *value* — `graph()` returns the
  literal `Graph` IR — so it inherits sha-pinning, export/import, replay, and the
  validator for free. A builder/class interposes a representation those
  facilities don't understand, and makes the TS API a second thing every tool
  must learn instead of a true peer of the YAML.
- **Three rings, clean division of labor.** The *types* own local/structural
  invariants (tsc checks valid `kind`, correct attrs-per-kind, and — via
  `Edge<keyof N>` — that edge endpoints reference real node ids). `validate()`
  owns global/semantic ones (dominance-by-success, `when:` totality, field
  existence) on the same IR the YAML parser produces. **Do not push dominance
  into the type system** — it's miserable, and you'd build the analysis twice and
  let the two front-ends' guarantees diverge. The invariant must live where both
  front-ends meet: the IR + `validate()`.
- **Discriminate `Node` by kind.** This is what makes a typed front-end worth
  having; a flat attr bag makes the typed API no safer than a YAML string. Kind
  helpers (`llm()`, `human()`, …) stay deliberately *thin* — they pin the
  discriminant and give autocomplete, nothing more. The moment one defaults or
  validates, it's a builder in disguise; resist.
- **Back edges vindicate the data approach.** `verify → review_full` is just
  another entry in the edge array — no forward declaration, no two-phase
  construction. A builder fights cycles; data has no construction order.

## 3. The ergonomic misses (where the first cut was wrong)

- **A flat edge list hides topology — and a workflow's readability *is* its
  topology.** Desugaring the YAML's node-local `routes:`/`next:` into one uniform
  edge array was model-purity at the expense of authoring reality. The fix is the
  hybrid the YAML already found: node-local `next:`/`routes:` sugar for common
  forward cases, a top-level `edges:` array as the escape hatch for the irregular
  ones (back edges, fan-in).
- **Encoding ≠ communicating.** `{ from: "verify", to: "review_full" }` *encodes*
  the loop but doesn't *announce* it. A named `retry()`/`loopBack()` helper
  producing that same edge restores what the YAML's `retry: review_full` said
  outright.
- **Type safety is a gradient, and the seam is principled.** Node-id typos light
  up instantly (`keyof N`). **Routes are also closable** — a node's `routes:` is
  a closed enum; thread it as a type parameter and the outgoing edges' `on` keys
  constrain to it. **`when:` expressions are not closable** without a builder/DSL
  (a templated expression), so they stay `validate()`-time. The honest line:
  node ids + routes are compile-time (closed reference sets); `when:` is
  validate()-time (open expression language) — and that boundary is exactly where
  lifting to types stops being a thin helper.
- **Legibility caps the generics.** "As type-safe as possible" is only worth it
  if the *error* is legible. `keyof N` for node ids yields clean errors; clever
  edge-endpoint/route-union inference can yield 40-line inscrutable ones. Prefer a
  crisp `validate()` diagnostic over a cryptic type error — draw the
  lift-to-types line by error legibility, not by what's theoretically encodable.

## 4. The real justification — composability

Not that any single workflow is nicer to write (the YAML is often nicer). It's
**composability**: factoring node-builders, parameterizing workflows, generating
graphs, testing them as code. That's the only reason to leave a declarative
format, and it's exactly the per-repo-custom-workflow story. The bar for the API
is therefore not "does it type-check" — it's "can a maintainer see the
evaluator-optimizer loop *at a glance* while gaining abstraction the YAML can't
express." A fair demo shows factored/parameterized nodes, not a 1:1 rebuild.

## 5. The unifying principle

Every reuse surprise has one root: **a name used where a reference was meant.**
Node ids, route values, and thread membership all want the same fix — promote the
string to a typed reference so collision is structurally impossible and intent is
explicit. (A typo'd `thread: "analyis"` today silently forks the conversation
with zero error — a name-as-reference bug; `thread("analysis")` as a handle makes
it impossible.) This is the same disease the [`embeddable-engine.md`](embeddable-engine.md)
work fixes at the macro scale — a concrete baked where a port was meant — applied
one altitude down, inside the graph's own vocabulary.

## 6. Prerequisites + open work

- **Blocked on** the `NodeAttrs`→discriminated-union refactor
  ([`workflow-ir.md`](workflow-ir.md) §8.4).
- **Open:** the exact sugar-vs-`edges:` surface; how far to thread route-unions
  through generics before legibility degrades; the `thread()` / `loopBack()` /
  `retry()` helper set; whether node-id references are `keyof N` over a record or
  references to node values.
