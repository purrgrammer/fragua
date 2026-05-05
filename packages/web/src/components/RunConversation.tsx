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

import { renderers as extensionRenderers } from "virtual:swarm-extensions";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@swarm/types";
import { type ReactNode, useMemo, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message as AIMessage, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { WebFetchResult } from "@/components/run-conversation/WebFetchResult";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  /** parentNodeId → currently-running branchIds. When non-empty for a
   * given parent, the parent's section renders as a tabbed sub-view
   * with one tab per active branch (filters messages by branch nodeId).
   * Tabs collapse back into flat node sections once the branches
   * complete. Absent / empty → today's flat render. */
  activeBranchesByParent?: ReadonlyMap<string, readonly string[]>;
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
  activeBranchesByParent,
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

  // subagent_id → label, derived from `agent` tool calls in the
  // parent's transcript. The toolCall's `arguments.description` is
  // the operator-friendly label the calling LLM picked; the matching
  // toolResult's `details.data.subagent_id` is the discriminator.
  // Pair them by toolCall id and stash the mapping so a sub-agent's
  // transcript can render with its label instead of the raw uuid.
  const subagentLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of messages) {
      if (row.content.role !== "assistant" || !Array.isArray(row.content.content)) continue;
      const blocks = row.content.content as Array<{
        type: string;
        id?: string;
        name?: string;
        arguments?: { description?: unknown };
      }>;
      for (const block of blocks) {
        if (block.type !== "toolCall") continue;
        if (block.name !== "agent") continue;
        const callId = block.id;
        if (!callId) continue;
        const description = typeof block.arguments?.description === "string" ? block.arguments.description : undefined;
        if (!description) continue;
        const result = toolResultsById.get(callId);
        if (!result) continue;
        const details = (result as { details?: { data?: { subagent_id?: unknown } } }).details;
        const sid = typeof details?.data?.subagent_id === "string" ? details.data.subagent_id : undefined;
        if (sid) map.set(sid, description);
      }
    }
    return map;
  }, [messages, toolResultsById]);

  // subagent_id → ordered array of sub-agent transcript messages.
  // Sub-agent messages are written to the parent's run with
  // `nodeId = "__subagent:<id>"`; they're rendered inline inside the
  // matching `agent` toolCall card (not as their own NodeSection)
  // so the parent's section flow stays unbroken and the operator
  // sees "spawned X with prompt Y, here's what it produced" in one
  // visual unit.
  const SUBAGENT_NODE_PREFIX = "__subagent:";
  const subagentMessagesById = useMemo(() => {
    const map = new Map<string, RunMessageRow[]>();
    for (const row of messages) {
      const nid = row.nodeId;
      if (typeof nid !== "string" || !nid.startsWith(SUBAGENT_NODE_PREFIX)) continue;
      const sid = nid.slice(SUBAGENT_NODE_PREFIX.length);
      const arr = map.get(sid) ?? [];
      arr.push(row);
      map.set(sid, arr);
    }
    return map;
  }, [messages]);

  // Strip sub-agent rows from the main message stream — they render
  // inside the agent toolCall card, not as their own section.
  const mainMessages = useMemo(
    () => messages.filter((m) => typeof m.nodeId !== "string" || !m.nodeId.startsWith(SUBAGENT_NODE_PREFIX)),
    [messages],
  );

  const stateByNodeId = useMemo(() => {
    const map = new Map<string, NodeState>();
    for (const n of nodeStates ?? []) map.set(n.nodeId, n);
    return map;
  }, [nodeStates]);

  // Group contiguous rows by nodeId. A fresh section opens whenever
  // the nodeId changes from the previous row. `null` / missing nodeIds
  // collapse into a single "(unscoped)" section — shouldn't happen
  // for agent-emitted messages but we guard defensively.
  const sections = useMemo(() => groupByNode(mainMessages), [mainMessages]);
  const visibleSections = sections.filter((s) => s.rows.some((r) => r.content.role !== "toolResult"));

  // Branch-tab planning: walk visibleSections; whenever we hit a section
  // whose nodeId is a parent with active branches, fold every immediately
  // following section whose nodeId is in that parent's branch set into
  // a single "branch tabs" group. Once we hit a non-branch nodeId or
  // run out of sections, the group closes and normal rendering resumes.
  // Branches whose state has flipped to `completed` (no longer in the
  // active set) fall back to a flat node section — this is exactly the
  // "tabs collapse after fan_in" behaviour the proposal asks for.
  const renderItems = useMemo<RenderItem[]>(
    () => buildRenderItems(visibleSections, activeBranchesByParent),
    [visibleSections, activeBranchesByParent],
  );

  // The streaming buffer belongs to whichever node the last frame
  // tagged — usually the one whose section is currently the tail.
  // Append to that section if it exists, otherwise create a new one.
  const streamingNodeId = streaming?.nodeId ?? null;
  const tailItem = renderItems[renderItems.length - 1];
  const tailSectionNodeId =
    tailItem?.kind === "section"
      ? tailItem.section.nodeId
      : tailItem?.kind === "branch-tabs"
        ? tailItem.parentNodeId
        : null;
  // Streaming may also belong inside a tab — if the streaming nodeId
  // is one of the active branches of the tail group, we render the
  // streaming row inside that tab.
  const tailBranchTabs = tailItem?.kind === "branch-tabs" ? tailItem : null;
  const streamingInTab =
    tailBranchTabs != null && streamingNodeId != null && tailBranchTabs.branches.includes(streamingNodeId);
  const appendStreamingToTail =
    streaming != null && streamingNodeId != null && tailSectionNodeId === streamingNodeId && !streamingInTab;
  const orphanStreaming = streaming != null && !appendStreamingToTail && !streamingInTab;

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
            {renderItems.map((item, i) => {
              const isTail = i === renderItems.length - 1;
              if (item.kind === "section") {
                const section = item.section;
                const nodeState = section.nodeId ? stateByNodeId.get(section.nodeId) : undefined;
                const showStreamHere = appendStreamingToTail && isTail;
                return (
                  <NodeSection
                    key={section.key}
                    nodeId={section.nodeId}
                    state={nodeState}
                    isLive={isLive}
                    isPaused={isPaused}
                    subagentLabelById={subagentLabelById}
                  >
                    {section.rows.map((row) => (
                      <MessageRow
                        key={row.ordinal}
                        row={row}
                        toolResultsById={toolResultsById}
                        subagentMessagesById={subagentMessagesById}
                        isLive={isLive}
                      />
                    ))}
                    {showStreamHere && <StreamingMessageRow streaming={streaming!} />}
                  </NodeSection>
                );
              }
              return (
                <BranchTabsSection
                  key={item.key}
                  parentNodeId={item.parentNodeId}
                  parentSection={item.parentSection}
                  branches={item.branches}
                  branchSections={item.branchSections}
                  stateByNodeId={stateByNodeId}
                  toolResultsById={toolResultsById}
                  isLive={isLive}
                  isPaused={isPaused}
                  streaming={isTail && streamingInTab ? streaming : null}
                />
              );
            })}
            {orphanStreaming && (
              <NodeSection
                nodeId={streamingNodeId}
                state={streamingNodeId ? stateByNodeId.get(streamingNodeId) : undefined}
                isLive={isLive}
                isPaused={isPaused}
                subagentLabelById={subagentLabelById}
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

// ─── Branch-tabs render planning ──────────────────────────────────

type RenderItem =
  | { kind: "section"; key: string; section: Section }
  | {
      kind: "branch-tabs";
      key: string;
      parentNodeId: string;
      /** Parent's own messages (if any) — rendered above the tab strip. */
      parentSection: Section | null;
      /** Active branchIds in declaration order; one tab per entry. */
      branches: readonly string[];
      /** branchId → contiguous Section, in tab declaration order. May be
       *  `null` for branches with no messages yet (still gets a tab). */
      branchSections: ReadonlyMap<string, Section | null>;
    };

function buildRenderItems(
  sections: readonly Section[],
  activeBranchesByParent: ReadonlyMap<string, readonly string[]> | undefined,
): RenderItem[] {
  if (!activeBranchesByParent || activeBranchesByParent.size === 0) {
    return sections.map((s) => ({ kind: "section", key: s.key, section: s }));
  }
  const out: RenderItem[] = [];
  let i = 0;
  while (i < sections.length) {
    const section = sections[i]!;
    const branches = section.nodeId ? activeBranchesByParent.get(section.nodeId) : undefined;
    if (!branches || branches.length === 0) {
      // Also start a tabs group when a branch section appears without
      // its parent being in the section list (parent had no messages).
      const parentForOrphan = section.nodeId ? findParentForBranch(section.nodeId, activeBranchesByParent) : null;
      if (parentForOrphan) {
        const parentBranches = activeBranchesByParent.get(parentForOrphan) ?? [];
        const consumed = collectBranchSections(sections, i, parentBranches);
        out.push({
          kind: "branch-tabs",
          key: `tabs-${parentForOrphan}-${section.key}`,
          parentNodeId: parentForOrphan,
          parentSection: null,
          branches: parentBranches,
          branchSections: consumed.branchSections,
        });
        i = consumed.nextIndex;
        continue;
      }
      out.push({ kind: "section", key: section.key, section });
      i += 1;
      continue;
    }
    // section.nodeId IS a parent with active branches — fold subsequent
    // branch sections into one tabs group.
    const consumed = collectBranchSections(sections, i + 1, branches);
    out.push({
      kind: "branch-tabs",
      key: `tabs-${section.nodeId ?? "unknown"}-${section.key}`,
      parentNodeId: section.nodeId ?? "",
      parentSection: section,
      branches,
      branchSections: consumed.branchSections,
    });
    i = consumed.nextIndex;
  }
  return out;
}

function findParentForBranch(
  nodeId: string,
  activeBranchesByParent: ReadonlyMap<string, readonly string[]>,
): string | null {
  for (const [parent, branches] of activeBranchesByParent) {
    if (branches.includes(nodeId)) return parent;
  }
  return null;
}

function collectBranchSections(
  sections: readonly Section[],
  startIndex: number,
  branches: readonly string[],
): { branchSections: Map<string, Section | null>; nextIndex: number } {
  const branchSet = new Set(branches);
  const branchSections = new Map<string, Section | null>();
  for (const b of branches) branchSections.set(b, null);
  let i = startIndex;
  while (i < sections.length) {
    const s = sections[i]!;
    if (s.nodeId == null || !branchSet.has(s.nodeId)) break;
    if (branchSections.get(s.nodeId) == null) {
      branchSections.set(s.nodeId, s);
    } else {
      // A branch already had a section earlier — keep both by merging
      // rows so message order is preserved.
      const existing = branchSections.get(s.nodeId) as Section;
      existing.rows.push(...s.rows);
    }
    i += 1;
  }
  return { branchSections, nextIndex: i };
}

function BranchTabsSection({
  parentNodeId,
  parentSection,
  branches,
  branchSections,
  stateByNodeId,
  toolResultsById,
  isLive,
  isPaused,
  streaming,
}: {
  parentNodeId: string;
  parentSection: Section | null;
  branches: readonly string[];
  branchSections: ReadonlyMap<string, Section | null>;
  stateByNodeId: Map<string, NodeState>;
  toolResultsById: Map<string, ToolResultMessage>;
  isLive: boolean;
  isPaused: boolean;
  streaming: StreamingMessage | null;
}): JSX.Element {
  const parentState = parentNodeId ? stateByNodeId.get(parentNodeId) : undefined;
  const initial = branches[0] ?? "";
  return (
    <section data-testid={`branch-tabs-${parentNodeId}`} className="relative flex flex-col gap-3">
      {parentSection ? (
        <NodeSection nodeId={parentSection.nodeId} state={parentState} isLive={isLive} isPaused={isPaused}>
          {parentSection.rows.map((row) => (
            <MessageRow key={row.ordinal} row={row} toolResultsById={toolResultsById} isLive={isLive} />
          ))}
        </NodeSection>
      ) : (
        <header className="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-sw-bg/95 px-1 py-1 backdrop-blur-sm">
          <StatusDot status={parentState?.state ?? "running"} isLive={isLive} isPaused={isPaused} />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-sw-text/80">
            {parentNodeId}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-sw-muted">
            {branches.length} branches
          </span>
          <div className="ml-2 h-px flex-1 bg-sw-border" aria-hidden />
        </header>
      )}
      <Tabs defaultValue={initial} className="flex flex-col gap-2 pl-4">
        <TabsList variant="line" className="self-start">
          {branches.map((branchId) => {
            const state = stateByNodeId.get(branchId);
            return (
              <TabsTrigger
                key={branchId}
                value={branchId}
                data-testid={`branch-tab-${branchId}`}
                data-branch-state={state?.state ?? "pending"}
              >
                <span className="font-mono text-[11px]">{branchId}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>
        {branches.map((branchId) => {
          const section = branchSections.get(branchId) ?? null;
          const state = stateByNodeId.get(branchId);
          const showStreamHere = streaming?.nodeId === branchId;
          return (
            <TabsContent
              key={branchId}
              value={branchId}
              data-testid={`branch-tab-content-${branchId}`}
              className="flex flex-col gap-3"
            >
              <NodeSection nodeId={branchId} state={state} isLive={isLive} isPaused={isPaused}>
                {section?.rows.map((row) => (
                  <MessageRow key={row.ordinal} row={row} toolResultsById={toolResultsById} isLive={isLive} />
                )) ?? null}
                {showStreamHere && streaming != null && <StreamingMessageRow streaming={streaming} />}
              </NodeSection>
            </TabsContent>
          );
        })}
      </Tabs>
    </section>
  );
}

interface NodeSectionProps {
  nodeId: string | null;
  state?: NodeState;
  isLive: boolean;
  isPaused: boolean;
  /** subagent_id → label map, derived from the parent's `agent`
   *  toolCall args. Used to render sub-agent sections with the
   *  caller's friendly label instead of a raw uuid. */
  subagentLabelById?: ReadonlyMap<string, string>;
  children: ReactNode;
}

function NodeSection({ nodeId, state, isLive, isPaused, subagentLabelById, children }: NodeSectionProps): JSX.Element {
  // Sub-agent message sections carry a synthetic `__subagent:<uuid>`
  // nodeId. Prefer the operator-friendly label from the parent's
  // `agent` toolCall args; fall back to a short-id slice when no
  // label was set. The full uuid stays on the header's `title` so
  // operators can still copy the discriminator.
  const SUBAGENT_PREFIX = "__subagent:";
  const label = (() => {
    if (nodeId == null) return "unscoped";
    if (!nodeId.startsWith(SUBAGENT_PREFIX)) return nodeId;
    const sid = nodeId.slice(SUBAGENT_PREFIX.length);
    const friendly = subagentLabelById?.get(sid);
    return `agent · ${friendly ?? sid.slice(0, 8)}`;
  })();
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
  /** Sub-agent transcripts keyed by subagent_id, indexed from the
   *  parent's `messages` table. Threaded into AssistantMessageRow so
   *  each `agent` toolCall card embeds its sub-agent's messages
   *  inline (no separate NodeSection break). Optional: only the
   *  parent flow needs it; nested toolCall cards inside an embedded
   *  sub-agent transcript don't (sub-agents can't spawn sub-agents). */
  subagentMessagesById?: ReadonlyMap<string, RunMessageRow[]>;
  isLive: boolean;
}

function MessageRow({ row, toolResultsById, subagentMessagesById, isLive }: MessageRowProps): JSX.Element | null {
  const msg = row.content;
  const testid = `message-${row.ordinal}`;
  if (msg.role === "system") return <SystemPromptRow content={msg.content} testid={testid} />;
  if (msg.role === "user") return <UserMessageRow message={msg} testid={testid} />;
  if (msg.role === "assistant") {
    return (
      <AssistantMessageRow
        message={msg}
        toolResultsById={toolResultsById}
        subagentMessagesById={subagentMessagesById}
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
  subagentMessagesById?: ReadonlyMap<string, RunMessageRow[]>;
  ordinal: number;
  isLive: boolean;
  testid: string;
}

function AssistantMessageRow({
  message,
  toolResultsById,
  subagentMessagesById,
  ordinal,
  isLive,
  testid,
}: AssistantRowProps): JSX.Element | null {
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
      const extRenderer = extensionRenderers.get(chunk.name);
      // Embedded sub-agent transcript: when this is an `agent`
      // toolCall, look up the sub-agent's messages by subagent_id
      // (carried on the matching toolResult's
      // `details.data.subagent_id`) and render them inside the Tool
      // card. Keeps the parent's NodeSection unbroken — no
      // interleaving with the sub-agent's transcript as a sibling
      // section. The recursive render passes no `subagentMessagesById`
      // so any nested toolCall doesn't try to recurse (sub-agents
      // can't spawn sub-agents).
      let embeddedSubagent: ReactNode = null;
      let agentLabel: string | undefined;
      if (chunk.name === "agent") {
        const description =
          typeof (chunk.arguments as { description?: unknown } | undefined)?.description === "string"
            ? ((chunk.arguments as { description?: unknown }).description as string)
            : undefined;
        if (subagentMessagesById && result) {
          const details = (result as { details?: { data?: { subagent_id?: unknown } } }).details;
          const sid = typeof details?.data?.subagent_id === "string" ? details.data.subagent_id : undefined;
          const subagentRows = sid ? subagentMessagesById.get(sid) : undefined;
          if (subagentRows && subagentRows.length > 0) {
            embeddedSubagent = (
              <div className="flex flex-col gap-2" data-testid={`subagent-transcript-${sid}`}>
                {subagentRows.map((row) => (
                  <MessageRow key={`sub-${row.ordinal}`} row={row} toolResultsById={toolResultsById} isLive={isLive} />
                ))}
              </div>
            );
          }
        }
        agentLabel = description ? `Agent · ${description}` : "Agent";
      }
      blocks.push(
        <Tool key={`${ordinal}-c${i}`} data-testid={`tool-${chunk.id}`} className="mb-0">
          <ToolHeader
            type={toolTypeFromName(chunk.name)}
            state={result ? (result.isError ? "output-error" : "output-available") : "input-available"}
            title={chunk.name}
            {...(agentLabel ? { labelOverride: agentLabel } : {})}
            {...(extRenderer?.icon ? { iconOverride: extRenderer.icon } : {})}
          />
          <ToolContent>
            <ToolInput input={chunk.arguments} />
            {embeddedSubagent}
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
  swarm_tool?: string;
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
  // Extension-paired *.web.tsx renderer takes precedence over the
  // hardcoded built-in branches below. The renderer's `content` slots
  // into <ToolContent> here (isCustom=false). isCustom=true is not
  // handled at this level — the calling site would need to bypass
  // <Tool> entirely; deferred until a real tool needs it.
  const extRenderer = extensionRenderers.get(toolName);
  if (extRenderer?.render) {
    const isStreaming = !result;
    const rendered = extRenderer.render(params, result, { isStreaming, isPartial: false });
    return <div className="space-y-[var(--sw-space-3)]">{rendered.content}</div>;
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
