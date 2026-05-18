# Types

The core algebra of the typed Graph model. Every type here is Typebox-derived so the runtime check matches the static type, and every type-level claim has a corresponding IR shape.

## Graph

```ts
type Graph<I, O, E = DefaultGraphEvent> = {
  id:            string;
  version:       string;                          // semver of the graph contract
  schemaVersion: number;                          // IR schema version
  inputSchema:   StandardSchemaV1<I>;
  outputSchema:  StandardSchemaV1<O>;
  nodes:         ReadonlyMap<NodeId, AnyNode>;
  edges:         readonly AnyEdge[];
  start:         NodeId;
  exits:         readonly NodeId[];
  events: {
    in:  StandardSchemaV1<IntentOf<E>>;          // intents the graph accepts
    out: StandardSchemaV1<FactOf<E>>;            // facts the graph emits
  };
};
```

A `Graph<I, O, E>` with input `I` and output `O` **also implements `Node<I, O>`**. Sub-graphs compose as nodes; the category is closed under composition. The IR has one shape, recursive.

## Node

```ts
interface Node<I, O> {
  readonly id:           NodeId;
  readonly inputSchema:  StandardSchemaV1<I>;
  readonly outputSchema: StandardSchemaV1<O>;
  readonly kind:         NodeKind;                // see kinds.md
  readonly retry?:       RetryPolicy;
  readonly thread?:      ThreadId;                // continuity hint, not data flow
  readonly bounds?: {
    maxCostUsd?: number;
    maxTokens?:  number;
    maxMs?:      number;
  };
}
```

A node's input comes from its incoming edge's `select` transform (or identity). A node's output is consumed by its outgoing edges' transforms. `thread` is a *continuity* hint — it tells the runtime to include prior thread messages in this node's call context — and is orthogonal to data flow.

## Edge

```ts
type Edge<O, I2> = {
  from:        NodeId;
  to:          NodeId;
  when?:       EdgePredicate<O>;       // default: always fire
  select?:     EdgeTransform<O, I2>;   // default: identity (requires O extends I2)
  kind:        'forward' | 'retarget';
  retryBudget?: number;                // bound on retarget cycles through this edge
  label?:      string;                 // operator-facing for HITL accelerators
};
```

Two edge kinds:

- **`forward`** — the normal flow. Forms a DAG. Multiple forward edges from one source must have disjoint or first-match `when` predicates.
- **`retarget`** — the *only* way cycles enter the graph. The evaluator-optimizer pattern is a retarget edge from the judge back to the generator with `retryBudget`. Static checks: forward edges form a DAG; retarget edges close cycles only when paired with a budget.

## EdgePredicate, EdgeTransform — the DSL

Edges carry hashable, portable data. The runtime executes them; cross-language clients emit them.

```ts
type EdgePredicate<O> =
  | { kind: 'expr'; ast: PredicateExpr }    // serialized AST, hashable, portable
  | { kind: 'ref';  ref: FunctionRef };      // named handle, code in registry

type EdgeTransform<O, I2> =
  | { kind: 'expr'; ast: TransformExpr }
  | { kind: 'ref';  ref: FunctionRef };
```

### Predicate DSL

```
expr  := and(expr, expr) | or(expr, expr) | not(expr)
       | eq(path, value) | ne | lt | gt | lte | gte
       | in(path, list) | exists(path) | matches(path, regex)
path  := "outcome.tag" | "value.verdict" | "value.findings.length" | …
value := string | number | boolean | null
```

Paths read into the upstream node's `Outcome<O>` shape. `outcome.tag` is the discriminator (`ok` / `err` / `paused` / `aborted`); `value.<path>` traverses the typed payload. The **same path namespace** serves predicates (routing) and transforms (data hand-off) — a deliberate departure from today's two-tier DOT model, where substitution reads `$<id>.output[.path]` and conditions read `outcome` + `context.<key>` with no overlap.

This unification means **Wait isn't a special case**. An HITL node's routing reads its `resumeSchema`-typed payload via `value.<path>` predicates, the same way an LLM or Reduce node's routing does. Today's accelerator-label matching (`label="[A] Approve"`) becomes a UI affordance; the schema and structured payload drive the predicate.

The TS builder desugars normal arrow functions into the DSL via an AST transform at compile time. Author writes:

```ts
when: (o) => o.value.verdict === 'approve'
```

Compiler emits:

```json
{ "kind": "expr",
  "ast": { "op": "eq",
           "lhs": { "path": "value.verdict" },
           "rhs": { "lit": "approve" } } }
```

### Transform DSL

```
expr := pick(...paths)       — keep only these fields
      | omit(...paths)        — drop these fields
      | set(path, value)      — set a constant
      | rename({ from: to })  — rename a field
      | merge(left, right)    — shallow merge
      | path-extract          — pull a sub-value
```

### Named function refs

When the DSL doesn't suffice, an edge references a function in the `FunctionRegistry`. The IR carries `{ kind: 'ref', ref: { name: 'feedbackFromReject' } }`; the runtime resolves it at bind time. Stable hash, code lives in the registry. Lint warns on ref edges to encourage data-shaped logic.

This is the same indirection used by `Function` and `Task` node bodies — uniform across the IR.

## Outcome

```ts
type Outcome<O, Err = NodeError> =
  | { tag: 'ok';      value: O }
  | { tag: 'err';     error: Err; retriable: boolean }
  | { tag: 'paused';  reason: PauseReason; resumeSchema: StandardSchemaV1<unknown> }
  | { tag: 'aborted'; reason: string };
```

Four cases, total. Type system enforces exhaustiveness on consumers. `paused` carries the resume schema so the runtime can validate operator input at the IO boundary — today's HITL accepts arbitrary payloads; the typed model rejects mismatches structurally.

## Where each property is enforced

### Type-system enforced (compile-time)

- **Schema compatibility at edges.** For every edge `(a → b)`: `Output(a) ⊆ select(Input(b))`. Compile error if violated.
- **Outcome totality.** Every node returns exactly one `Outcome<O>` case. Discriminated union; exhaustiveness checked on consumers.
- **Sub-graph closure.** `Graph<I, O>` implements `Node<I, O>`. The category is closed.

### Statically checkable on the IR (lint, pre-run)

- **Reachability.** Every node reachable from `start`; every node reaches an `exit`. Dead code rejected.
- **Predicate completeness.** Outgoing forward edges' `when` predicates cover all of `O`, or an explicit `else` edge exists.
- **Predicate disjointness.** At most one forward edge from a given node fires per outcome.
- **DAG property.** Forward edges form a DAG; cycles only via retarget edges; every retarget edge has `retryBudget`.

The full law list (including runtime invariants and property-test templates) lives in [laws.md](laws.md).
