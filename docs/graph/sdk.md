# `@swarm/sdk` — userland surface

Single TypeScript package authors consume. Subsumes today's `@swarm/extension` (tools / hooks) and adds the typed graph-definition surface.

## Exports

### Graph definition

```ts
import {
  defineGraph,
  llm, task, wait, map, reduce,         // node-kind builders
  edge, retarget,                        // edge builders
} from '@swarm/sdk';

import type {
  Graph, Node, Edge, Outcome,
  RunStatus, NodeContext, IO,
} from '@swarm/sdk';
```

Authors build a typed graph; `.compile()` returns `{ graph, ir, sha }`. The IR is the wire contract; the graph is the typed handle.

### Schema helpers

```ts
import { Type, defineSchema } from '@swarm/sdk';     // Type re-exported from @sinclair/typebox
```

`defineSchema(name, schema)` registers a named schema for cross-graph reuse; the IR carries the resolved JSON Schema verbatim.

### Tool / hook / extension definition

```ts
import {
  defineTool, defineHook, defineExtension,
} from '@swarm/sdk';

import type {
  ToolDef, HookDef, ExtensionContext, SwarmAPI,
} from '@swarm/sdk';
```

Same surface as today's `@swarm/extension`. Tools and hooks ship as extensions; the daemon loads them at boot; `LLM` nodes call tools by name. See [`docs/proposals/extensions-tools.md`](../proposals/extensions-tools.md) and [`docs/proposals/project-extensions.md`](../proposals/project-extensions.md) for the extension lifecycle.

### Pattern library

```ts
import {
  evaluatorOptimizer,                    // (gen, eval, retries) → SubGraph
  vote,                                  // (body, n, aggregate) → Node
  withRetry,                             // (body, retryBudget) → SubGraph (retarget self-edge)
  inputHashKey, alwaysFreshKey,          // Task idempotency helpers
} from '@swarm/sdk';
```

Common patterns expressed as one-liners. See [patterns.md](patterns.md) for the full Anthropic-pattern catalog and how they land in the typed model.

### Testing utilities

```ts
import {
  mockEnvironment,                       // Environment with injectable clock/rng + stub registries
  runGraphInMemory,                      // in-process run for unit tests
} from '@swarm/sdk';
```

Mock the Environment, drive `Run.send`, assert on `Run.events`. Pure-function nodes mock to themselves; LLM calls return replayable canned responses.

### Browser-safe sub-entry

```ts
import { /* React renderers, graph viz components */ } from '@swarm/sdk/web';
```

Component renderers for tools (paired with their server-side definition) and graph visualization. Same split as today's `@swarm/extension/web` carries forward.

## Compile flow

```ts
const change = defineGraph('change', '1.0.0')
  .input(Type.Object({ task: Type.String() }))
  .output(Type.Object({ sha: Type.String() }))
  .node('plan', llm({ /* ... */ }))
  .node('implement', llm({ /* ... */, thread: 'dev' }))
  .node('review', llm({ /* ... */, thread: 'dev' }))
  .edge('plan', 'implement')
  .edge('implement', 'review')
  .edge('review', 'commit', { when: (v) => v.value.verdict === 'approve' })
  .edge('review', 'implement', retarget({
    when: (v) => v.value.verdict === 'reject',
    retryBudget: 2,
  }))
  // ...
  .compile();

// change.graph: Graph<ChangeInput, ChangeOutput>
// change.ir:    string (canonical JSON)
// change.sha:   string (sha256 of ir, == workflow_sha)
```

`.compile()` is **explicit and idempotent**. Returns `{ graph, ir, sha }`. The IR is canonical JSON; the sha matches `workflow_sha` once stored.

`swarm run change.ts` is what authors actually type:

1. CLI imports the `.ts` file.
2. Picks up the exported graph (default export or a named convention).
3. Calls `.compile()`.
4. POSTs the IR (and the inferred `(scope, name)`) to the daemon.
5. Streams events.

Authors don't think about compilation unless they're writing test harnesses.

## Predicate desugaring

Arrow-form predicates and transforms (`when: (o) => o.value.choice === 'approve'`) desugar to DSL AST at `.compile()` time. The SDK ships a runtime TypeScript AST parser; no build-step requirement.

Single-expression arrows: supported.

```ts
when: (o) => o.value.verdict === 'approve'
when: (o) => o.value.severity >= 3 && o.value.cited
when: (o) => o.value.errors.length === 0
```

Multi-statement arrows: rejected at compile-time with a clear error pointing at the lint rule:

```ts
// FAILS:
when: (o) => {
  const x = computeSomething(o);
  return x > 5;
}
// Error: predicates must be single expressions. Rewrite as a pre-computed Task,
// or use a builtin ref. See: <docs link>
```

Closures over external variables: rejected for the same reason — the captured value isn't in the IR, so it can't be replayed or hashed deterministically.

Edges that need richer logic either split into multiple edges, pre-compute via a `Task` node, or reference a runtime builtin (`{ kind: 'ref', ref: 'severityAtLeastHigh' }`). User-authored JS for routing never lives in the IR.

## Type inference across the graph

The SDK's value proposition: type errors at edges fail `tsc`, not runtime.

```ts
const plan       = llm<ChangeInput, PlanSchema>({ /* ... */ });
const implement  = llm<PlanSchema,  ImplementOutput>({ /* ... */ });
const review     = llm<ImplementOutput, Verdict>({ /* ... */ });

defineGraph(...)
  .node('plan',      plan)
  .node('implement', implement)
  .node('review',    review)
  .edge('plan',      'implement')          // ok: PlanSchema → PlanSchema
  .edge('implement', 'review')             // ok: ImplementOutput → ImplementOutput
  .edge('review',    'commit', { when: (v) => v.value.verdict === 'approve' })  // ok
  ;
```

A schema mismatch at an edge — say, `.edge('plan', 'commit')` skipping `implement` — fails `tsc` because `PlanSchema` doesn't extend the commit node's input. Refactor-rename a schema field, every downstream consumer fails to compile.

## Authoring vs runtime

| Concern | Lives in |
|---|---|
| Type inference, builder ergonomics | SDK (TS-time) |
| Predicate AST, schema JSON, node attrs | IR (canonical JSON) |
| Function bodies, regex compilation, edge predicates | Runtime (interprets the IR) |
| `workflow_sha` | sha256 of the IR, not the TS source |

The IR is the contract. The SDK is sugar. Same model as ASL → Step Functions, ADL → Argo, etc.

## What the SDK is *not*

- **Not a query language.** Edge DSL covers routing; for richer logic, write a Task.
- **Not a workflow runtime.** The daemon runs IRs; the SDK only emits them.
- **Not a registry surface for arbitrary user JS bodies.** Tools and hooks are the supported integration points; node bodies are scripts or LLM calls.

## Migration from `@swarm/extension`

When this lands, today's `@swarm/extension` becomes a thin re-export from `@swarm/sdk` for backward-compat. New code imports from `@swarm/sdk` directly; old extension code keeps working until a major version bumps the re-export away. The extension type surface (`defineTool`, hook types) is unchanged; only the package name moves.
