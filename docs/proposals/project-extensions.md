---
title: Extensions — custom tools and hooks
status: proposed
maturity: designed
last-reviewed: 2026-05-04
---

# Extensions — custom tools and hooks

User-authored TypeScript that runs inside the daemon and registers
custom tools (LLM-callable) and hooks (lifecycle interception). One
factory per file. Discovered from `~/.swarm/extensions/` (user) and
`<cwd>/.swarm/extensions/` (project) — both fire concurrently. API
mirrors pi-coding-agent's extension surface verbatim where the seam
already exists in `@swarm/agent`.

This proposal supersedes the earlier sketch that split tools, hooks,
and skills across three directories with observation-only hooks.
Skills already shipped under their own discovery (see
`packages/workspace/src/skills/`) and stay out of scope here.

## Goals

- Authors write a single `.ts` file that may register tools, hooks, or
  both.
- Hooks have feedback (block, mutate args, replace results, replace
  system prompt) — observation-only is too thin to justify the build.
- API shape is verbatim pi-coding-agent for the events swarm exposes,
  so authors who know `@mariozechner/pi-coding-agent` extensions
  transfer skills 1:1.
- Loader, hot reload, trust, and disable mechanics mirror the skills
  pipeline (`packages/workspace/src/skills/discover.ts`) so we don't
  invent two competing UX models.
- Daemon and run-level observability via the existing `daemon_events`
  table and the per-run event log — no new schema.

## Non-goals (this proposal)

- Custom node-kinds. `kind` stays closed; tools cover the long tail.
- Custom commands / shortcuts / providers / message renderers / UI
  components. pi-codergen exposes those because it's a TUI; swarm's
  TUI surface is the web app, which is out of scope here.
- Sandboxing. Trust mirrors skills (project trusted by default). The
  credentials-in-DB threat model (`./credentials.md`) is the lever we
  pull when the blast radius gets concrete.
- Web UI page. Defer to a unified "plugins" page that pairs with
  `/skills` (also missing today).
- Replacing `handler-discipline-extensions.md` — that proposal owns
  AST-level lint at registration time and is complementary.

## Discovery and layout

Two scopes, both active concurrently for every run:

| Scope | Path | Precedence |
|---|---|---|
| Project | `<cwd>/.swarm/extensions/{*.ts,*/index.ts}` | wins on tool-name collision |
| User | `~/.swarm/extensions/{*.ts,*/index.ts}` | shadowed if project has same tool name |

Single-file extensions and directory-with-`index.ts` are both
accepted. `package.json` + `node_modules/` works for extensions that
need third-party deps (jiti resolves through the nearest
`node_modules`, same as pi).

Hooks from both scopes always fire — there's no shadowing for hooks,
only for tool names. Multi-scope authors who want different behavior
filter on `event.cwd` / `event.workflowSha` in the hook body.

## API package

New top-level `@swarm/extension` (types only):

```ts
export type {
  SwarmAPI,
  ExtensionContext,
  ToolDescriptor,
  ToolBeforeCallEvent,
  ToolAfterCallEvent,
  AgentBeforeStartEvent,
  HookOptions,
} from "@swarm/extension";
```

Public surface lives in this package; runtime loader and dispatch live
in `@swarm/workspace` (next to `skills/`). The split keeps user code
from pulling in our runtime guts.

## Factory shape

```ts
import type { SwarmAPI } from "@swarm/extension";
import { Type } from "typebox";

export default function (sw: SwarmAPI) {
  sw.registerTool({
    name: "fetch_weather",
    label: "Weather",
    description: "Look up current weather for a city.",
    parameters: Type.Object({ city: Type.String() }),
    sideEffect: "external",
    async handler(args, ctx) {
      const r = await ctx.http.fetch(`https://wx.example.com/${args.city}`);
      return { content: [{ type: "text", text: await r.text() }], details: {} };
    },
  });

  sw.on("tool.before_call", { timeoutMs: 2000 }, (event, ctx) => {
    if (event.toolName === "bash" && /\brm\s+-rf\b/.test(event.input.command)) {
      return { block: true, reason: "policy: rm -rf" };
    }
  });
}
```

### `registerTool` — verbatim pi-coding-agent shape

```ts
interface ToolDescriptor<A = unknown, R = unknown> {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema; // typebox
  sideEffect: "none" | "idempotent" | "external";
  promptSnippet?: string;
  promptGuidelines?: string[];
  handler: (args: A, ctx: ToolHandlerContext) => Promise<{ content: ContentBlock[]; details?: unknown }>;
}
```

Mirrors `pi.registerTool` 1:1. `sideEffect` is swarm-specific (drives
the `recordIntent` / `recordDone` external-call wrapping); pi has
no equivalent so we add it. `promptSnippet` / `promptGuidelines` ride
the existing system-prompt assembly path (see
`packages/agent/src/system-prompt.ts`).

Tool name collisions: project beats user, warn surfaces in
`extension.loaded` payload and on `swarm extensions list`.

### Hook subscription — `sw.on`

Single surface. All hooks awaited sequentially. Feedback via return
value.

```ts
sw.on(
  event: "tool.before_call" | "tool.after_call" | "agent.before_start",
  options: { timeoutMs?: number; onFailure?: "open" | "closed" },
  handler: (event, ctx) => Promise<Result | undefined>
): void;
```

Defaults: `timeoutMs: 2000`, `onFailure: "open"`.

## Event catalogue

Four events in the initial surface. Names use swarm's dotted-form
convention; payloads filter pi-coding-agent's superset.

### `tool.before_call`

Mirrors pi's `tool_call`. Fires after the LLM emits `tool_use` but
before `pi-ai` dispatches the tool.

```ts
interface ToolBeforeCallEvent {
  type: "tool.before_call";
  runId: string;
  nodeId: string;
  iteration: number;
  workflowSha: string;
  cwd: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>; // mutable in place — see composition
}

type ToolBeforeCallResult = { block?: boolean; reason?: string } | undefined;
```

Pi convention: **mutate `event.input` in place to patch arguments**
(later hooks see the mutation; no re-validation). Return
`{ block: true, reason }` to veto — produces a synthetic
`isError: true` tool result with the reason as content and skips the
tool entirely.

### `tool.after_call`

Mirrors pi's `tool_result`. Fires after tool execution, before the
result enters the conversation.

```ts
interface ToolAfterCallEvent {
  type: "tool.after_call";
  runId: string;
  nodeId: string;
  iteration: number;
  workflowSha: string;
  cwd: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: ContentBlock[];
  isError: boolean;
}

type ToolAfterCallResult = {
  content?: ContentBlock[];
  isError?: boolean;
} | undefined;
```

Returning a field replaces it in the result the LLM ultimately sees.
Later hooks see earlier hooks' replacements.

### `agent.before_start`

Mirrors pi's `before_agent_start`, **filtered**. Fires once per
codergen `backend.run()` immediately before `new Agent({...})` at
`packages/agent/src/backend.ts:346`.

```ts
interface AgentBeforeStartEvent {
  type: "agent.before_start";
  runId: string;
  nodeId: string;
  iteration: number;
  workflowSha: string;
  cwd: string;
  prompt: string;             // read-only: workflow-substituted user prompt
  systemPrompt: string;       // mutable via return
  model: { provider: string; id: string };  // read-only
  tools: readonly string[];   // read-only: post-narrow allowlist
}

type AgentBeforeStartResult = { systemPrompt?: string } | undefined;
```

Mutation surface intentionally narrower than pi's:

- `systemPrompt` — mutable. Natural seam (already has the
  `mergeSystemPrompt` helper at `packages/agent/src/system-prompt.ts:104`).
- `prompt` — **read-only**. Workflow-substituted; mutating
  post-substitution breaks the workflow contract.
- `tools` — **read-only**. Already filtered by
  `node.attrs.allowed_tools`; further override violates reproducibility.
- `model` — **read-only**. Comes from `node.attrs.llm_*` + config
  cascade; same reproducibility argument.
- `images`, `message`, `systemPromptOptions` (pi internals) —
  dropped.

### `agent.turn_end`

Mirrors pi's `turn_end`. Fires after each assistant turn settles —
the assistant message and any tool results for that turn are final.
Read-only in v0. Seam: the `agent.subscribe` callback in
`packages/agent/src/backend.ts:408`, immediately before the bridged
`agent.turn_end` run-event is recorded.

```ts
import type { AssistantMessage, ToolResultMessage } from "@swarm/extension";

interface AgentTurnEndEvent {
  type: "agent.turn_end";
  runId: string;
  nodeId: string;
  iteration: number;            // codergen iteration (run scope)
  workflowSha: string;
  cwd: string;
  turnIndex: number;            // turn index within this iteration (pi-supplied)
  message: AssistantMessage;    // read-only: content blocks + usage + cost
  toolResults: readonly ToolResultMessage[];
}

type AgentTurnEndResult = undefined;  // observation-only in v0
```

`AssistantMessage` and `ToolResultMessage` are re-exported from
`@swarm/extension` (sourced from `@mariozechner/pi-ai` — already a
runtime dep via `@swarm/agent`, no new dependency for extension
authors).

Use cases: per-turn analytics, content scanning / DLP, custom
side-effect emission keyed off LLM behaviour, summarisation triggers.
Mutability is **deferred** — rewriting the persisted message mid-run
would force a messages-projection rewrite and replay-determinism
work that no concrete use case has yet justified. Re-open if a
caller needs it.

Failure semantics: `onFailure` is irrelevant for read-only events —
"open" and "closed" are equivalent (the hook can't affect the
chain). Errors still surface as `extension.hook_error`.

## Composition rules

For all four events:

1. **Order**: hooks fire in `(scope, sourcePath, registrationOrder)`.
   Project scope first, then user scope. Within a scope, alphabetical
   by source path; within a file, registration order.
2. **Mutation chain**: each handler sees the previous handler's
   mutation. For `agent.before_start`, the rolling `systemPrompt` is
   passed forward. For `tool.before_call`, `event.input` is mutated in
   place. For `tool.after_call`, returned fields replace in the
   accumulator.
3. **Short-circuit**: first `block: true` on `tool.before_call`
   returns immediately; subsequent hooks for that event don't fire.
   Other events have no short-circuit.
4. **Failure** (timeout or throw):
   - `onFailure: "open"` (default) → emit `extension.hook_error`,
     drop this hook's contribution, continue chain.
   - `onFailure: "closed"` → emit `extension.hook_error`, treat the
     return value as `{ block: true, reason: "<extId> failed
     (closed)" }` for `tool.before_call`; for other events the
     chain stops with the last successful state.

## Hot reload

`node:fs` `watch` on the two extension roots, with a thin retry
wrapper for the inode-change footgun (mirrors pi's
`packages/coding-agent/src/utils/fs-watch.ts`). chokidar deliberately
not introduced.

- File changed → re-run loader → atomic swap of
  `(extensionId → registrations)`.
- In-flight runs see the version captured at `Dispatcher.get()`
  (snapshot-at-dispatch). New version applies on next dispatch.
- Reload of a file that no longer parses → keep previous version
  active, emit `extension.load_failed`, surface in `extensions list`.
- Debounce window: 250ms (matches pi's `watchFile` interval). Multiple
  saves within the window collapse to one reload.

## Trust model

V0: mirror skills.

```jsonc
{
  "extensions": {
    "trustProject": true,             // false hides project extensions
    "disabled": ["audit", "policy"]   // exclusion list (matches name)
  }
}
```

Project extensions trusted by default. `trustProject=false` keeps the
discovery scan but skips loading; the entry surfaces in
`extensions list` with `disabled_reason: "project scope hidden"`. The
`disabled` array hard-skips by name regardless of scope.

The structural risk — a hostile project extension reading other
projects' secrets via `bun:sqlite` — is acknowledged and deferred to
the credentials-in-DB proposal (`./credentials.md`). v0 ships with a
loud `extensions: <N> project extensions trusted` line in daemon
startup logs so the operator sees what's loaded.

## Observability

### Run-scoped (per-run event log)

| Event | Payload | Cap |
|---|---|---|
| `extension.hook_call` | `{ extensionId, eventName, durationMs }` | <100 B |
| `extension.hook_error` | `{ extensionId, eventName, error: { name, message } }` | error.message truncated to fit 4 KB |

Existing `tool.execution_*` events get a new optional field:
`source: "core" | "extension:<extensionId>"`. No new event type.

### Daemon-scoped (existing `daemon_events` table)

| Event | When | Payload | `run_id` |
|---|---|---|---|
| `extension.loaded` | boot or successful reload | `{ extensionId, scope, sourcePath, sha256, registeredTools, registeredHooks }` | NULL |
| `extension.load_failed` | parse / loader throws | `{ extensionId, sourcePath, error }` | NULL |
| `extension.unloaded` | file deleted, or name conflict shadowing | `{ extensionId, reason }` | NULL |
| `extension.reload_started` | watcher fires | `{ extensionId, sourcePath, trigger }` | NULL |

`registeredHooks` is `[{ eventName, timeoutMs, onFailure }]` —
metadata only, not function refs. `registeredTools` is `[{ name,
sideEffect }]`.

### 4 KB payload cap

`daemon_events.payload` has a `length(payload) < 4096` CHECK
constraint (`packages/store/src/schema.sql:184`). Hook event
observability stays metadata-only — `extension.hook_error` truncates
`error.message` to fit. Per-run `tool.execution_*` already exists and
already captures full args/results subject to the
`events.payload` cap; no additional payload pressure introduced.

## CLI / API surface (no UI in this proposal)

- `GET /extensions` — list of `{ name, scope, sourcePath, sha256,
  registeredTools, registeredHooks, loadedAt, disabled, lastError? }`.
- `GET /daemon/events?type=extension.*` — already present via
  `getDaemonEvents`; just exercises the existing reader.
- `swarm extensions list` — table-formatted CLI of the same.
- `swarm extensions reload <name>` — manual reload trigger
  (debugging convenience; the watcher is the primary path).

A future "plugins" web page renders this same shape alongside skills.
Tracked separately so the API surface lands without waiting on UI.

## Test plan

Unit:

- Loader scans both scopes, applies project-beats-user collision rule,
  warns on shadow.
- Tool descriptor schema validation rejects malformed `parameters`.
- Hook composition: `(project, user)` ordering, mutation chain on
  `tool.before_call` and `tool.after_call`, short-circuit on first
  `block`.
- Failure semantics: `onFailure: "open"` continues with prior state;
  `onFailure: "closed"` short-circuits via synthetic block.
- Timeout fires at `timeoutMs`, emits `extension.hook_error` with
  `error.name === "TimeoutError"`.
- Hot reload: file change re-registers; in-flight handler still sees
  the snapshot; failed reload preserves prior version.

Integration:

- End-to-end with a real codergen run: a project extension registers
  a tool, the LLM is steered to call it, the tool's response surfaces
  in `tool.execution_end`.
- `tool.before_call` mutation visible in the actual tool args.
- `agent.before_start` system-prompt mutation reflected in `llm.start`
  payload.
- `agent.turn_end` hook receives the same `AssistantMessage` content
  that the messages projection persists — assert structural equality
  on `message.content` and `message.usage`.
- `daemon_events` rows for `extension.loaded`, `extension.hook_error`.

Discipline:

- Lint test (or extension to `handler-discipline-extensions.md`)
  rejects extensions importing `bun:sqlite`, `node:child_process`
  without an explicit `requiresProcess: true` marker.

## Open questions

- **`requiresProcess` opt-in**: the discipline-extensions proposal
  proposes a marker. This proposal is silent on the descriptor
  field; resolve when that proposal lands.
- **AST-at-registration cost**: hot reload makes parsing per-edit
  rather than per-boot. Probably negligible (jiti already parses) but
  unmeasured. Benchmark before declaring it free.
- **`extension.hook_call` volume**: a busy run with 100 tool calls and
  5 hooks emits 1500 of these. The events table has its own
  retention; this might pressure it. If it does, batch-summarise to
  `extension.hook_summary { extensionId, runId, eventName, count,
  totalMs }` at run end and drop the per-call event.
- **`tool.before_call` mutation visibility**: pi mutates `event.input`
  in place. swarm runs hooks across two scopes; we need to confirm
  that mutation propagates correctly when the same event object is
  passed sequentially (probably fine — pi already does it — but worth
  a property test).
- **`agent.turn_end` mutability**: deferred. Re-open if a caller
  wants to redact / sanitise / rewrite the persisted message before
  it lands in `messages`. Cost: messages-projection rewrite path,
  replay-determinism on resumed runs, and a new `tool.after_call`-
  style chain semantics for `message`/`toolResults`. Read-only ships
  v0 and covers the majority of asks (analytics, scanning, custom
  emit).

## What this does not commit to

- Replacing the loader's load-time discipline lint (owned by
  `handler-discipline-extensions.md`).
- Sandboxing or capability-based permissions (deferred to
  `credentials.md` resolution).
- Cross-project read isolation (same).
- Replay determinism via `project_context_sha` — the schema field
  exists for this reason, but populating it is a follow-up once the
  loader's content-hash surface stabilises.
- A `/extensions` web page — design parallel to a future `/skills`
  page; ship the API surface here, ship the page in a separate UI
  proposal.

## Migration path

There is none. v0 ships the full surface (tools + four hook events:
three with feedback, one read-only). The earlier observation-only
v0/v1 split was scrapped during design — observation-only hooks
were judged too thin to be useful, except for `agent.turn_end` where
the natural contract is read-only and mutation is genuinely
expensive.
