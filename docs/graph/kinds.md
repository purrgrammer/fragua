# Node kinds

Five kinds. Each is a discriminated case of `NodeKind`. Authoring picks the kind explicitly; the runtime dispatches on it.

There is no `Conditional`/`Router` kind — routing is an edge property (`when` predicate), not a node kind. Diamonds disappear from the model.

There is also no `Function` kind for user-authored JS bodies. The three places "function-shaped" code shows up — edge predicates / transforms, fan-in reducers, and small compute nodes — each have a better home:

- **Edge predicates / transforms** are expressed in the predicate / transform DSL (see [types.md](types.md)); their TS-builder form (`(o) => o.value.choice`) desugars to AST at compile time and never runs as JS at runtime.
- **Fan-in reducers** are either `Reduce { kind: 'llm' }` for synthesis or `Reduce { kind: 'function' }` pointing at a small *runtime-provided* builtin registry (`concat`, `majority_vote`, `json_merge`, `dedup_rank`). Not user-extensible at the IR level.
- **Domain compute nodes** ("extract areas from a snapshot", "pick a model from a heuristic") express as `Task` — scripts or commands with idempotency metadata. Process spawn overhead is ms-scale; almost nothing in this category is hot enough to need in-process execution.

User-authored JS reaches into runs through **the SDK's extension surface** (`@swarm/sdk`'s `defineTool` / `defineHook` — invoked from `LLM` nodes), not through a graph node kind. That's a separate, already-loaded surface; see [sdk.md](sdk.md).

## LLM

```ts
type LLMAttrs<I, O> = {
  provider:    string;
  model:       string;
  tools?:      ToolRef[];                       // resolved against Environment.tools
  thread?:     ThreadId;                        // optional continuity
  bounds?:     { maxCostUsd?, maxTokens?, maxMs? };
  reasoningEffort?: 'low' | 'medium' | 'high';

  buildPrompt: (input: I, ctx: NodeContext) => Promise<LLMRequest>;
  parseOutput: 'tool-call' | 'structured-response' | {
    fromAssistantText: (s: string) => O;        // fallback parser
  };
  outputRetries?: number;                       // default: 1 (see "Output failure" below)
};

type ToolRef = string;                          // bare name; e.g. 'web_fetch', 'read', 'bash'
```

A typed input is rendered into messages by `buildPrompt`. The LLM call produces typed `O` via one of three mechanisms:

1. **Terminal output tool** (default). Implicit `emit_output` tool whose schema is `O`. The LLM is required to call it to terminate; the tool result is the output. Observable in the event log, fallback-friendly, works on any provider with tool use.
2. **Structured response.** Provider-native (`response_format`, JSON mode). Faster path when the provider supports it natively.
3. **Fallback text parser.** Author-supplied parser. Used only when neither tool-call nor structured-response is available.

Tools are referenced by bare name (`'web_fetch'`, `'read'`, `'bash'`); `Environment.tools` resolves them at bind time. Tool versioning is an extension-management concern (the extension's own version pin in project config), not a workflow concern — if a deployment needs a specific tool version, it pins the extension, not the workflow.

### Output failure handling

The model may decline to call the output tool, or call it with arguments that fail the output schema. Default behavior: feed the validation error back as a user message ("Your previous output didn't match the schema: <error>. Please call `emit_output` again with valid arguments."), retry once. On the second failure, emit `Outcome.err` with the validation error in the body; downstream edges route on it. `outputRetries?: number` overrides the cap (default 1).

The `fallback` parser case is different — if the author supplied `parseOutput: { fromAssistantText: ... }`, parse errors there are `Outcome.err` immediately; no LLM retry.

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
  retriableExitCodes?: number[];                  // default: [] (every non-zero is non-retriable)

  // Cacheability + replay safety — REQUIRED
  idempotencyKey:  (input: I) => string;          // no default; author asserts explicitly
  cache?:          { ttlMs: number };
};
```

The single "user-authored compute" node kind. Covers today's `tool` nodes (`parallelogram` in DOT) and absorbs what was previously called a `Function` node. Authors who want a deterministic pure transform write a script (`./scripts/extract-areas`) and declare it idempotent; the runtime caches by `idempotencyKey` so replays don't re-execute side effects.

### `idempotencyKey` is required

The SDK provides two helpers for the common cases:

```ts
import { task, inputHashKey, alwaysFreshKey } from '@swarm/sdk';

task({ command: 'bun ./extract.ts', idempotencyKey: inputHashKey  })   // pure transform
task({ command: 'bun run ci',       idempotencyKey: i => i.gitSha })   // pin by sha
task({ command: 'curl ...',         idempotencyKey: alwaysFreshKey })  // never cache
```

`inputHashKey` is `i => sha256(canonicalJson(i))`; `alwaysFreshKey` is `() => crypto.randomUUID()`. The default-by-input-hash idiom is *available* via `inputHashKey` but never implicit — the author has to write the choice. Forces thinking about it; CI fetches and moving targets stop being silent footguns.

`retriableExitCodes` opts specific non-zero exit codes into the retarget-edge retry path. Default empty: every non-zero exit is `Outcome.err` and routes via edge predicates. Authors who want "exit 75 (EX_TEMPFAIL) → retry" set `retriableExitCodes: [75]` and add a retarget self-edge with `retryBudget`.

### Examples

- **Deterministic pure transform** (was: Function): `command="bun ./scripts/extract-areas.ts"`, input piped as JSON on stdin, output parsed as JSON from stdout. `idempotencyKey: inputHashKey`. Process spawn cost is ms-scale; this is fine for anything not on a hot inner loop.
- **Run CI**: `command="bun run ci"`, `idempotencyKey: i => i.gitSha`. Cached: same sha → cached result, no re-run.
- **Fetch a doc**: `command="curl …"`, `idempotencyKey: i => \`${i.url}|${i.etag}\``.
- **Apply a patch**: `command="bun ./scripts/apply-patch.ts"`, `idempotencyKey: i => sha256(i.patch)`.

The author asserts idempotency by setting the key. The runtime trusts it — a non-idempotent body declared idempotent is a bug, surfaced when replay diverges from the original run.

For non-idempotent ad-hoc shell calls, prefer the `bash` tool inside an `LLM` node rather than a Task — that's what it's for.

## Wait

```ts
type WaitAttrs<I, O> =
  | { source: 'human'; prompt: (i: I) => HumanPrompt; resumeSchema: StandardSchemaV1<O> }
  | { source: 'http';  callbackPath: string;          expect:       StandardSchemaV1<O> }
  | { source: 'timer'; durationMs: number;            onFire:       O };
```

A pause primitive. **Each `Wait` node has exactly one source** — `human`, `http`, or `timer` — and its typed output `O` is that source's payload. Today's HITL hexagon is the `human` source; HTTP callbacks and timer firings become first-class on the same primitive with their own variants.

The single-source choice is deliberate. Almost every real Wait is HITL-only; forcing a tagged union on every node penalizes the common case for a rare one. Multi-source ("wait for human OR timeout") is expressed by composition: `Map(extract: () => [humanWait, timerWait], body: subgraph, policy: 'first_success')`. Explicit and rare; the common HITL case stays clean.

The `Outcome` of a `Wait` node is `{ tag: 'ok'; value: O }` once resolved; before that, the node sits in `{ tag: 'paused' }` state and the runtime emits `fact.run_paused`. Resumption events flow in via `IO<E>` and the runtime validates them against the source's schema (`resumeSchema` for human, `expect` for http) before propagating. Validator rejects multi-source Wait at IR build time.

### Routing on `Wait` output

Wait isn't a special case for routing. Outgoing edges read the typed `O` via the same predicate DSL as any other node:

```ts
.node('signoff', wait({
  source:       'human',
  prompt:       () => ({ question: 'Approve to ship?' }),
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
  extract:     (i: I) => readonly Elem[];
  body:        Node<Elem, BodyOut>;               // sub-graph or single node
  concurrency: number;
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

## Cross-kind invariants

- **`Task`** bodies are externally observable (process-spawned); the IR carries only `command` + idempotency metadata. The author asserts idempotency by setting `idempotencyKey`; the runtime trusts that and caches by key for replay.
- **`LLM`** is the only kind whose output isn't fully deterministic. The event log captures every turn; replay uses the logged result, not a fresh call.
- **`Map`** and **`Reduce`** with builtin function reducers are fully replayable (logged element outcomes feed the reducer; builtin code is stable across runs).
- **`Wait`** suspends and resumes via the event log; the resume event is the output.

The replay property holds across all five kinds when the Environment is deterministic (injected `clock`, `rng`) and Task bodies honor their declared `idempotencyKey`.
