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
  nextNode?: "next",                    // omit to route via the 5-rule edge selector (condition → preferredLabel → suggestedNextIds → weight → lexical); set to "__end__" to terminate
  outcomeStatus?: "success",            // matched against edge `condition="outcome=<s>"` clauses; defaults to "success"
  preferredLabel?: "go-on",             // matched against unconditional edges' `label` attr
  suggestedNextIds?: ["publish"],       // matched against unconditional edges' `to` after label matching fails
  outputRef?: ArtifactRef,              // optional; executor records it
  routingDelta?: { key: value },        // merged into run_state.routing
  tokens: 0,                            // total tokens charged to this node
  costUsd: 0,                           // total dollars charged
  inputCostUsd?: 0,                     // USD split (pi-ai usage.cost.input / .output); optional for back-compat
  outputCostUsd?: 0,
  inputTokens?: 0,                      // input/output/cache split; reducer defaults missing fields to 0
  outputTokens?: 0,
  cacheReadTokens?: 0,
  cacheWriteTokens?: 0,
  modelName?: "gemini-1.5-pro",         // for per-model rollups
};
```

### `yield_hitl`
Handler needs a human to choose one of a structured set of options. Run transitions to `paused_hitl`, the executor frees the process. The `fact.run_paused_hitl` event carries `label` + `options[]` so the web UI can render choice buttons immediately.

When an operator writes `intent.hitl_input { selected, note? }`, `wakePendingHitl` moves the run back to `queued`; the handler re-enters with `ctx.hitlInput` set to `{ selected: string; note?: string }`.

On resume the handler writes:
- `human.gate.selected` — accelerator key of the chosen option
- `human.gate.label` — display label
- `human.gate.note` — operator annotation (if provided)

and returns `suggestedNextIds: [chosen.to]` so edge selection routes to the matching target without conditions.

```typescript
return {
  kind: "yield_hitl",
  label: "Review the draft:",
  options: [
    { key: "A", label: "[A] Approve", to: "publish" },
    { key: "R", label: "[R] Revise",  to: "revise"  },
  ],
  routingDelta?: { key: value },        // optional; merged into run_state.routing before the pause
};
```

### `halt`
Terminal failure. Emits `fact.run_halted`.

```typescript
return {
  kind: "halt",
  reason: "budget" | "max_loops" | "error" | "goal_gate_unsatisfied" | "max_retries_exceeded",
  detail?: string,
};
// `abort_loop`, `schema_drift`, and `aborted_exit` are also valid `fact.run_halted` reasons,
// but the executor emits those itself (not via a handler return).
```

### `pause_provider`
Recoverable provider transport failure (HTTP 402/429/5xx, network reset). The executor commits `fact.run_paused_provider_error`, transitions the run to `paused_provider_error`, and frees the process. An operator `intent.resume` wakes the run and re-dispatches the same `(nodeId, iteration)` with the rehydrated transcript. Handlers never construct this themselves — the codergen agent boundary detects provider transport errors and returns this kind on the handler's behalf.

```typescript
return {
  kind: "pause_provider",
  httpStatus: number | null,            // null on pre-response network failures
  provider: "anthropic" | "openai" | ...,
  errorMessage: string,                  // raw provider string, displayed verbatim
};
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

- **`ctx.messages.append(message)`** — user-visible transcript; takes a pi-agent-core `AgentMessage` (round-trips losslessly, carries tool_use / tool_result / thinking blocks). Tracked as `fact.message_appended`
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

`args` must be JSON-serialisable (plain objects, arrays, strings, finite numbers, booleans, `null`). The canonical form is exact:

- **Object keys are sorted lexicographically** after Unicode normalisation. Two objects with the same content but different key insertion order produce the same `argsHash`.
- **All strings — keys and values — are normalised to Unicode NFC** before hashing. The same word typed once on macOS (NFD by default) and once on Linux (NFC by default) hashes identically. Callers don't have to think about it.
- **Numbers** use `JSON.stringify`'s canonical form: `1`, `1.0`, and `1e0` are all the same `number` at runtime, so all hash to `"1"`. Finite-only — `NaN` and `±Infinity` throw.
- **Rejected loudly** (no silent corruption): `undefined`, `bigint`, `Symbol`, function, cyclic references, `Date`, `Buffer`, any `TypedArray`, `ArrayBuffer`. Convert to plain JSON values before passing as `args`.
- **Duplicate keys after NFC normalisation** throw — an object with both `{"café": 1}` (NFC) and `{"café": 2}` (NFD) is ambiguous; the canonical form refuses to silently last-write-wins.

Tests pinning the corpus live at `packages/core/test/handler/canonical-stringify.test.ts`. The whole point of moving canonicalisation into the framework is that a handler that reconstructs args across a replay can't accidentally drift its hash.

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

### Quarantine inside a parallel branch

If any branch's `externalCall` orphans (handler crashed mid-`fn`,
sweep on next startup finds an `intent` with no matching `done`), the
**entire parent run** quarantines. There is no "quarantine just one
branch" model — quarantine is a run-level state machine transition
(`status='quarantined'`) and parallel branches don't have their own
status row. Concretely:

- All sibling branches in the same fan-out are abandoned. Their
  in-memory work is lost; any artifacts they wrote stay in the
  `artifacts` table (the run isn't deleted, just paused).
- The fan_in node never fires for that quarantine cycle.
- Operator triages via `intent.unquarantine`. The three resolutions
  behave as on a non-parallel run, but the unit of work is the
  whole parallel node, not the orphan branch:
  - `cancel` → `fact.run_cancelled`. Whole run dies.
  - `retry` → `fact.run_resumed`. Run goes back to queued. Executor
    re-dispatches the parent parallel node, which re-spawns ALL
    branches from scratch (including the ones that succeeded
    on the prior attempt). The orphan branch's external call uses
    the same `idempotencyKey`, so the provider dedups; siblings
    that succeeded before run again — they're idempotent by
    construction (no filesystem mutations) so this is acceptable
    but burns extra tokens.
  - `treat_as_done` → synthesised `fact.side_effect_done` for each
    orphan + `fact.run_resumed`. Same re-dispatch story as `retry`.

If branch-level isolation matters for your workflow (e.g. one
branch made a real-world side effect that's expensive to redo),
either:
- model branches as `sideEffect: "external"` with provider
  idempotency and trust the dedup;
- or split the parallel into a sequence of single-node steps so
  the failure granularity matches the recovery granularity.

Per-branch quarantine is intentionally out of scope for v1.

## Agent tools (LLM-callable, inside a codergen turn)

The agent-callable tool surface is deliberately minimal:

| Tool   | Purpose                                                           |
|--------|-------------------------------------------------------------------|
| `read` | Read a file. Text returns line-truncated content; image files (jpg/png/gif/webp) return as inline `ImageContent` blocks the model can see. macOS path quirks (NFD, AM/PM, curly quotes) resolve transparently. |
| `write`| Write / overwrite a file. Atomic temp+rename via the env, serialized per-path through a mutation queue so concurrent writes can't interleave. Creates parent dirs. |
| `edit` | Multi-edit exact-text replacement with fuzzy fallback (NFKC + smart-quote / dash / NBSP normalization). Per-edit `oldText` must be unique and non-overlapping; error messages reference `edits[i]` so the model can self-correct. `prepareArguments` recovers from JSON-stringified `edits` arrays and legacy `{oldText, newText}` flat shape. |
| `bash` | Run a shell command. Detached process group + tree kill on timeout/abort. Rolling buffer + temp-file spill keeps the full transcript recoverable when output exceeds the truncation window — the spill path appears in the truncation notice and in `data.full_output_path`. Optional `onUpdate` streams partial output during execution. Blocklist refuses dangerous commands before spawn. |

Tool names are bare identifiers — no `local:` prefix, no namespace.
The `ToolRegistry` enforces `^[a-z][a-z0-9_]*$` on registration.

Anything an agent used to need a dedicated tool for
(`list_dir` / `glob` / `grep` / `git_read` / `apply_patch` /
`web_fetch` / `subagent` / `load_skill`) now goes through `bash` (or,
for skills, through `read` against the SKILL.md `<location>` in the
system-prompt catalog). The four tools are deliberately powerful —
streaming output, image content, rich diffs, fuzzy edits, atomic
writes — so an agent never has to pick between seven tools that all
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
`$ARGUMENTS`, `$nodeId.output[.path]`, `${context.x}`. Stdout + stderr
become artifacts keyed by
`${nodeId}:stdout` / `${nodeId}:stderr`, so downstream codergen nodes
can reference them via `$toolNodeId.output`.

A tool node is not an agent tool. Agent-callable tools (read / write /
edit / bash) are what an LLM invokes *inside* a codergen turn; the
graph-level `tool` node is a distinct primitive for fixed shell steps
with no LLM in the loop. See `.swarm/workflows/ci-gate.dot` for a pure-tool
example and `.swarm/workflows/showcase.dot` for a tool node alongside
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
- The operator chose `intent.unquarantine: { resolution: "retry" }` after a hard-crash quarantine

Under replay, a handler must:

- Produce the same idempotency key for the same logical work (use `ctx.externalCall` with a stable `argsHash`)
- Be replay-safe with respect to artifacts. By default `ctx.artifacts.put(key, content)` is **collision-detecting**:
  - Identical content at the same `(run, node, iteration, key)` → no-op, returns the existing ref
  - Different content at the same scope → throws `ArtifactCollisionError`
  - Pass `{ replace: true }` to opt into overwrite when retries can legitimately produce different content (shell stdout containing timestamps, build outputs, etc.)
- Not assume `ctx.messages` is empty on entry — prior partial runs may have appended. If your handler produces deterministic message content for a given scope, the store layer offers opt-in dedup via `appendMessage(runId, row, { dedup: true })`. Default is OFF: agent transcripts carry per-call timestamps that legitimately differ between attempts even when the semantic message is the same, so dedup must be the caller's explicit assertion.

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
      ctx.messages.append({ role: "assistant", content: res.content });
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
