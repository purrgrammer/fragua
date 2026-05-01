# Tool Hooks

Tool hooks are TypeScript modules that intercept tool calls within codergen
nodes. They run inline — inside the LLM turn, not as separate workflow
steps — so feedback reaches the model immediately and self-correction
happens without a node round-trip.

Authoritative references: `packages/agent/src/hooks/` (implementation),
`packages/agent/src/backend.ts` (wiring into `pi-agent-core`'s
`beforeToolCall` / `afterToolCall`), `.swarm/hooks/` (project examples).

---

## 1. What hooks are for

After every `write` or `edit` tool call, a hook can run `bun run typecheck`,
parse the output, and append diagnostics directly into the tool result
content that the LLM sees. The model reads "3 type errors in foo.ts" in
the same turn and fixes them before moving on — no separate verify node,
no retry edge, no extra LLM call.

Hooks are **not** workflow nodes. They don't appear in the DOT graph, don't
produce events in the run timeline (beyond a lightweight `hook.executed`
trace), and don't have their own LLM context. They augment the tools the
agent already uses.

---

## 2. Hook API

Each hook is a TypeScript file that exports a default factory function.
The factory receives a `HookAPI` — deliberately smaller than pi's
`ExtensionAPI`. Hooks are headless (no UI), can't register tools or
commands, and have exactly two events.

```typescript
// .swarm/hooks/typecheck-on-edit.ts
import type { HookAPI } from "@swarm/agent";

export default function (hook: HookAPI) {
  hook.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const file = event.input.path as string;
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return;

    const result = await ctx.exec("bun run typecheck 2>&1 | head -50", {
      timeoutMs: 15_000,
    });

    if (result.exitCode !== 0) {
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `\n\n--- [typecheck] ---\n${result.stdout}\n${result.stderr}`,
          },
        ],
      };
    }
  });
}
```

### 2.1 Events

| Event | pi equivalent | What it can do |
|---|---|---|
| `tool_call` | `beforeToolCall` / extension `tool_call` | Block execution (`{ block: true, reason }`), mutate `event.input` in place |
| `tool_result` | `afterToolCall` / extension `tool_result` | Override `{ content?, isError? }` — feedback injection point |

**`tool_call` event shape:**

```typescript
interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>; // mutable
}

interface ToolCallResult {
  block?: boolean;
  reason?: string;
}
```

**`tool_result` event shape:**

```typescript
interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

interface ToolResultResult {
  content?: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
```

Handlers chain in load order. Each handler sees the result after previous
handlers' changes. Omitted fields keep their current values.

### 2.2 Hook context

Every handler receives `ctx: HookContext`:

| Method / Property | Description |
|---|---|
| `ctx.exec(command, opts?)` | Run a shell command in the worktree. Same `ExecutionEnvironment` as tools. |
| `ctx.readFile(path)` | Read a file from the worktree. |
| `ctx.cwd` | Worktree root (absolute path). |
| `ctx.signal` | `AbortSignal` from the agent run. |
| `ctx.nodeId` | Which workflow node is executing. |
| `ctx.runId` | Which run this belongs to. |

`exec` options:

```typescript
interface ExecOptions {
  timeoutMs?: number;  // default 30_000
  cwd?: string;        // relative to worktree root
}
```

No `ctx.ui` — hooks are headless. No `registerTool` — hooks augment, they
don't extend.

### 2.3 HookAPI

```typescript
interface HookAPI {
  on(event: "tool_call", handler: HookHandler<ToolCallEvent, ToolCallResult>): void;
  on(event: "tool_result", handler: HookHandler<ToolResultEvent, ToolResultResult>): void;
}

type HookHandler<E, R> = (event: E, ctx: HookContext) => Promise<R | undefined> | R | undefined;
```

---

## 3. Discovery and loading

### 3.1 Locations

| Location | Scope | Loaded when |
|---|---|---|
| `.swarm/hooks/*.ts` | Project-local | Per-run (from the worktree) |
| `.swarm/hooks/*/index.ts` | Project-local (subdirectory with deps) | Per-run (from the worktree) |
| `~/.swarm/hooks/*.ts` | Global (all projects) | Daemon startup |
| `~/.swarm/hooks/*/index.ts` | Global (subdirectory) | Daemon startup |

Project-local hooks load from the worktree, so each run sees the hooks
that match its branch. Global hooks load once at daemon startup and apply
to every run.

On name collision, project scope wins over global scope.

### 3.2 Loading

Bun natively imports `.ts` — no jiti or compilation step needed. The hook
loader calls `import(path)` to get the default export (the factory
function), then calls the factory with a `HookAPI` to collect event
registrations.

### 3.3 Config

`.swarm/config.jsonc` gets a `hooks:` section:

```jsonc
"hooks": {
  // Explicit paths disable auto-discovery of .swarm/hooks/
  // "paths": ["hooks/custom-dir"],

  // Names to exclude from discovery
  disabled: ["expensive-lint"]
```

Mirrors the existing `skills:` config shape.

---

## 4. Integration

### 4.1 Backend wiring

In `PiCodergenBackend.run()`, when constructing the `Agent`:

```typescript
const agent = new Agent({
  // ... existing opts
  beforeToolCall: async ({ toolCall, args }, signal) => {
    return hookRunner.emitToolCall(
      { toolName: toolCall.name, toolCallId: toolCall.id, input: args },
      { signal, cwd: effectiveEnv.cwd(), nodeId: input.node.id, runId: input.run_id },
    );
  },
  afterToolCall: async ({ toolCall, args, result, isError }, signal) => {
    return hookRunner.emitToolResult(
      { toolName: toolCall.name, toolCallId: toolCall.id, input: args, content: result.content, isError },
      { signal, cwd: effectiveEnv.cwd(), nodeId: input.node.id, runId: input.run_id },
    );
  },
});
```

### 4.2 Event emission

Each hook execution emits a `hook.executed` event through the existing
`input.emit` callback:

```json
{
  "hook": "typecheck-on-edit",
  "event": "tool_result",
  "tool": "edit",
  "exit_code": 1,
  "duration_ms": 3200,
  "output_bytes": 1240,
  "modified_result": true
}
```

Visible in `events.jsonl` and the web dashboard step view.

### 4.3 Hook runner

`packages/agent/src/hooks/runner.ts` — the core orchestrator:

- Holds a list of loaded hooks (each with its registered handlers).
- `emitToolCall(event, ctx)` — runs `tool_call` handlers in order. First
  `{ block: true }` wins. Input mutations chain.
- `emitToolResult(event, ctx)` — runs `tool_result` handlers in order.
  Each handler sees the latest content after previous handler changes.
  Partial return patches merge field-by-field (same semantics as
  pi-agent-core's `AfterToolCallResult`).

### 4.4 Daemon wiring

`packages/cli/src/commands/daemon.ts`:

1. At startup: discover + load global hooks from `~/.swarm/hooks/`.
2. Per-run: discover + load project hooks from the worktree's
   `.swarm/hooks/`. Merge with global hooks (project wins on collision).
3. Pass the merged `HookRunner` into `PiCodergenBackendOptions` so the
   backend can wire `beforeToolCall` / `afterToolCall` on each `Agent`.

---

## 5. Package layout

```
packages/agent/src/hooks/
├── types.ts       # HookAPI, HookContext, event types, result types
├── runner.ts      # HookRunner — load, chain, emit
├── discover.ts    # Scan .swarm/hooks/ and ~/.swarm/hooks/
├── context.ts     # HookContext factory (wraps ExecutionEnvironment)
└── index.ts       # Public re-exports
```

---

## 6. Example hooks

Ship in `.swarm/hooks/` for the swarm repo itself:

### 6.1 typecheck-on-edit.ts

Runs `bun run typecheck` after every `write` or `edit` on `.ts`/`.tsx`
files. Appends compiler diagnostics to the tool result on failure.

```typescript
import type { HookAPI } from "@swarm/agent";

export default function (hook: HookAPI) {
  hook.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const file = event.input.path;
    if (typeof file !== "string") return;
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return;

    const result = await ctx.exec("bun run typecheck 2>&1 | head -50", {
      timeoutMs: 15_000,
    });

    if (result.exitCode !== 0) {
      const diagnostics = (result.stdout + "\n" + result.stderr).trim();
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `\n\n--- [typecheck] ---\n${diagnostics}` },
        ],
      };
    }
  });
}
```

### 6.2 lint-on-edit.ts

Runs `biome check` on the edited file. Lighter than a full typecheck —
catches formatting and lint violations.

```typescript
import type { HookAPI } from "@swarm/agent";

export default function (hook: HookAPI) {
  hook.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const file = event.input.path;
    if (typeof file !== "string") return;
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return;

    const result = await ctx.exec(`bun run biome check "${file}" 2>&1 | head -30`, {
      timeoutMs: 10_000,
    });

    if (result.exitCode !== 0) {
      const diagnostics = (result.stdout + "\n" + result.stderr).trim();
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `\n\n--- [lint] ---\n${diagnostics}` },
        ],
      };
    }
  });
}
```

### 6.3 test-on-edit.ts

Runs the test file co-located with the edited source file, if one exists.
More expensive — disable via config when iteration speed matters more than
correctness.

```typescript
import type { HookAPI } from "@swarm/agent";

export default function (hook: HookAPI) {
  hook.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const file = event.input.path;
    if (typeof file !== "string") return;
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return;

    // Derive test path: src/foo.ts → test/foo.test.ts
    const testFile = file
      .replace(/^src\//, "test/")
      .replace(/\.tsx?$/, ".test.ts");

    const exists = await ctx.exec(`test -f "${testFile}" && echo yes || echo no`, {
      timeoutMs: 2_000,
    });
    if (!exists.stdout.trim().startsWith("yes")) return;

    const result = await ctx.exec(`bun test "${testFile}" 2>&1 | tail -30`, {
      timeoutMs: 30_000,
    });

    if (result.exitCode !== 0) {
      const diagnostics = (result.stdout + "\n" + result.stderr).trim();
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `\n\n--- [test: ${testFile}] ---\n${diagnostics}` },
        ],
      };
    }
  });
}
```

---

## 7. Workflow adaptation

With hooks wired, workflow prompts simplify:

### Before (without hooks)

The `implement` node prompt says:
> After edits, `bun run typecheck` on every modified package; fix errors.
> Cap typecheck-fix cycles at 5 per package.

The workflow needs a separate `verify` node for CI, and reviewers still
catch type errors the agent missed.

### After (with hooks)

The `implement` node prompt says:
> Implement the plan. Fix any errors reported in tool results.

Typecheck output appears inline after every edit. The agent sees
`--- [typecheck] --- error TS2345: ...` and fixes it in the next tool
call. The `verify` node becomes a final CI gate (`bun run ci`) — not the
primary feedback loop.

Concrete changes to `.swarm/workflows/change.dot`:
- Simplify `implement` prompt: remove the explicit per-package typecheck
  loop — hooks emit diagnostics inline on every `edit`/`write`.
- `verify` (the `bun run ci` gate) stays as the final check.
- The goal-gate `review → implement` retarget cycle costs less, because
  most mechanical fixables are caught by hooks within the implement turn —
  reviewers see fewer scope-creep / contract-violation issues, which is
  exactly what they're best at.

---

## 8. What this does NOT include

- **No `tool_hooks.pre` / `tool_hooks.post` graph attrs.** The TypeScript
  hook system supersedes these dead declarations in `GraphAttrs`. Remove
  them or repurpose for per-workflow hook overrides later.
- **No UI.** Hooks are headless. Visibility is through `hook.executed`
  events in the web dashboard.
- **No hot-reload.** Hooks load once per daemon start (global) or per
  worktree init (project). Restart to pick up changes.
- **No `registerTool`.** Hooks augment existing tools. Custom tool
  registration is a separate feature.
- **No `tool_call` input mutation re-validation.** Same as pi — mutations
  skip schema validation. The hook author is responsible for producing
  valid input.
