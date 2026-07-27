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
//   - `conversation-messages-error` — messages fetch failed, nothing to show
//   - `conversation-messages-error-inline` — fetch failed but stale rows render

import type { AssistantMessage, TextContent, ToolNodeMessage, ToolResultMessage } from "@fragua/types";
import { Fragment, type ReactNode, useMemo, useState } from "react";
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
import { HitlDecisionBanner } from "@/components/run-conversation/HitlDecisionBanner";
import { HitlStepCard } from "@/components/run-conversation/HitlStepCard";
import { RouteToolResult } from "@/components/run-conversation/RouteToolResult";
import { SkillToolResult } from "@/components/run-conversation/SkillToolResult";
import { WebFetchResult } from "@/components/run-conversation/WebFetchResult";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { EmptyState } from "@/components/ui/empty-state";
import type { NodeState, RunDetail, RunMessageRow } from "@/lib/api";
import { type FanoutTopology, fanoutTopology } from "@/lib/fanout-topology";
import { type StreamingBlock, type StreamingMessage, type ToolStream, UNSCOPED_NODE } from "@/lib/useRunLive";
import { cn } from "@/lib/utils";

export interface RunConversationProps {
  messages: RunMessageRow[];
  /** In-flight assistant buffers from `useRunLive`, keyed by nodeId.
   * Each node section (and each fan-out branch) renders its OWN buffer at
   * its tail — concurrent `type: parallel` branches stream at once, so a
   * single shared buffer would clobber/interleave them. */
  streamingByNode?: ReadonlyMap<string, StreamingMessage>;
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
  /** The most recent messages fetch failed (`useRunLive.messagesError`).
   * With no rows to show this renders the standard error EmptyState;
   * with stale rows it renders them plus an inline failure note — a
   * fetch error must never wipe or blank the transcript. */
  messagesError?: boolean;
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
    /** Sparse route-name → button-text overrides (workflow edge `label=`).
     * Routes absent here fall back to `humanizeRouteName`. */
    optionLabels?: Record<string, string>;
  } | null;
  /** Per-node record of the route (+ optional note) the operator chose at
   * each answered human gate. Rendered as a "Responded" banner in the
   * owning node section. Derived from the event log, so it persists across
   * reload and is visible to any observer — not just the operator who
   * answered. The currently-open gate (`hitl.nodeId`) is suppressed: its
   * card takes precedence until the answer lands. */
  hitlDecisions?: Record<string, { route: string; note?: string }> | null;
  /** Server-derived fan-out topology records (`RunDetail.fanout`). Drives
   * branch grouping under each `type: parallel` parent, and identifies
   * tool-type nodes so we can render an empty Terminal placeholder while
   * a tool node is running but hasn't emitted any `tool.output_chunk`
   * yet — without this, a tool node that sits silently for minutes shows
   * as an empty conversation. */
  fanout?: RunDetail["fanout"];
  className?: string;
}

const EMPTY_STREAMING: ReadonlyMap<string, StreamingMessage> = new Map();

export function RunConversation({
  messages,
  streamingByNode = EMPTY_STREAMING,
  nodeStates,
  isLive = false,
  isPaused = false,
  isLoading = false,
  messagesError = false,
  userInput,
  toolStreams,
  hitl = null,
  hitlDecisions = null,
  fanout: fanoutRecords,
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

  // Fan-out topology: branch nodeId → its `type: parallel` parent, plus
  // each branch's declared order. Drives collapsing concurrent branches
  // under one parent group instead of N interleaved sections.
  const fanout = useMemo(() => fanoutTopology(fanoutRecords), [fanoutRecords]);

  // Group contiguous rows by nodeId. A fresh section opens whenever
  // the nodeId changes from the previous row. `null` / missing nodeIds
  // collapse into a single "(unscoped)" section — shouldn't happen
  // for agent-emitted messages but we guard defensively.
  const sections = useMemo(() => groupByNode(messages), [messages]);
  const visibleSections = useMemo(
    () => sections.filter((s) => s.rows.some((r) => r.content.role !== "toolResult")),
    [sections],
  );

  // nodeIds with a live in-flight buffer (real nodeId only; the unscoped
  // sentinel surfaces as a null-keyed buffer handled at the tail).
  const streamingNodeIds = useMemo(() => {
    const s = new Set<string>();
    for (const buf of streamingByNode.values()) if (buf.nodeId != null) s.add(buf.nodeId);
    return s;
  }, [streamingByNode]);
  // Membership-stable view of the streaming node ids: `streamingByNode` is a
  // fresh Map on every SSE delta, but WHICH nodes are streaming only changes
  // on message_start/message_end. Funnelling through a primitive string key
  // gives downstream memos (branch grouping) a dep that holds per token.
  const streamingNodeKey = useMemo(() => [...streamingNodeIds].sort().join("\n"), [streamingNodeIds]);
  const streamingNodeIdList = useMemo<readonly string[]>(
    () => (streamingNodeKey.length === 0 ? [] : streamingNodeKey.split("\n")),
    [streamingNodeKey],
  );
  const hasSectionFor = useMemo(() => {
    const s = new Set<string | null>();
    for (const sec of visibleSections) s.add(sec.nodeId);
    return s;
  }, [visibleSections]);

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

  // Set of every tool-type nodeId in the workflow, from the already-parsed
  // fan-out topology. Used to render an empty Terminal placeholder when a
  // tool node is running but hasn't emitted any output yet — without this,
  // a long-silent tool node shows as an empty conversation.
  const toolNodeIds = useMemo<ReadonlySet<string>>(() => {
    const out = new Set<string>();
    for (const [id, type] of fanout.nodeTypes) {
      if (type === "tool") out.add(id);
    }
    return out;
  }, [fanout.nodeTypes]);

  // Tool nodes that are running but have no other representation yet:
  // no persisted message, no live `tool.output_chunk` accumulator, no
  // streaming buffer. We surface them so the operator can see the run
  // is making progress instead of staring at an empty conversation.
  const placeholderToolNodes = useMemo<string[]>(() => {
    if (toolNodeIds.size === 0 || !nodeStates || nodeStates.length === 0) return [];
    const liveStreamIds = new Set<string>();
    if (toolStreams) {
      for (const id of toolStreams.keys()) liveStreamIds.add(id);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const n of nodeStates) {
      if (n.state !== "running") continue;
      if (!toolNodeIds.has(n.nodeId)) continue;
      if (persistedToolNodeIds.has(n.nodeId)) continue;
      if (liveStreamIds.has(n.nodeId)) continue;
      if (streamingNodeIds.has(n.nodeId)) continue;
      if (seen.has(n.nodeId)) continue;
      seen.add(n.nodeId);
      out.push(n.nodeId);
    }
    return out;
  }, [toolNodeIds, nodeStates, toolStreams, streamingNodeIds, persistedToolNodeIds]);

  // Decided human gates with no message rows of their own (the common
  // case — human nodes emit none) render as standalone banner sections.
  // Slot them into node-EXECUTION order so a mid-flow signoff appears
  // between the nodes it ran between, not dumped at the tail (which also
  // stole the conversation's auto-scroll from a still-streaming node).
  // `before` = decisions that precede the first visible section;
  // `after.get(i)` = decisions rendered right after visible section `i`.
  const decisionBuckets = useMemo(() => {
    const before: DecisionEntry[] = [];
    const after = new Map<number, DecisionEntry[]>();
    if (!hitlDecisions) return { before, after };
    // Key nodes by their first-seen lastEventSeq so ordering reflects
    // temporal execution, not the alphabetical sort deriveNodeStates uses.
    const order = new Map<string, number>();
    for (const n of nodeStates ?? []) {
      const prev = order.get(n.nodeId);
      if (prev === undefined || n.lastEventSeq < prev) order.set(n.nodeId, n.lastEventSeq);
    }
    const sectionOrder = visibleSections.map((s) =>
      s.nodeId != null ? (order.get(s.nodeId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY,
    );
    for (const [nodeId, decision] of Object.entries(hitlDecisions)) {
      // The open gate shows its card, not a banner; nodes that have their
      // own message section render the banner in-section.
      if (nodeId === hitl?.nodeId) continue;
      if (visibleSections.some((s) => s.nodeId === nodeId)) continue;
      const oi = order.get(nodeId) ?? Number.POSITIVE_INFINITY;
      let k = -1;
      for (let i = 0; i < sectionOrder.length; i++) {
        if (sectionOrder[i]! <= oi) k = i;
      }
      if (k === -1) before.push({ nodeId, decision });
      else (after.get(k) ?? after.set(k, []).get(k)!).push({ nodeId, decision });
    }
    return { before, after };
  }, [hitlDecisions, nodeStates, visibleSections, hitl?.nodeId]);

  const hasDecisions = decisionBuckets.before.length > 0 || decisionBuckets.after.size > 0;
  const sectionChrome = { stateByNodeId, isLive, isPaused };

  // Collapse runs of consecutive fan-out branch sections (all branches of
  // one `type: parallel` parent run between its fanout_started/joined, so
  // their sections are contiguous) into a single parallel group. Normal
  // sections pass through unchanged, carrying their original visibleSections
  // index so decision slotting still lines up.
  const renderItems = useMemo<RenderItem[]>(
    () => buildRenderItems(visibleSections, fanout.parentOf),
    [visibleSections, fanout.parentOf],
  );

  // Parents whose branches are streaming but produced no rows yet (fan-out
  // just dispatched) — synthesize a group so they don't read as "nothing
  // happening". Parents already rendered above are excluded.
  const renderedParents = useMemo(() => {
    const s = new Set<string>();
    for (const it of renderItems) if (it.kind === "parallel") s.add(it.parentId);
    return s;
  }, [renderItems]);
  const streamingOnlyParents = useMemo(() => {
    const parents: string[] = [];
    for (const nid of streamingNodeIdList) {
      const parent = fanout.parentOf.get(nid);
      if (parent === undefined || renderedParents.has(parent) || parents.includes(parent)) continue;
      parents.push(parent);
    }
    return parents;
  }, [streamingNodeIdList, fanout.parentOf, renderedParents]);

  // branchEntries re-walks every branch section's rows and re-sorts; called
  // bare in the render map it re-ran per SSE delta for EVERY parallel group.
  // Keyed on the membership-stable id list instead of the per-token Map, the
  // regroup only happens when rows land or a stream starts/ends.
  const parallelBranches = useMemo(() => {
    const map = new Map<string, BranchEntry[]>();
    for (const item of renderItems) {
      if (item.kind !== "parallel") continue;
      map.set(
        `${item.parentId}-${item.indices[0]}`,
        branchEntries(item.sections, item.parentId, fanout, streamingNodeIdList),
      );
    }
    return map;
  }, [renderItems, fanout, streamingNodeIdList]);
  const liveOnlyBranches = useMemo(() => {
    const map = new Map<string, BranchEntry[]>();
    for (const parentId of streamingOnlyParents) {
      map.set(parentId, branchEntries([], parentId, fanout, streamingNodeIdList));
    }
    return map;
  }, [streamingOnlyParents, fanout, streamingNodeIdList]);

  const noContent =
    !userInput &&
    visibleSections.length === 0 &&
    streamingByNode.size === 0 &&
    liveToolNodes.length === 0 &&
    placeholderToolNodes.length === 0 &&
    hitl == null &&
    !hasDecisions;
  // The fetch-failed state isn't gated on `isLoading` — the messages
  // request already settled (in failure); waiting on the SSE handshake
  // would leave the pane blank exactly when it must explain itself.
  const empty = noContent && (messagesError || !isLoading);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <Conversation className="flex-1">
        {empty ? (
          <ConversationContent>
            {messagesError ? (
              <EmptyState
                data-testid="conversation-messages-error"
                title="Couldn't load the conversation"
                description="The messages request failed. It retries automatically as new events arrive — or reload the page."
              />
            ) : (
              <ConversationEmptyState
                data-testid="conversation-empty"
                title="No conversation yet"
                description="The agent hasn't produced any messages for this run."
              />
            )}
          </ConversationContent>
        ) : (
          <ConversationContent>
            {messagesError && (
              // biome-ignore lint/a11y/useSemanticElements: <output> is form-oriented; role="status" is the established live-region pattern (same rationale as EmptyState).
              <div
                data-testid="conversation-messages-error-inline"
                role="status"
                className="flex items-center gap-2 rounded-sw-card border border-sw-border bg-sw-surface px-3 py-2 text-sw-xs text-sw-muted"
              >
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-sw-accent-warn" />
                <span>Couldn't refresh the conversation — showing the last loaded messages.</span>
              </div>
            )}
            {userInput && <UserPromptMessage text={userInput} />}
            {decisionBuckets.before.map((d) => (
              <DecisionSection key={`decision-${d.nodeId}`} entry={d} {...sectionChrome} />
            ))}
            {renderItems.map((item) => {
              if (item.kind === "parallel") {
                return (
                  <Fragment key={`parallel-${item.parentId}-${item.indices[0]}`}>
                    <ParallelGroupSection
                      parentId={item.parentId}
                      branches={parallelBranches.get(`${item.parentId}-${item.indices[0]}`) ?? []}
                      toolResultsById={toolResultsById}
                      streamingByNode={streamingByNode}
                      stateByNodeId={stateByNodeId}
                      isLive={isLive}
                      isPaused={isPaused}
                    />
                    {item.indices.flatMap((i) =>
                      (decisionBuckets.after.get(i) ?? []).map((d) => (
                        <DecisionSection key={`decision-${d.nodeId}`} entry={d} {...sectionChrome} />
                      )),
                    )}
                  </Fragment>
                );
              }
              const { section, index: i } = item;
              const nodeState = section.nodeId ? stateByNodeId.get(section.nodeId) : undefined;
              const nodeStream = streamingByNode.get(section.nodeId ?? UNSCOPED_NODE);
              const showHitlHere = hitl != null && section.nodeId === hitl.nodeId;
              // The open gate's card takes precedence over its own past
              // decision (loop re-entry); suppress the banner there.
              const decision = !showHitlHere && section.nodeId != null ? hitlDecisions?.[section.nodeId] : undefined;
              return (
                <Fragment key={section.key}>
                  <NodeSection nodeId={section.nodeId} state={nodeState} isLive={isLive} isPaused={isPaused}>
                    {section.rows.map((row) => (
                      <MessageRow key={messageKey(row)} row={row} toolResultsById={toolResultsById} />
                    ))}
                    {nodeStream && <StreamingMessageRow streaming={nodeStream} />}
                    {showHitlHere && (
                      <HitlStepCard
                        runId={hitl.runId}
                        label={hitl.label}
                        options={hitl.options}
                        optionLabels={hitl.optionLabels}
                      />
                    )}
                    {decision && <HitlDecisionBanner route={decision.route} note={decision.note} />}
                  </NodeSection>
                  {decisionBuckets.after.get(i)?.map((d) => (
                    <DecisionSection key={`decision-${d.nodeId}`} entry={d} {...sectionChrome} />
                  ))}
                </Fragment>
              );
            })}
            {/* Streaming buffers for nodes with no section yet: a fresh fan-out
                whose branches are mid-first-token (grouped under the parent), or
                a lone non-branch node streaming before its first persisted row. */}
            {streamingOnlyParents.map((parentId) => (
              <ParallelGroupSection
                key={`parallel-live-${parentId}`}
                parentId={parentId}
                branches={liveOnlyBranches.get(parentId) ?? []}
                toolResultsById={toolResultsById}
                streamingByNode={streamingByNode}
                stateByNodeId={stateByNodeId}
                isLive={isLive}
                isPaused={isPaused}
              />
            ))}
            {[...streamingByNode.values()]
              .filter((buf) => {
                const nid = buf.nodeId;
                if (nid == null) return !hasSectionFor.has(null);
                return !hasSectionFor.has(nid) && !fanout.parentOf.has(nid);
              })
              .map((buf) => (
                <NodeSection
                  key={`orphan-stream-${buf.nodeId ?? "unscoped"}`}
                  nodeId={buf.nodeId}
                  state={buf.nodeId ? stateByNodeId.get(buf.nodeId) : undefined}
                  isLive={isLive}
                  isPaused={isPaused}
                >
                  <StreamingMessageRow streaming={buf} />
                </NodeSection>
              ))}
            {hitl != null && !visibleSections.some((s) => s.nodeId === hitl.nodeId) && (
              <NodeSection
                nodeId={hitl.nodeId}
                state={stateByNodeId.get(hitl.nodeId)}
                isLive={isLive}
                isPaused={isPaused}
              >
                <HitlStepCard
                  runId={hitl.runId}
                  label={hitl.label}
                  options={hitl.options}
                  optionLabels={hitl.optionLabels}
                />
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
            {placeholderToolNodes.map((nodeId) => (
              <NodeSection
                key={`tool-pending-${nodeId}`}
                nodeId={nodeId}
                state={stateByNodeId.get(nodeId)}
                isLive={isLive}
                isPaused={isPaused}
              >
                <ToolNodePendingRow testid={`tool-pending-${nodeId}`} />
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

interface DecisionEntry {
  nodeId: string;
  decision: { route: string; note?: string };
}

/** A decided human gate that has no message rows of its own — rendered as
 * a standalone "Responded" banner section, slotted into execution order by
 * the caller. */
function DecisionSection({
  entry,
  stateByNodeId,
  isLive,
  isPaused,
}: {
  entry: DecisionEntry;
  stateByNodeId: Map<string, NodeState>;
  isLive: boolean;
  isPaused: boolean;
}): JSX.Element {
  return (
    <NodeSection nodeId={entry.nodeId} state={stateByNodeId.get(entry.nodeId)} isLive={isLive} isPaused={isPaused}>
      <HitlDecisionBanner route={entry.decision.route} note={entry.decision.note} />
    </NodeSection>
  );
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

// ─── Fan-out branch grouping ────────────────────────────────────────

type Fanout = FanoutTopology;

type RenderItem =
  | { kind: "node"; section: Section; index: number }
  | { kind: "parallel"; parentId: string; sections: Section[]; indices: number[] };

/** Collapse each contiguous run of fan-out branch sections (same parent)
 * into one `parallel` render item. Non-branch sections pass through,
 * carrying their original `visibleSections` index so decision slotting
 * (keyed by that index) still aligns. */
function buildRenderItems(visibleSections: Section[], parentOf: ReadonlyMap<string, string>): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < visibleSections.length) {
    const sec = visibleSections[i]!;
    const parent = sec.nodeId != null ? parentOf.get(sec.nodeId) : undefined;
    if (parent === undefined) {
      items.push({ kind: "node", section: sec, index: i });
      i += 1;
      continue;
    }
    const sections: Section[] = [];
    const indices: number[] = [];
    let j = i;
    while (j < visibleSections.length) {
      const s = visibleSections[j]!;
      if (s.nodeId != null && parentOf.get(s.nodeId) === parent) {
        sections.push(s);
        indices.push(j);
        j += 1;
      } else break;
    }
    items.push({ kind: "parallel", parentId: parent, sections, indices });
    i = j;
  }
  return items;
}

/** One member node (e.g. a `scan` or a `verify`) within a branch. */
interface BranchNode {
  nodeId: string;
  rows: RunMessageRow[];
}

/** One fan-out BRANCH = its `scan → verify → …` member nodes, rendered as a
 * mini-conversation in a single collapsible. */
interface BranchEntry {
  /** The branch entry (lens) id — its collapsible header + sort key. */
  branchId: string;
  nodes: BranchNode[];
}

/** Group a parallel group's interleaved sections into one entry PER BRANCH
 * (a branch's scan + verify steps share a `branchOf`), each carrying its
 * member nodes' rows in first-seen (scan → verify) order. Includes nodes that
 * are streaming but have no persisted rows yet; orders branches by the parent's
 * declared `branches:` order. */
function branchEntries(
  sections: Section[],
  parentId: string,
  fanout: Fanout,
  streamingNodeIds: readonly string[],
): BranchEntry[] {
  const rowsByNode = new Map<string, RunMessageRow[]>();
  const nodeOrder: string[] = [];
  const note = (nid: string): RunMessageRow[] => {
    let rows = rowsByNode.get(nid);
    if (rows === undefined) {
      rows = [];
      rowsByNode.set(nid, rows);
      nodeOrder.push(nid);
    }
    return rows;
  };
  for (const s of sections) {
    if (s.nodeId == null) continue;
    note(s.nodeId).push(...s.rows);
  }
  for (const nid of streamingNodeIds) {
    if (fanout.parentOf.get(nid) === parentId) note(nid);
  }
  const byBranch = new Map<string, BranchNode[]>();
  for (const nid of nodeOrder) {
    const branch = fanout.branchOf.get(nid) ?? nid;
    const members = byBranch.get(branch) ?? [];
    members.push({ nodeId: nid, rows: rowsByNode.get(nid) ?? [] });
    byBranch.set(branch, members);
  }
  return [...byBranch.entries()]
    .map(([branchId, nodes]) => ({ branchId, nodes }))
    .sort((a, b) => (fanout.orderOf.get(a.branchId) ?? 0) - (fanout.orderOf.get(b.branchId) ?? 0));
}

/** A `type: parallel` fan-out group: a parent header over a stack of
 * per-branch collapsibles, each collapsed by default so the K concurrent
 * branch transcripts don't interleave into one wall of text. Expanding a
 * branch reveals its messages (+ live streaming buffer). */
function ParallelGroupSection({
  parentId,
  branches,
  toolResultsById,
  streamingByNode,
  stateByNodeId,
  isLive,
  isPaused,
}: {
  parentId: string;
  branches: BranchEntry[];
  toolResultsById: Map<string, ToolResultMessage>;
  streamingByNode: ReadonlyMap<string, StreamingMessage>;
  stateByNodeId: Map<string, NodeState>;
  isLive: boolean;
  isPaused: boolean;
}): JSX.Element {
  const branchStatusOf = (b: BranchEntry): NodeState["state"] | "idle" =>
    aggregateState(b.nodes.map((n) => stateByNodeId.get(n.nodeId)?.state));
  const groupStatus = aggregateState(branches.map(branchStatusOf));
  return (
    <section
      id={`node-${parentId}`}
      data-testid={`parallel-section-${parentId}`}
      className="relative flex flex-col gap-3"
    >
      <header className="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-sw-bg/95 px-1 py-1 backdrop-blur-sm">
        <StatusDot status={groupStatus} isLive={isLive} isPaused={isPaused} />
        <span
          className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-sw-text/80"
          title={parentId}
        >
          {parentId}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-sw-accent-thinking">
          parallel · {branches.length} branches
        </span>
        <div className="ml-2 h-px flex-1 bg-sw-border" aria-hidden />
      </header>
      <div className="flex flex-col gap-2 pl-4">
        {branches.map((b) => (
          <BranchCollapsible
            key={b.branchId}
            entry={b}
            stateByNodeId={stateByNodeId}
            streamingByNode={streamingByNode}
            toolResultsById={toolResultsById}
            isLive={isLive}
            isPaused={isPaused}
          />
        ))}
      </div>
    </section>
  );
}

/** Roll a set of member-node states into one branch/group state: running if any
 * is running, else failed if any failed, else completed if all completed. */
function aggregateState(states: (NodeState["state"] | "idle" | undefined)[]): NodeState["state"] | "idle" {
  if (states.some((s) => s === "running")) return "running";
  if (states.some((s) => s === "failed")) return "failed";
  if (states.length > 0 && states.every((s) => s === "completed")) return "completed";
  return "idle";
}

/** One fan-out BRANCH, collapsed by default. The header carries the branch id
 * + rolled-up status; expanding reveals a mini-conversation — each member node
 * (`scan`, `verify`, …) as its own node section with transcript + live stream. */
function BranchCollapsible({
  entry,
  stateByNodeId,
  streamingByNode,
  toolResultsById,
  isLive,
  isPaused,
}: {
  entry: BranchEntry;
  stateByNodeId: Map<string, NodeState>;
  streamingByNode: ReadonlyMap<string, StreamingMessage>;
  toolResultsById: Map<string, ToolResultMessage>;
  isLive: boolean;
  isPaused: boolean;
}): JSX.Element {
  const status = aggregateState(entry.nodes.map((n) => stateByNodeId.get(n.nodeId)?.state));
  const totalRows = entry.nodes.reduce(
    (sum, n) => sum + n.rows.filter((r) => r.content.role !== "toolResult").length,
    0,
  );
  return (
    <Collapsible
      data-testid={`branch-${entry.branchId}`}
      className="group/branch rounded-md border border-sw-border bg-sw-surface/40"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-sw-surface/60">
        <StatusDot status={status} isLive={isLive} isPaused={isPaused} />
        <span className="font-mono text-[11px] font-semibold tracking-[0.04em] text-sw-text/90" title={entry.branchId}>
          {entry.branchId}
        </span>
        {entry.nodes.length > 1 && (
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-sw-muted">
            {entry.nodes.length} steps
          </span>
        )}
        <AnimatedNumber value={totalRows} className="ml-auto font-mono text-[10px] text-sw-muted tabular-nums" />
        <span className="font-mono text-[10px] opacity-60 transition group-data-[state=open]/branch:rotate-180">▾</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 border-t border-sw-border px-3 py-3 pl-3">
        {entry.nodes.map((m) => {
          const nodeStream = streamingByNode.get(m.nodeId);
          return (
            <NodeSection
              key={m.nodeId}
              nodeId={m.nodeId}
              state={stateByNodeId.get(m.nodeId)}
              isLive={isLive}
              isPaused={isPaused}
              staticHeader
            >
              {m.rows.map((row) => (
                <MessageRow key={messageKey(row)} row={row} toolResultsById={toolResultsById} />
              ))}
              {nodeStream && <StreamingMessageRow streaming={nodeStream} />}
            </NodeSection>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

interface NodeSectionProps {
  nodeId: string | null;
  state?: NodeState;
  isLive: boolean;
  isPaused: boolean;
  children: ReactNode;
  /** Render the header static (not sticky). Used for member-node sections
   * nested inside a fan-out branch collapsible — a sticky header inside the
   * scroll container would pin and overlap as you scroll the branch. */
  staticHeader?: boolean;
}

function NodeSection({
  nodeId,
  state,
  isLive,
  isPaused,
  children,
  staticHeader = false,
}: NodeSectionProps): JSX.Element {
  const label = nodeId ?? "unscoped";
  const status: NodeState["state"] | "idle" = state?.state ?? "idle";
  return (
    <section
      id={nodeId ? `node-${nodeId}` : undefined}
      data-testid={nodeId ? `node-section-${nodeId}` : "node-section-unscoped"}
      className="relative flex flex-col gap-3"
    >
      <header
        className={cn(
          "z-10 -mx-1 flex items-center gap-2 bg-sw-bg/95 px-1 py-1 backdrop-blur-sm",
          !staticHeader && "sticky top-0",
        )}
      >
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

/** Pre-output placeholder for a tool node that has been dispatched but
 * hasn't emitted any `tool.output_chunk` yet. A bash step waiting on an
 * HTTP call or a subprocess startup may sit silent for minutes; without
 * this card the conversation reads as "nothing happening" even though
 * the run is making progress. Identical Terminal shell to
 * `ToolNodeStreamingRow` so the live stream slots in seamlessly once
 * chunks start arriving. */
function ToolNodePendingRow({ testid }: { testid: string }): JSX.Element {
  return (
    <div data-testid={testid} className="flex flex-col gap-2">
      <Terminal status="running" tone="thinking" output="" isStreaming />
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
      // reason text is the primary diagnostic — and `emit_output` carries
      // the node's structured output: both open by default so the operator
      // sees the payload without an extra click.
      const defaultOpen = chunk.name === "abort" || chunk.name === "emit_output";
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
  // (URL pill, cache/redirect/error variants). Mirrors the bash/edit
  // branches below.
  if (toolName === "web_fetch") {
    return <WebFetchResult params={params as { url?: string } | undefined} result={result} isStreaming={!result} />;
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
  // emit_output: the node's structured output. The value IS the tool input
  // (rendered by ToolInput above); the result is a fixed "emit_output called"
  // acknowledgement carrying no information — suppress it.
  if (toolName === "emit_output") return null;
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
