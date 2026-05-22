// RunConversation — the primary surface of `/runs/:id`.
//
// Renders the run's full transcript from the `messages` table (§I9).
// Each row is a pi-agent-core `AgentMessage`; we iterate
// `content[]` blocks (text, thinking, toolCall) and pair each
// `toolCall` to its matching `toolResult` message by `tool_use_id`.
// Fragua-internal `system` rows (the assembled system prompt) collapse
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

import type { AssistantMessage, TextContent, ToolNodeMessage, ToolResultMessage } from "@fragua/types";
import { type ReactNode, useMemo, useState } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message as AIMessage, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Terminal } from "@/components/ai-elements/terminal";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { AbortToolResult } from "@/components/run-conversation/AbortToolResult";
import { HitlStepCard } from "@/components/run-conversation/HitlStepCard";
import { RouteToolResult } from "@/components/run-conversation/RouteToolResult";
import { SkillToolResult } from "@/components/run-conversation/SkillToolResult";
import { WebFetchResult } from "@/components/run-conversation/WebFetchResult";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { NodeState, RunMessageRow } from "@/lib/api";
import type { StreamingBlock, StreamingMessage, ToolStream } from "@/lib/useRunLive";
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
  /** Per-nodeId in-flight stdout/stderr from running tool
   * (tool node) nodes. Populated by `useRunLive` from
   * `tool.output_chunk` events. Cleared by `useRunLive` when the
   * persisted `tool_node` row lands. RunConversation renders a
   * streaming Terminal for any nodeId in this map that doesn't
   * already have a `tool_node` message in `messages`. */
  toolStreams?: ReadonlyMap<string, ToolStream>;
  /** Active HITL gate. When present the run is `paused_human` and
   * RunConversation renders an inline choice card at the tail of
   * the paused node's section so the operator can respond without
   * leaving the conversation view. */
  hitl?: {
    runId: string;
    nodeId: string;
    label: string | null;
    options: string[];
  } | null;
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
  toolStreams,
  hitl = null,
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
  const tailSectionNodeId = tailSection?.nodeId ?? null;
  const appendStreamingToTail = streaming != null && streamingNodeId != null && tailSectionNodeId === streamingNodeId;
  const orphanStreaming = streaming != null && !appendStreamingToTail;

  // In-flight tool nodes (tool node). For each entry in
  // `toolStreams` whose nodeId doesn't already have a persisted
  // `tool_node` row in `messages`, render a synthesized tail section
  // with a streaming Terminal. Sections appear in the order the
  // streams started — Map iteration order is insertion order.
  const persistedToolNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of messages) {
      if (row.content.role === "tool_node" && typeof row.nodeId === "string") {
        ids.add(row.nodeId);
      }
    }
    return ids;
  }, [messages]);
  const liveToolNodes = useMemo<Array<{ nodeId: string; stream: ToolStream }>>(() => {
    if (!toolStreams || toolStreams.size === 0) return [];
    const out: Array<{ nodeId: string; stream: ToolStream }> = [];
    for (const [nodeId, stream] of toolStreams) {
      if (persistedToolNodeIds.has(nodeId)) continue;
      out.push({ nodeId, stream });
    }
    return out;
  }, [toolStreams, persistedToolNodeIds]);

  const empty =
    !isLoading &&
    !userInput &&
    visibleSections.length === 0 &&
    streaming == null &&
    liveToolNodes.length === 0 &&
    hitl == null;

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
              const isTail = i === visibleSections.length - 1;
              const nodeState = section.nodeId ? stateByNodeId.get(section.nodeId) : undefined;
              const showStreamHere = appendStreamingToTail && isTail;
              const showHitlHere = hitl != null && section.nodeId === hitl.nodeId;
              return (
                <NodeSection
                  key={section.key}
                  nodeId={section.nodeId}
                  state={nodeState}
                  isLive={isLive}
                  isPaused={isPaused}
                >
                  {section.rows.map((row) => (
                    <MessageRow key={messageKey(row)} row={row} toolResultsById={toolResultsById} />
                  ))}
                  {showStreamHere && <StreamingMessageRow streaming={streaming!} />}
                  {showHitlHere && <HitlStepCard runId={hitl.runId} label={hitl.label} options={hitl.options} />}
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
            {hitl != null && !visibleSections.some((s) => s.nodeId === hitl.nodeId) && (
              <NodeSection
                nodeId={hitl.nodeId}
                state={stateByNodeId.get(hitl.nodeId)}
                isLive={isLive}
                isPaused={isPaused}
              >
                <HitlStepCard runId={hitl.runId} label={hitl.label} options={hitl.options} />
              </NodeSection>
            )}
            {liveToolNodes.map(({ nodeId, stream }) => (
              <NodeSection
                key={`tool-stream-${nodeId}`}
                nodeId={nodeId}
                state={stateByNodeId.get(nodeId)}
                isLive={isLive}
                isPaused={isPaused}
              >
                <ToolNodeStreamingRow stream={stream} testid={`tool-stream-${nodeId}`} />
              </NodeSection>
            ))}
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
      out.push({ key: `${nodeId ?? "unscoped"}-${messageKey(row)}`, nodeId, rows: [row] });
    }
  }
  return out;
}

function messageKey(row: RunMessageRow): string {
  return String(row.ordinal);
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
        <span
          className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-sw-text/80"
          title={nodeId ?? undefined}
        >
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
}

function MessageRow({ row, toolResultsById }: MessageRowProps): JSX.Element | null {
  const msg = row.content;
  const testid = `message-${row.ordinal}`;
  if (msg.role === "system") return <SystemPromptRow content={msg.content} testid={testid} />;
  if (msg.role === "tool_node") return <ToolNodeRow message={msg} nodeId={row.nodeId ?? undefined} testid={testid} />;
  if (msg.role === "user") return <UserMessageRow message={msg} testid={testid} />;
  if (msg.role === "assistant") {
    return (
      <AssistantMessageRow message={msg} toolResultsById={toolResultsById} ordinal={row.ordinal} testid={testid} />
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

// ─── Tool-node row (graph-level shell step) ────────────────────────

function ToolNodeRow({
  message,
  nodeId,
  testid,
}: {
  message: ToolNodeMessage;
  nodeId?: string;
  testid: string;
}): JSX.Element {
  const body = composeTerminalBody(message.stdout, message.stderr);
  const truncationNote = composeTruncationNote(
    message.stdoutTruncated ?? false,
    message.stderrTruncated ?? false,
    message.outputArtifactKey,
  );
  const status = `exit ${message.exitCode} · ${formatDuration(message.durationMs)}`;
  const tone: "success" | "error" = message.exitCode === 0 ? "success" : "error";
  return (
    <div data-testid={testid} className="flex flex-col gap-2">
      <CodeBlock code={message.command} language="shell">
        <CodeBlockHeader>
          <CodeBlockTitle>{nodeId ? <CodeBlockFilename>{nodeId}</CodeBlockFilename> : null}</CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton />
          </CodeBlockActions>
        </CodeBlockHeader>
      </CodeBlock>
      <Terminal status={status} tone={tone} output={`${body}${truncationNote}`} />
    </div>
  );
}

/** In-flight tool node row: there's no persisted `tool_node` message
 * yet, but `tool.output_chunk` events have populated a streaming
 * buffer. Renders a Terminal with `isStreaming` showing accumulated
 * stdout/stderr. The CodeBlock (command) only appears after completion
 * since the substituted command isn't on the SSE stream during the
 * run — it lands on the persisted message. */
function ToolNodeStreamingRow({ stream, testid }: { stream: ToolStream; testid: string }): JSX.Element {
  const body = composeTerminalBody(stream.stdout, stream.stderr);
  return (
    <div data-testid={testid} className="flex flex-col gap-2">
      <Terminal status="running" tone="thinking" output={body} isStreaming />
    </div>
  );
}

function composeTerminalBody(stdout: string, stderr: string): string {
  if (stderr.length === 0) return stdout;
  const sep = stdout.length === 0 || stdout.endsWith("\n") ? "" : "\n";
  return `${stdout}${sep}\x1b[2m── stderr ──\x1b[0m\n${stderr}`;
}

function composeTruncationNote(stdoutTruncated: boolean, stderrTruncated: boolean, artifactKey?: string): string {
  const parts: string[] = [];
  if (stdoutTruncated) parts.push("stdout truncated");
  if (stderrTruncated) parts.push("stderr truncated");
  if (parts.length === 0) return "";
  const ref = artifactKey ? ` · full output: ${artifactKey}` : "";
  return `\n\n\x1b[2m[${parts.join(", ")}${ref}]\x1b[0m`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
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
      // All tool cards default to collapsed — the header is enough;
      // the user clicks to expand. Per-card open state lives in
      // Radix's uncontrolled Collapsible.
      // Exception: `abort` is the terminal self-halt signal — its
      // reason text is the primary diagnostic, so the card opens by
      // default so the operator sees it without an extra click.
      const defaultOpen = chunk.name === "abort";
      blocks.push(
        <Tool key={`${ordinal}-c${i}`} data-testid={`tool-${chunk.id}`} className="mb-0" defaultOpen={defaultOpen}>
          <ToolHeader
            type={toolTypeFromName(chunk.name)}
            state={result ? (result.isError ? "output-error" : "output-available") : "input-available"}
            title={chunk.name}
          />
          <ToolContent>
            <ToolInput input={chunk.arguments} />
            <RichToolResult
              toolName={chunk.name}
              result={result}
              params={chunk.arguments as Record<string, unknown> | undefined}
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

// ─── Rich tool-result rendering ──────────────────────────────────────
//
// The four core tools (read, write, edit, bash) each produce a
// distinctive payload that benefits from custom rendering:
//
//   read   — may carry an ImageContent block alongside text. We render
//            the image inline so vision-model outputs are auditable.
//   edit   — `details.data.diff` carries a unified diff with line
//            numbers. Render with green/red coloring so reviewers can
//            scan changes at a glance.
//   bash   — `details.data.full_output_path` points at the spilled
//            host-file when output was truncated. Surface the path so
//            an operator can `cat` it from a terminal.
//
// Anything we don't recognise falls back to the plain ToolOutput
// renderer so unknown tools keep working.

interface ToolResultDetails {
  fragua_tool?: string;
  is_error?: boolean;
  data?: unknown;
  full_output_path?: string;
}

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

function isImageBlock(b: unknown): b is ImageBlock {
  if (b == null || typeof b !== "object") return false;
  const x = b as { type?: unknown; data?: unknown; mimeType?: unknown };
  return x.type === "image" && typeof x.data === "string" && typeof x.mimeType === "string";
}

function isTextBlock(b: unknown): b is { type: "text"; text: string } {
  if (b == null || typeof b !== "object") return false;
  const x = b as { type?: unknown; text?: unknown };
  return x.type === "text" && typeof x.text === "string";
}

function RichToolResult({
  toolName,
  result,
  params,
}: {
  toolName: string;
  result: ToolResultMessage | undefined;
  params?: Record<string, unknown> | undefined;
}): JSX.Element | null {
  // web_fetch is a core tool but worth its own dedicated renderer
  // (URL pill, cache/redirect/error variants, model+cost footer).
  // Mirrors the bash/edit branches below.
  if (toolName === "web_fetch") {
    return (
      <WebFetchResult
        params={params as { url?: string; prompt?: string } | undefined}
        result={result}
        isStreaming={!result}
      />
    );
  }
  // skill: built-in tool that loads a SKILL.md by catalogue name and
  // substitutes $ARGUMENTS. The structured payload (name, description,
  // path, content) lands on result.details.data — same channel every
  // built-in uses.
  if (toolName === "skill") {
    return (
      <SkillToolResult
        params={params as { name?: string; arguments?: string } | undefined}
        result={result}
        isStreaming={!result}
      />
    );
  }
  // route: built-in routing signal. The chosen branch lands on params.name
  // and is echoed on result.details.data.route — surface it as a named card
  // rather than the generic "route: <name>" text dump.
  if (toolName === "route") {
    return <RouteToolResult params={params as { name?: string } | undefined} result={result} />;
  }
  // abort: built-in self-halt signal. The reason lands on params and is
  // echoed on result.details.data — surface it as an error-tone card
  // rather than a generic ToolOutput dump.
  if (toolName === "abort") {
    return <AbortToolResult params={params as { reason?: string } | undefined} result={result} />;
  }
  if (!result) return null;
  const text = flattenText(result.content);
  const errorText = result.isError ? text : undefined;
  const details = (result.details ?? undefined) as ToolResultDetails | undefined;

  // Image content only shows up on read today, but route on shape so a
  // future browser/screenshot tool drops in without touching this block.
  const images = Array.isArray(result.content) ? result.content.filter(isImageBlock) : [];
  const textBlocks = Array.isArray(result.content) ? result.content.filter(isTextBlock) : [];

  // Edit tool: render the diff prominently. `data.diff` is the
  // unified-diff string our edit-diff.ts builds; lines are
  // `±N text` / ` N text` with leading sign + line number.
  const data = (details?.data ?? undefined) as { diff?: unknown; full_output_path?: unknown } | undefined;
  const diff = typeof data?.diff === "string" ? (data.diff as string) : null;
  const fullOutputPath =
    typeof data?.full_output_path === "string"
      ? (data.full_output_path as string)
      : typeof details?.full_output_path === "string"
        ? (details.full_output_path as string)
        : null;

  const isEdit = toolName === "edit";
  const isBash = toolName === "bash";

  return (
    <div className="space-y-[var(--sw-space-3)]">
      {isEdit && diff !== null && diff.length > 0 && <DiffView diff={diff} />}
      {images.length > 0 && (
        <ImageGallery
          images={images.map((b, i) => ({
            data: b.data,
            mimeType: b.mimeType,
            key: `${result.toolCallId}-img-${i}`,
          }))}
        />
      )}
      {/* For tools whose primary signal IS the diff, the text block is just
          a "Successfully replaced N block(s)" status — keep it as a small
          subtitle rather than a full ToolOutput card. */}
      {isEdit && diff !== null && diff.length > 0 && textBlocks.length > 0 && (
        <p className="font-mono text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]">{textBlocks[0]?.text}</p>
      )}
      {/* Bash: surface the spilled-output path link so the agent / operator
          can recover the full transcript. */}
      {isBash && fullOutputPath !== null && <BashSpillNotice path={fullOutputPath} />}
      {/* Default text output — skipped when we already rendered a richer
          variant above (image, diff). Keeps the card focused on the
          highest-fidelity rendering for that tool. */}
      {(!isEdit || diff === null || diff.length === 0) && <ToolOutput output={text || null} errorText={errorText} />}
    </div>
  );
}

function DiffView({ diff }: { diff: string }): JSX.Element {
  const lines = diff.split("\n");
  return (
    <div className="space-y-[var(--sw-space-2)]">
      <h4
        className={cn(
          "font-medium uppercase",
          "text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]",
          "tracking-[0.06em]",
        )}
      >
        Diff
      </h4>
      <pre
        data-testid="tool-diff"
        className={cn(
          "overflow-x-auto rounded-[var(--sw-radius-default)] border",
          "p-[var(--sw-space-3)] font-mono text-[length:var(--sw-text-xs)] leading-relaxed",
        )}
        style={{ borderColor: "var(--sw-border)", backgroundColor: "var(--sw-surface)" }}
      >
        {lines.map((line, i) => {
          const sign = line[0] ?? " ";
          const tone =
            sign === "+"
              ? { color: "var(--sw-accent-success)" }
              : sign === "-"
                ? { color: "var(--sw-accent-error)" }
                : { color: "var(--sw-muted)" };
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable id; list is derived per render and never reorders
            <div key={`d${i}`} style={tone}>
              {line || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function ImageGallery({ images }: { images: Array<{ data: string; mimeType: string; key: string }> }): JSX.Element {
  return (
    <div className="space-y-[var(--sw-space-2)]">
      <h4
        className={cn(
          "font-medium uppercase",
          "text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]",
          "tracking-[0.06em]",
        )}
      >
        {images.length === 1 ? "Image" : `Images (${images.length})`}
      </h4>
      <div className="flex flex-wrap gap-[var(--sw-space-2)]">
        {images.map((img) => (
          <ImagePreview key={img.key} data={img.data} mimeType={img.mimeType} />
        ))}
      </div>
    </div>
  );
}

function ImagePreview({ data, mimeType }: { data: string; mimeType: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const src = `data:${mimeType};base64,${data}`;
  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className={cn(
        "block overflow-hidden rounded-[var(--sw-radius-default)] border",
        "transition-[max-width] duration-200",
      )}
      style={{ borderColor: "var(--sw-border)", maxWidth: expanded ? "100%" : "16rem" }}
      aria-label={expanded ? "Collapse image" : "Expand image"}
    >
      {/* Embedded as data URL so renders work offline / in archive view. */}
      <img alt="tool result" src={src} className="block h-auto w-full" />
    </button>
  );
}

function BashSpillNotice({ path }: { path: string }): JSX.Element {
  return (
    <div
      data-testid="bash-spill-notice"
      className={cn(
        "flex items-center gap-[var(--sw-space-2)]",
        "rounded-[var(--sw-radius-default)] border",
        "px-[var(--sw-space-3)] py-[var(--sw-space-2)]",
        "font-mono text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]",
      )}
      style={{ borderColor: "var(--sw-border)", backgroundColor: "var(--sw-surface)" }}
      title="Output exceeded the truncation window — the full transcript was spilled to a host-side temp file. Cat this path from the run's working directory to recover it."
    >
      <span className="uppercase tracking-[0.06em]" style={{ color: "var(--sw-accent-warn)" }}>
        Full output
      </span>
      <code className="break-all">{path}</code>
    </div>
  );
}
