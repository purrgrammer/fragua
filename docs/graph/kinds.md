# Node kinds

Six kinds. Each is a discriminated case of `NodeKind`. Authoring picks the kind explicitly; the runtime dispatches on it.

There is no `Conditional`/`Router` kind — routing is an edge property (`when` predicate), not a node kind. Diamonds disappear from the model.

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

## Function

```ts
type FunctionAttrs<I, O> = {
  ref: FunctionRef;                              // named handle in FunctionRegistry
};
```

Pure, deterministic, side-effect-free. Sync or async. The function is registered in `Environment.functions` and looked up at bind time. The IR carries the ref, not the code — `workflow_sha` is stable across formatter changes.

Examples: extract a list of areas from a discover snapshot; compute a hash; pick a model based on a heuristic.

## Task

```ts
type TaskAttrs<I, O> = {
  ref:            FunctionRef;
  idempotencyKey: (input: I) => string;          // for caching / replay
  cache?:         { ttlMs: number };
};
```

Idempotent side-effect. Cacheable by `idempotencyKey`. Replay-safe: a Task with the same key returns the cached result without re-executing.

Examples: run CI (idempotency key = git sha); fetch a doc (key = URL + last-modified); apply a patch (key = patch hash).

The boundary between `Function` and `Task`: `Function` is pure; `Task` has effects but is *cacheable*. A non-idempotent side effect is a bug — express it as an `LLM` node with the `bash` tool if it must exist.

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

This is a deliberate departure from today's two-tier model (substitution paths for prompts, condition paths for routing). In the typed model the path namespace is one: predicates and transforms both read the same `Outcome<O>` shape, and Wait is no different from LLM, Reduce, Function, or any sub-graph.

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
  | { kind: 'function'; ref: FunctionRef }
  | { kind: 'llm';      llm: LLMAttrs<readonly Elem[], O> };
```

Fan-in: take an array, produce an aggregate. Two flavors:

- **Function reducer** — deterministic, hashable, replay-stable. Use for majority votes, sums, ranks, dedup, severity-merges.
- **LLM reducer** — calls a model on `Elem[]` to synthesize a structured `O`. Use for cross-finding synthesis, narrative merges.

Today's `tripleoctagon` is conceptually a Reduce, currently restricted to the function form (deterministic heuristic concatenator) regardless of whether `prompt=` is set. The typed `Reduce` makes the LLM-vs-function choice explicit instead of inferring from prompt presence.

## Cross-kind invariants

- **`Function` and `Task`** must be **pure-on-bind**: bodies can have side effects, but the IR ref is stable across runs; replaying the event log against the same Environment produces the same result.
- **`LLM`** is the only kind whose output isn't fully deterministic. The event log captures every turn; replay uses the logged result, not a fresh call.
- **`Map` and `Reduce`** with function bodies are fully replayable (logged element outcomes feed the reducer).
- **`Wait`** suspends and resumes via the event log; the resume event is the output.

The replay property holds across all six kinds when the Environment is deterministic (injected `clock`, `rng`).
