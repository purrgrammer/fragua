# Types

The core algebra of the typed Graph model. Every type here is Typebox-derived so the runtime check matches the static type, and every type-level claim has a corresponding IR shape.

## Graph

```ts
type Graph<I, O, E = DefaultGraphEvent> = {
  id:               string;
  contractVersion:  string;                       // author-supplied semver, e.g. "1.2.0"; informational
  irVersion:        number;                       // IR schema version; load-bearing for migration
  inputSchema:      StandardSchemaV1<I>;
  outputSchema:     StandardSchemaV1<O>;
  nodes:            ReadonlyMap<NodeId, AnyNode>;
  edges:            readonly AnyEdge[];
  start:            NodeId;
  exits:            readonly NodeId[];
  bounds?:          Bounds;                       // graph-level budget; sub-graphs share by default
};
```

### Two version fields

- **`contractVersion: string`** — author-supplied semver tag, e.g. `"1.2.0"`. Informational; surfaced in UIs for version-listing per `(scope, name)`. Affects sha only because it's in the IR; doesn't drive any runtime logic.
- **`irVersion: number`** — IR schema version. Load-bearing for schema-migration paths. v1 at first ship.

### No `events` field

The runtime emits facts determined by the *kinds* present (LLM emits `llm.text_delta`, Task emits `task.stdout_line`, etc.). Authors don't declare `E`; the SDK infers it from the graph's kinds for typed-IO consumers. Custom events from extension tools (via `ctx.emit`) join `E` via the extension's declared events schema — not via the graph IR. Earlier drafts carried `events: { in; out }` on Graph; dropped to reduce author confusion ("what do I put here?") and IR size.

A `Graph<I, O, E>` with input `I` and output `O` **also implements `Node<I, O>`**. Sub-graphs compose as nodes; the category is closed under composition. The IR has one shape, recursive.

### Schema embedding

`inputSchema` and `outputSchema` are Typebox-derived JSON Schemas embedded *verbatim* in the IR. The SDK re-exports `Type` from `@sinclair/typebox`; authors write `Type.Object({...})` and the resulting JSON Schema serializes as a plain JSON sub-tree inside the IR. Hashable (it's already JSON), runtime-validatable via `Typebox.Value.Check`, browser-safe. Standard Schema interop is a binding-layer concern at SDK use sites, not in the IR. Schemas are verbose; IRs aren't supposed to be tiny.

### Sub-graph IR shape and node ID scoping

A sub-graph appears in the parent IR as a Node with `kind: 'subgraph'` and an inlined `graph` field carrying the full child Graph object (see [kinds.md § Subgraph](kinds.md#subgraph)). The parent's `workflow_sha` hashes the whole tree.

Internal `nodes` are scoped per sub-graph — child IDs don't collide with parent IDs. Cross-sub-graph node references aren't expressible in the IR (sub-graphs are black boxes from outside); if a cross-reference is needed, hoist the dependent node to the parent. Event-log path prefixing (see [runtime.md](runtime.md)) keeps observability legible across nested runs.

### Bounds and bounds policy

```ts
type Bounds = {
  maxCostUsd?: number;
  maxTokens?:  number;
  maxMs?:      number;
  policy?:     'stop' | 'warn' | 'pause';      // default: 'stop'
};
```

- **`stop`** — exceed → `fact.run_halted { reason: 'budget' }`. Terminal.
- **`warn`** — exceed → emit budget event, keep going. Non-blocking observability.
- **`pause`** — exceed → `fact.run_paused { reason: 'budget' }`. Operator raises the ceiling via `intent.budget_adjusted`, then `intent.resume` re-dispatches the same `(nodeId, iteration)` against the new ceiling.

`bounds` lives on `Graph` (overall budget for the whole tree, including sub-graphs) and on per-kind attrs that have spend potential (`LLMAttrs.bounds`, `TaskAttrs.bounds.maxMs`). Per-kind bounds have no `policy` — they always halt the offending node when exceeded; policy is graph-level.

Sub-graph bounds inherit from the parent unless explicitly overridden (see [runtime.md § Budget inheritance](runtime.md#budget-inheritance)).

## Node

```ts
interface Node<I, O> {
  readonly id:           NodeId;
  readonly inputSchema:  StandardSchemaV1<I>;
  readonly outputSchema: StandardSchemaV1<O>;
  readonly kind:         NodeKind;                // see kinds.md
  // kind-specific attrs live alongside (LLMAttrs, TaskAttrs, etc.)
}
```

The Node interface is minimal: identity, typed schemas, kind discriminator. Per-kind attributes (thread, bounds, prompt, command, etc.) live on the kind's attrs — see [kinds.md](kinds.md). Generic fields on the Node interface that only apply to some kinds (today's `thread`, `bounds`) were misplaced; moved to the kinds that need them.

A node's input comes from its incoming edge's `select` transform (or identity). A node's output is consumed by its outgoing edges' transforms.

### `NodeId` scheme

```
NodeId ::= string matching /^[a-z][a-z0-9-]{0,62}$/
```

Kebab-case, 1–63 chars, leading letter. No reserved IDs — `start` / `exit` are conventions, not special-cased by the runtime. Validator rejects out-of-format IDs at IR-compile time.

### No node-level retry policy

The runtime handles provider-level transient retries (HTTP 429, network resets) below the surface via the `pause_provider` mechanism. Author-controlled retry is expressed in the graph topology — see [retarget edges](#edge) with `retryBudget`. One retry knob, one model: the graph encodes the retry policy.

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
  | { kind: 'ref';  ref: BuiltinRef };       // runtime-provided builtin (not user JS)

type EdgeTransform<O, I2> =
  | { kind: 'expr'; ast: TransformExpr }
  | { kind: 'ref';  ref: BuiltinRef };
```

### Predicate DSL

```
expr  := and(expr, expr) | or(expr, expr) | not(expr)
       | eq(path, value) | ne | lt | gt | lte | gte
       | in(path, list) | exists(path) | matches(path, regex)
path  := "outcome.tag" | "value.verdict" | "value.findings.length" | …
value := string | number | boolean | null
```

Paths read into the upstream node's `Outcome<O>` shape. `outcome.tag` is the discriminator (`ok` / `err` / `aborted` — three variants; `paused` is a `RunStatus`, not an Outcome); `value.<path>` traverses the typed payload for `ok`; `error.<path>` for `err`. The **same path namespace** serves predicates (routing) and transforms (data hand-off) — a deliberate departure from today's two-tier DOT model, where substitution reads `$<id>.output[.path]` and conditions read `outcome` + `context.<key>` with no overlap.

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

### Named builtin refs

When the DSL doesn't suffice, an edge references a *runtime-provided builtin* — a small fixed set of functions the runtime ships (predicates and transforms common enough to warrant inclusion, but too gnarly to express as DSL ASTs). The IR carries `{ kind: 'ref', ref: { name: 'severityAtLeastHigh' } }`; the runtime resolves it at bind time against `Environment.builtins`. Stable hash, code lives in the runtime release, not in user IRs.

Not user-extensible at the IR level. Authors who need richer logic either split into multiple edges, pre-compute via a `Task` node, or — for genuinely user-authored hooks — use the `@swarm/extension` surface (tools, hooks) consumed from an `LLM` node. Lint warns on `ref` edges to encourage data-shaped logic and signal when the DSL falls short for an author.

This is the same indirection used by `Reduce { kind: 'function' }` — the registry contains a small set of named builtins (`concat`, `majority_vote`, `json_merge`, `dedup_rank`, plus the edge-builtins). User-authored JS never lives in the IR.

## Outcome

```ts
type Outcome<O, Err = NodeError> =
  | { tag: 'ok';      value: O }
  | { tag: 'err';     error: Err }
  | { tag: 'aborted'; reason: string };
```

**Three cases, total.** Type system enforces exhaustiveness on consumers. There is no `paused` variant — paused is a *runtime status* (`RunStatus`), not a terminal outcome. Edges only fire when a node has terminated; a Wait node that suspends doesn't produce an Outcome until it resumes (at which point its Outcome is `ok` with the resume value).

No `retriable` field on err — retry is a property of the graph topology (retarget edges with `retryBudget`), not of an outcome. An err just routes to wherever its edge predicates say. The transient-provider-retry case (HTTP 429, network reset) lives below the handler surface as today's `pause_provider` mechanism, not on `Outcome`.

`RunStatus` is the orthogonal axis: `running` | `paused` (with sub-reasons: `paused_hitl`, `paused_budget`, etc.) | `completed` | `halted`. Runtime concern; doesn't appear on node Outcome.

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
