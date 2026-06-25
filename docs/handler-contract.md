# Handler contract

How to write a handler for a fragua node. Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) §5; this doc is the practical guide.

---

## What a handler is

A handler is a pure async function that takes an immutable `HandlerContext` and returns a `HandlerResult`:

```typescript
import type { handler } from "@fragua/core";

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

## HandlerContext members

The context object the executor hands to every handler. The fields below are the ones not already covered by the I/O accessors (`ctx.llm`, `ctx.http`, `ctx.tools`, `ctx.messages`, `ctx.artifacts`, `ctx.externalCall`, `ctx.signal`, `ctx.routing`). Source: `packages/core/src/handler/types.ts` `interface HandlerContext`.

### `ctx.args: Readonly<SubstitutionArgs>`

Substitution args for prompt templating. Passed to `substitute()` before the prompt hits the LLM. `inputs` is the resolved `${{ inputs.<name> }}` map (declared `default:` values overlaid by run-provided `--input name=value`, stored on `routing.inputs`). Cross-node data transfer happens through shared `thread:` (SPEC §3.3), with optional per-node `summary:` for compression, not through prompt substitution.

### `ctx.emit(type, payload): void`

Emit an observability event — `agent.*`, `llm.*`, `tool.*`, `cost.recorded`, `summary.*`. The executor persists these to the store under their verbatim type so the UI's conversation + step views can project them. Non-blocking: writes are buffered and flushed alongside the node's terminal fact, and the buffer flushes even if the handler throws.

### `ctx.env?: ExecutionEnvironment`

Per-run shell + filesystem environment. Set by the executor when a `WorktreeProvisioner` is wired — `ctx.env` then points at the run's isolated `git worktree`. Required for every production dispatch: the `tool` graph-step handler (`packages/core/src/handler/handlers/tool.ts`) halts immediately when invoked with `ctx.env === undefined` and no explicit `cfg.spawner`. Silently falling back to `process.cwd()` was the worktree-isolation leak vector under a same-cwd daemon (`bun run fragua harness` from a project root would write tool-node edits straight into the main checkout). The only legitimate env-less path is test code that injects `cfg.spawner` to bypass cwd entirely. Handlers that spawn subprocesses or read files MUST prefer `ctx.env` over `process.cwd()` so concurrent runs don't step on each other. The agent-callable tools section below covers how `ctx.env` is wrapped in a read-only proxy when the node's narrowed toolset carries no mutator.

### `ctx.budgetSnapshot?: BudgetSnapshotInput`

Cumulative cost / tokens against configured ceilings, computed by the executor from `run_state.metrics` + the active graph + node attrs at dispatch time. Backends pass it through to surface "X of Y used" on `llm.start.budget`. Undefined when no ceiling is configured for this run.

```typescript
interface BudgetSnapshotInput {
  cumulative_cost_usd: number;
  cumulative_tokens: number;
  max_cost_usd?: number;
  run_max_cost_usd?: number;
}
```

---

## The four return kinds

### `transition`
Handler finished; the executor commits a `fact.node_completed` + a `fact.node_started` (or `fact.run_terminated{status:"completed"}` if `nextNode === "__end__"`), then moves on.

```typescript
return {
  kind: "transition",
  nextNode?: "next",                    // omit to let edge selection decide; set to "__end__" to terminate
  outcomeStatus?: "success",            // matched against edge `outcome=` attrs; defaults to "success". Unannotated edges default to outcome=success.
  route?: "feature",                    // set by the llm backend when the agent exited via the synthesised `route` tool; the engine's route-case edge selector keys on this and the daemon persists it onto `fact.node_completed.payload.route`
  failureReason?: "validation failed: schema mismatch", // single-line; surfaces as fact.run_terminated{status:"errored"}.detail on fail→__end__
  tokens: 0,                            // total tokens charged to this node
  costUsd: 0,                           // total dollars charged
  inputCostUsd?: 0,                     // USD split (pi-ai usage.cost.input / .output); optional for back-compat
  outputCostUsd?: 0,
  cacheReadCostUsd?: 0,                 // cache-read / cache-write cost split; optional for back-compat
  cacheWriteCostUsd?: 0,
  inputTokens?: 0,                      // input/output/cache split; reducer defaults missing fields to 0
  outputTokens?: 0,
  cacheReadTokens?: 0,
  cacheWriteTokens?: 0,
  modelName?: "gemini-1.5-pro",         // for per-model rollups
};
```

`failureReason` is the canonical channel for a handler that wants to fail with a quotable cause. Set it on `outcomeStatus="fail"` returns; ignored on every other outcome. When a fail outcome has no fail-edge to claim it, the executor routes to `__end__` and halts (`aborted_exit`); the string surfaces verbatim as `fact.run_terminated{status:"errored"}.detail` — which is what operators read in the failure-mode playbook (the `operate` skill's `references/forensics.md`). (A fail that follows an explicit author-declared edge to the `exit` sink is a graceful landing instead — `fact.run_terminated{status:"completed"}`, no halt, so `failureReason` is not consulted there.) A fail without a quotable reason (e.g. retry-policy exhaustion, programmatic gate) leaves it unset and the executor synthesises a generic detail string. This replaces an earlier convention of smuggling the reason through routing keys (commit `dd4850f`); new handlers should not reintroduce that pattern. Source: `packages/core/src/handler/types.ts` (the `kind: "transition"` arm).

`outcomeStatus="retry"` has distinct executor semantics: no edge is selected and no `fact.node_completed` is committed. Instead the executor consults the retry-policy (`packages/core/src/engine/retry-policy.ts`) and emits `fact.run_paused{reason:"handler_retry"}` → `paused_auto`. The wake-pending sweeper re-queues the run at `resumeAt`; the same `(nodeId, iteration)` re-dispatches with the prior transcript intact. The per-node retry counter is bounded by the node's `max_retries` attr; exhaustion emits `fact.run_paused{reason:"max_retries"}` → `paused` (operator-resumable via `intent.max_retries_adjusted { nodeId, newLimit }`). Source: `packages/daemon/src/transition-planner.ts`.

### `yield_human`
Handler needs an operator to choose one of a closed set of routes. Run transitions to `paused_human`, the executor frees the process. The `fact.run_paused_human` event carries `text` (operator-facing prompt) + `routes: string[]` (declared route names) so the web UI can render one button per route immediately. A human node declares `routes=` on the source node and `route=` on every outgoing edge; edge `label=` is pure UX (button text), never a routing input.

When an operator writes `intent.human_input { route, note? }` the wake-pending sweep moves the run back to `queued`; the handler re-enters with `ctx.humanInput` set to `{ route: string; note?: string }`.

On resume the handler emits **no routing writes** — the operator's chosen route and optional `note` from `intent.human_input` are preserved verbatim in the resume event's payload for audit. The handler returns `route: <chosen>` so the engine's route-case edge selector fires the edge whose `attrs.route` equals the operator's choice.

```typescript
return {
  kind: "yield_human",
  text: "Review the draft. Choose how to proceed.",
  routes: ["approve", "revise", "reject"],
};
```

`HumanInput` (the resume payload at `ctx.humanInput`):

```typescript
interface HumanInput {
  route: string;        // must be one of the declared routes
  note?: string;        // free-form audit text, ignored by routing
}
```

Server-side enum validation: `POST /runs/:id/human` reads the latest `fact.run_paused_human` payload's `routes` and rejects off-list routes with 400 before any intent is written. The handler re-validates as defense-in-depth (a hand-crafted intent could bypass the server check) and halts with `reason: "error"` + a descriptive `detail` if an unknown route reaches it.

### `halt`
Terminal failure. Emits `fact.run_terminated{status:"errored"}`.

```typescript
return {
  kind: "halt",
  reason: "budget" | "max_loops" | "error" | "goal_gate_unsatisfied" | "max_retries_exceeded"
        | "route_not_picked" | "route_call_not_isolated" | "edge_no_match",
  detail?: string,
};
// Additional `fact.run_terminated{status:"errored"}` reasons emitted directly by the executor (not constructible by handlers):
// `"aborted_exit"`, `"occ_exhausted"`, `"timeout_exhausted"`, `"worktree_error"` (provision failure).
// `"abort_loop"` and `"provider_exhausted"` are executor-only and convert to
// `fact.run_paused` (not halts). `"max_loops"`, `"goal_gate_unsatisfied"`, and
// `"max_retries_exceeded"` are handler-constructible but are likewise translated
// by result-to-facts into `fact.run_paused{reason:"max_loops"|"goal_gate"|"max_retries"}`
// respectively — they never produce a terminal `fact.run_terminated{status:"errored"}`. A version mismatch is likewise a
// recoverable `fact.run_paused{reason:"engine_incompatible"}`, not a halt.
```

When the executor emits `reason: "occ_exhausted"` (optimistic-concurrency retry budget hit on a single `(nodeId, iteration)`), the `fact.run_terminated{status:"errored"}.payload` carries an additional `occContext?: { count, nodeId, iteration, lastVersion, attemptedFactType }` so operators can post-mortem without grepping the freeform `detail`. The shape is authoritative in `packages/types/src/events.ts` (`fact.run_terminated` payload) and mirrored in `docs/ARCHITECTURE.md` §3; this doc does not redefine it.

### `pause_provider`
Recoverable provider transport failure (HTTP 402/408/429/5xx, network reset). The executor commits `fact.run_paused` with a reason-discriminated payload: `payment_required` (402; manual top-up) → `paused`; `provider_error` (manual class — 400/401/403/404/413/422) → `paused`; `provider_retry` (transient transport class — 408/429/5xx/529/network; carries `attempt`, `resumeAt`) → `paused_auto`. The process is free in every case. An operator `intent.resume` wakes the run — or the wake-pending sweeper does it automatically when status is `paused_auto` and `now >= resumeAt` — and re-dispatches the same `(nodeId, iteration)` with the rehydrated transcript. Handlers never construct this themselves — the llm agent boundary detects provider transport errors and returns this kind on the handler's behalf.

```typescript
return {
  kind: "pause_provider",
  httpStatus: number | null,            // null on pre-response network failures
  provider: "anthropic" | "openai" | ...,
  errorMessage: string,                  // raw provider string, displayed verbatim
  retryAfterMs?: number,                 // provider-supplied Retry-After (ms); honoured exactly when set
};
```

`retryAfterMs` carries the provider's `Retry-After` header (or its in-body equivalent) normalised to milliseconds. When set, the daemon's auto-retry policy honours it exactly — no jitter, no exponential cap. Absent → the daemon falls back to its own full-jitter exponential schedule. Source: `packages/core/src/handler/types.ts` (the `kind: "pause_provider"` arm).

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

- **`ctx.messages.append(message)`** — user-visible transcript; takes a pi-agent-core `AgentMessage` (round-trips losslessly, carries tool_use / tool_result / thinking blocks). Tracked as `fact.message_appended`. Rows are scoped `(node, iteration, pass)` — `pass` is the goal-gate re-entry epoch, stamped at context build — so a threadless node's resume hydration never pulls a prior gate pass's transcript (unthreaded nodes rehydrate only when *resumed*; a fresh pass starts clean)
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
`ctx.routing` is the only cross-turn state surface, fed by the intent fold (budget overrides, max_retries adjustments, priority). A handler that stashes data on `this`, a module-level `Map`, or a file will silently lose it on daemon restart. If you need to surface data that another turn must read, write it to:

- **Messages** (`ctx.messages.append`) when downstream nodes share a thread — the next turn loads the raw prior conversation by default, or a summariser-compressed view when the receiving node sets `summary=low|medium|high`.
- **Artifacts** (`ctx.artifacts.put(key, content)`) for blob-shaped output — 16MB max, deduplicated by sha256, addressable by `(run, node, iteration, key)`.

---

## Agent tools (LLM-callable, inside an llm turn)

The agent-callable tool surface is deliberately minimal:

| Tool   | Purpose                                                           |
|--------|-------------------------------------------------------------------|
| `read` | Read a file. Text returns line-truncated content; image files (jpg/png/gif/webp) return as inline `ImageContent` blocks the model can see. macOS path quirks (NFD, AM/PM, curly quotes) resolve transparently. |
| `write`| Write / overwrite a file. Atomic temp+rename via the env, serialized per-path through a mutation queue so concurrent writes can't interleave. Creates parent dirs. |
| `edit` | Multi-edit exact-text replacement with fuzzy fallback (NFKC + smart-quote / dash / NBSP normalization). Per-edit `oldText` must be unique and non-overlapping; error messages reference `edits[i]` so the model can self-correct. `prepareArguments` recovers from JSON-stringified `edits` arrays and legacy `{oldText, newText}` flat shape. |
| `bash` | Run a shell command. Detached process group + tree kill on timeout/abort. Rolling buffer + temp-file spill keeps the full transcript recoverable when output exceeds the truncation window — the spill path appears in the truncation notice and in `data.full_output_path`. Optional `onUpdate` streams partial output during execution. Blocklist refuses dangerous commands before spawn. |
| `grep` | Native regex search across files via `env.glob` — no shell spawn, no `rg` dependency. Skips default-ignored directories (`node_modules/`, `.git/`, `dist/`, `build/`, `.fragua/`, `.next/`, `coverage/`, `*.pyc`, `*.min.js`), binary files (null byte in first 1KB), and files larger than 1MB. 100-match limit by default; lines longer than 500 chars are truncated. Schema: `{ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? }`. |
| `find` | Native glob enumeration via `env.glob` — no shell spawn, no `fd` dependency. Default ignores honoured. 1000-result limit by default. Schema: `{ pattern, path?, limit? }`. |
| `ls`   | Non-recursive directory listing via `env.listDir`. Sorted alphabetical case-insensitive; directories carry a `/` suffix; dotfiles included. 500-entry limit by default. Schema: `{ path?, limit? }`. |

Tool names are bare identifiers — no `local:` prefix, no namespace.
The `ToolRegistry` enforces `^[a-z][a-z0-9_]*$` on registration.

Less common operations (`git_read` / `apply_patch` / `web_fetch`) still go through `bash`; for skills, an agent reads the SKILL.md `<location>` directly via `read` against the system-prompt catalog. The tools are deliberately powerful — streaming output,
image content, rich diffs, fuzzy edits, atomic writes, native walks —
so an agent never has to pick between a dozen tools that all do
variants of the same thing.

`grep` / `find` / `ls` work *without* `bash` in the allowed_tools set
(they don't shell out), so a survey/inventory node can declare
`allowed_tools = "read, grep, find, ls"` and stay strictly read-only —
the env-scoping in `packages/core/src/handler/context.ts` then wraps
`ctx.env` so even direct `env.exec` / `env.writeFile` calls throw
`ReadOnlyEnvError`.

Narrowing per-node is a hard filter, not a convention. A node's
`allowed_tools = "read, bash"` applies at two boundaries, both built
into the framework:

1. **`ctx.tools`** — the executor calls `ToolRegistry.select({ allow, deny })`
   before constructing the HandlerContext. A handler that reaches for
   `ctx.tools.get("write")` on a read-only node gets `unknown tool: write`,
   the same error it would get for an unregistered tool. The narrowed
   registry also rejects `register()` so a handler can't smuggle a tool
   back in.
2. **Agent tool surface** — the llm backend calls `select(...)` on its
   workspace ToolRegistry before passing the resulting array to pi-ai, so
   the LLM literally does not see disallowed tools in its tool menu. If
   `allowed_tools` names zero registered tools, the backend fails the
   call loudly rather than handing the model an empty menu.

Read-only nodes rely on this narrowing: a node with `allowed_tools = "read"`
cannot invoke `bash` / `write` / `edit` at either boundary. Prompt
prose that says "you have read-only tools" is descriptive; the
enforcement is the narrowing.

**`ctx.env` follows the same policy.** If the narrowed toolset carries
no mutator (`bash` / `write` / `edit`), `ctx.env` is wrapped so
`writeFile` and `exec` throw `ReadOnlyEnvError`. That way a handler
that loses its *tools* to the allowed_tools filter also loses the raw
env path that would otherwise bypass them — relevant when the llm
backend's agent-callable tools sit on top of `ctx.env` (write → `env.writeFile`,
bash → `env.exec`). Read-only methods (`readFile`, `exists`, `listDir`,
`glob`) pass through.

Custom tools can be added later by `ToolRegistry.register()`-ing an
additional `Tool` at daemon startup. They share the same bare-identifier
rule and slot in alongside the builtins.

## Tool nodes (graph-level shell)

A `type: tool` node runs its `run:` command as a single
shell invocation — no LLM, no agent loop. Use it for
deterministic steps: running tests, linters, git plumbing, small
scripts. Exit 0 → `outcome=success`; non-zero → `outcome=fail`.

```yaml
  run_tests:
    type: tool
    run: bun test ${{ inputs.filter }}
    retry: implement   # re-run `implement` until tests pass (goal gate)
```

`run:` (stored as `tool_command`) substitutes `${{ inputs.<name> }}` (POSIX-quoted)
and runs the shell command. Stdout + stderr become artifacts keyed by
`${nodeId}:stdout` / `${nodeId}:stderr` for debugging / replay; tool
nodes do not feed data forward to downstream nodes. A workflow that
needs to run a deterministic script and reason about its output should
call the script from inside an llm step's `bash` tool instead of
synthesising a tool-node-then-llm chain.

A tool node is not an agent tool. Agent-callable tools (read / write /
edit / bash) are what an LLM invokes *inside* an llm turn; the
graph-level `tool` node is a distinct primitive for side-effect-only
shell steps (CI gates, idempotent commands) with no LLM in the loop.
See the `format` / `ci` steps in `.fragua/workflows/work.yaml` for
`tool` nodes in a mixed pipeline.

## LLM self-abort (`abort` tool)

An llm agent signals "I cannot proceed" by calling the built-in
`abort` tool with a one-sentence `reason`. The llm handler's
`findAbortToolCall` (`packages/agent/src/backend.ts`) scans the
transcript for the call and translates it into `outcome.status="fail"`
with the reason as `failure_reason` and `non_retryable: true`;
workflows route via `on: {fail: …}` edges.

The `abort` tool is **force-included** on every llm node — even
when the node pins `allowed_tools` or lists `abort` under
`denied_tools`. The `skill` tool is force-included on the same terms,
but only when the node's effective skill catalogue is non-empty: a node
with `skills_disabled: true`, an empty `skills:` intersection, or no
skills in scope at all gets neither the catalogue block nor the `skill`
tool (it could resolve no name). The tool's own
description teaches the contract; workflow node prompts do not restate
it. They declare *when* to abort, in their own task-specific terms
(e.g. "abort with reason `typecheck blocked: <top error>` after 5 fix
cycles").

The tool sets `terminate: true`, so the agent loop stops after the
tool batch rather than running another turn. `findAbortToolCall` walks
the whole transcript — not just the last message — so an abort still
wins when it was emitted alongside other tool calls in a
non-terminating batch. The reason is whitespace-collapsed and clamped
to 400 chars before it reaches `failure_reason`; an empty reason falls
back to a default string.

Stray `<promise>X_READY</promise>` markers in earlier prompt versions
were prose convention only — never engine signals. They have been
removed from `.fragua/workflows/*.yaml` and should not be reintroduced.

## Loops

Graph-level only, via backward edges.
There is no `loop` primitive. To re-run a node on failure, route back to
it (or to an upstream node) via `on: {fail: …}`, and set `max-retries`
on the target:

```yaml
steps:
  implement:
    prompt: "..."
    max-retries: 2          # caps the retry counter
  review:
    on: {success: exit, fail: implement}   # backward edge on fail
```

`ctx.iteration` tracks the re-entry counter; the executor bumps it each
time the backward edge re-enters. Pure retry-policy semantics live in
`@fragua/core`'s `engine/retry-policy.ts` — `retryStep(state, status)`
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

`maxMs` on the spec is a hard deadline. The executor composes `AbortSignal.timeout(maxMs)` into `ctx.signal`. If the handler ignores `signal` and runs past `maxMs + LEAK_GRACE_MS` (30s), the executor emits `fact.handler_timeout_leaked` and halts the run. Don't ignore `signal`.

`HandlerSpec.maxMs` is typed `number | undefined`. LLM-kind handlers may omit it (or set it to `undefined`) to disable wall-clock bounding entirely — cost/token attrs (`max_cost_usd`, `max_tokens`) remain the operative ceiling for the model loop. Authors opt in per-node via `max-ms: 0` (or `timeout="0"`); the auto-dispatcher resolves either to `HandlerSpec.maxMs: undefined`. When `maxMs` is undefined the executor skips `AbortSignal.timeout` AND the leak watchdog, but steer / cancel / shutdown aborts still propagate through `ctx.signal`. 

---

## Example: minimal LLM handler

```typescript
import { handler } from "@fragua/core";

export function makeGreetingHandler(nextNode: string): handler.HandlerSpec {
  return {
    kind: "greeting",
    sideEffect: "none",
    maxMs: 30_000,
    handler: async (ctx) => {
      const name = typeof ctx.routing.name === "string" ? ctx.routing.name : "friend";
      const sentAt = Date.now();
      const res = await ctx.llm.call({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: `Greet ${name} in one sentence.`, timestamp: sentAt }],
      });
      // ctx.messages.append takes a pi-agent-core AgentMessage (assistant content
      // is a block array, not a plain string). For handlers that need message
      // persistence, use makeLlmHandler from @fragua/agent — it handles appending
      // correctly. This low-level ctx.llm.call path is for single bare LLM calls
      // where the agent surface is not needed.
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

For a fully-featured LLM backend with skills, context files, and tool-calling, use `makeLlmHandler` from `@fragua/agent` which wraps `PiLlmBackend`.

---

## Checklist for PR review

Before merging a new handler:

- [ ] `sideEffect` declared correctly (none / idempotent / external)
- [ ] `maxMs` set, or intentionally omitted for llm-style handlers that self-bound via cost/tokens
- [ ] Uses `ctx.signal` anywhere it blocks on I/O
- [ ] No `node:fs` / `node:child_process` / bare `fetch` imports
- [ ] External tool calls route through `ctx.externalCall`
- [ ] Replay-safe: re-running produces ≤1 external effect per idempotency key
- [ ] Property test at minimum: "random prefix of the handler's work, then abort, then re-run → converges"
