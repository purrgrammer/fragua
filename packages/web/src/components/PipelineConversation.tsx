// PipelineConversation — the primary surface of `/pipelines/:id` in P5.08.
//
// Renders the full pipeline run as a single scrollable conversation,
// using Vercel AI Elements end-to-end: `Conversation`, `Message`,
// `MessageResponse`, `Reasoning`, `Tool`, `Checkpoint`, `Task`, `Shimmer`.
//
// Data flow: the route hands us the parsed `PipelineConversation` tree
// (from `events-to-conversation.ts`) plus a map of node states from the
// API's `PipelineDetail.nodes` (so section status reflects the server's
// authoritative view even when the reducer hasn't seen the
// node.completed event yet — happens on reconnect mid-run).
//
// Collapse behaviour:
//   - Default: all sections expanded.
//   - Long runs (> LONG_RUN_TURNS turns): sections default collapsed
//     with an "Expand all" button in the header. Threshold is
//     deliberately generous (200) — a normal build-feature.dot run is
//     well under that.
//   - Per-section toggle: click the section header to flip that one.
//   - Loop nodes (>1 turn, e.g. `implement_and_review`, `verify`): each
//     iteration is wrapped in an AI Elements <Task> so it can be
//     collapsed independently; the first iteration stays open.
//
// `data-testid` hooks (stable for Playwright / unit tests):
//   - `node-section-<nodeId>`     — the <section> element per node.
//   - `turn-<turnId>`             — one per agent turn within a section.
//   - `tool-<toolCallId>`         — one per tool_call part.
//   - `reasoning-<messageId>`     — one per reasoning block.
//   - `expand-all`                — the "Expand all" button (long runs).
//   - `conversation-empty`        — empty-state marker.
//
// Formatting discipline (AGENTS.md): cost via `formatUsd`, tokens via
// `formatTokensCompact`. No inline `Intl.*`.

import { type ReactNode, useMemo, useState } from "react";
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from "@/components/ai-elements/checkpoint";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message as AIMessage, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Task, TaskContent, TaskTrigger } from "@/components/ai-elements/task";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import type { NodeState } from "@/lib/api";
import {
  type PipelineConversation as ConversationTree,
  type NodeSection,
  type NodeSectionStatus,
  type Part,
  toolTypeFromName,
} from "@/lib/events-to-conversation";
import { formatTokensCompact, formatUsd, statusLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

export const LONG_RUN_TURNS = 200;

export interface PipelineConversationProps {
  /** Parsed conversation tree (from `eventsToConversation`). */
  conversation: ConversationTree;
  /** Optional server-side node states — preferred for section status. */
  nodeStates?: readonly NodeState[];
  /** Whether the SSE stream is still live; drives the live-streaming pill. */
  isLive?: boolean;
  className?: string;
}

export function PipelineConversation({
  conversation,
  nodeStates,
  isLive = false,
  className,
}: PipelineConversationProps): JSX.Element {
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

  const turnCount = useMemo(() => sections.reduce((n, s) => n + s.turns.length, 0), [sections]);
  const isLongRun = turnCount > LONG_RUN_TURNS;

  // Per-node collapse state. Keys: nodeId. Default depends on isLongRun.
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
  const [allExpanded, setAllExpanded] = useState(false);

  const defaultCollapsed = isLongRun && !allExpanded;

  function isCollapsed(nodeId: string): boolean {
    const override = collapsedOverrides[nodeId];
    return override === undefined ? defaultCollapsed : override;
  }

  function toggle(nodeId: string): void {
    setCollapsedOverrides((prev) => ({
      ...prev,
      [nodeId]: !isCollapsed(nodeId),
    }));
  }

  function expandAll(): void {
    setAllExpanded(true);
    setCollapsedOverrides({});
  }

  if (sections.length === 0) {
    return (
      <Conversation className={cn("h-full", className)}>
        <ConversationContent>
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
        {isLongRun && !allExpanded && (
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span>Long run ({turnCount} turns). Sections are collapsed by default.</span>
            <Button data-testid="expand-all" size="sm" variant="outline" onClick={expandAll}>
              Expand all
            </Button>
          </div>
        )}

        {sections.map((section, idx) => (
          <SectionBlock
            key={section.nodeId}
            section={section}
            isLive={isLive}
            collapsed={isCollapsed(section.nodeId)}
            onToggle={() => toggle(section.nodeId)}
            isFirst={idx === 0}
          />
        ))}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

// --------------------------------------------------------------------
// Section (one per node).
// --------------------------------------------------------------------

interface SectionBlockProps {
  section: NodeSection;
  isLive: boolean;
  collapsed: boolean;
  onToggle: () => void;
  isFirst: boolean;
}

function SectionBlock({ section, isLive, collapsed, onToggle, isFirst }: SectionBlockProps): JSX.Element {
  const isLoop = section.turns.length > 1;
  const isRunning = section.status === "running" || section.status === "retrying";

  return (
    <section
      id={`node-section-${section.nodeId}`}
      data-testid={`node-section-${section.nodeId}`}
      data-status={section.status}
      className="scroll-mt-4"
    >
      {/* Checkpoint divider between sections (and above the first one,
          which also doubles as a visual anchor for graph-click scrolls).
          `CheckpointTrigger` is rendered disabled — "restore run to
          this node" is out of scope for P5.08. */}
      <Checkpoint className={cn(isFirst ? "mt-0" : "mt-6")}>
        <CheckpointIcon />
        <CheckpointTrigger disabled className="cursor-default pointer-events-none">
          Node: {section.nodeId}
        </CheckpointTrigger>
      </Checkpoint>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="text-sm font-medium text-foreground hover:underline"
          aria-expanded={!collapsed}
          aria-controls={`node-section-body-${section.nodeId}`}
        >
          {collapsed ? "▸" : "▾"} {section.nodeId}
        </button>
        <StatusChip status={section.status} />
        {/* Shimmer sibling next to the status chip while live. */}
        {isRunning && isLive && <Shimmer className="text-xs">streaming…</Shimmer>}
        {isLoop && <span className="text-[10px] text-muted-foreground">({section.turns.length} iterations)</span>}
      </div>

      <Collapsible open={!collapsed}>
        <CollapsibleContent id={`node-section-body-${section.nodeId}`} className="mt-2">
          {isLoop
            ? // Loop nodes (e.g. `implement_and_review`, `verify`): each
              // iteration is its own collapsible <Task>. First iteration
              // stays open so the latest progress is immediately visible;
              // earlier iterations collapse to a one-line summary.
              section.turns.map((turn, i) => (
                <Task key={turn.turnId} defaultOpen={i === section.turns.length - 1} className="mt-3 first:mt-0">
                  <TaskTrigger title={`Iteration ${i + 1} of ${section.turns.length}`} />
                  <TaskContent>
                    <TurnBlock turn={turn} isLive={isLive} />
                  </TaskContent>
                </Task>
              ))
            : section.turns.map((turn) => <TurnBlock key={turn.turnId} turn={turn} isLive={isLive} />)}
          {section.turns.length === 0 && (
            <p className="text-xs text-muted-foreground italic">(no agent turns for this node)</p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function StatusChip({ status }: { status: NodeSectionStatus }): JSX.Element {
  const palette: Record<NodeSectionStatus, string> = {
    pending: "bg-muted text-muted-foreground",
    running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
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
  return (
    <div data-testid={`turn-${turn.turnId}`} className="space-y-3 border-l-2 border-muted pl-3 py-2">
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

function MessageBlock({ message, isLive }: MessageBlockProps): JSX.Element {
  const role = (
    message.role === "user" || message.role === "assistant" || message.role === "system" ? message.role : "assistant"
  ) as "user" | "assistant" | "system";

  // Partition parts: reasoning gets its own (consolidated) block;
  // text & tool_calls render inline. We intentionally render reasoning
  // *before* body text so the "Thinking…" pill shows up above the reply.
  const reasoningParts = message.parts.filter((p) => p.type === "reasoning");
  const otherParts = message.parts.filter((p) => p.type !== "reasoning");

  const hasStreaming = message.parts.some((p) => (p.type === "text" || p.type === "reasoning") && p.streaming);

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

        {(message.costUsd !== undefined || message.modelId) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            {message.modelId && <span>model: {message.modelId}</span>}
            {message.costUsd !== undefined && <span>cost: {formatUsd(message.costUsd)}</span>}
            {(message.inputTokens !== undefined || message.outputTokens !== undefined) && (
              <span>tokens: {formatTokensCompact((message.inputTokens ?? 0) + (message.outputTokens ?? 0))}</span>
            )}
          </div>
        )}
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
    // mid-stream markdown doesn't crash rendering. The streamdown source
    // hint in `tailwind.config.ts` (`content` glob) keeps its utility
    // classes alive through the JIT. See the P5.08 spec's "AI Elements
    // reference → message" section.
    return <MessageResponse>{part.text}</MessageResponse>;
  }
  if (part.type === "tool_call") {
    const defaultOpen = part.state === "output-available" || part.state === "output-error";
    const title = part.toolName || "tool";
    return (
      <Tool data-testid={`tool-${part.toolCallId || `idx-${part.contentIndex ?? 0}`}`} defaultOpen={defaultOpen}>
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
