# P5.08 — Web: full pipeline conversation (AI Elements)

## Goal
Render the entire pipeline run as a single scrollable **conversation**, using
Vercel AI Elements end-to-end: one `Message` per agent turn, `Reasoning` for
thinking blocks, `Tool` for tool calls + results, and `Checkpoint` between
nodes as visual section markers (no restore-state behavior yet). Streaming
is first-class — text deltas, thinking deltas, and tool-call deltas roll
into their respective components live.

This **supersedes** the earlier "per-node drilldown pane" framing. The new
default is the continuous, top-to-bottom view of the whole pipeline; a
per-node "focus" toggle is a nice-to-have and can ship as a flag.

## Depends on
- P5.05 (web scaffold — shipped)
- P5.06 (pipelines list + detail — shipped)
- P5.12 (AI Elements adoption — the library, paths alias, shadcn/ui, and
  Tailwind 4 setup are in place before this task runs)

## Scope

- Files to create:
  - `packages/web/src/components/PipelineConversation.tsx` — renders the
    full conversation from a `PipelineDetail` + its event stream.
    Internally uses the AI Elements components listed below; keeps a
    per-node collapse state. Default: all nodes expanded; long runs (>200
    agent.turn_start events) collapse all by default with a "Expand all"
    button.
  - `packages/web/src/lib/events-to-conversation.ts` — **pure reducer**
    folding the event stream into a conversation tree:
    ```ts
    type PipelineConversation = NodeSection[];
    interface NodeSection {
      nodeId: string;
      status: "pending"|"running"|"completed"|"failed"|"skipped"|"retrying";
      turns: Turn[];            // one per agent.turn_start
    }
    interface Turn {
      turnId: string;
      sessionId?: string;
      messages: Message[];      // usually 1 assistant msg; 2+ when tool results feed a follow-up
    }
    interface Message {
      role: "assistant" | "user" | "system";
      parts: Part[];            // text / reasoning / tool_call / tool_result
      costUsd?: number;         // from the nearest cost.recorded
      inputTokens?: number;
      outputTokens?: number;
      modelId?: string;         // from llm.start
    }
    type Part =
      | { type: "text"; text: string; streaming?: boolean }
      | { type: "reasoning"; text: string; streaming?: boolean }
      | { type: "tool_call"; toolCallId: string; toolName: string; input: unknown; state: "input-streaming"|"input-available"|"output-available"|"output-error"; output?: unknown; errorText?: string };
    ```
    Rules:
    - `agent.message_start` opens a new Message; `agent.message_end` closes it.
    - `llm.text_delta` appends to the *last* `text` part of the current Message (creating one on first delta). `llm.done` flips `streaming=false` on the last streaming text part.
    - `llm.thinking_delta` does the same for `reasoning` parts. Multiple reasoning parts within a single Message are **consolidated** into one (matches AI Elements' `Reasoning` docs — it expects one block per message).
    - `llm.toolcall_delta` streams into a `tool_call` part keyed by `toolCallId`.
    - `tool.execution_start` sets the `tool_call` part state to `"input-available"`. `tool.execution_end` sets it to `"output-available"` (or `"output-error"` if `is_error`), and attaches `output` / `errorText`.
    - `cost.recorded` attaches cost/tokens to the *most recent* assistant Message in the current turn.
    - Events missing a `node_id` (pipeline-lifecycle) are dropped from the conversation but inform section status.
  - `packages/web/test/lib/events-to-conversation.test.ts` — feed real
    `.swarm/runs/*/events.jsonl` fixtures; assert a deterministic
    conversation tree; cover streaming partials, multi-turn sessions,
    tool-call lifecycle, loop (trapezium) iterations.
  - `packages/web/test/components/PipelineConversation.test.tsx` — render
    fixture conversation, assert `data-testid="node-section-<id>"` blocks,
    `Checkpoint` between sections, `Reasoning` collapses, `Tool` expands to
    show input/output, streaming pill renders when a part is live.

- Files to modify:
  - `packages/web/src/routes/PipelineDetail.tsx` — **Conversation is the
    primary surface** on this route. Layout changes:
    1. The header (runId, status, metrics) stays on top.
    2. `<PipelineConversation />` becomes the main content area, fed by
       the existing `useSSE` hook. It fills the available height and owns
       the scroll.
    3. The graph is demoted to a **secondary "map" element**. Render
       `<GraphView />` inside a collapsible panel (default: collapsed on
       viewports < 1280px, expanded-as-sidebar on ≥ 1280px). Use AI
       Elements' `Panel` if it fits naturally; otherwise a plain
       shadcn/ui `Sheet` / `Collapsible` is fine. Keep the click-to-focus
       behavior — clicking a node in the graph scrolls the conversation
       to that node's section (`document.getElementById(`node-section-${id}`)`).
    4. When the graph panel is collapsed, show a thin "Open map" trigger
       with the run's node-state summary (e.g. `3 completed · 1 running`).
  - `packages/web/src/lib/api.ts` — no API shape change; this task
    consumes the existing `PipelineDetail` + SSE `/pipelines/:id/events`.

- No server changes. Everything is a client-side projection of events
  already on the wire.

## AI Elements reference (baked in — no skill/MCP fetch required)

The agent runs without an `npx skills add vercel/ai-elements` helper, so
the minimum AI Elements component reference you need is inlined here. For
each, install via `cd packages/web && npx ai-elements@latest add <name>`.
Import paths are `@/components/ai-elements/<name>`.

### `conversation` — auto-scrolling scroll container

```tsx
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationEmptyState,
} from "@/components/ai-elements/conversation";

<Conversation>
  <ConversationContent>
    {/* <Message />s go here */}
  </ConversationContent>
  <ConversationScrollButton />
</Conversation>
```

Auto-sticks to bottom, surfaces a scroll-to-bottom button when the user
scrolls up. Children of `ConversationContent` are just React nodes.

### `message` — one bubble per turn, with markdown response body

```tsx
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
} from "@/components/ai-elements/message";

<Message from={role /* "assistant" | "user" | "system" */}>
  <MessageContent>
    <MessageResponse>{textMarkdown}</MessageResponse>
  </MessageContent>
  <MessageActions>
    <MessageAction tooltip="Copy" onClick={copy}>📋</MessageAction>
  </MessageActions>
</Message>
```

Post-install **you must add** the following to
`packages/web/src/styles/globals.css`:

```css
@source "../../../../node_modules/streamdown/dist/*.js";
```

(adjust relative depth for our Vite monorepo). Without this line
`MessageResponse` renders unstyled. Confirm after install by rendering a
fixture markdown block (headings + a code fence) and eyeballing that
padding/syntax-highlighting is applied.

`MessageResponse` handles streaming-incomplete markdown gracefully —
unclosed code fences / lists render without crashing.

### `reasoning` — collapsible thinking block with live indicator

```tsx
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";

<Reasoning className="w-full" isStreaming={part.streaming}>
  <ReasoningTrigger />
  <ReasoningContent>{reasoningText}</ReasoningContent>
</Reasoning>
```

Auto-opens while `isStreaming` is true, then auto-collapses. Consolidate
all reasoning parts of a single Message into one `Reasoning` block —
multiple ones display as multiple "Thinking…" pills which is noisy.

### `tool` — collapsible tool invocation with input + output

```tsx
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";

<Tool defaultOpen={part.state === "output-available" || part.state === "output-error"}>
  <ToolHeader type={`tool-${part.toolName}`} state={part.state} />
  <ToolContent>
    <ToolInput input={part.input} />
    <ToolOutput output={renderOutput(part.output)} errorText={part.errorText} />
  </ToolContent>
</Tool>
```

`state` is one of: `"input-streaming"` (Pending badge), `"input-available"`
(Running), `"output-available"` (Completed), `"output-error"` (Error),
plus `"approval-requested"` / `"approval-responded"` / `"output-denied"`
for human-in-the-loop (deferred — see P5.14). `ToolInput` JSON-formats the
input; `ToolOutput` takes arbitrary React — for swarm, render the result
content via `MessageResponse` for markdown outputs, or a monospace
`<pre>` for raw strings.

The `type` prop expects `"tool-<name>"`. swarm tools are namespaced like
`local:bash` / `local:subagent` — map these as `tool-local_bash` /
`tool-local_subagent` (replace `:` with `_`) for the badge label; show
the real name in the ToolHeader's `title` prop override.

### `checkpoint` — visual separator between node sections

```tsx
import {
  Checkpoint,
  CheckpointIcon,
  CheckpointTrigger,
} from "@/components/ai-elements/checkpoint";

<Checkpoint>
  <CheckpointIcon />   {/* BookmarkIcon by default */}
  <CheckpointTrigger disabled>Node: {nodeId}</CheckpointTrigger>
</Checkpoint>
```

We're using it for **visual separation only** in v1 — `CheckpointTrigger`
is rendered disabled (no click handler). Future: wire to a "rewind run
to this node" feature if/when swarm supports it.

### `task` — compact progress cluster (use for trapezium loop iterations)

```tsx
import {
  Task,
  TaskTrigger,
  TaskContent,
  TaskItem,
} from "@/components/ai-elements/task";

<Task defaultOpen={false}>
  <TaskTrigger title={`${nodeId} — ${turns.length} iterations`} />
  <TaskContent>
    {turns.map((t, i) => <TaskItem key={t.turnId}>Iteration {i+1}: {t.summary}</TaskItem>)}
  </TaskContent>
</Task>
```

Use this as the **section header** for trapezium loop nodes
(`implement_and_review`, `verify` in build-feature.dot). Non-loop nodes
render their header as plain text + the Checkpoint marker.

### `shimmer` — streaming pill

```tsx
import { Shimmer } from "@/components/ai-elements/shimmer";
<Shimmer>streaming…</Shimmer>
```

Use next to status chips when a node is mid-execution or a specific
message part is still streaming. Keep the text short — animation spreads
across character count.

### Conventions that apply to all AI Elements

- Components are **composable**, not monolithic. Prefer composing small
  parts (`<Message><MessageContent><MessageResponse>…`) over a single
  catch-all. Don't add convenience wrappers around them in this task.
- Components extend HTML primitive attrs — pass `data-testid`, `aria-*`,
  `className` directly.
- Theming is shadcn/ui CSS variables; the project's existing globals.css
  applies automatically.
- **Do NOT** introduce `@ai-sdk/react` / `useChat` / `useCompletion` /
  `DefaultChatTransport` — those are for chat backends we don't have. We
  feed components directly from our SSE hook + reducer.

## Tests

- `events-to-conversation.test.ts`:
  - Fixture: load `.swarm/runs/<some successful run>/events.jsonl`. Assert
    the reducer yields ≥1 node section per executed node, with turns and
    messages in the expected structure (shape assertions, not exact
    content — runs aren't deterministic).
  - Streaming: feed `llm.text_delta` × 5 → `llm.done`; final reducer
    output has one text part with `streaming: false` and concatenated text.
  - Reasoning consolidation: two adjacent `llm.thinking_delta` bursts in
    the same Message → one `reasoning` part, not two.
  - Tool lifecycle: `llm.toolcall_delta` → `tool.execution_start` →
    `tool.execution_end` flips state `input-streaming` → `input-available`
    → `output-available`; `is_error=true` maps to `output-error`.
  - Trapezium loop: three retry cycles on `implement_and_review` produce
    three turns inside one node section (not three sections).
  - Determinism: the same events fed twice produce deep-equal output.

- `PipelineConversation.test.tsx`:
  - Renders one section per node + a `Checkpoint` between sections.
  - Reasoning trigger is present for Messages with thinking parts.
  - Tool header renders the mapped swarm tool name.
  - Long run (>200 turns fixture): sections default-collapsed, "Expand
    all" button un-collapses them.
  - Live-streaming part shows a `Shimmer` sibling next to the status chip.
  - `data-testid` stability: `node-section-<id>`, `turn-<id>`,
    `tool-<toolCallId>`, `reasoning-<messageId>`.

## Verification

- `bun run ci` passes.
- Smoke: run a real pipeline (`bun run packages/cli/bin/swarm.ts run
  workflows/build-feature.dot --input-file tasks/p5/NN-*.md`), open
  `/pipelines/<id>`, watch the conversation populate node-by-node. Every
  node boundary shows a `Checkpoint`. Tool calls render with their badge
  state transitioning as events arrive. Reasoning blocks auto-open while
  streaming and collapse on `llm.done`.
- Known runs to test against (local fixtures):
  `.swarm/runs/1776447451676-vqde47/events.jsonl` (P5.06 run, short),
  `.swarm/runs/1776452594912-hr4ffl/events.jsonl` (P5.13 run, long).

## Out of scope

- **Restore-to-checkpoint** (rewind the pipeline to a node). The
  `CheckpointTrigger` is rendered disabled; wiring is a future task.
- **Editing / re-running a turn**. Replay is task 10.
- **Approval UI / human-in-the-loop** — belongs in P5.14 with the
  `Confirmation` component.
- **Model Context usage widget** (`Context` component) — add later once
  we have context-window budgets per model exposed.
- **Historical run search / filter**.
- **AI SDK hook integration** (`useChat` etc.). We don't have a chat
  backend in the loop — swarm events feed the UI directly.

## Reusable patterns

- Event ordering: the JSONL is authoritative. Fold sequentially; don't
  reorder.
- Scope by `(run_id, node_id, session_id)` when building turn groups.
  `session_id` distinguishes subagent invocations from the parent agent.
- Canonical event sequence (from `packages/core/src/types/events.ts` +
  pi-agent-core): `agent.turn_start` → `agent.message_start` →
  `llm.start` → [`llm.text_delta` | `llm.thinking_delta` |
  `llm.toolcall_delta`]* → `llm.done` → `agent.message_end` →
  (`tool.execution_start` → `tool.execution_end`)* → (next message, or
  `agent.turn_end`).
- Cost attribution: the `cost.recorded` event sits between `llm.done`
  and `agent.message_end`, scoped to the same message. Attach it to the
  most recent assistant Message rather than trying to match IDs.
- Formatting discipline: every timestamp through `lib/time.ts`, every
  number through `lib/format.ts`. No inline Intl calls.
