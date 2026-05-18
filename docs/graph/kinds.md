# Node kinds

Five kinds. Each is a discriminated case of `NodeKind`. Authoring picks the kind explicitly; the runtime dispatches on it.

There is no `Conditional`/`Router` kind — routing is an edge property (`when` predicate), not a node kind. Diamonds disappear from the model.

There is also no `Function` kind for user-authored JS bodies. The three places "function-shaped" code shows up — edge predicates / transforms, fan-in reducers, and small compute nodes — each have a better home:

- **Edge predicates / transforms** are expressed in the predicate / transform DSL (see [types.md](types.md)); their TS-builder form (`(o) => o.value.choice`) desugars to AST at compile time and never runs as JS at runtime.
- **Fan-in reducers** are either `Reduce { kind: 'llm' }` for synthesis or `Reduce { kind: 'function' }` pointing at a small *runtime-provided* builtin registry (`concat`, `majority_vote`, `json_merge`, `dedup_rank`). Not user-extensible at the IR level.
- **Domain compute nodes** ("extract areas from a snapshot", "pick a model from a heuristic") express as `Task` — scripts or commands with idempotency metadata. Process spawn overhead is ms-scale; almost nothing in this category is hot enough to need in-process execution.

User-authored JS reaches into runs through **extensions** (`@swarm/extension` — tools and hooks called from `LLM` nodes), not through a graph node kind. That's a separate, already-loaded surface.

## LLM

```ts
type LLMAttrs<I, O> = {
  provider:    string;
  model:       string;
  tools?:      ToolRef[];                       // resolved against Environment
  thread?:     ThreadId;                        // optional continuity
  bounds?:     { maxCostUsd?, maxTokens?, maxMs? };
  reasoningEffort?: 'low' | 'medium' | 'high';

  buildPrompt: (input: I, ctx: NodeContext) => Promise<LLMRequest>;
  parseOutput: 'tool-call' | 'structured-response' | {
    fromAssistantText: (s: string) => O;        // fallback parser
  };
};
```

A typed input is rendered into messages by `buildPrompt`. The LLM call produces typed `O` via one of three mechanisms:

1. **Terminal output tool** (default). Implicit `emit_output` tool whose schema is `O`. The LLM is required to call it to terminate; the tool result is the output. Observable in the event log, fallback-friendly, works on any provider with tool use.
2. **Structured response.** Provider-native (`response_format`, JSON mode). Faster path when the provider supports it natively.
3. **Fallback text parser.** Author-supplied parser. Used only when neither tool-call nor structured-response is available.

Tools are referenced by name (`ToolRef`); `Environment.tools` resolves them at bind time.

## Task

```ts
type TaskAttrs<I, O> = {
  // What to run. Today's `tool_command` shape extended with structured
  // I/O knobs and idempotency metadata.
  command:         string;                        // shell command; substitution supported
  inputMode?:      'stdin-json' | 'args' | 'env'; // default: stdin-json
  outputMode?:     'stdout-json' | 'stdout-text'; // default: stdout-json when I/O is typed
  cwd?:            string;
  env?:            Record<string, string>;

  // Cacheability + replay safety
  idempotencyKey?: (input: I) => string;          // default: canonicalized input hash
  cache?:          { ttlMs: number };
};
```

The single "user-authored compute" node kind. Covers today's `tool` nodes (`parallelogram` in DOT) and absorbs what was previously called a `Function` node. Authors who want a deterministic pure transform write a script (`./scripts/extract-areas`) and declare it idempotent; the runtime caches by `idempotencyKey` so replays don't re-execute side effects.

Examples (drawn from current and target workflows):

- **Deterministic pure transform** (was: Function): `command="bun ./scripts/extract-areas.ts"`, input piped as JSON on stdin, output parsed as JSON from stdout. `idempotencyKey = i => sha256(JSON.stringify(i))`. Process spawn cost is ms-scale; this is fine for anything not on a hot inner loop.
- **Run CI**: `command="bun run ci"`, `idempotencyKey = i => i.gitSha`. Cached: same sha → cached result, no re-run.
- **Fetch a doc**: `command="curl …"`, `idempotencyKey = i => \`${i.url}|${i.etag}\``.
- **Apply a patch**: `command="bun ./scripts/apply-patch.ts"`, `idempotencyKey = i => sha256(i.patch)`.

The author asserts idempotency by setting the key. The runtime trusts it — a non-idempotent body declared idempotent is a bug, surfaced when replay diverges from the original run. Side-effecting bodies without an idempotency key are valid but won't replay correctly; the validator warns when `idempotencyKey` is absent on a Task that produces typed output.

For non-idempotent ad-hoc shell calls, prefer the `bash` tool inside an `LLM` node rather than a Task — that's what it's for.

## Wait

```ts
type WaitAttrs<I, O> = {
  human?:  { prompt: (i: I) => HumanPrompt; resumeSchema: StandardSchemaV1<O> };
  http?:   { callbackPath: string; expect: StandardSchemaV1<O> };
  timer?:  { durationMs: number; onFire: O };
};
```

A unified pause primitive. Any source listed (human / http / timer) can satisfy the wait — whichever resolves first wins. Today's HITL hexagon is `{ human: … }`; HTTP callbacks and timer firings become first-class on the same primitive.

The `Outcome` of a `Wait` node is always `{ tag: 'ok'; value: O }` once resolved; before that, the node sits in `{ tag: 'paused' }` state and the runtime emits `fact.run_paused`. Resumption events flow in via `IO<E>` and the runtime validates them against `resumeSchema` / `expect` before propagating.

### Routing on `Wait` output

Wait isn't a special case for routing. Outgoing edges read the typed `O` via the same predicate DSL as any other node:

```ts
.node('signoff', wait({
  human: {
    prompt:       () => ({ question: 'Approve to ship?' }),
    resumeSchema: Type.Object({
      choice: Type.Union([Type.Literal('approve'), Type.Literal('reject'), Type.Literal('defer')]),
      note:   Type.Optional(Type.String()),
    }),
  },
}))
.edge('signoff', 'publish', { when: (o) => o.value.choice === 'approve' })
.edge('signoff', 'draft',   { when: (o) => o.value.choice === 'reject'  })
.edge('signoff', 'queue',   { when: (o) => o.value.choice === 'defer'   })
```

The DOT-era accelerator labels (`label="[A] Approve"`) become **UI affordances**, not routing keys. They're hints for the operator (or for a CLI prompt) about which canonical payloads to send; the schema is the source of truth, and predicates read structured fields. A rich `resumeSchema` can carry far more than a flat enum — radio + free-text + checkboxes — while routing still reads the structured payload.

This is a deliberate departure from today's two-tier model (substitution paths for prompts, condition paths for routing). In the typed model the path namespace is one: predicates and transforms both read the same `Outcome<O>` shape, and Wait is no different from LLM, Reduce, Task, Map, or any sub-graph.

## Map

```ts
type MapAttrs<I, Elem, O> = {
  extract:     (i: I) => readonly Elem[];
  body:        Node<Elem, ElementOf<O>>;          // sub-graph or single node
  concurrency: number;
  policy:      'wait_all' | 'first_success' | 'collect_settled';
};
```

Fan-out over an array. `body` runs per element (concurrently up to `concurrency`); outputs collect according to `policy`:

- **`wait_all`** — every element must succeed; output is `O2[]` in extract order.
- **`first_success`** — first successful element wins; others abort; output is `O2`.
- **`collect_settled`** — `Promise.allSettled` semantics; output is `Settled<O2>[]`.

`body` is `Node<Elem, …>`, which includes sub-graphs. `Map` composes naturally with the typed model.

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

## Cross-kind invariants

- **`Task`** bodies are externally observable (process-spawned); the IR carries only `command` + idempotency metadata. The author asserts idempotency by setting `idempotencyKey`; the runtime trusts that and caches by key for replay.
- **`LLM`** is the only kind whose output isn't fully deterministic. The event log captures every turn; replay uses the logged result, not a fresh call.
- **`Map`** and **`Reduce`** with builtin function reducers are fully replayable (logged element outcomes feed the reducer; builtin code is stable across runs).
- **`Wait`** suspends and resumes via the event log; the resume event is the output.

The replay property holds across all five kinds when the Environment is deterministic (injected `clock`, `rng`) and Task bodies honor their declared `idempotencyKey`.
