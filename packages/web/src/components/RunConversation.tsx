// RunConversation — the primary surface of `/runs/:id`.
//
// Renders the full run run as a single scrollable conversation,
// using Vercel AI Elements: `Conversation`, `Message`, `MessageResponse`,
// `Reasoning`, `Tool`, `Shimmer`. No nesting, no per-section collapse —
// one continuous thread with lightweight step markers.
//
// Data flow: the route hands us the parsed `RunConversation` tree
// (from `events-to-conversation.ts`) plus the server-side node states
// from `RunDetail.nodes`. When both disagree, the server wins —
// handles the replay / reconnect mid-run case where the reducer hasn't
// seen the close event yet.
//
// `data-testid` hooks (stable for Playwright / unit tests):
//   - `node-section-<nodeId>`  — the <section> element per node.
//   - `turn-<turnId>`          — one per agent turn within a section.
//   - `tool-<toolCallId>`      — one per tool_call part.
//   - `reasoning-<messageId>`  — one per reasoning block.
//   - `conversation-empty`     — empty-state marker.

import { Fragment, type ReactNode, useMemo } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message as AIMessage, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import type { NodeState } from "@/lib/api";
import {
  type RunConversation as ConversationTree,
  type NodeSection,
  type NodeSectionStatus,
  type Part,
  toolTypeFromName,
} from "@/lib/events-to-conversation";
import { statusLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface RunConversationProps {
  /** Parsed conversation tree (from `eventsToConversation`). */
  conversation: ConversationTree;
  /** Optional server-side node states — preferred for section status. */
  nodeStates?: readonly NodeState[];
  /** Whether the SSE stream is still live; drives the live-streaming pill. */
  isLive?: boolean;
  /** Whether we're still bootstrapping events. Suppresses the empty
   * state during the REST-fetch phase so the user doesn't briefly see
   * "No conversation yet" before the events arrive. */
  isLoading?: boolean;
  /** The free-form text the run was launched with. Rendered as the first
   * user message at the top of the thread. The agent's event stream
   * doesn't carry this prompt today — it only emits empty structural
   * `role=user` shells for tool-result round-trips — so the header is
   * the only place we have it. */
  userInput?: string | null;
  className?: string;
}

export function RunConversation({
  conversation,
  nodeStates,
  isLive = false,
  isLoading = false,
  userInput,
  className,
}: RunConversationProps): JSX.Element {
  // Merge: server state wins when present (handles replay / reconnect
  // where the reducer hasn't seen the close event yet).
  const sections = useMemo<NodeSection[]>(() => {
    if (!nodeStates || nodeStates.length === 0) return conversation.slice();
    const byId = new Map(nodeStates.map((n) => [n.nodeId, n.state]));
    return conversation.map((s) => {
      const authoritative = byId.get(s.nodeId);
      return authoritative ? { ...s, status: authoritative } : s;
    });
  }, [conversation, nodeStates]);

  const userPrompt = userInput?.trim() ? userInput : null;

  if (sections.length === 0) {
    // Suppress the empty state while events are still being fetched —
    // an empty surface is better than "No conversation yet" flashing
    // for a second and then getting replaced with a populated tree.
    if (isLoading) {
      return (
        <Conversation className={cn("h-full", className)}>
          <ConversationContent>{userPrompt && <UserPromptMessage text={userPrompt} />}</ConversationContent>
        </Conversation>
      );
    }
    return (
      <Conversation className={cn("h-full", className)}>
        <ConversationContent>
          {userPrompt && <UserPromptMessage text={userPrompt} />}
          <ConversationEmptyState
            data-testid="conversation-empty"
            title="No conversation yet"
            description="This run hasn't produced any agent turns. Events will appear here as they stream in."
          />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation className={cn("h-full", className)}>
      <ConversationContent>
        {userPrompt && <UserPromptMessage text={userPrompt} />}
        {sections.map((section, idx) => (
          <SectionBlock key={section.nodeId} section={section} isLive={isLive} isFirst={idx === 0} />
        ))}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function UserPromptMessage({ text }: { text: string }): JSX.Element {
  return (
    <AIMessage from="user" data-testid="conversation-user-prompt">
      <MessageContent>
        <p className="whitespace-pre-wrap">{text}</p>
      </MessageContent>
    </AIMessage>
  );
}

// --------------------------------------------------------------------
// Section (one per node).
// --------------------------------------------------------------------

interface SectionBlockProps {
  section: NodeSection;
  isLive: boolean;
  isFirst: boolean;
}

function SectionBlock({ section, isLive, isFirst }: SectionBlockProps): JSX.Element {
  const isRunning = section.status === "running" || section.status === "retrying";

  // Flat layout — the step header is at the same visual level as the
  // messages that follow it, not a collapsible wrapper. The user wanted
  // the whole run to read as one continuous thread with lightweight
  // step markers, not nested drawers.
  return (
    <section
      id={`node-section-${section.nodeId}`}
      data-testid={`node-section-${section.nodeId}`}
      data-status={section.status}
      className={cn("scroll-mt-4", isFirst ? "mt-0" : "mt-1")}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">{section.nodeId}</span>
        <StatusChip status={section.status} />
        {/* Shimmer sibling next to the status chip while live. */}
        {isRunning && isLive && <Shimmer className="text-xs">streaming…</Shimmer>}
      </div>

      <div id={`node-section-body-${section.nodeId}`} className="mt-1">
        <NodeInputBlock section={section} />
        <NodeSummaryBlock section={section} />
        {/* Turns render as a flat list — no per-iteration grouping.
            Retry loops (backward edges) emit multiple turns in encounter
            order. Empty sections (run-lifecycle-only nodes like `start`
            / `done`, or a node we haven't seen events for yet) render
            just the header — no placeholder text. */}
        {section.turns.map((turn) => (
          <TurnBlock key={turn.turnId} turn={turn} isLive={isLive} />
        ))}
      </div>
    </section>
  );
}

/**
 * One-line summary rendered for non-LLM handler kinds: graph-level tool
 * nodes emit `tool.completed`, parallel nodes emit `parallel.completed`,
 * and fan_in nodes emit `fan_in.completed`. Without this block these
 * sections would render as bare headers — visible in the event log but
 * silent in the conversation view.
 */
function NodeSummaryBlock({ section }: { section: NodeSection }): JSX.Element | null {
  const { toolSummary, parallelSummary, fanInSummary } = section;
  if (!toolSummary && !parallelSummary && !fanInSummary) return null;

  return (
    <div
      data-testid={`node-summary-${section.nodeId}`}
      className="mb-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs"
    >
      {toolSummary && (
        <div data-testid={`tool-summary-${section.nodeId}`} className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold uppercase tracking-wide text-muted-foreground">tool</span>
          <span
            className={cn(
              "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px]",
              toolSummary.exitCode === 0
                ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                : "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
            )}
          >
            exit {toolSummary.exitCode}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">{formatDuration(toolSummary.durationMs)}</span>
          {toolSummary.command && (
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{toolSummary.command}</code>
          )}
        </div>
      )}
      {parallelSummary && (
        <div data-testid={`parallel-summary-${section.nodeId}`} className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold uppercase tracking-wide text-muted-foreground">parallel</span>
          <span className="font-mono text-[10px] text-muted-foreground">join: {parallelSummary.joinPolicy}</span>
          <span className="flex flex-wrap gap-1">
            {parallelSummary.branches.map((b) => (
              <span
                key={b.branchId}
                className={cn(
                  "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px]",
                  b.status === "success"
                    ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                    : b.status === "fail"
                      ? "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200"
                      : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
                )}
              >
                {b.branchId} · {b.status}
              </span>
            ))}
          </span>
        </div>
      )}
      {fanInSummary && (
        <div data-testid={`fanin-summary-${section.nodeId}`} className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold uppercase tracking-wide text-muted-foreground">fan-in</span>
          {fanInSummary.allFailed ? (
            <span className="inline-flex items-center rounded bg-rose-100 px-1.5 py-0.5 font-mono text-[10px] text-rose-900 dark:bg-rose-950 dark:text-rose-200">
              all branches failed
            </span>
          ) : (
            <>
              <span className="font-mono text-[10px] text-muted-foreground">winner:</span>
              <code className="font-mono text-[11px] text-foreground">{fanInSummary.winner ?? "—"}</code>
            </>
          )}
          {fanInSummary.rankedOrder.length > 1 && (
            <span className="font-mono text-[10px] text-muted-foreground">
              rank: {fanInSummary.rankedOrder.join(" > ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs.toString().padStart(2, "0")}s`;
}

// --------------------------------------------------------------------
// Node input — collapsible snapshot of what the agent was asked.
// --------------------------------------------------------------------

/**
 * Render a `<details>` block with the resolved prompt, system prompt, and
 * model binding for this section. Collapsed by default — the conversation
 * is dense, and most readers want the agent's reply, not the input. Only
 * renders when something interesting exists (prompt or template); otherwise
 * returns null so non-LLM sections (start / exit / conditional) stay bare.
 */
function NodeInputBlock({ section }: { section: NodeSection }): JSX.Element | null {
  const hasPrompt = Boolean(section.prompt || section.promptTemplate);
  const hasMeta = Boolean(section.model || section.systemPrompt);
  if (!hasPrompt && !hasMeta) return null;

  const modelLabel = section.provider && section.model ? `${section.provider}/${section.model}` : section.model;

  return (
    <details
      data-testid={`node-input-${section.nodeId}`}
      className="mb-2 rounded-md border border-border/60 bg-muted/30 text-xs"
    >
      <summary className="cursor-pointer select-none px-2 py-1 text-muted-foreground hover:text-foreground">
        <span className="font-medium">input</span>
        {modelLabel && <span className="ml-2 font-mono text-[10px] opacity-70">{modelLabel}</span>}
        {section.threadId && <span className="ml-2 font-mono text-[10px] opacity-70">thread:{section.threadId}</span>}
      </summary>
      <div className="space-y-3 border-t border-border/60 px-3 py-2">
        {section.prompt && (
          <InputField label="prompt (resolved)" value={section.prompt} testId={`node-input-prompt-${section.nodeId}`} />
        )}
        {section.promptTemplate && section.promptTemplate !== section.prompt && (
          <InputField label="prompt template" value={section.promptTemplate} />
        )}
        {section.systemPrompt && <InputField label="system prompt" value={section.systemPrompt} />}
        <InputMetaGrid section={section} />
      </div>
    </details>
  );
}

function InputField({ label, value, testId }: { label: string; value: string; testId?: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre
        {...(testId ? { "data-testid": testId } : {})}
        className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-foreground"
      >
        {value}
      </pre>
    </div>
  );
}

function InputMetaGrid({ section }: { section: NodeSection }): JSX.Element | null {
  const rows: Array<[string, string]> = [];
  if (section.nodeType) rows.push(["type", section.nodeType]);
  if (section.fidelity) rows.push(["fidelity", section.fidelity]);
  if (section.allowedTools?.length) rows.push(["allowed_tools", section.allowedTools.join(", ")]);
  if (section.deniedTools?.length) rows.push(["denied_tools", section.deniedTools.join(", ")]);
  if (section.contextFiles?.length) rows.push(["context_files", section.contextFiles.join(", ")]);
  if (section.contextKeys?.length) rows.push(["context_keys", section.contextKeys.join(", ")]);
  if (section.nodeOutputsInScope?.length) rows.push(["node_outputs", section.nodeOutputsInScope.join(", ")]);
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[10px]">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="uppercase tracking-wide text-muted-foreground">{k}</dt>
          <dd className="break-words font-mono text-foreground">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function StatusChip({ status }: { status: NodeSectionStatus }): JSX.Element {
  const palette: Record<NodeSectionStatus, string> = {
    pending: "bg-muted text-muted-foreground",
    running: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
    retrying: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
    completed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
    failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
    skipped: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  };
  return (
    <span
      data-testid="status-chip"
      data-status={status}
      className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", palette[status])}
    >
      {statusLabel(status)}
    </span>
  );
}

// --------------------------------------------------------------------
// Turn (one per agent.turn_start).
// --------------------------------------------------------------------

interface TurnBlockProps {
  turn: {
    turnId: string;
    messages: {
      messageId: string;
      role: string;
      parts: Part[];
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      modelId?: string;
    }[];
  };
  isLive: boolean;
}

function TurnBlock({ turn, isLive }: TurnBlockProps): JSX.Element {
  // No left border / indent — the step marker upstream separates turns
  // at the same level as messages, and a vertical rule just added
  // visual noise.
  return (
    <div data-testid={`turn-${turn.turnId}`} className="space-y-3">
      {turn.messages.map((msg) => (
        <MessageBlock key={msg.messageId} message={msg} isLive={isLive} />
      ))}
    </div>
  );
}

// --------------------------------------------------------------------
// Message (one per agent.message_start).
// --------------------------------------------------------------------

interface MessageBlockProps {
  message: {
    messageId: string;
    role: string;
    parts: Part[];
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    modelId?: string;
  };
  isLive: boolean;
}

function MessageBlock({ message, isLive }: MessageBlockProps): JSX.Element | null {
  const role = (
    message.role === "user" || message.role === "assistant" || message.role === "system" ? message.role : "assistant"
  ) as "user" | "assistant" | "system";

  // Partition parts: reasoning gets its own (consolidated) block;
  // text & tool_calls render inline. We intentionally render reasoning
  // *before* body text so the "Thinking…" pill shows up above the reply.
  const reasoningParts = message.parts.filter((p) => p.type === "reasoning");
  const otherParts = message.parts.filter((p) => p.type !== "reasoning");

  const hasStreaming = message.parts.some((p) => (p.type === "text" || p.type === "reasoning") && p.streaming);

  // Skip empty messages. pi-agent-core emits `agent.message_start(role=user)`
  // as a structural marker when feeding tool results back into the loop;
  // the visible content lives on the prior assistant message's
  // `tool_call` part, so the user shell has no parts. Rendering it would
  // leak AI Elements' user-bubble styling as an empty gray pill.
  const hasVisibleText = otherParts.some((p) => p.type !== "text" || p.text.trim().length > 0);
  if (reasoningParts.length === 0 && !hasVisibleText) return null;

  return (
    <AIMessage from={role}>
      <MessageContent>
        {reasoningParts.length > 0 && (
          <Reasoning
            data-testid={`reasoning-${message.messageId}`}
            className="w-full"
            isStreaming={reasoningParts.some((p) => p.streaming)}
          >
            <ReasoningTrigger />
            <ReasoningContent>
              {reasoningParts.map((p) => (p.type === "reasoning" ? p.text : "")).join("")}
            </ReasoningContent>
          </Reasoning>
        )}

        {otherParts.map((part, i) => (
          <PartView key={`${message.messageId}-p${i}`} part={part} />
        ))}

        {isLive && hasStreaming && <Shimmer className="mt-1 text-[10px]">streaming…</Shimmer>}

        {/* TODO: re-enable cost/model/tokens byline once we find a layout
            that reads cleanly. Prior attempts (trailing footer, leading
            byline, border-separated strip) all looked orphaned between
            messages. The data stays on the Message object so the render
            is a one-liner swap when we come back to it. */}
      </MessageContent>
    </AIMessage>
  );
}

// --------------------------------------------------------------------
// Part renderers.
// --------------------------------------------------------------------

function PartView({ part }: { part: Part }): ReactNode {
  if (part.type === "text") {
    // Assistant text flows through AI Elements' `MessageResponse`
    // (streamdown-backed) so markdown renders styled and partial /
    // mid-stream markdown doesn't crash rendering. The Tailwind v4
    // `@source` directive in `globals.css` keeps streamdown's runtime
    // utility classes alive through the JIT. See the P5.08 spec's
    // "AI Elements reference → message" section.
    return <MessageResponse>{part.text}</MessageResponse>;
  }
  if (part.type === "tool_call") {
    // Tools render collapsed by default — the full conversation is already
    // dense, and expanded tool I/O dwarfs the assistant text around it.
    // Users can click the header to drill in when they want the details.
    const title = part.toolName || "tool";
    return (
      <Tool data-testid={`tool-${part.toolCallId || `idx-${part.contentIndex ?? 0}`}`}>
        <ToolHeader type={toolTypeFromName(part.toolName || "unknown")} state={part.state} title={title} />
        <ToolContent>
          <ToolInput input={part.input} />
          <ToolOutput output={renderToolOutput(part.output)} errorText={part.errorText} />
        </ToolContent>
      </Tool>
    );
  }
  // Reasoning handled at the message level.
  return null;
}

/**
 * swarm tool results are usually `{ content: [{type: "text", text}] }`
 * (pi-agent-core's MCP-aligned envelope). Flatten to a plain string
 * here so `ToolOutput` renders a clean code block rather than dumping
 * the whole JSON envelope.
 */
function renderToolOutput(output: unknown): unknown {
  if (!output) return output;
  if (typeof output === "object" && output !== null) {
    const obj = output as { content?: Array<{ type?: string; text?: string }> };
    if (Array.isArray(obj.content)) {
      const texts = obj.content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return output;
}
