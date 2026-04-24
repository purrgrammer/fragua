# Handler contract

How to write a handler for a swarm node. Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) §5; this doc is the practical guide.

---

## What a handler is

A handler is a pure async function that takes an immutable `HandlerContext` and returns a `HandlerResult`:

```typescript
import type { handler } from "@swarm/core";

const spec: handler.HandlerSpec = {
  kind: "my-node-kind",
  sideEffect: "none",           // or "idempotent" | "external"
  maxMs: 30_000,                // hard timeout; the executor aborts on expiry
  handler: async (ctx) => {
    // do work with ctx.llm / ctx.http / ctx.tools / ctx.messages / ctx.artifacts
    return {
      kind: "transition",
      nextNode: "the-next-one",
      tokens: 0,
      costUsd: 0,
    };
  },
};
```

Register with a `Dispatcher`:

```typescript
dispatcher.register(workflowSha, nodeId, spec);
```

---

## The three return kinds

### `transition`
Handler finished; the executor commits a `fact.node_completed` + a `fact.node_started` (or `fact.run_completed` if `nextNode === "__end__"`), then moves on.

```typescript
return {
  kind: "transition",
  nextNode: "next",                     // next node id, or "__end__"
  outputRef?: ArtifactRef,              // optional; executor records it
  routingDelta?: { key: value },        // merged into run_state.routing
  tokens: 0,                            // count charged to this node
  costUsd: 0,                           // dollars charged
  modelName?: "gemini-1.5-pro",         // for per-model rollups
};
```

### `yield_hitl`
Handler needs a human to answer something. Run transitions to `paused_hitl`, the executor frees the process. When an operator writes `intent.hitl_input`, `wakePendingHitl` moves the run back to `queued`; the handler re-enters with `ctx.hitlInput` set.

```typescript
return {
  kind: "yield_hitl",
  prompt: "approve the plan?",
  routingDelta?: { ... },
};
```

### `halt`
Terminal failure. Emits `fact.run_halted`.

```typescript
return { kind: "halt", reason: "budget" | "max_loops" | "error", detail?: string };
```

---

## The four hard rules

### 1. Respect `ctx.signal`
It composes the steer controller + `AbortSignal.timeout(maxMs)` + shutdown. Everything I/O-adjacent must be cancellable:

```typescript
// ✅ good — ctx.llm already wires the signal
const res = await ctx.llm.call({ model: "...", messages: [...] });

// ✅ good — ctx.http wraps fetch with the signal
await ctx.http.fetch("https://example.test");

// ❌ bad — won't cancel
await fetch("https://example.test");
```

### 2. No direct I/O — use `ctx`
Handlers must not import `node:fs`, `node:child_process`, `node:net`, or `undici`; they must not call bare `fetch`. The handler-discipline lint (`packages/core/test/handler/discipline.test.ts`) will fail CI if any of those appear under `packages/core/src/handler/handlers/`.

Persistent state goes through:

- **`ctx.messages.append(role, content)`** — user-visible transcript (appended in order; tracked as `fact.message_appended`)
- **`ctx.artifacts.put(key, content, mime?)`** — content-addressed blob with a per-(run, node, iteration, key) ref
- **`ctx.http.fetch(...)`** — abort-wired HTTP
- **`ctx.llm.call(...)`** — LLM with accounting hook
- **`ctx.tools.get(name)`** — registered tool
- **`ctx.externalCall(...)`** — idempotency-keyed external call (see §3)

### 3. External side effects use `ctx.externalCall`
Anything that moves money or makes a network call the caller can't reverse must route through `ctx.externalCall`. Pass the call's arguments as `args: unknown` — the framework canonicalises them (sorted keys, deterministic output), sha256s that to an `argsHash`, and derives the idempotency key as `sha256(runId + nodeId + iteration + argsHash + attempt)`. `fact.side_effect_intent` / `_done` / `_failed` wrap the call. If the daemon crashes between intent and done, the startup sweep quarantines the run rather than blindly re-running.

```typescript
const result = await ctx.externalCall(
  { toolName: "charge", args: { customerId, amountCents } },
  async (idempotencyKey) => {
    // pass the key to your provider as an Idempotency-Key header or equivalent
    return provider.charge({ customerId, amountCents }, { idempotencyKey });
  },
);
```

`args` must be JSON-serialisable (plain objects, arrays, strings, finite numbers, booleans, `null`). Functions, `undefined`, `bigint`, `Symbol`, cyclic references, and non-finite numbers throw `CanonicalStringifyError`. Two objects with the same content but different key insertion order produce the same `argsHash` — the whole point of moving canonicalisation into the framework is that a handler that reconstructs args across a replay can't accidentally drift its hash.

Declare your handler's risk level on the spec:

- `sideEffect: "none"` — pure computation or read-only
- `sideEffect: "idempotent"` — safe to replay (e.g. GET, deterministic calc)
- `sideEffect: "external"` — must use `ctx.externalCall`

### 4. No state outside the projection
`ctx.routing` is the only cross-turn state. A handler that stashes data on `this`, a module-level `Map`, or a file will silently lose it on daemon restart. If you need durable state:

- Small (≤8KB total): `routingDelta` in the return → merged into `run_state.routing`
- Large: `ctx.artifacts.put(key, content)` → 16MB max, deduplicated by sha256

---

## Parallel fan-out / fan-in

Use `component` (parallel) + `tripleoctagon` (parallel.fan_in) to fork
a run into N branches that explore alternatives in parallel, rank the
outcomes, and continue down a single path (attractor §4.8 / §4.9).

Swarm's parallel is **deliberation-only** (regime C): each branch gets
an in-memory deep-cloned routing snapshot and shares the parent run's
single worktree. Branches must NOT mutate the filesystem; restrict
their `allowed_tools` to read-only sets and have the follow-up node
(after fan_in) perform any actual writes.

```dot
  explore [
    shape    = component
    fan_in   = pick_best     // required — points at the fan_in node
    join_policy = "wait_all" // or "first_success"
  ]
  approach_a [ prompt = "..." allowed_tools = "read, bash" ]
  approach_b [ prompt = "..." allowed_tools = "read, bash" ]
  pick_best [ shape = tripleoctagon ]   // heuristic ranking by (status, -score, id)

  explore -> approach_a
  explore -> approach_b
  approach_a -> pick_best
  approach_b -> pick_best
  pick_best -> next_step
```

Branch outcomes land in routing under
`parallel.<parallelNodeId>.results = [{branchId, status, score?}, …]`,
and the fan_in winner lands under `fan_in.<nodeId>.winner`. Downstream
nodes read these through normal `${context.*}` substitution.

Limits (v1): a branch that returns `yield_hitl` is coerced to `fail`
with a documented reason; nested HITL in a parallel fan-out is not
supported. A branch's `externalCall` intent/done facts attribute to
the parent parallel node's id for idempotency purposes.

## Agent tools (LLM-callable, inside a codergen turn)

The agent-callable tool surface is deliberately minimal:

| Tool   | Purpose                                                           |
|--------|-------------------------------------------------------------------|
| `read` | Read a UTF-8 file                                                 |
| `write`| Write / overwrite a file (creates parent dirs)                    |
| `edit` | Replace a unique substring in a file                              |
| `bash` | Run a shell command (ls, grep, git, curl, any other mutation)     |

Tool names are bare identifiers — no `local:` prefix, no namespace.
The `ToolRegistry` enforces `^[a-z][a-z0-9_]*$` on registration.

Anything an agent used to need a dedicated tool for
(`list_dir` / `glob` / `grep` / `git_read` / `apply_patch` /
`web_fetch` / `subagent` / `load_skill`) now goes through `bash` (or,
for skills, through `read` against the SKILL.md `<location>` in the
system-prompt catalog). This is the "less is more" directive: agents
spend tokens on thinking, not on picking between seven tools that all
do variants of the same thing.

Narrowing per-node is a hard filter, not a convention. A node's
`allowed_tools = "read, bash"` applies at two boundaries, both built
into the framework:

1. **`ctx.tools`** — the executor calls `ToolRegistry.select({ allow, deny })`
   before constructing the HandlerContext. A handler that reaches for
   `ctx.tools.get("write")` on a read-only node gets `unknown tool: write`,
   the same error it would get for an unregistered tool. The narrowed
   registry also rejects `register()` so a handler can't smuggle a tool
   back in.
2. **Agent tool surface** — the codergen backend calls `select(...)` on its
   workspace ToolRegistry before passing the resulting array to pi-ai, so
   the LLM literally does not see disallowed tools in its tool menu. If
   `allowed_tools` names zero registered tools, the backend fails the
   call loudly rather than handing the model an empty menu.

Parallel branches rely on this narrowing to stay read-only: a branch
node with `allowed_tools = "read"` cannot invoke `bash` / `write` /
`edit` at either boundary. Prompt prose that says "you have read-only
tools" is descriptive; the enforcement is the narrowing.

**`ctx.env` follows the same policy.** If the narrowed toolset carries
no mutator (`bash` / `write` / `edit`), `ctx.env` is wrapped so
`writeFile` and `exec` throw `ReadOnlyEnvError`. That way a handler
that loses its *tools* to the allowed_tools filter also loses the raw
env path that would otherwise bypass them — relevant when the codergen
backend's agent tools sit on top of `ctx.env` (write → `env.writeFile`,
bash → `env.exec`). Read-only methods (`readFile`, `exists`, `listDir`,
`glob`) pass through.

Custom tools can be added later by `ToolRegistry.register()`-ing an
additional `Tool` at daemon startup. They share the same bare-identifier
rule and slot in alongside the four builtins.

## Tool nodes (graph-level shell)

A `parallelogram`-shape node runs `node.attrs.tool_command` as a single
shell invocation (attractor §4.10) — no LLM, no agent loop. Use it for
deterministic steps: running tests, linters, git plumbing, small
scripts. Exit 0 → `outcome=success`; non-zero → `outcome=fail`.

```dot
  run_tests [
    shape        = parallelogram
    tool_command = "bun test $ARGUMENTS"
    goal_gate    = true
  ]
```

`tool_command` goes through the same substitution as codergen prompts:
`$ARGUMENTS`, `$RUN_ID`, `$WORKTREE_PATH`, `$nodeId.output`,
`${context.x}`. Stdout + stderr become artifacts keyed by
`${nodeId}:stdout` / `${nodeId}:stderr`, so downstream codergen nodes
can reference them via `$toolNodeId.output`.

A tool node is not an agent tool. Agent-callable tools (read / write /
edit / bash) are what an LLM invokes *inside* a codergen turn; the
graph-level `tool` node is a distinct primitive for fixed shell steps
with no LLM in the loop. See `workflows/ci-gate.dot` for a pure-tool
example and `workflows/review-parallel.dot` for a tool node alongside
parallel / fan_in / wait.human.

## Loops

Graph-level only, via backward conditional edges (attractor §3.6 / §5.2).
There is no `loop` primitive. To re-run a node on an outcome, add an edge
back to it (or to an upstream node) guarded by a condition, and set
`max_retries` on the target:

```dot
  implement [
    prompt = "..."
    max_retries = 2        // caps the retry counter
  ]
  implement -> review
  review    -> implement [condition="outcome=retry"]   // backward edge
```

`ctx.iteration` tracks the re-entry counter; the executor bumps it each
time the backward edge re-enters. Pure retry-policy semantics live in
`@swarm/core`'s `engine/retry-policy.ts` — `retryStep(state, status)`
returns `advance` / `retry` / `fail` / `halt`. The executor consults it
after every handler completion.

**Do not write for-loops inside a handler.** An in-handler loop blocks
the fiber, doesn't respect `ctx.signal` at the loop boundary, and can't
be paused.

---

## Replay semantics

The executor re-runs a handler whenever:

- The handler was aborted mid-flight (steer, timeout, shutdown)
- A transient failure left the run `queued`

Under replay, a handler must:

- Produce the same idempotency key for the same logical work (use `ctx.externalCall` with a stable `argsHash`)
- Be safe to invoke twice — if it wrote an artifact on the first run, it'll overwrite on the second (per `(run, node, iteration, key)`)
- Not assume `ctx.messages` is empty on entry — previous partial runs may have appended

If your handler can't be made replay-safe (rare), declare `sideEffect: "external"` and rely on `ctx.externalCall`'s quarantine behavior.

---

## Accounting

The LLM client binds an accounting hook. When you call `ctx.llm.call(...)`, tokens + cost + model flow into the node's running totals, which the executor commits onto `fact.node_completed`:

```typescript
const res = await ctx.llm.call({ model: "claude-opus-4-7", messages: [...] });
// res.tokens, res.costUsd, res.model are already in the fact payload.
return { kind: "transition", nextNode: "next", tokens: 0, costUsd: 0 };
// Executor fills tokens/costUsd/modelName from accounting if you leave them at 0.
```

Per-model rollups are available at `GET /metrics/global.breakdownByModel`.

---

## Timeouts

`maxMs` on the spec is a hard deadline. The executor composes `AbortSignal.timeout(maxMs)` into `ctx.signal`. If the handler ignores `signal` and runs past `maxMs + LEAK_GRACE_MS` (5s), the executor emits `fact.handler_timeout_leaked` and halts the run. Don't ignore `signal`.

---

## Example: minimal LLM handler

```typescript
import { handler } from "@swarm/core";

export function makeGreetingHandler(nextNode: string): handler.HandlerSpec {
  return {
    kind: "greeting",
    sideEffect: "none",
    maxMs: 30_000,
    handler: async (ctx) => {
      const name = typeof ctx.routing.name === "string" ? ctx.routing.name : "friend";
      const res = await ctx.llm.call({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: `Greet ${name} in one sentence.` }],
      });
      ctx.messages.append("assistant", res.content);
      return {
        kind: "transition",
        nextNode,
        tokens: 0,        // filled from accounting
        costUsd: 0,
      };
    },
  };
}
```

For a fully-featured LLM backend with skills, context files, and tool-calling, use `makeCodergenHandler` from `@swarm/agent` which wraps `PiCodergenBackend`.

---

## Checklist for PR review

Before merging a new handler:

- [ ] `sideEffect` declared correctly (none / idempotent / external)
- [ ] `maxMs` set — no defaults on purpose
- [ ] Uses `ctx.signal` anywhere it blocks on I/O
- [ ] No `node:fs` / `node:child_process` / bare `fetch` imports
- [ ] External tool calls route through `ctx.externalCall`
- [ ] Replay-safe: re-running produces ≤1 external effect per idempotency key
- [ ] Property test at minimum: "random prefix of the handler's work, then abort, then re-run → converges"
