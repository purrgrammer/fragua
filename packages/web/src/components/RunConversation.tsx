// RunConversation — the primary surface of `/runs/:id`.
//
// Renders the run's full transcript from the `messages` table (§I9).
// Each row is a pi-agent-core `AgentMessage`; we iterate
// `content[]` blocks (text, thinking, toolCall) and pair each
// `toolCall` to its matching `toolResult` message by `tool_use_id`.
// Swarm-internal `system` rows (the assembled system prompt) collapse
// by default.
//
// Messages group by `nodeId` into sections divided by a hairline
// rule + a small section header carrying node id + status badge.
// A streaming buffer from `useRunLive` renders at the tail of the
// last section as a pending assistant message, fed by
// `llm.text_delta` / `llm.thinking_delta` / `llm.toolcall_delta`
// frames between `agent.message_start` and `agent.message_end`.
//
// `data-testid` hooks:
//   - `conversation-user-prompt`   — the initial user-input message
//   - `node-section-<nodeId>`      — one per node group
//   - `message-<ordinal>`          — one per row
//   - `tool-<toolCallId>`          — one per tool_call
//   - `reasoning-<ordinal>-<idx>`  — one per thinking block
//   - `streaming-message`          — the in-flight assistant buffer
//   - `conversation-empty`         — empty state

import type { AssistantMessage, TextContent, ToolResultMessage } from "@swarm/types";
import { type ReactNode, useMemo } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message as AIMessage, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { NodeState, RunMessageRow } from "@/lib/api";
import type { StreamingBlock, StreamingMessage } from "@/lib/useRunLive";
import { cn } from "@/lib/utils";

export interface RunConversationProps {
  messages: RunMessageRow[];
  /** In-flight assistant message buffer from `useRunLive`. When
   * present, renders at the tail of its node section as a pending
   * message with a streaming shimmer. */
  streaming?: StreamingMessage | null;
  /** Per-node state projection from `RunDetail.nodes`, used to drive
   * the section header status dot + label. */
  nodeStates?: readonly NodeState[];
  isLive?: boolean;
  /** Run is in a paused state (provider error or HITL). Suppresses the
   * "streaming" label and the running-node pulse — the in-flight node's
   * state is still `"running"` from the projection (no completion fact
   * landed) but no work is happening. */
  isPaused?: boolean;
  isLoading?: boolean;
  /** Free-form text the run was launched with. Rendered as the first
   * user message at the top. The agent's event stream carries only
   * synthesized `role=user` shells, so the initial prompt lives here. */
  userInput?: string | null;
  className?: string;
}

export function RunConversation({
  messages,
  streaming = null,
  nodeStates,
  isLive = false,
  isPaused = false,
  isLoading = false,
  userInput,
  className,
}: RunConversationProps): JSX.Element {
  // toolCallId → result map, so each toolCall inside an assistant
  // message pulls in its paired result inline.
  const toolResultsById = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const row of messages) {
      if (row.content.role === "toolResult") {
        map.set(row.content.toolCallId, row.content);
      }
    }
    return map;
  }, [messages]);

  const stateByNodeId = useMemo(() => {
    const map = new Map<string, NodeState>();
    for (const n of nodeStates ?? []) map.set(n.nodeId, n);
    return map;
  }, [nodeStates]);

  // Group contiguous rows by nodeId. A fresh section opens whenever
  // the nodeId changes from the previous row. `null` / missing nodeIds
  // collapse into a single "(unscoped)" section — shouldn't happen
  // for agent-emitted messages but we guard defensively.
  const sections = useMemo(() => groupByNode(messages), [messages]);
  const visibleSections = sections.filter((s) => s.rows.some((r) => r.content.role !== "toolResult"));

  // The streaming buffer belongs to whichever node the last frame
  // tagged — usually the one whose section is currently the tail.
  // Append to that section if it exists, otherwise create a new one.
  const streamingNodeId = streaming?.nodeId ?? null;
  const tailSection = visibleSections[visibleSections.length - 1];
  const appendStreamingToTail =
    streaming != null && streamingNodeId != null && tailSection != null && tailSection.nodeId === streamingNodeId;
  const orphanStreaming = streaming != null && !appendStreamingToTail;

  const empty = !isLoading && !userInput && visibleSections.length === 0 && streaming == null;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <Conversation className="flex-1">
        {empty ? (
          <ConversationContent>
            <ConversationEmptyState
              data-testid="conversation-empty"
              title="No conversation yet"
              description="The agent hasn't produced any messages for this run."
            />
          </ConversationContent>
        ) : (
          <ConversationContent>
            {userInput && <UserPromptMessage text={userInput} />}
            {visibleSections.map((section, i) => {
              const nodeState = section.nodeId ? stateByNodeId.get(section.nodeId) : undefined;
              const isTail = i === visibleSections.length - 1;
              const showStreamHere = appendStreamingToTail && isTail;
              return (
                <NodeSection
                  key={section.key}
                  nodeId={section.nodeId}
                  state={nodeState}
                  isLive={isLive}
                  isPaused={isPaused}
                >
                  {section.rows.map((row) => (
                    <MessageRow key={row.ordinal} row={row} toolResultsById={toolResultsById} isLive={isLive} />
                  ))}
                  {showStreamHere && <StreamingMessageRow streaming={streaming!} />}
                </NodeSection>
              );
            })}
            {orphanStreaming && (
              <NodeSection
                nodeId={streamingNodeId}
                state={streamingNodeId ? stateByNodeId.get(streamingNodeId) : undefined}
                isLive={isLive}
                isPaused={isPaused}
              >
                <StreamingMessageRow streaming={streaming!} />
              </NodeSection>
            )}
          </ConversationContent>
        )}
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
}

// ─── Node section grouping ──────────────────────────────────────────

interface Section {
  key: string;
  nodeId: string | null;
  rows: RunMessageRow[];
}

function groupByNode(messages: RunMessageRow[]): Section[] {
  const out: Section[] = [];
  for (const row of messages) {
    const nodeId = row.nodeId;
    const last = out[out.length - 1];
    if (last && last.nodeId === nodeId) {
      last.rows.push(row);
    } else {
      out.push({ key: `${nodeId ?? "∅"}-${row.ordinal}`, nodeId, rows: [row] });
    }
  }
  return out;
}

interface NodeSectionProps {
  nodeId: string | null;
  state?: NodeState;
  isLive: boolean;
  isPaused: boolean;
  children: ReactNode;
}

function NodeSection({ nodeId, state, isLive, isPaused, children }: NodeSectionProps): JSX.Element {
  const label = nodeId ?? "unscoped";
  const status: NodeState["state"] | "idle" = state?.state ?? "idle";
  return (
    <section
      id={nodeId ? `node-${nodeId}` : undefined}
      data-testid={nodeId ? `node-section-${nodeId}` : "node-section-unscoped"}
      className="relative flex flex-col gap-3"
    >
      <header className="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-sw-bg/95 px-1 py-1 backdrop-blur-sm">
        <StatusDot status={status} isLive={isLive} isPaused={isPaused} />
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-sw-text/80">
          {label}
        </span>
        {state && <NodeStatusLabel state={state.state} isLive={isLive} isPaused={isPaused} />}
        <div className="ml-2 h-px flex-1 bg-sw-border" aria-hidden />
      </header>
      <div className="flex flex-col gap-3 pl-4">{children}</div>
    </section>
  );
}

// ─── Status chips ────────────────────────────────────────────────

const STATUS_TONE: Record<NodeState["state"] | "idle", { dot: string; label: string; ring: string }> = {
  running: {
    dot: "bg-sw-accent-thinking",
    label: "text-sw-accent-thinking",
    ring: "ring-sw-accent-thinking/30",
  },
  completed: {
    dot: "bg-sw-accent-success",
    label: "text-sw-accent-success",
    ring: "ring-sw-accent-success/30",
  },
  failed: { dot: "bg-sw-accent-error", label: "text-sw-accent-error", ring: "ring-sw-accent-error/30" },
  retrying: {
    dot: "bg-sw-accent-warn",
    label: "text-sw-accent-warn",
    ring: "ring-sw-accent-warn/30",
  },
  pending: {
    dot: "bg-sw-accent-idle",
    label: "text-sw-accent-idle",
    ring: "ring-sw-accent-idle/30",
  },
  skipped: {
    dot: "bg-sw-accent-idle",
    label: "text-sw-accent-idle",
    ring: "ring-sw-accent-idle/20",
  },
  idle: {
    dot: "bg-sw-accent-idle",
    label: "text-sw-accent-idle",
    ring: "ring-sw-accent-idle/20",
  },
};

function StatusDot({
  status,
  isLive,
  isPaused,
}: {
  status: NodeState["state"] | "idle";
  isLive: boolean;
  isPaused: boolean;
}): JSX.Element {
  const tone = STATUS_TONE[status];
  // Pulse signals "actively producing tokens." Suppress when the run is
  // paused — the node state is still `running` (no completion fact yet)
  // but no work is happening.
  const pulse = status === "running" && isLive && !isPaused ? "sw-pulse" : "";
  return (
    <span
      aria-hidden
      data-status={status}
      className={cn("inline-block size-2 rounded-full ring-2", tone.dot, tone.ring, pulse)}
    />
  );
}

function NodeStatusLabel({
  state,
  isLive,
  isPaused,
}: {
  state: NodeState["state"];
  isLive: boolean;
  isPaused: boolean;
}): JSX.Element {
  const tone = STATUS_TONE[state];
  const label =
    state === "running"
      ? isPaused
        ? "paused"
        : isLive
          ? "streaming"
          : "in progress"
      : state === "completed"
        ? "done"
        : state === "failed"
          ? "failed"
          : state === "retrying"
            ? "retrying"
            : state === "skipped"
              ? "skipped"
              : "pending";
  return (
    <span
      data-testid={`node-status-${state}`}
      data-status={state}
      className={cn("font-mono text-[10px] uppercase tracking-[0.08em]", tone.label)}
    >
      {label}
    </span>
  );
}

// ─── Message dispatch ──────────────────────────────────────────────

interface MessageRowProps {
  row: RunMessageRow;
  toolResultsById: Map<string, ToolResultMessage>;
  isLive: boolean;
}

function MessageRow({ row, toolResultsById, isLive }: MessageRowProps): JSX.Element | null {
  const msg = row.content;
  const testid = `message-${row.ordinal}`;
  if (msg.role === "system") return <SystemPromptRow content={msg.content} testid={testid} />;
  if (msg.role === "user") return <UserMessageRow message={msg} testid={testid} />;
  if (msg.role === "assistant") {
    return (
      <AssistantMessageRow
        message={msg}
        toolResultsById={toolResultsById}
        ordinal={row.ordinal}
        isLive={isLive}
        testid={testid}
      />
    );
  }
  return null;
}

// ─── Initial user-input message (from run.args) ────────────────────

function UserPromptMessage({ text }: { text: string }): JSX.Element {
  return (
    <AIMessage from="user" data-testid="conversation-user-prompt">
      <MessageContent>
        <MessageResponse>{text}</MessageResponse>
      </MessageContent>
    </AIMessage>
  );
}

// ─── System prompt (collapsed by default) ──────────────────────────

function SystemPromptRow({ content, testid }: { content: string; testid: string }): JSX.Element {
  return (
    <Collapsible
      data-testid={testid}
      className="group/sysprompt rounded-md border border-sw-border bg-sw-surface/40 px-3 py-2 text-xs"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 font-mono text-sw-muted hover:text-sw-text">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-sw-muted/40" aria-hidden />
        <span>system prompt · {content.length.toLocaleString()} chars</span>
        <span className="ml-auto font-mono text-[10px] opacity-60 transition group-data-[state=open]/sysprompt:rotate-180">
          ▾
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-sw-text/80">
        {content}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── User message (pi-ai UserMessage) ──────────────────────────────

function UserMessageRow({
  message,
  testid,
}: {
  message: { content: string | Array<TextContent | { type: string }> };
  testid: string;
}): JSX.Element | null {
  const text = flattenText(message.content);
  if (text.length === 0) return null;
  return (
    <AIMessage from="user" data-testid={testid}>
      <MessageContent>
        <MessageResponse>{text}</MessageResponse>
      </MessageContent>
    </AIMessage>
  );
}

// ─── Assistant message — walks content[] blocks in order ────────────

interface AssistantRowProps {
  message: AssistantMessage;
  toolResultsById: Map<string, ToolResultMessage>;
  ordinal: number;
  isLive: boolean;
  testid: string;
}

function AssistantMessageRow({ message, toolResultsById, ordinal, testid }: AssistantRowProps): JSX.Element | null {
  const blocks: ReactNode[] = [];
  let i = 0;
  for (const chunk of message.content) {
    if (chunk.type === "text") {
      if (chunk.text.trim().length > 0) {
        blocks.push(<MessageResponse key={`${ordinal}-t${i}`}>{chunk.text}</MessageResponse>);
      }
    } else if (chunk.type === "thinking") {
      if (chunk.thinking.trim().length > 0) {
        blocks.push(
          <Reasoning key={`${ordinal}-r${i}`} data-testid={`reasoning-${ordinal}-${i}`} className="w-full">
            <ReasoningTrigger />
            <ReasoningContent>{chunk.thinking}</ReasoningContent>
          </Reasoning>,
        );
      }
    } else if (chunk.type === "toolCall") {
      const result = toolResultsById.get(chunk.id);
      blocks.push(
        <Tool key={`${ordinal}-c${i}`} data-testid={`tool-${chunk.id}`} className="mb-0">
          <ToolHeader
            type={toolTypeFromName(chunk.name)}
            state={result ? (result.isError ? "output-error" : "output-available") : "input-available"}
            title={chunk.name}
          />
          <ToolContent>
            <ToolInput input={chunk.arguments} />
            <ToolOutput
              output={result ? flattenText(result.content) : null}
              errorText={result?.isError ? flattenText(result.content) : undefined}
            />
          </ToolContent>
        </Tool>,
      );
    }
    i++;
  }
  if (blocks.length === 0) return null;

  return (
    <AIMessage from="assistant" data-testid={testid}>
      <MessageContent>{blocks}</MessageContent>
    </AIMessage>
  );
}

// ─── Streaming assistant (mid-message deltas) ─────────────────────

function StreamingMessageRow({ streaming }: { streaming: StreamingMessage }): JSX.Element {
  const blocks: ReactNode[] = streaming.blocks
    .map((block, i) => renderStreamingBlock(block, i))
    .filter((x): x is ReactNode => x !== null);

  return (
    <AIMessage from="assistant" data-testid="streaming-message">
      <MessageContent>{blocks}</MessageContent>
    </AIMessage>
  );
}

function renderStreamingBlock(block: StreamingBlock, i: number): ReactNode {
  if (block.type === "text") {
    if (block.text.length === 0) return null;
    return <MessageResponse key={`stream-t${i}`}>{block.text}</MessageResponse>;
  }
  if (block.type === "thinking") {
    if (block.text.length === 0) return null;
    return (
      <Reasoning key={`stream-r${i}`} className="w-full" isStreaming>
        <ReasoningTrigger />
        <ReasoningContent>{block.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (block.type === "toolCall") {
    return (
      <Tool key={`stream-c${i}`} className="mb-0">
        <ToolHeader type="tool-pending" state="input-streaming" title="…" />
        <ToolContent>
          <pre className="whitespace-pre-wrap font-mono text-[11px] text-sw-muted">{block.argsText}</pre>
        </ToolContent>
      </Tool>
    );
  }
  return null;
}

// ─── Helpers ───────────────────────────────────────────────────────

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block != null && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

function toolTypeFromName(name: string): `tool-${string}` {
  return `tool-${name}` as `tool-${string}`;
}
