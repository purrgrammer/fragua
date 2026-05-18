# Runtime

Three layers: `Graph` (pure value), `BoundGraph` (resolved against an `Environment`), `Run` (an execution instance exposing `IO<E>`).

```
Graph<I, O, E>       — IR. Hashable. workflow_sha lives here.
       ↓ bind(env)
BoundGraph<I, O, E>  — every IR ref resolved against the Environment.
                       Missing tools / models / functions caught here.
       ↓ run(input)
Run<I, O, E>         — execution instance. Stateful view over an event log.
                       Exposes IO<E>. Owned by the daemon, observed by clients.
```

This split makes today's "validate model is registered at `POST /workflows`" check explicit and reusable: anywhere a graph is about to execute, bind it first, surface every unresolved ref together.

## Environment

```ts
type Environment = {
  store:        EventStore;             // event log (today: SQLite)
  providers:    ProviderRegistry;       // anthropic / openai / … + credentials
  tools:        ToolRegistry;           // IR tool ids → implementations (via extensions)
  builtins:     BuiltinRegistry;        // runtime-provided edge / reducer builtins
                                         // (concat, majority_vote, json_merge,
                                         //  dedup_rank, severityAtLeastHigh, …)
                                         // not user-extensible
  skills?:      SkillCatalog;
  agents?:      AgentCatalog;
  cwd:          string;                 // worktree root
  worktrees?:   WorktreeProvisioner;
  clock:        Clock;                  // injectable for determinism
  rng?:         () => number;           // injectable for determinism
  budgets?:     BudgetEnforcer;
  hitl?:        HumanFeedbackSource;
  httpHooks?:   HttpCallbackEndpoint;
};
```

User-authored code reaches the runtime through two surfaces:

- **`tools`** — extensions defined via `@swarm/sdk`'s `defineTool` / `defineExtension` register tools and hooks at boot; `LLM` nodes invoke them by name. The "user JS lives here" answer. See [sdk.md](sdk.md).
- **`Task` bodies** — process-spawned scripts referenced by `command`. The runtime never resolves user JS itself; the process boundary is the sandbox.

There is no `FunctionRegistry` for arbitrary user JS bodies. The graph's IR never carries user JS source or compiled artifacts; it carries names that resolve to either extension tools (via `tools`) or runtime-provided builtins (via `builtins`).

Two properties to maintain:

1. **Determinism axis.** `clock` and `rng` are injectable; replay against a logged event stream with the same injected sources produces identical state. Today swarm has this by accident for the clock; making it explicit is cheap and pays off.
2. **Capability axis.** Every external effect is reachable via `Environment`, and nothing else. Node bodies can't `import { execSync } from 'child_process'` and bypass the registry. Enforced structurally (handler discipline test, today already in place) and by review.

## bind(graph, env)

```ts
function bind<I, O, E>(
  graph: Graph<I, O, E>,
  env:   Environment,
): BoundGraph<I, O, E> | BindError[];
```

Resolves every IR reference against the Environment:

- LLM `provider` + `model` against `env.providers`
- LLM `tools` against `env.tools`
- Edge / reducer builtin refs against `env.builtins`
- `Task` commands resolved against the worktree's `cwd` and shell at execution time (not bind time, since commands can substitute `$<id>.output`-style late-bound values)
- Sub-graph refs recursively

Returns a `BoundGraph` on success, or an array of `BindError`s listing every unresolved ref. Today's `POST /workflows` rejection with `code="model_unresolved"` becomes a `bind` failure; same logic, one place, reusable from CLI, daemon, dev-time.

`BoundGraph` is a type-level proof that everything resolves. Downstream code consumes `BoundGraph`, not `Graph`.

## Run

```ts
interface Run<I, O, E> extends IO<E> {
  readonly id:           RunId;
  readonly workflowSha:  string;
  readonly input:        I;

  readonly result:       Promise<Outcome<O>>;     // resolves on terminal
  readonly status:       Signal<RunStatus>;       // reactive

  state():               RunState;                // pure projection over events
  history():             Promise<readonly FactOf<E>[]>;

  pause():                                          Promise<void>;
  resume(payload?: unknown):                        Promise<void>;
  cancel(reason: string):                           Promise<void>;
  steer(nodeId: NodeId, steer: Steer):              Promise<void>;
  feedback(nodeId: NodeId, payload: unknown):       Promise<void>;
}

namespace Run {
  function fresh<I, O, E>(bound: BoundGraph<I, O, E>, input: I): Run<I, O, E>;
  function replay<I, O, E>(bound: BoundGraph<I, O, E>, runId: RunId): Run<I, O, E>;
  function resume<I, O, E>(bound: BoundGraph<I, O, E>, runId: RunId): Run<I, O, E>;
}
```

`Run` is a *view* over an event log. The event log is the source of truth. `Run.state()` is a pure projection.

Three constructors:

- **`fresh`** — start a new run with a new `run_id`.
- **`replay`** — rebuild state from a stored event log without executing further. Pure.
- **`resume`** — rebuild state, then continue execution from the latest fact.

Today swarm has resume but no first-class replay; making them peer constructors is the explicit goal.

## IO<E>

```ts
interface IO<E> {
  send:       (intent: IntentOf<E>) => Promise<Receipt>;
  events:     AsyncIterable<FactOf<E>>;
  subscribe:  (fn: (e: FactOf<E>) => void) => Unsubscribe;
}

type IntentOf<E> = E extends { dir: 'in';  shape: infer S } ? S : never;
type FactOf<E>   = E extends { dir: 'out'; shape: infer S } ? S : never;
```

Bidirectional event channel. Intents flow in (operator pause / resume / cancel / steer / feedback); facts flow out (lifecycle, cost, errors). Same envelope, two directions, both typed.

Today's `intent.*` and `fact.*` events become `IntentOf<E>` and `FactOf<E>`. The taxonomy is preserved; the type just makes direction first-class so a UI binding to `IO<E>` knows what it can `send` vs only `subscribe` to.

The same `IO<E>` surface serves:

- The dashboard subscribing to events.
- The CLI streaming output.
- Test harnesses driving a run with synthesized intents.
- The replay tool walking a logged stream.

## NodeContext

Each node body runs with a capability-scoped projection of the Environment:

```ts
type NodeContext<I, O, E> = {
  readonly runId:   RunId;
  readonly nodeId:  NodeId;
  readonly input:   I;
  readonly cwd:     string;
  readonly signal:  AbortSignal;

  // Kind-specific capabilities — only what the node is allowed to use
  readonly llm?:     LLMHandle;
  readonly tools?:   readonly ToolHandle[];

  readonly emit:     (partial: PartialFact<E>) => void;        // streaming partials
  readonly awaitResume?: <T>(schema: StandardSchemaV1<T>) => Promise<T>;
};
```

A node never sees the full `Environment`. The capability boundary is structural — handler bodies can only touch what's on `ctx`. Replay determinism falls out: a body that doesn't reach outside `ctx` is, by construction, deterministic given `ctx`.

`emit` is the streaming surface — what today produces `llm.text_delta` / `cost.update` events. It writes through to the event log via the same envelope; clients see the partials over `IO<E>`.

## Sub-Runs: one mechanism, two entry points

Both `Map` elements and direct `Subgraph`-kind nodes run as **sub-Runs**: child `run_state` rows with `parent_run_id` linkage, per [`../proposals/parallel.md`](../proposals/parallel.md). One mechanism, two entry points into it. The runtime doesn't distinguish "sub-graph because Map.body" from "sub-graph because direct Subgraph node" — both produce sub-Run rows that inherit the parent's per-turn services (watchdog, budgets, retries, intent fold, HITL, goal gates, edge selection).

Net effect: HITL inside a parallel branch, multi-node branch sub-graphs, retargets inside sub-graphs — all work as first-class features because every sub-graph is just another Run.

## Budget inheritance

By default, sub-graphs and Map elements **share the parent run's budget pool**. The graph-level `bounds.maxCostUsd` is the ceiling for the whole tree; sub-graph nodes don't get their own budget unless explicitly asked.

An optional `bounds` override on a sub-graph node (or `Map.body` node) creates a sub-budget. The runtime enforces `min(parent_remaining, sub_budget)` at every turn boundary; whichever cap binds first fires the budget policy. Authors who need per-element bounds set them on the Map's `body` node.

Policy (`stop` / `warn` / `pause`) lives on graph-level bounds (see [types.md § Bounds policy](types.md#bounds-policy)). Sub-graphs inherit policy from the parent unless explicitly overridden.

```ts
// Whole-graph budget; sub-runs share it.
defineGraph(...).bounds({ maxCostUsd: 5.00 })

// Map element body capped at $0.30 each, drawing from the shared $5 pool.
map({
  extract: (i) => i.subtasks,
  body: workerNode.bounds({ maxCostUsd: 0.30 }),
  concurrency: 4,
  policy: 'wait_all',
})
```

## Sub-graph and Map event surface

Sub-graph events (and Map element events) emit on the parent run's stream wrapped in a `fact.subgraph_event` envelope with a `nodeIdPath` prefix. Subscribers to the parent's `IO<E>` see the nested fact; subscribers to the sub-graph's own `IO<E>` (returned from `runGraph` for an explicit sub-Run) see the raw inner fact.

This means dashboards can subscribe to the parent once and render nested by path; the SDK's typed `IO<E>` on a child `Run` filters to its own slice. Same event log, two views.

## Properties to preserve through the migration

- **Replayability.** `replay(graph, env_det, eventLog) ≡ state`. Pure function.
- **Resumability.** A run can be reconstructed from any event-log prefix.
- **Observability.** Every state transition is a fact in the event log.
- **Bounded autonomy.** Budget / cost / time enforced at the Environment layer.
- **Cancellability.** Every node receives an `AbortSignal` scoped to its execution.

The reactive surface (`Run.result` promise, `IO<E>` subscription) and the event-sourced reducer (append-only facts, projection over them) are dual views of the same state. Neither is privileged; both stay first-class.
