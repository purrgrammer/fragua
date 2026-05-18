# docs/graph/ — typed workflow model

> **Status: design.** A target shape, not the current runtime. The current runtime ships DOT-text-keyed workflows with stringly-typed outputs (last assistant message); this directory describes where we're heading. See `../proposals/json-ir-canonical.md` for the canonical-IR flip that's the first concrete step.

The current workflow model carries two limitations that drive everything in this directory:

1. **Outputs are strings.** Codergen returns the last assistant message; downstream nodes parse prose. Edge conditions are a stringly-typed DSL over `outcome` and `context.<key>`.
2. **Authoring is DOT-only.** Workflows live in a text DSL with no type system; schema mismatches between nodes surface at runtime, not at author time.

The typed Graph model addresses both. The runtime semantics — event-sourced reducer, replay, intent/fact separation, budget enforcement — stay; the *authoring surface* and *data-flow contract* gain types.

## Reading order

1. **[types.md](types.md)** — `Graph<I, O, E>`, `Node<I, O>`, `Edge<O, I'>`, `Outcome<O>`, edge predicate/transform DSL. The core algebra.
2. **[kinds.md](kinds.md)** — five node kinds: `LLM`, `Task`, `Wait`, `Map`, `Reduce`. User-authored compute lives in `Task` (scripts/commands); user JS reaches runs through extensions, not through a graph node body. No `Function` kind.
3. **[runtime.md](runtime.md)** — `Environment`, `BoundGraph`, `Run<I, O, E>`, `IO<E>`. How a graph executes.
4. **[laws.md](laws.md)** — algebraic and operational invariants + property-based testing strategy.
5. **[patterns.md](patterns.md)** — the eight Anthropic patterns (chain / route / sectioning / voting / orchestrator-workers / evaluator-optimizer / autonomous / augmented) expressed in the typed model.
6. **[migration.md](migration.md)** — every current workflow translated to the new model: what gets better, what stays the same.
7. **[sdk.md](sdk.md)** — `@swarm/sdk` userland surface: graph definition, tool definition, hook definition, pattern library, testing utilities, browser-safe sub-entry. Replaces today's `@swarm/extension` and adds the typed authoring layer.

## What ships when

The migration lands in layers, each independently useful:

1. **Canonical JSON IR** (proposal: `../proposals/json-ir-canonical.md`). DOT stays the primary authoring surface; storage flips to canonical JSON. `workflow_sha` = sha256 of the IR.
2. **Typed schemas on nodes.** Each node carries `inputSchema` and `outputSchema`. LLM nodes terminate via a structured-output tool whose schema is `O`. Edge transforms become typed selectors.
3. **TS builder (`@swarm/sdk`).** A typed builder that emits the JSON IR from TS code. Authoring becomes IDE-native; the IR stays the wire contract.
4. **Edge DSL.** Predicate + transform DSL with named-function escape hatch. Edges stay hashable / portable / cross-language emittable.
5. **Five-kind model.** `Task`, `Map`, `Reduce` join `LLM` and `Wait`. `Conditional`/diamond disappears (routing is an edge property); no `Function` kind (user JS lives in extensions, deterministic compute in `Task`).
6. **Run / Environment split.** `bind(graph, env)` resolves IR refs (tools, models, functions). `Run.fresh(boundGraph, input)` produces a `Run<I, O, E>` exposing `IO<E>`.

DOT stays as an authoring surface throughout. The runtime accepts JSON IR over the wire; DOT lowers client-side or server-side. Comments don't round-trip; structure does.

## What this directory is not

- **Not a roadmap.** The order and phasing of the layers above is the closest thing; concrete schedules live in proposals.
- **Not implementation.** No package layout, file paths under `packages/`, or migration playbooks. That belongs in proposals once the design is firm.
- **Not exhaustive.** Sketches the algebra and the runtime contract; doesn't enumerate every attribute, error code, or runtime knob. The current `docs/SPEC.md` / `docs/ARCHITECTURE.md` carry that load until the typed model ships.
