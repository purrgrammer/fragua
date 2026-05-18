# Node kinds

Six IR `kind` discriminator values: five **compute** kinds (`llm`, `task`, `wait`, `map`, `reduce`) and one **structural** kind (`subgraph`) that wraps a child `Graph<I, O>` so it composes as a node. Authoring picks the compute kind explicitly; sub-graphs are produced by composing graphs via the SDK (`.node('id', subgraph(childGraph))` or by passing a compiled `Graph<I, O>` directly to `.node()`).

There is no `Conditional`/`Router` kind — routing is an edge property (`when` predicate), not a node kind. Diamonds disappear from the model.

There is also no `Function` kind for user-authored JS bodies. The three places "function-shaped" code shows up — edge predicates / transforms, fan-in reducers, and small compute nodes — each have a better home:

- **Edge predicates / transforms** are expressed in the predicate / transform DSL (see [types.md](types.md)); their TS-builder form (`(o) => o.value.choice`) desugars to AST at compile time and never runs as JS at runtime.
- **Fan-in reducers** are either `Reduce { kind: 'llm' }` for synthesis or `Reduce { kind: 'function' }` pointing at a small *runtime-provided* builtin registry (`concat`, `majority_vote`, `json_merge`, `dedup_rank`). Not user-extensible at the IR level.
- **Domain compute nodes** ("extract areas from a snapshot", "pick a model from a heuristic") express as `Task` — scripts or commands with idempotency metadata. Process spawn overhead is ms-scale; almost nothing in this category is hot enough to need in-process execution.

User-authored JS reaches into runs through **the SDK's extension surface** (`@swarm/sdk`'s `defineTool` / `defineHook` — invoked from `LLM` nodes), not through a graph node kind. That's a separate, already-loaded surface; see [sdk.md](sdk.md).

## LLM

```ts
type LLMAttrs<I, O> = {
  provider:        string;                      // 'anthropic' | 'openai' | ...
  model:           string;                      // provider-native model id
  tools?:          ToolRef[];                   // resolved against Environment.tools
  thread?:         ThreadId;                    // optional continuity hint
  bounds?:         { maxCostUsd?: number; maxTokens?: number; maxMs?: number };
  reasoningEffort?: 'low' | 'medium' | 'high';

  prompt:          PromptSpec;                  // declarative template
  parseOutput:     'tool-call' | 'structured-response';
  outputRetries?:  number;                      // default: 1
};

type PromptSpec = {
  system?:   TemplateExpr;                      // optional system message
  user:      TemplateExpr;                      // required user message
};

type ToolRef =
  | string                                      // 'web_fetch' — bare; ambiguous if multiple extensions provide it
  | { extension: string; name: string };        // 'bitrefill/web_fetch' — explicit
```

A typed input is rendered to messages by interpolating `prompt.user` (and `prompt.system` if set) against `I` via the [TemplateExpr DSL](expressions.md#templateexpr--string-templates-with-placeholders). The LLM call produces typed `O` via one of two mechanisms:

1. **Terminal output tool** (default). Implicit `emit_output` tool whose schema is `O`. The LLM is required to call it to terminate; the tool result is the output. Observable in the event log, works on any provider with tool use.
2. **Structured response.** Provider-native (`response_format`, JSON mode). Faster path when the provider supports it natively.

There is no fallback text parser. Authors who can't use either output mode restructure with a downstream `Task` that parses prose.

Tools are referenced by name; `Environment.tools` resolves at bind. Bare-string refs fail with "ambiguous tool name" if multiple extensions register the same name; the explicit `{ extension, name }` form disambiguates. Tool versioning is an extension-management concern (the extension's own version pin in project config), not a workflow concern.

### Output failure handling

The model may decline to call the output tool, or call it with arguments that fail the output schema. Default behavior: feed the validation error back as a user message ("Your previous output didn't match the schema: <error>. Please call `emit_output` again with valid arguments."), retry once. On the second failure, emit `Outcome.err` with the validation error in the body; downstream edges route on it. `outputRetries?: number` overrides the cap (default 1).

### Prompt expressivity ceiling

`prompt.user` and `prompt.system` are TemplateExpr strings — placeholders against `I`, no conditionals, no loops, no function calls outside the filter registry. The constraint is deliberate: it keeps the IR pure data. Authors who need conditional sections or loops factor the work into an upstream `Task` that produces typed prompt-data; the LLM node consumes the structured data via a simple template.

If you find yourself wanting `{{#if input.urgent}}...{{/if}}` in a template, that's the signal to author an upstream Task that builds the typed `{ heading, urgentSection?, ... }` shape, then template against that.

## Task

```ts
type TaskAttrs<I, O> = {
  command:    TemplateExpr;                       // shell command; placeholders substitute from I
  inputMode?: 'stdin-json' | 'args' | 'env';      // default: stdin-json
  outputMode?: 'stdout-json' | 'stdout-text';     // default: stdout-json when I/O is typed
  cwd?:       string;
  env?:       Record<string, string>;
  bounds?:    { maxMs?: number };
};
```

The single "user-authored compute" node kind. Covers today's `tool` nodes (`parallelogram` in DOT) and absorbs what was previously called a `Function` node. Authors write a script (`./scripts/extract-areas`) and pipe typed I/O through it.

### Examples

- **Deterministic pure transform**: `command: 'bun ./scripts/extract-areas.ts'`, input piped as JSON on stdin, output parsed as JSON from stdout. Process spawn cost is ms-scale; fine for anything not on a hot inner loop.
- **Run CI**: `command: 'bun run ci'`. Just runs; replay reads the logged Outcome from the event store.
- **Fetch a doc**: `command: 'curl ${input.url}'`.
- **Apply a patch**: `command: 'bun ./scripts/apply-patch.ts'`.

### Replay vs caching

Replay determinism comes from the event log: a replayed run reads the Outcome that was logged on the original run; the command never re-executes. This is sufficient for the runtime contract — authors don't need to assert idempotency on the IR.

Caching across runs (LRU on `(command, canonicalized input, env, cwd)`) is a future runtime-internal optimization that doesn't surface in the IR. Authors who need "always fresh" semantics inside a single run write a fresh upstream input value (a `Map` with a per-element nonce, etc.); authors who need cross-run dedup wait for the runtime to add caching.

The earlier `idempotencyKey` / `cache` fields were author-facing surface for a feature swarm doesn't ship today. Dropped to keep the IR honest.

For non-idempotent ad-hoc shell calls, prefer the `bash` tool inside an `LLM` node rather than a Task — that's what it's for.

### Task error body and stderr access

On non-zero exit, the failure body carries stdout, stderr, and exit code:

```ts
Outcome.err = {
  tag: 'err',
  error: { stdout?: string; stderr: string; exitCode: number },
};
```

Downstream edges route on `o.error.exitCode` (e.g., distinguish `EX_TEMPFAIL=75` from other failures) and read stderr text via `o.error.stderr`. Authors who want "exit 75 → retry" wire a retarget self-edge:

```ts
.edge('myTask', 'myTask', retarget({
  when: (o) => o.tag === 'err' && o.error.exitCode === 75,
  retryBudget: 3,
}))
```

On exit-zero success, stderr is captured in the streaming-partials event log (observable via `IO<E>`) but not surfaced on the Node's typed `O`. The legacy `$<id>.stderr` substitution retires with substitution generally — typed edges carry the error body directly.

## Wait

```ts
type WaitAttrs<I, O> =
  | {
      source:       'human';
      prompt:       { question: TemplateExpr; description?: TemplateExpr };
      resumeSchema: StandardSchemaV1<O>;
    }
  | {
      source:       'http';
      callbackPath: string;                       // relative URL; runtime knows base
      expect:       StandardSchemaV1<O>;
    }
  | {
      source:       'timer';
      durationMs:   number;                       // for "wait until X", compute durationMs at start
      onFire:       O;                            // const value the timer produces
    };
```

A pause primitive. **Each `Wait` node has exactly one source** — `human`, `http`, or `timer` — and its typed output `O` is that source's payload. Today's HITL hexagon is the `human` source; HTTP callbacks and timer firings become first-class on the same primitive with their own variants.

The single-source choice is deliberate. Almost every real Wait is HITL-only; forcing a tagged union on every node penalizes the common case for a rare one. Multi-source ("wait for human OR timeout") is expressed by composition: `Map(extract: () => [humanWait, timerWait], body: subgraph, policy: 'first_success')`. Explicit and rare; the common HITL case stays clean.

The `Outcome` of a `Wait` node is `{ tag: 'ok'; value: O }` once resolved. While the Wait is suspended, the run has `RunStatus.paused` (the orthogonal axis — `paused` is a runtime status, not an Outcome variant); the runtime emits `fact.run_paused`. Resumption events flow in via `IO<E>` and the runtime validates them against the source's schema (`resumeSchema` for human, `expect` for http) before propagating to the Outcome. Validator rejects multi-source Wait at IR build time.

### Routing on `Wait` output

Wait isn't a special case for routing. Outgoing edges read the typed `O` via the same predicate DSL as any other node:

```ts
.node('signoff', wait({
  source:       'human',
  prompt:       { question: 'Approve to ship ${input.summary}?' },
  resumeSchema: Type.Object({
    choice: Type.Union([Type.Literal('approve'), Type.Literal('reject'), Type.Literal('defer')]),
    note:   Type.Optional(Type.String()),
  }),
}))
.edge('signoff', 'publish', { when: (o) => o.value.choice === 'approve' })
.edge('signoff', 'draft',   { when: (o) => o.value.choice === 'reject'  })
.edge('signoff', 'queue',   { when: (o) => o.value.choice === 'defer'   })
```

The DOT-era accelerator labels (`label="[A] Approve"`) become **UI affordances**, not routing keys. They're hints for the operator (or for a CLI prompt) about which canonical payloads to send; the schema is the source of truth, and predicates read structured fields. A rich `resumeSchema` can carry far more than a flat enum — radio + free-text + checkboxes — while routing still reads the structured payload.

This is a deliberate departure from today's two-tier model (substitution paths for prompts, condition paths for routing). In the typed model the path namespace is one: predicates and transforms both read the same `Outcome<O>` shape, and Wait is no different from LLM, Reduce, Task, Map, or any sub-graph.

## Map

```ts
type MapAttrs<I, Elem, BodyOut, O> = {
  extract:     TransformExpr;                     // path/expression yielding Elem[]
  body:        Node<Elem, BodyOut>;               // sub-graph or single node
  concurrency: number;                            // > 0; runtime caps at extracted-array length
  policy:      'wait_all' | 'first_success' | 'collect_settled';
};
```

Fan-out over an array. `body` runs per element (concurrently up to `concurrency`); outputs collect according to `policy`:

- **`wait_all`** — every element must succeed; output is `BodyOut[]` in extract order.
- **`first_success`** — first successful element wins; others abort; output is `BodyOut`.
- **`collect_settled`** — `Promise.allSettled` semantics; output is `Settled<BodyOut>[]`.

The Map node's `outputSchema` (the typed `O` in the surrounding `Node<I, O>`) is **derived by the SDK** from `body.outputSchema` × `policy` — authors don't write it. The IR carries the derived shape verbatim; downstream `.edge()` calls see the right type via inference. Schema-derivation rules live in the SDK, not at bind time.

`body` is `Node<Elem, …>`, which includes sub-graphs. `Map` composes naturally with the typed model.

Each Map element runs as a **child `run_state` row** with `parent_run_id` linkage — see [../proposals/parallel.md](../proposals/parallel.md). This unifies today's `component → branches → fan_in` and the typed `Map → Reduce` paths through the same sub-run mechanism. Map and the parallel-sub-runs proposal land together. HITL inside a Map element body is supported (the element is a sub-run; sub-runs support all of the executor's per-turn services including HITL goal-gates).

This is the primitive that replaces today's `component` fan-out, and the one that enables the *observable* form of orchestrator-workers: `LLM(decompose) → Map(extract = out.subtasks) → Reduce`.

## Reduce

```ts
type ReduceAttrs<Elem, O> =
  | { kind: 'function'; builtin: BuiltinReducerRef }   // runtime-provided
  | { kind: 'llm';      llm: LLMAttrs<readonly Elem[], O> };
```

Fan-in: take an array, produce an aggregate. Two flavors:

- **Function reducer** — references a named builtin from a small runtime-provided registry: `concat` (today's heuristic), `majority_vote`, `json_merge`, `dedup_rank`. Deterministic, hashable, replay-stable. Not user-extensible at the IR level — extensions register tools, not reducers. For ad-hoc deterministic aggregation that isn't covered by a builtin, feed `Map`'s output into a downstream `Task` instead.
- **LLM reducer** — calls a model on `Elem[]` to synthesize a structured `O`. Use for cross-finding synthesis, narrative merges, anything that needs judgment.

Today's `tripleoctagon` is conceptually a Reduce, currently restricted to the heuristic-concatenator builtin regardless of whether `prompt=` is set (see [../proposals/fan-in-to-reduce.md](../proposals/fan-in-to-reduce.md)). The typed `Reduce` makes the LLM-vs-builtin choice explicit instead of inferring from prompt presence.

## Subgraph

```ts
type SubgraphAttrs<I, O, E> = {
  graph: Graph<I, O, E>;                  // inlined in the parent's IR
};
```

A `Node<I, O>` whose body is a child `Graph<I, O>`. The IR inlines the child graph verbatim at the parent's site — parent's `workflow_sha` hashes the whole tree. Storage-level dedup of shared sub-graphs (a `subgraphRefs?: { sha; nodeId }[]` index) is deferred as an optimization; v1 inlines for simplicity.

**Single-exit sub-graphs** (the common case) have `O = ExitOutput` directly — the child's output schema flows up unchanged.

**Multi-exit sub-graphs** (a child Graph with multiple `exits`) emit a **tagged-union output**:

```ts
O = { exit: 'publish'; value: PublishOutput }
  | { exit: 'draft';   value: DraftOutput };
```

The SDK derives the output schema from the child's exits. Downstream edges route on `o.value.exit === 'publish'` via the predicate DSL.

Sub-graphs run as **sub-Runs**: a child `run_state` row with `parent_run_id` linkage, per [`../proposals/parallel.md`](../proposals/parallel.md). This is the same sub-Run mechanism Map elements use — one path, two entry points. Sub-runs inherit the parent's budget pool by default (overridable per [runtime.md § Budget inheritance](runtime.md#budget-inheritance)), and their events propagate to the parent stream with `nodeIdPath` prefix (per [runtime.md § Sub-graph and Map event surface](runtime.md#sub-graph-and-map-event-surface)).

Validation (reachability, predicate completeness, DAG property) applies **per sub-graph recursively**, not transitively. Each sub-graph is its own DAG; the parent's edges connecting sub-graph-nodes form a DAG at the parent level.

## Cross-kind invariants

- **`Task`** bodies are externally observable (process-spawned); the IR carries only `command` and I/O wiring. Replay reads the logged Outcome from the event store; no idempotency assertion needed from the author.
- **`LLM`** is the only kind whose output isn't fully deterministic. The event log captures every turn; replay uses the logged result, not a fresh call.
- **`Map`** and **`Reduce`** with builtin function reducers are fully replayable (logged element outcomes feed the reducer; builtin code is stable across runs).
- **`Wait`** suspends and resumes via the event log; the resume event is the output. Suspension is a `RunStatus` (`paused`), not an Outcome variant.
- **`Subgraph`** is pure structural composition; the replay property of the parent is the conjunction of the replay properties of the child sub-graphs.

The replay property holds across all six kinds when the Environment is deterministic (injected `clock`, `rng`) — Task outputs are read from the event log on replay, so determinism doesn't depend on author-asserted properties of the Task body.

### No function-typed attrs in the IR

Every kind's attrs above use [declarative expression types](expressions.md) — `TemplateExpr`, `PathExpr`, `TransformExpr`, `PredicateExpr`, `BuiltinRef`. No kind carries a TS function in the IR. The SDK desugars author-friendly forms (template literal strings, single-expression arrows, imported builtins) at `.compile()` time. Authors who need richer logic factor the work into an upstream Task. This is the constraint that keeps the IR pure data and replays deterministic.
