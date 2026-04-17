# P5.08 — Web: step drilldown (Vercel AI Elements)

## Goal
When the user clicks a node in the graph or a row in the timeline, open a
detail pane that reconstructs that node's full agent conversation using
Vercel AI Elements components: `<Conversation>`, `<Message>`, `<Response>`,
`<Reasoning>`, `<ToolCall>`, `<ToolResult>`. Each turn, thinking block, tool
call, and tool result is a first-class visual element.

## Depends on
- P5.07 (Timeline — need the click-to-select wiring)

## Scope

- Files to create:
  - `packages/web/src/components/NodeDrilldown.tsx` — the pane
  - `packages/web/src/lib/events-to-conversation.ts` — pure reducer that
    folds `agent.message_*`, `llm.text_delta`, `llm.thinking_delta`,
    `tool.execution_*` events into an AI-Elements-shaped conversation tree
  - `packages/web/test/events-to-conversation.test.ts` — fixture-based (load a
    real events.jsonl from `.swarm/runs/` and verify reconstruction)
  - `packages/web/test/NodeDrilldown.test.tsx`
- Files to modify:
  - `packages/web/src/App.tsx` — add state for `selectedNodeId`, mount pane
  - `packages/web/src/components/GraphView.tsx` — expose `onNodeClick(id)`
  - `packages/web/src/components/EventTimeline.tsx` — expose `onEventClick(e)`
- Dependencies:
  - Add Vercel AI Elements — most likely via `ai` package or `@vercel/ai-elements` (check current package name at implementation time)

## Tests

- `events-to-conversation.test.ts`:
  - Fixture events sequence → structured conversation with 2 turns, one with thinking, one with 2 tool calls
  - Streaming deltas (text_delta → text_delta → llm.done) collapse into a single `<Response>` with full text
  - Tool call IDs from `tool.execution_start` match up with `tool.execution_end` payloads
- `NodeDrilldown.test.tsx`: renders a multi-turn conversation, all elements present

## Verification

- `bun run ci` passes
- Smoke: run a workflow that uses tools, click the `implement` node, see every
  reasoning block, tool call, and tool result laid out correctly

## Out of scope

- Editing / replaying a turn
- Sending new messages mid-run (that's what `swarm steer` does — already shipped)
- Historical run search UI

## Reusable patterns

- Event ordering is already correct in the JSONL — just fold sequentially
- Use `run_id` + `node_id` + `session_id` to scope events to one node's turns
- See pi-mono's agent-loop for the canonical event sequence: `agent.message_start` → `llm.start` → [`llm.text_delta` | `llm.thinking_delta` | `llm.toolcall_delta`] → `llm.done` → `agent.message_end` → (tool calls) → next turn
