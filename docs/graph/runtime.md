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

- **`tools`** — extensions defined via `@swarm/sdk`'s `defineTool` / `defineExtension` register tools at boot; `LLM` nodes invoke them by name. The "user JS lives here" answer. See [sdk.md](sdk.md).
- **`Task` bodies** — process-spawned scripts referenced by `command`. The runtime never resolves user JS itself; the process boundary is the sandbox.

There is no `FunctionRegistry` for arbitrary user JS bodies. The graph's IR never carries user JS source or compiled artifacts; it carries names that resolve to either extension tools (via `tools`) or runtime-provided builtins (via `builtins`).

### `skills` and `agents` catalogs

`SkillCatalog` and `AgentCatalog` are **read-only metadata** consumed by the LLM-node system-prompt builder. When an LLM node is dispatched, the runtime renders an `## Available skills` and `## Available sub-agents` block into the system prompt so the model knows what's invocable via the `skill` and `agent` tools.

The `skill` and `agent` tools themselves are normal entries in the tool registry. The catalogs are *discovery surfaces* for the system prompt — not auto-include behaviors. There is no "trigger-based skill injection" magic; the LLM explicitly calls `skill({ name: 'design' })` if it wants design context, with the catalog telling it `design` is available.

Catalog contents (name, description, parameters where applicable) are part of the system prompt; the rendered block is part of the LLM's input messages. Replay captures the rendered system prompt in the event log; catalog edits don't affect already-logged runs.

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
  send:   (intent: IntentOf<E>) => Promise<Receipt>;
  events: AsyncIterable<FactOf<E>>;
}

type IntentOf<E> = E extends { dir: 'in';  shape: infer S } ? S : never;
type FactOf<E>   = E extends { dir: 'out'; shape: infer S } ? S : never;
```

Bidirectional event channel. Intents flow in (operator pause / resume / cancel / steer); facts flow out (lifecycle, cost, errors). Same envelope, two directions, both typed.

Today's `intent.*` and `fact.*` events become `IntentOf<E>` and `FactOf<E>`. The taxonomy is preserved; the type just makes direction first-class so a UI binding to `IO<E>` knows what it can `send` vs only iterate.

`events` is `AsyncIterable` — the standard JS surface; consumers who want callbacks wrap it (`for await (const e of io.events) fn(e)`). Earlier drafts had both an iterable AND a callback `subscribe`; redundant, dropped.

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

### AbortSignal triggers

`ctx.signal` fires (aborts in-flight work) on:

- **`intent.cancel`** — operator cancellation. Cleanest stop; in-flight LLM streams close; subprocesses get SIGTERM (then SIGKILL after `cancelGraceMs`, default 5s).
- **`bounds` exceeded** with `policy: 'stop'` — runtime aborts whatever's mid-execution.
- **`maxMs` per-node timeout** — fires on the offending node only.
- **Parent run cancellation** — propagates recursively to sub-Runs.
- **`Race` losing branches** — when one branch resolves, AbortSignal propagates to the others.

When a Wait suspends, `ctx.signal` does NOT fire — the run pauses, the signal stays clean, the Wait resumes by appending an event. Cancel while paused: the signal fires, the Wait transitions to `Outcome.aborted`.

## Edge-selection algorithm

When a node completes with `Outcome<O>`, the runtime picks the outgoing edge to fire next via this exact algorithm:

```
edge_selection(node, outcome):
  outgoing = edges where edge.from == node
  // Step 1: filter by predicate
  candidates = [e for e in outgoing if matches(e.when, outcome)]
  // Step 2: separate retargets from forwards
  retargets = [e in candidates if e.kind == 'retarget' and budget_remaining(e) > 0]
  forwards  = [e in candidates if e.kind == 'forward']
  // Step 3: retargets win first (when budget remains)
  if retargets:
    chosen = first(retargets)    // source-order; validator requires disjoint predicates
    increment_budget_counter(chosen)
    return chosen
  if forwards:
    chosen = first(forwards)     // source-order; validator requires disjoint predicates within forward set
    return chosen
  // Step 4: no edge matched
  halt(run, reason='no_matching_edge', detail='node {node} produced {outcome.tag} with no outgoing edge matching')
```

### Retry budget scope and persistence

`retryBudget` is **per edge instance, per containing run**. A retarget edge with `retryBudget: 5` in the top-level graph fires at most 5 times in the top-level Run; the same edge instance in a sub-Run has its own counter scoped to that sub-Run.

Counters persist via `fact.retarget_fired` events in the event log. Replay reconstructs counters by counting the facts. The validator rejects retarget edges without an explicit `retryBudget`.

### Predicate matching rules

- `when` absent → predicate always matches.
- `when` present and predicate is in the decidable subset → matches deterministically.
- `when` present and predicate is outside the decidable subset → matches per the runtime's predicate evaluator. The validator can't prove disjointness across non-decidable predicates; authors writing such predicates must ensure source-order resolves ties intentionally.

### Source-order priority

Within the retargets-list (or the forwards-list), the first edge in IR source order that matches wins. The validator warns when multiple edges in the same set could match the same `Outcome` (only for predicates in the decidable subset where overlap can be proven).

### Halt on no-matching-edge

If neither retargets (with budget) nor forwards match, the run halts with `reason: 'no_matching_edge'`. This is the typed-model equivalent of today's "no outgoing edge after fail" silent halt — now explicit, with a fact in the log.

## Sub-Runs: one mechanism, four entry points

`Map` elements, `Race` branches, direct `Subgraph`-kind nodes, and any nested `Graph<I, O>` used as a node all run as **sub-Runs**: child `run_state` rows with `parent_run_id` linkage, per [`../proposals/parallel.md`](../proposals/parallel.md). One mechanism, multiple entry points into it. The runtime doesn't distinguish their origins — they're all sub-Runs that inherit the parent's per-turn services (watchdog, budgets, retries, intent fold, HITL, goal gates, edge selection).

Net effect: HITL inside a parallel branch, multi-node branch sub-graphs, retargets inside sub-graphs, racing heterogeneous nodes — all work as first-class features because every sub-graph is just another Run.

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

## Sub-Run event model and replay

Each Run — top-level or nested — has its own slice of the event log, keyed by `run_id`. Sub-Run events do **not** duplicate into the parent's stream.

When a sub-Run completes (terminates with `ok`, `err`, or `aborted`), its parent emits **one** fact: `fact.subrun_completed`, carrying the child's `run_id`, terminal `Outcome` summary, and roll-up cost/tokens. The parent's event log contains this single summary fact per sub-Run, not the child's full event stream. This aligns with [`../proposals/parallel.md`](../proposals/parallel.md).

### Replay scope

A parent run replays by walking **its own** event log only — it reads `fact.subrun_completed` records to learn what each child produced; it does **not** recurse into child event logs during replay. Child runs replay independently from their own event logs when an operator requests a child-specific replay.

This avoids:

- **Write amplification** — events would otherwise be written twice (child log + parent envelope).
- **Replay ambiguity** — the child's event log is canonical for the child; the parent's `fact.subrun_completed` is canonical for "what the parent saw."
- **Coupling cost** — parent replay is O(parent events), not O(tree size).

### Operator views

- **`/runs/:id/events`** — events for run `id` only. Default; cheapest; the canonical event log for that run.
- **`/runs/:id/events?descendants=true`** — union view of the run and all transitive sub-Runs, constructed by recursive SQL on `parent_run_id`. Operator-side lazy tree walk; not used by replay.
- **`/runs/:id/tree`** — the run tree (parent + descendants) with status, terminal Outcome summary, cost rollup. Compact summary surface for dashboards.

### Cost rollup

The parent's `fact.subrun_completed` carries the child's *own-spend* (the child's own LLM calls, Task durations, etc.). The parent's `metrics.totalCostUsd` is **own-spend only** — what the parent itself accrued. The "with-descendants" view sums lazily via tree walk for operator displays.

This split distinguishes **bounded parent budget** (the parent's own runaway prevention) from **observable total spend** (the tree-walk view). Today's swarm conflates them; the typed model separates.

## Wait control plane

Wait nodes change the operator control plane, not just the node kind. Today's `POST /runs/:id/hitl { selected, note? }` flat-payload endpoint generalizes:

```
POST /runs/:id/resume
{
  nodeId:   <wait_node_id>,
  payload:  <validated against Wait.resumeSchema>
}
```

Server validates `payload` against the Wait's `resumeSchema` at the runtime boundary (Tier 3). Validation failure → 400 with the structured error; no run state change. Success → the payload is the Wait node's `Outcome.value`; the run resumes against it.

Endpoint variants:

- **HITL (`source: 'human'`)** — operator POSTs the payload directly. UI affordances (radio buttons, free-text) are derived from the `resumeSchema` shape (rendered via the SDK's web entry).
- **HTTP-Wait (`source: 'http'`)** — *parked for v1*. Auth, replay, idempotency, endpoint identity all unresolved. HITL-only ships first.
- **Timer-Wait (`source: 'timer'`)** — auto-fires via the existing `wake-pending` mechanism. The run pauses with `RunStatus.paused_auto`; the wake-pending sweeper fires `POST /runs/:id/resume` internally with the configured `onFire` payload at the resume time. Indistinguishable from operator-driven resume from the run's perspective.

`intent.hitl_input` (today's intent type) remains as the wire representation of the resume intent; the server adapter converts the new `/resume` endpoint into the typed intent.

## Large-value handling: transparent blob spill

The typed model passes data via edge transforms — `Outcome.value` flows from node to node. For workflows that produce large outputs (a Task fetching a 10MB doc, an LLM generating a 100KB report), naïvely storing `Outcome.value` inline in the event log would blow past the 4 KB payload cap that the store enforces today.

The runtime handles this **transparently**: any field over a threshold (default 32 KB) in any `Outcome` payload — `Outcome.value`, `Outcome.err.error`, `Outcome.aborted.reason`, intermediate fact payloads, validation error bodies — is spilled to the blob store; the event log carries a `Blob` ref keyed by sha256 of the content. Reads inline the content from the blob store when a consumer node accesses it. Authors don't see blobs in the IR; schema validation, edge transforms, debugging tools all operate on the conceptual inlined value.

```
Task fetches 10MB doc                  → runtime: stores in blobs/{sha}, Outcome.value carries { content: <Blob ref> }
Edge: pick(value.title, value.content) → both fields propagate (one inline, one as ref)
LLM consumer: reads value.content      → runtime resolves the ref, inlines for prompt
```

The blob store reuses today's `blobs/` directory and `blobs` table. Replay reads the same refs; deterministic given the same blob store contents.

Authors who need explicit "this field is huge, store as blob" hints can use the `external(path)` TransformExpr form (forces spill regardless of size); `inline(blob_ref)` forces resolution into the materialized value (rare; the runtime resolves automatically when downstream nodes access the field).

Schema validation operates on the **conceptual value**, not the on-disk form. A field typed `Type.String()` validates a blob ref's inlined content as a string. Authors don't write schemas with blob types.

## Thread context policy

A `thread?: ThreadId` on an LLM node tells the runtime to include prior thread messages in this call's context. The runtime applies a **tail-with-budget** policy by default:

- Include the most recent N turns from the shared thread.
- N is adaptive: shrink to fit within the LLM's remaining context window (after `bounds.maxTokens`), preferring more recent turns.
- Older turns are dropped, not summarized. (Summarization is a future runtime optimization; v1 truncates from the head.)

Authors who need explicit control add `threadContextPolicy?: 'tail' | 'full' | 'first-of'` and `threadContextSize?: number` to LLMAttrs:

- **`tail`** (default) — last N turns, where N defaults to "fit budget"; explicit `threadContextSize` caps.
- **`full`** — all prior turns. Authors using this take responsibility for token explosion; the runtime warns at bind time on threads it can statically prove will exceed `bounds.maxTokens`.
- **`first-of`** — only the most recent N turns from the *most recent run* in the thread; useful when threads span retargeted re-runs and you don't want the older retargeted iteration's context.

The migration claim "shared thread = full prior context" was naive — that explodes tokens. The runtime applies a sensible truncation policy by default; authors override only when needed.

## Workflow_sha pinning: runs are immutable

A `Run` is bound to its `workflow_sha` at enqueue time. The `workflows` table is content-addressed (`docs/proposals/json-ir-canonical.md` Decision 5); sha is sha256 of canonical JSON IR. Workflow edits create new shas. Old runs continue to reference their original sha.

Implications for **long-running waits** (a HITL Wait that sits paused for two weeks while the workflow's edited):

- The paused run's `workflow_sha` doesn't change.
- The Wait's `resumeSchema` is whatever it was at enqueue.
- The operator's resume payload is validated against that original schema.
- New runs (post-edit) use the new sha and the new schema; old paused runs don't see the new shape.
- The alias table (`workflow_aliases`) tracks "the latest version of `(scope, name)`"; CLI dispatches new runs against the latest, but the run table holds shas.

There is no "in-flight schema migration" to design. The model is pin-and-replay; runs are immutable references to immutable IR. If an operator wants a paused run to use a *new* schema, they cancel the old run and start a new one — no upgrade-in-place protocol.

This is the same property today's swarm has for `dot_source` — formalized and made explicit in the canonical-IR model.

## Properties to preserve through the migration

- **Replayability.** `replay(graph, env_det, eventLog) ≡ state`. Pure function.
- **Resumability.** A run can be reconstructed from any event-log prefix.
- **Observability.** Every state transition is a fact in the event log.
- **Bounded autonomy.** Budget / cost / time enforced at the Environment layer.
- **Cancellability.** Every node receives an `AbortSignal` scoped to its execution.

The reactive surface (`Run.result` promise, `IO<E>` subscription) and the event-sourced reducer (append-only facts, projection over them) are dual views of the same state. Neither is privileged; both stay first-class.
