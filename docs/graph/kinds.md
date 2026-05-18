# Node kinds

Seven IR `kind` discriminator values: **compute** kinds (`llm`, `task`), **suspend** kind (`wait`), **composition** kinds (`map`, `reduce`, `race`, `subgraph`). Authoring picks the compute / suspend kind explicitly; composition kinds compose other nodes.

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

### LLM terminal protocol

A precise spec for how an LLM call ends. The provider call loops until a terminal condition; the result determines the Node's `Outcome`.

**Mode: `parseOutput: 'tool-call'`**

The runtime advertises three implicit tools to the provider in addition to the node's `tools`:

- `emit_output` — args validated against `outputSchema`. Calling it signals "this is my final answer."
- `abort` — args = `{ reason: string }`. Calling it signals "halt this run; my caller can route on `Outcome.aborted`."
- `pause_provider` — internal; the runtime injects on transient HTTP errors.

The dispatch loop:

```
loop:
  response = provider.call(messages, tools)
  parse response.toolCalls:
    if abort in toolCalls:
      → Outcome.aborted { reason: abort.reason }
      // Other tools in the same assistant message are ignored.
    if emit_output in toolCalls:
      validate emit_output.args against outputSchema:
        if valid → Outcome.ok { value: emit_output.args }
        if invalid:
          if outputRetries remaining:
            append validation error as user message
            decrement outputRetries; continue loop
          else:
            → Outcome.err { error: { kind: 'output_validation_failed', detail } }
      // Other tools in the same assistant message execute in parallel;
      // their results are logged but don't affect Outcome (run is terminating).
    if neither emit_output nor abort, but other tools called:
      execute tools, append results to messages, continue loop
    if no tool calls (only assistant text):
      if outputRetries remaining:
        append "Please call emit_output to terminate" as user message
        decrement outputRetries; continue loop
      else:
        → Outcome.err { error: { kind: 'no_terminal_call', text } }
```

Precedence: **abort wins** over emit_output in the same message. Authors who want abort-OR-emit_output semantics can author it either way; abort takes precedence in case both fire.

**Mode: `parseOutput: 'structured-response'`**

Provider returns one JSON object directly (Anthropic JSON-mode, OpenAI `response_format`). No tools are advertised; the configured `tools` field is rejected at bind time when paired with this mode. The response is validated against `outputSchema`; success → `Outcome.ok`, failure → `Outcome.err { error: { kind: 'structured_response_invalid' } }`. No retry loop in this mode (provider-native structured output enforces shape natively).

**outputRetries**

Caps validation-failure retries in `tool-call` mode. Default 1. Set to 0 to disable retries; failure becomes immediate `Outcome.err`.

### Prompt expressivity ceiling

`prompt.user` and `prompt.system` are TemplateExpr strings — placeholders against `I`, no conditionals, no loops, no function calls outside the filter registry. The constraint is deliberate: it keeps the IR pure data. Authors who need conditional sections or loops factor the work into an upstream `Task` that produces typed prompt-data; the LLM node consumes the structured data via a simple template.

If you find yourself wanting `{{#if input.urgent}}...{{/if}}` in a template, that's the signal to author an upstream Task that builds the typed `{ heading, urgentSection?, ... }` shape, then template against that.

## Task

```ts
type TaskAttrs<I, O> =
  | {
      // PRIMARY: argv form. Safe by default — no shell, no injection surface.
      argv:       ArgvExpr;                       // [cmd, ...args]; each slot is a TemplateExpr or path-ref
      inputMode?: 'stdin-json' | 'env';           // default: stdin-json. (args not available — argv slots ARE the args)
      outputMode?: 'stdout-json' | 'stdout-text'; // default: stdout-json when I/O is typed
      cwd?:       string;                         // relative to worktree root; default = worktree
      env?:       Record<string, string>;         // explicit declaration only; never inherits host env
      bounds?:    { maxMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number };
    }
  | {
      // OPT-IN: shell form. Authors who need pipes, redirects, shell-builtins.
      shell:      { command: TemplateExpr };      // executed via /bin/sh -c
      inputMode?: 'stdin-json' | 'args' | 'env';
      outputMode?: 'stdout-json' | 'stdout-text';
      cwd?:       string;
      env?:       Record<string, string>;
      bounds?:    { maxMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number };
    };

type ArgvExpr = (TemplateExpr | { ref: PathExpr })[];   // each element is a single argv slot
```

The single "user-authored compute" node kind. Covers today's `tool` nodes (`parallelogram` in DOT) and absorbs what was previously called a `Function` node. Authors write a script (`./scripts/extract-areas`) and pipe typed I/O through it.

### Argv vs shell

**Default to `argv`.** Each slot is a separate process argument; the runtime executes via `execve` directly (no shell). Path-refs from typed input drop into argv slots verbatim — no quoting, no escaping, no injection surface even for inputs containing shell metacharacters.

```ts
.node('lint', task({
  argv: ['biome', 'check', { ref: 'input.path' }],   // path-ref drops in as one arg
}))

.node('rebase', task({
  argv: ['git', 'rebase', { ref: 'input.baseRef' }, '--onto', { ref: 'input.target' }],
}))
```

**Opt into `shell` for pipes / redirects / shell-builtins.** Authors who need `bun run ci`, `for f in ...`, or pipe operations use the shell form explicitly. The runtime wraps with `/bin/sh -c "${command}"`. Authors are responsible for quoting; the validator warns on shell forms that interpolate path-refs without explicit quoting filters.

```ts
.node('ci', task({
  shell: { command: 'bun run ci' },                  // no input interpolation, safe
}))
```

The validator flags shell-form commands that contain path-ref placeholders without an `| sh-quote` filter as a security warning. Not a hard error (escape hatches exist) but visible.

### Security model

- **`env`**: the IR's `env` is the *extension* over a runtime-provided safe baseline. The runtime always provides `PATH`, `HOME`, `LANG`, `TERM`, `LC_ALL`, `TMPDIR` with deterministic-by-environment values (worktree-derived `HOME`, configured `PATH` that resolves `bun`, `git`, `python`, etc.). Author's `env` extends or overrides those. **No host-env variables leak**: vars not in the baseline or the author's declaration are not inherited.
  - To force strict isolation (no baseline at all): `env: { __inheritDefaults: false, ... }`. Rare; authors who do this take responsibility for resolving binaries.
- **`cwd`**: defaults to the run's worktree root; relative paths resolve there. Absolute paths outside the worktree are rejected by the validator unless the workflow author explicitly opts in via `allowAbsoluteCwd: true` (rare).
- **Output caps**: `maxStdoutBytes` / `maxStderrBytes` cap streaming output to prevent runaway producers. Default: 10 MiB stdout, 1 MiB stderr. Exceeding caps truncates output, marks the Outcome with a `truncated: true` flag, and emits a warning fact.
- **Outcome.err size**: subject to [runtime blob spill](runtime.md#large-value-handling-transparent-blob-spill) on any field over the spill threshold (default 32 KB) — `error.stdout`, `error.stderr`, and structured error bodies all spill transparently. Authors don't manage blobs.
- **No filesystem isolation by default** — Tasks run in the worktree. Authors who need stronger isolation use a containerized command (`docker run ...`).

The single "user-authored compute" node kind. Covers today's `tool` nodes (`parallelogram` in DOT) and absorbs what was previously called a `Function` node. Authors write a script (`./scripts/extract-areas`) and pipe typed I/O through it.

### Examples

- **Deterministic pure transform**: `argv: ['bun', './scripts/extract-areas.ts']`, input piped as JSON on stdin, output parsed as JSON from stdout. Process spawn cost is ms-scale; fine for anything not on a hot inner loop.
- **Run CI**: `shell: { command: 'bun run ci' }`. Just runs; replay reads the logged Outcome from the event store.
- **Fetch a doc**: `argv: ['curl', '-fsSL', { ref: 'input.url' }]`. Path-ref drops as one arg; no quoting needed.
- **Apply a patch**: `argv: ['bun', './scripts/apply-patch.ts']`, input via stdin-json.

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

The single-source choice is deliberate. Almost every real Wait is HITL-only; forcing a tagged union on every node penalizes the common case for a rare one. Multi-source ("wait for human OR timeout") is expressed via the [`Race`](#race) kind — a structural combinator that takes heterogeneous branches and fires on first-to-succeed. Wait stays single-source; Race composes.

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

## Race

```ts
type RaceAttrs<I, O> = {
  branches: ReadonlyArray<Node<I, O>>;    // heterogeneous; same input I, same output O
  policy?:  'first_success' | 'first_settled';   // default: first_success
};
```

Structural combinator that runs multiple branches concurrently and produces the output of whichever one finishes first. Unlike `Map`, branches can be heterogeneous (an LLM, a Wait, a Task) — each is a separately-typed `Node<I, O>` with the same `I` and `O`.

The canonical use is "wait for human OR auto-fire on timeout":

```ts
const humanWithTimeout = race({
  branches: [
    wait({
      source:       'human',
      prompt:       { question: 'Approve to ship?' },
      resumeSchema: ChoiceSchema,
    }),
    wait({
      source:     'timer',
      durationMs: 24 * 60 * 60 * 1000,    // 24h
      onFire:     { choice: 'defer' },     // auto-fire payload
    }),
  ],
  policy: 'first_success',
});
```

Policies:

- **`first_success`** (default) — first branch to produce `Outcome.ok` wins; others are aborted.
- **`first_settled`** — first branch to produce *any* terminal Outcome (ok, err, aborted) wins; others are aborted. Useful when you want to know "something terminated, and what."

The SDK provides a `humanWithTimeout({...})` sugar helper for the common pattern.

Race runs each branch as a sub-Run (see [runtime.md](runtime.md)). Cancellation of losing branches propagates AbortSignals; in-flight LLM calls close their streams; subprocess Tasks get SIGTERM. The losing branches' partial work is logged for audit.

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

Sub-graphs run as **sub-Runs**: a child `run_state` row with `parent_run_id` linkage, per [`../proposals/parallel.md`](../proposals/parallel.md). This is the same sub-Run mechanism Map elements use. Sub-runs inherit the parent's budget pool by default (overridable per [runtime.md § Budget inheritance](runtime.md#budget-inheritance)); their events live in the child run's own event log (no duplication to parent), and the parent emits one `fact.subrun_completed` summary fact per child (see [runtime.md § Sub-Run event model and replay](runtime.md#sub-run-event-model-and-replay)).

Validation (reachability, predicate completeness, DAG property) applies **per sub-graph recursively**, not transitively. Each sub-graph is its own DAG; the parent's edges connecting sub-graph-nodes form a DAG at the parent level.

## Cross-kind invariants

- **`Task`** bodies are externally observable (process-spawned); the IR carries only `command` and I/O wiring. Replay reads the logged Outcome from the event store; no idempotency assertion needed from the author.
- **`LLM`** is the only kind whose output isn't fully deterministic. The event log captures every turn; replay uses the logged result, not a fresh call.
- **`Map`** and **`Reduce`** with builtin function reducers are fully replayable (logged element outcomes feed the reducer; builtin code is stable across runs).
- **`Wait`** suspends and resumes via the event log; the resume event is the output. Suspension is a `RunStatus` (`paused`), not an Outcome variant.
- **`Subgraph`** is pure structural composition; the replay property of the parent is the conjunction of the replay properties of the child sub-graphs.

The replay property holds across all seven kinds when the Environment is deterministic (injected `clock`, `rng`) — Task outputs are read from the event log on replay, so determinism doesn't depend on author-asserted properties of the Task body.

### No function-typed attrs in the IR

Every kind's attrs above use [declarative expression types](expressions.md) — `TemplateExpr`, `PathExpr`, `TransformExpr`, `PredicateExpr`, `BuiltinRef`. No kind carries a TS function in the IR. The SDK desugars author-friendly forms (template literal strings, single-expression arrows, imported builtins) at `.compile()` time. Authors who need richer logic factor the work into an upstream Task. This is the constraint that keeps the IR pure data and replays deterministic.
