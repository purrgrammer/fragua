---
title: Agent tool — LLM-spawned sub-agents via inline codergen
summary: "LLM-spawnable sub-agents via the `agent` tool"
status: shipped
maturity: specified
last-reviewed: 2026-05-05
---

# Agent tool — LLM-spawned sub-agents via inline codergen

> Give a codergen node the ability to spawn an isolated sub-agent that
> runs in its own context window and returns only its final message.
> The sub-agent is a tool implementation — its work runs inline within
> the parent's tool call, all observability lands on the parent's
> event stream tagged with a `subagent_id`, and cost rolls into the
> parent's metrics naturally.

## Goals

- One LLM-callable tool, `agent`, registered alongside `read` /
  `write` / `edit` / `bash` / `web_fetch`. `defaultDisabled: true`,
  opt-in per node via `allowed_tools="…,agent"`.
- All knobs inline at the tool-call site. The LLM constructs the
  sub-agent's prompt, tool pool, and skill set per call. Named
  profiles loaded from `.agents/agents/` are V2 territory — see
  [`agent-definitions.md`](./agent-definitions.md).
- Sub-agents are **not runs**. They have no `run_state` row, no
  separate event stream, no independent lifecycle. They're a tool
  implementation that uses a separate LLM context window.
- All sub-agent observability (`llm.start`, `llm.toolcall_*`,
  `cost.recorded`, `agent.turn_*`) lands on the parent's stream
  tagged with `subagent_id` on the event payload. Cost flows into
  the parent's `metrics` through the existing accumulation path.
- Two new observability event types — `subagent.start` and
  `subagent.end` — bracket the slice on the parent's stream.
- No nesting: `agent` is structurally stripped from the sub-agent's
  tool pool, enforced by the registry filter.
- Inherits the parent codergen node's model, system prompt, and
  execution environment. No per-call model selection.
- Parallel-safe: a single parent assistant message can issue N
  `agent` toolcalls; pi-ai dispatches them concurrently, each
  sub-agent runs against its own thread under the parent's run, and
  cost / events demux by `subagent_id`.

## Non-goals (V2 territory)

- MCP servers, hooks, persistent memory, `permissionMode`,
  `background: true`, fork-mode (full-history inheritance), worktree
  isolation, named/file-defined agent profiles, sub-agents that
  outlive the parent's tool call, sub-agents as first-class runs
  (with their own queue / pause-resume / cancel surface).

## Tool surface

```ts
// packages/workspace/src/agent.ts
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
    data: { subagent_id, status, halt_reason?, total_tool_calls } }
```

`subagent_id` is a per-spawn UUID stamped on every event the
sub-agent emits onto the parent's stream. The LLM gets it back in
the tool result so it can quote it, and the UI / replay / search
layer uses it to fold the slice.

## Event taxonomy — toolcall lifecycle, no fact events

```
parent assistant message: [toolCall: agent, toolCall: agent]   (parallel spawns)
   ↓
seq N+0  llm.toolcall_start { tool_name: "agent", id: t1 }
seq N+1  llm.toolcall_start { tool_name: "agent", id: t2 }
seq N+2  subagent.start     { subagent_id: A, parent_node_id, iteration, model, label? }
seq N+3  subagent.start     { subagent_id: B, … }
seq N+4  llm.start          { subagent_id: A, model: ... }
seq N+5  llm.start          { subagent_id: B, … }
seq N+6  llm.toolcall_*     { subagent_id: A, … }       (sub-agent's own tool call)
seq N+7  cost.recorded      { subagent_id: A, cost_usd: 0.01 }
seq N+8  cost.recorded      { subagent_id: B, cost_usd: 0.02 }
seq N+9  subagent.end       { subagent_id: A, status: "completed", summary_chars, total_tool_calls }
seq N+10 subagent.end       { subagent_id: B, … }
seq N+11 llm.toolcall_end   { tool_name: "agent", id: t1, result: { subagent_id: A, status, … } }
seq N+12 llm.toolcall_end   { tool_name: "agent", id: t2, result: { subagent_id: B, … } }
seq N+13 cost.recorded      { cost_usd: 0.005 }                  (parent's own LLM call)
seq N+14 fact.node_completed { nodeId: "spawn", costUsd: 0.035, … }   (parent rollup)
```

No `fact.subagent.*` events — `fact.run_*` and `fact.node_*` carry
run-level / node-level semantics that fire long tails of reducer /
dispatcher / sweep / analytics logic on something that isn't a run
or a node. The `llm.toolcall_*` lifecycle is the contract for every
tool, including `agent`.

## Implementation

`packages/daemon/src/spawn-subagent.ts` is the per-call factory the
parent's codergen backend wires onto `swarmContext.spawnSubagent`.
On each call:

1. Generate a fresh `subagent_id` (UUID).
2. Materialise the child's system prompt (override or inherit) +
   filter parent skills by `spec.skills`.
3. Compute the child's tool pool (parent's pool, narrowed by
   `spec.allowed_tools` / `spec.disallowed_tools`, then strip
   `agent` so children can't recursively spawn).
4. Synthesise a node carrying the child's `system_prompt` /
   `allowed_tools` / `skills` / `provider` / `model` /
   `context_files: []` attrs. The nodeId is `__subagent:<id>`,
   used only as a thread namespace and message-table discriminator.
5. Emit `subagent.start` on the parent's stream.
6. Wrap `emit` to forward every event onto the parent's stream
   stamped with `subagent_id` on the payload.
7. Wrap `persistMessage` to write the sub-agent's transcript into
   the parent's `messages` table under the synthetic nodeId so it
   doesn't pollute the parent's main-thread `priorMessages` load.
8. Call `backend.run` synchronously — same backend instance the
   parent codergen used, with `run_id = parentRunId`,
   `thread_id = subagentNodeId`, parent's `env`, the wrapped emit
   and persistMessage, and `skipSystemPersist: true` so the backend
   doesn't double-write the system message.
9. Emit `subagent.end` on the parent's stream.
10. Return `{ summary, subagentId, status, haltReason?,
    totalToolCalls }` to the `agent` tool.

Cancellation: `spec.signal` (the tool's signal) and the daemon
shutdown signal both feed an in-process `AbortController` that drives
the `backend.run` call. No DB intent — there's no separate run to
cancel; the abort path is purely in-process.

## Cost rollup

Every `cost.recorded` event the sub-agent emits goes through the
parent's emit channel (with `subagent_id` stamped on the payload).
The parent's codergen handler-bridge accumulates every
`cost.recorded` into the parent node's totals — it doesn't filter
on `subagent_id`, so sub-agent cost lands in the parent's
`fact.node_completed` payload alongside the parent's own LLM cost.
The reducer folds the lot into `parent.run_state.metrics`.

Spawning N sub-agents in one parent message → N × per-spawn cost
all attributing to the same calling node. /analytics, the global
totals, the per-run `costUsd` field — all show the true bill.

## Schema

No schema additions. v5's `kind` / `parent_run_id` /
`parent_node_id` / `parent_iteration` columns and the
`idx_run_state_parent` index are all dropped in v7 (they were a
stepping stone toward the abandoned "child-run" design). v6's
`schedule_id` (a separate proposal) stays. `workflow_sha` returns to
`NOT NULL`.

## Same-PR doc obligations (per AGENTS.md §1)

| File touched | Same-PR doc update |
|---|---|
| `packages/store/src/schema.sql` (v7 cleanup) | `docs/ARCHITECTURE.md` §2 (schema) |
| `packages/types/src/swarm-events.ts` (no change to fact union; added two observability event types in `events.ts`) | `docs/ARCHITECTURE.md` §3 — explanatory note on sub-agent events |
| New tool registered + new observability events | `STATUS.md` "What swarm delivers today" |

## Design history (for context)

This proposal went through three iterations during the smoke-test
loop:

1. **First draft (early 2026-05-05)** — sub-agents as first-class
   conversation runs (`kind='conversation'`, separate event stream,
   `parent_run_id` linkage). Schema v5. Two dedicated facts
   (`fact.subagent.spawned` / `_completed`) on the parent's stream.
   Smoke test surfaced (a) the parent system prompt didn't fit in
   `routing` (8 KB cap), (b) the child didn't inherit the parent's
   model, (c) the child didn't inherit the parent's env, (d)
   missing emit wiring lost all child observability events.
2. **Second draft** — kept the conversation-run shape but moved the
   seed prompts into the messages table and wired model + env +
   emit. Surfaced that `fact.run_completed` for sub-agents
   triggers run-level state-machine logic that doesn't apply, and
   that the synthetic `fact.node_completed` for cost rollup makes
   the sub-agent look like a one-node workflow in step aggregates.
3. **Final (this draft)** — sub-agents are not runs. Inline
   codergen against the parent's stream with `subagent_id`
   discriminator. Cost rolls up naturally through the parent's
   existing accumulation. v7 migration drops the v5 scaffolding.

The smoke test (`~/.swarm/workflows/agent-smoke.dot`) drove the
iteration; each pass surfaced a real bug or conceptual gap in the
preceding design.
