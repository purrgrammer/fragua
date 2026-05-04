---
title: Agent tool — LLM-spawned sub-agents via conversation runs
status: accepted
maturity: specified
last-reviewed: 2026-05-05
---

# Agent tool — LLM-spawned sub-agents via conversation runs

> Give a codergen node the ability to spawn an isolated sub-agent that
> runs in its own context window, drives a sub-conversation, and
> returns only its final message. Mirrors Claude Code's `Agent` tool
> shape; lands inside swarm as one new LLM-callable tool plus a new
> first-class run kind (`conversation`) that sits alongside today's
> `workflow` runs.

## Goals

- One LLM-callable tool, `agent`, registered alongside `read` /
  `write` / `edit` / `bash` / `web_fetch`. `defaultDisabled: true`,
  opt-in per node via `allowed_tools="…,agent"`.
- All knobs inline at the tool-call site. No definition files. No
  named/registered sub-agent profiles. The LLM constructs the
  sub-agent's prompt, tool pool, and skill set per call.
- Sub-agent runs in its own `run_id` with full event stream — child
  run lifecycle visible in the UI alongside the parent. Replay /
  post-mortem use existing infrastructure.
- No nesting: `agent` is structurally stripped from the child's tool
  pool, enforced by the registry filter.
- Inherits the parent codergen node's model. No per-call model
  selection (V1).

## Non-goals (V2 territory)

- MCP servers, hooks, persistent memory, `permissionMode`,
  `background: true`, fork-mode (full-history inheritance), worktree
  isolation, named/file-defined agent profiles. Each layers on later
  as additional optional params or a new discovery channel.

## Tool surface

```ts
// packages/workspace/src/agent.ts (new)
agent({
  description?: string,           // optional 1-line label for UI / events
  prompt: string,                 // the only context the sub-agent sees
  system_prompt?: string,         // override; otherwise inherit parent's
  allowed_tools?: string[],       // default = parent's pool minus `agent`
  disallowed_tools?: string[],    // applied after allowlist
  skills?: string[],              // names; resolved against parent's catalog
  max_iterations?: number,        // default = parent's remaining budget
})
→ { text: <final assistant message>,
    data: { child_run_id, status, halt_reason?, total_tool_calls } }
```

`description` is optional but recommended (surfaces in `fact.subagent.spawned`).
`prompt` is the **only** context — the sub-agent sees nothing of the
parent transcript unless the LLM pastes it in. `system_prompt`
omitted ⇒ child inherits the parent codergen node's effective system
prompt verbatim. `skills` injects skill bodies into the child's
system prompt at startup; sub-agents do **not** inherit the parent's
loaded skills.

## Data model — conversation runs as a kind

`run_state` gains a `kind` discriminator and parent-link columns.
`workflow_sha` becomes nullable (conversation runs have no DOT
document). Schema bump v4 → v5.

```sql
ALTER TABLE run_state
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'workflow'
    CHECK (kind IN ('workflow','conversation'));
-- workflow_sha becomes nullable (rebuild required; migrate sets all
-- existing rows to kind='workflow', workflow_sha unchanged).
ALTER TABLE run_state ADD COLUMN parent_run_id    TEXT REFERENCES run_state(run_id) ON DELETE SET NULL;
ALTER TABLE run_state ADD COLUMN parent_node_id   TEXT;
ALTER TABLE run_state ADD COLUMN parent_iteration INTEGER;
CREATE INDEX idx_run_state_parent
  ON run_state(parent_run_id) WHERE parent_run_id IS NOT NULL;
```

Workflow runs continue to carry `workflow_sha NOT NULL` — enforced at
the writer paths (`enqueueRun`), not by a CHECK (SQLite can't express
conditional NOT NULL without a constraint trigger). Conversation runs
carry `workflow_sha = NULL`.

The migration goes through a table rebuild (SQLite has no `ALTER
TABLE … DROP NOT NULL`). Existing rows: `kind = 'workflow'`, parent
columns NULL. Indexes recreate identically plus the new partial
parent index.

## Event taxonomy — observability-only on the parent

Two new fact types ride the parent's stream:

| Type | Payload | Semantics |
|---|---|---|
| `fact.subagent.spawned` | `parent_node_id`, `iteration`, `child_run_id`, `label?` | Parent codergen iteration spawned a sub-agent |
| `fact.subagent.completed` | `child_run_id`, `status`, `summary_chars`, `total_tool_calls` | Sub-agent reached terminal; tool result returned |

Both are **observability-only** — written to the parent's event
stream for SSE / UI / replay, but **not** folded into the parent's
`run_state` projection. Skipped by the reducer via the existing
observability discriminator. Child status lives on the child's own
`run_state` row; parent gets to it via `parent_run_id` join.

## Executor — extract `runCodergenLoop`, add `runConversation`

Extract today's per-node codergen invocation into a reusable
`runCodergenLoop(runCtx): Promise<{ status, lastAssistantMessage,
toolCallCount }>` primitive. The workflow path keeps calling it from
the codergen handler. New `runConversation(runId)` entry point in
the executor: load the conversation's seeded system prompt + initial
user message, drive `runCodergenLoop`, write terminal status. No
graph walk.

No behaviour change for workflow runs.

## `spawnSubagent` — the wiring

`SwarmToolContext` (in `packages/workspace/src/types.ts`) gains:

```ts
spawnSubagent(spec: SubagentSpec): Promise<SubagentResult>;
skillCatalog: SkillCatalog;     // parent's resolved catalog
```

`spawnSubagent` lives wherever per-call `SwarmToolContext` is
constructed (daemon executor, alongside the existing context plumbing).
Implementation:

1. Resolve `spec.skills` (names) → skill bodies via
   `ctx.skillCatalog`. (Catalog is plumbed by the framework, never
   from the tool-call args.)
2. Materialise the child's system prompt via
   `packages/agent/src/system-prompt.ts:materialiseForChild(spec,
   parentSystemPrompt, catalog)`. Override or inherit per spec.
3. Compute the child's tool pool: parent's effective pool, then
   `select({ allow: spec.allowedTools, deny: spec.disallowedTools
   })`, then filter out `agent` (no nesting).
4. Insert `run_state` row directly: `kind = 'conversation'`,
   `workflow_sha = NULL`, `parent_*` set, `status = 'queued'`,
   `cwd` inherited.
5. Write `fact.subagent.spawned` to the parent's stream.
6. Call `runConversation(childRunId)` synchronously in the parent's
   fiber. Await terminal.
7. Read the last assistant message from `messages` for the summary;
   read terminal status from the child's `run_state`.
8. Write `fact.subagent.completed` to the parent's stream.
9. Return `{ summary, childRunId, status, haltReason?,
   totalToolCalls }`.

On `opts.signal` abort (parent cancellation): write
`intent.cancel` against the child run, await its terminal state,
then surface the abort to the parent's tool result.

## Tool-adapter guard

`packages/agent/src/tool-adapter.ts` (or wherever
`ToolRegistry.select` is composed for child runs): structurally strip
`agent` from the child's pool. One-line guard. Belt-and-braces with
the spawnSubagent step 3.

## Supervisor — orphan-child sweep

`packages/daemon/src/supervisor.ts` boot sweep: any conversation run
with `parent_run_id` whose parent is in a terminal state
(completed / failed / cancelled / halted / quarantined) and whose own
status is non-terminal ⇒ issue `intent.cancel` against the child.
Same shape as existing zombie cleanup.

## Same-PR doc obligations (per AGENTS.md §1)

| File touched | Same-PR doc update |
|---|---|
| `packages/store/src/schema.sql` | `docs/ARCHITECTURE.md` §2 (schema): add `kind` column, nullable `workflow_sha`, parent columns, parent index |
| `packages/types/src/swarm-events.ts` (new fact types) | `docs/ARCHITECTURE.md` §3 (event taxonomy): rows for `fact.subagent.spawned` + `fact.subagent.completed`, both flagged observability-only |
| New tool registered | `README.md` "What swarm delivers today": one-line note on sub-agents (LLM can spawn isolated child runs from a codergen node, returns only summary, full child transcript replayable) |

## Tests

| Suite | Asserts |
|---|---|
| `packages/store/test/migrations.test.ts` | v4 → v5 walks; existing rows get `kind='workflow'`; parent index used for `WHERE parent_run_id = ?` |
| `packages/store/test/queries.test.ts` | `RunStateRow` + `RunState` carry the new fields; `findChildRuns(parent_run_id)` returns children; conversation row inserts with NULL `workflow_sha`; existing list-runs queries unaffected |
| `packages/workspace/test/agent.test.ts` (new) | TypeBox schema validates known shapes; `defaultDisabled` keeps `agent` out of the default `select()` result; `is_error` returned when `swarmContext` missing; mocked `spawnSubagent` round-trip returns `{ text, data: { child_run_id, … } }` |
| `packages/workspace/test/tool-registry.test.ts` | `select({ allow: ['agent'] })` includes `agent` (defaultDisabled bypass for explicit allow); `agent` is structurally absent when filtered for child pool |
| `packages/daemon/test/conversation.test.ts` (new) | `runConversation(runId)` drives a codergen loop to terminal, writes terminal `run_state`; no graph walk attempted |
| `packages/daemon/test/subagent.test.ts` (new) | E2E: parent codergen calls `agent` → child conversation runs a tool → returns summary; `parent_run_id` / `parent_node_id` / `parent_iteration` on child row; `agent` absent from child's pool; cancellation propagates parent → child |
| `packages/daemon/test/supervisor.test.ts` | Boot sweep cancels orphan children whose parent is terminal |

## Cross-package dependency order

1. `packages/store` (schema + migration + types + queries) — no other
   package depends on the new shape until later slices land.
2. `packages/types` (`swarm-events.ts` adds two fact types) —
   independent of store; can land in parallel.
3. `packages/daemon` (extract `runCodergenLoop`, add
   `runConversation`) — depends on store types being current.
4. `packages/workspace` (`agent` tool, `SwarmToolContext`
   extensions) — depends on store types only for `RunKind` /
   conversation-run awareness, not on the executor.
5. `packages/agent` (`materialiseForChild`, registry guard) —
   depends on workspace types.
6. `packages/daemon` (`spawnSubagent` wiring + supervisor sweep) —
   depends on all of the above.

Slices may consolidate; the order is the typecheck order.

## What this deliberately doesn't do

- No "fork mode" where the child inherits the parent transcript. The
  LLM constructs `prompt` to include whatever context it wants.
- No MCP / hooks / memory / `permissionMode` knobs. None of these are
  structurally blocked by the V1 shape.
- No background concurrency. The graph already supports
  `parallel`/`fan_in`; the inline foreground sub-agent is enough for
  V1.
- No worktree isolation per child. Children inherit the parent run's
  worktree.
- No agent-definition files. The tool *is* the spec.
