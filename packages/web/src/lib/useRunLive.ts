// useRunLive — data hook for the run conversation view.
//
// Fetches the run's messages table (AgentMessage JSON per row, §I9)
// and keeps it live via SSE. On `agent.message_end` /
// `fact.message_appended` frames, triggers an incremental re-fetch
// (`?sinceOrdinal=<last>`) and appends.
//
// Mid-message streaming: a lightweight buffer captures
// `llm.text_delta` / `llm.thinking_delta` / `llm.toolcall_delta`
// frames between `agent.message_start` and `agent.message_end` so the
// UI renders assistant output as it streams.
//
// Side channels:
//   - `totalEvents` — monotonic counter, cheap invalidation trigger.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRunEventsUrl, getRunMessages, type RunMessageRow } from "./api.ts";
import { type DetailOverlay, EMPTY_DETAIL_OVERLAY, foldDetailFrame, isDetailEvent } from "./useDetailOverlay.ts";
import { useEventSource } from "./useEventSource.ts";
import {
  aggregateLiveFrames,
  type CostAggregate,
  frameFromPayload,
  type LiveCostFrame,
} from "./useLiveCostAggregate.ts";

export type RunLiveStatus = "idle" | "loading" | "live" | "closed" | "error";

/** A streaming-in-flight assistant message, buffered from SSE deltas
 * between `agent.message_start` and `agent.message_end`. Cleared when
 * the persisted row arrives via refetch. Blocks appear in the order
 * pi-agent-core streams them (by `content_index`). */
export interface StreamingMessage {
  nodeId: string | null;
  blocks: StreamingBlock[];
}

export type StreamingBlock =
  | { type: "text"; index: number; text: string }
  | { type: "thinking"; index: number; text: string }
  | { type: "toolCall"; index: number; argsText: string };

/** Live stdout/stderr from a tool (parallelogram) node, accumulated
 * from `tool.output_chunk` events. Cleared when the persisted
 * `tool_node` message lands for the same node — the message row is
 * the source of truth once it arrives. Keyed by nodeId so concurrent
 * tool nodes (parallel branches) each get their own buffer. */
export interface ToolStream {
  stdout: string;
  stderr: string;
}

export interface UseRunLiveResult {
  /** All persisted messages for the run, ordered by ordinal. */
  messages: RunMessageRow[];
  /** In-flight assistant message being streamed, or `null` when the
   * agent is idle or between turns. */
  streaming: StreamingMessage | null;
  /** Per-nodeId in-flight tool output. Empty entries are pruned. */
  toolStreams: ReadonlyMap<string, ToolStream>;
  /** Connection status across bootstrap + stream. */
  status: RunLiveStatus;
  /** Monotonic counter bumped on every SSE frame. Cheap invalidation
   * trigger for queries keyed on it (e.g. CostInspector's `/steps`
   * refresh). Detail-level state is folded into `detailOverlay` and
   * doesn't need this. */
  totalEvents: number;
  /** Running cost/token aggregate over `cost.recorded` SSE frames whose
   * seq exceeds `opts.sinceSeq` — the snapshot watermark. Frames the
   * snapshot already accounts for are filtered out automatically when
   * the snapshot advances, so `snapshot.costUsd + liveCost.totalCostUsd`
   * never double-counts. Reset on `runId` change. */
  liveCost: CostAggregate;
  /** Event-driven overlay for the run-detail snapshot — node states,
   * selectedEdges appended since `sinceSeq`, and run-level status.
   * Pairs with `mergeDetail(snapshot, overlay)` to render live state
   * without refetching `/runs/:id` on every SSE frame. Reset on
   * `runId` change. */
  detailOverlay: DetailOverlay;
  /** Live `tool_call_id → subagent_id` map folded from `subagent.start`
   * frames. Lets the conversation renderer link a parent toolCall card
   * to its in-flight sub-agent before the toolResult — which carries
   * the canonical mapping in `details.data.subagent_id` — has landed.
   * Reset on `runId` change. */
  subagentByToolCallId: ReadonlyMap<string, string>;
}

export interface UseRunLiveOptions {
  /** Test injection; defaults to global EventSource. */
  eventSourceImpl?: typeof EventSource;
  /** Skip the historical backlog by telling the server to start
   * replaying after this seq. Pass the snapshot's `lastEventSeq` so the
   * initial connect doesn't flood the browser with thousands of frames
   * the snapshot already accounts for. */
  sinceSeq?: number;
  /** Tri-state terminal flag, derived from the snapshot:
   *   - `true`  — confirmed terminal; no SSE will ever be opened.
   *   - `false` — confirmed live; SSE opens immediately.
   *   - `undefined` — snapshot still loading; defer SSE until we know.
   *
   * The third state matters because without it we'd open an SSE for the
   * 50ms snapshot fetch on every page load — including for terminal
   * runs that never need a stream — and the connection has to close +
   * reopen once the snapshot settles. */
  terminal?: boolean;
}

/** Event types that imply new rows have landed in the messages table.
 * On any of these we re-fetch `?sinceOrdinal=<last>`. */
const MESSAGE_SIGNAL_TYPES = new Set<string>(["agent.message_end", "fact.message_appended", "fact.run_started"]);

export function useRunLive(runId: string | null | undefined, opts: UseRunLiveOptions = {}): UseRunLiveResult {
  const [messages, setMessages] = useState<RunMessageRow[]>([]);
  const [streaming, setStreaming] = useState<StreamingMessage | null>(null);
  const [toolStreams, setToolStreams] = useState<ReadonlyMap<string, ToolStream>>(() => new Map());
  const [totalEvents, setTotalEvents] = useState(0);
  const [liveCostFrames, setLiveCostFrames] = useState<LiveCostFrame[]>([]);
  const [detailOverlay, setDetailOverlay] = useState<DetailOverlay>(EMPTY_DETAIL_OVERLAY);
  const [subagentByToolCallId, setSubagentByToolCallId] = useState<ReadonlyMap<string, string>>(() => new Map());

  // Latest ordinal persisted so incremental fetches don't re-load the world.
  const lastOrdinalRef = useRef(0);
  // Coalesce refetches — a burst of message_end events under 30ms triggers a single fetch.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset state on runId change, then bootstrap-fetch the historical
  // messages backlog. Both are gated on `terminal !== undefined` —
  // see the comment block on the URL gate below for rationale.
  useEffect(() => {
    setMessages([]);
    setStreaming(null);
    setToolStreams(new Map());
    setTotalEvents(0);
    setLiveCostFrames([]);
    setDetailOverlay(EMPTY_DETAIL_OVERLAY);
    setSubagentByToolCallId(new Map());
    lastOrdinalRef.current = 0;

    if (!runId || opts.terminal === undefined) return;

    let cancelled = false;
    getRunMessages(runId, 0)
      .then((rows) => {
        if (cancelled || rows.length === 0) return;
        lastOrdinalRef.current = rows[rows.length - 1]!.ordinal;
        setMessages(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn("[useRunLive] messages fetch failed for", runId, "—", err);
      });
    return () => {
      cancelled = true;
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
    };
  }, [runId, opts.terminal]);

  // SSE subscription. URL is null when:
  //   - runId is missing (no run to watch).
  //   - opts.terminal === undefined: snapshot still loading; opening
  //     an SSE we'd close 50ms later when the snapshot resolves shows
  //     up in the network log as transient connections.
  //   - opts.terminal === true: confirmed terminal; no new frames will
  //     ever arrive, snapshot+messages fetch already loaded everything.
  //
  // `sinceSeq` short-circuits the historical replay: server resumes
  // from sinceSeq+1 instead of seq 0. Without this, opening a 14k-event
  // run lit up the browser with every prior event before any new one
  // could arrive — the `setStreaming` accumulator alone ran tens of
  // thousands of state updates.
  const sseUrl = runId && opts.terminal === false ? getRunEventsUrl(runId, opts.sinceSeq) : null;

  const onFrame = useCallback(
    (ev: MessageEvent): void => {
      if (!runId) return;
      const idNum = ev.lastEventId ? Number.parseInt(ev.lastEventId, 10) : Number.NaN;
      setTotalEvents((n) => n + 1);

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(String(ev.data ?? "")) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(parsed["type"] ?? ev.type);
      const payload = (parsed["payload"] ?? null) as Record<string, unknown> | null;
      const nodeId = typeof payload?.["nodeId"] === "string" ? (payload["nodeId"] as string) : null;

      // Cost frames are tagged with their seq so the consumer can filter
      // out anything the snapshot already accounts for. Drop frames
      // without a parseable seq — production SSE always carries one in
      // the `id:` field, so a missing/NaN seq is a test-fixture bug, not
      // a real-world condition we should silently absorb.
      if (type === "cost.recorded" && payload != null && Number.isFinite(idNum)) {
        setLiveCostFrames((prev) => {
          // Idempotent against reconnect replay: a frame at a seq we
          // already captured is dropped on the spot.
          const last = prev.length > 0 ? prev[prev.length - 1]!.seq : -1;
          if (idNum <= last) return prev;
          return [...prev, frameFromPayload(idNum, payload)];
        });
      }

      // Fold structural events (node/edge/run-status) into the detail
      // overlay so the UI can render live state without refetching the
      // /runs/:id snapshot on every SSE frame. `isDetailEvent` keeps
      // the hot text-delta path out of this code entirely.
      if (isDetailEvent(type) && Number.isFinite(idNum)) {
        setDetailOverlay((prev) => foldDetailFrame(prev, type, payload, idNum));
      }

      // Fold `subagent.start { tool_call_id, subagent_id }` so the
      // conversation renderer can link the parent toolCall card to its
      // running sub-agent before the toolResult lands. The canonical
      // link is on the toolResult's `details.data.subagent_id` (set
      // when the `agent` tool returns); this map is the early-arriving
      // mirror that keeps the embedded transcript visible mid-flight.
      if (type === "subagent.start" && payload != null) {
        const tcid = typeof payload["tool_call_id"] === "string" ? (payload["tool_call_id"] as string) : null;
        const sid = typeof payload["subagent_id"] === "string" ? (payload["subagent_id"] as string) : null;
        if (tcid && sid) {
          setSubagentByToolCallId((prev) => {
            if (prev.get(tcid) === sid) return prev;
            const next = new Map(prev);
            next.set(tcid, sid);
            return next;
          });
        }
      }

      // `subagent.resumed` fires on respawn after a daemon crash. The
      // tool_call_id→subagent_id mapping was already captured by the
      // original (pre-crash) subagent.start in the event log; the
      // resumed event closes the bracket on its own without needing
      // a fresh fold. Acknowledge the type so the SSE frame doesn't
      // accidentally fall through into MESSAGE_SIGNAL_TYPES or the
      // streaming-delta path below.
      if (type === "subagent.resumed") {
        return;
      }

      if (MESSAGE_SIGNAL_TYPES.has(type)) {
        if (refetchTimerRef.current) return;
        const id = runId;
        refetchTimerRef.current = setTimeout(() => {
          refetchTimerRef.current = null;
          const since = lastOrdinalRef.current;
          getRunMessages(id, since)
            .then((rows) => {
              if (rows.length === 0) return;
              lastOrdinalRef.current = rows[rows.length - 1]!.ordinal;
              setMessages((prev) => [...prev, ...rows]);
              // The persisted `tool_node` row is the authoritative
              // Terminal card for that node — drop the live stream
              // buffer so RunConversation swaps over to it without
              // the brief blank gap a node_completed-keyed clear
              // would leave between live and persisted renders.
              const landedToolNodes = rows
                .filter((r) => r.content.role === "tool_node" && typeof r.nodeId === "string")
                .map((r) => r.nodeId as string);
              if (landedToolNodes.length > 0) {
                setToolStreams((prev) => {
                  let changed = false;
                  const next = new Map(prev);
                  for (const id of landedToolNodes) {
                    if (next.delete(id)) changed = true;
                  }
                  return changed ? next : prev;
                });
              }
            })
            .catch((err: unknown) => {
              console.warn("[useRunLive] messages fetch failed for", id, "—", err);
            });
        }, 30);
      }

      // Streaming buffer: open on assistant message_start, accumulate
      // deltas, clear on message_end (the persisted row replaces it).
      if (type === "agent.message_start") {
        if (payload?.["role"] === "assistant") {
          setStreaming({ nodeId, blocks: [] });
        }
        return;
      }
      if (type === "agent.message_end") {
        setStreaming(null);
        return;
      }
      if (type === "llm.text_delta" || type === "llm.thinking_delta" || type === "llm.toolcall_delta") {
        const delta = typeof payload?.["delta"] === "string" ? (payload["delta"] as string) : "";
        const index = typeof payload?.["content_index"] === "number" ? (payload["content_index"] as number) : 0;
        const kind: StreamingBlock["type"] =
          type === "llm.text_delta" ? "text" : type === "llm.thinking_delta" ? "thinking" : "toolCall";
        setStreaming((prev) => applyDelta(prev, nodeId, kind, index, delta));
      }

      // Tool node (parallelogram) output streaming. Each
      // `tool.output_chunk` event carries a slice of stdout or
      // stderr; we accumulate into a per-node buffer so the UI can
      // render a live Terminal until the persisted `tool_node`
      // message replaces it. The live entry is dropped only when
      // its persisted row lands via the messages refetch above —
      // not on `fact.node_completed`, which would leave a blank
      // window before the row arrived.
      if (type === "tool.output_chunk" && nodeId != null) {
        const kind = payload?.["kind"];
        const delta = typeof payload?.["delta"] === "string" ? (payload["delta"] as string) : "";
        if ((kind === "stdout" || kind === "stderr") && delta.length > 0) {
          setToolStreams((prev) => appendToolChunk(prev, nodeId, kind, delta));
        }
      }
    },
    [runId],
  );

  const sseOpts = opts.eventSourceImpl ? { eventSourceImpl: opts.eventSourceImpl } : {};
  const { status: sseStatus } = useEventSource(sseUrl, onFrame, sseOpts);

  // Prune frames the snapshot has absorbed. Keeps the array bounded as
  // `react-query` advances `snapshot.lastEventSeq` past in-flight cost
  // events. Pure cleanup — `aggregateLiveFrames` filters again on render
  // (belt-and-suspenders), so missing this prune doesn't double-count.
  useEffect(() => {
    if (typeof opts.sinceSeq !== "number") return;
    setLiveCostFrames((prev) => {
      const cutoff = opts.sinceSeq!;
      const i = prev.findIndex((f) => f.seq > cutoff);
      if (i < 0) return prev.length === 0 ? prev : [];
      if (i === 0) return prev;
      return prev.slice(i);
    });
  }, [opts.sinceSeq]);

  // Aggregate against the snapshot watermark. Disjoint by construction —
  // snapshot.costUsd covers seq ≤ sinceSeq (server SQL aggregate), this
  // delta covers seq > sinceSeq.
  const liveCost = useMemo<CostAggregate>(
    () => aggregateLiveFrames(liveCostFrames, opts.sinceSeq ?? 0),
    [liveCostFrames, opts.sinceSeq],
  );

  // Project the SSE primitive's status into the RunLiveStatus shape
  // callers consume — `loading` while bootstrap pending, `closed` for
  // terminal runs, otherwise the raw SSE status.
  const status: RunLiveStatus = !runId
    ? "idle"
    : opts.terminal === undefined
      ? "loading"
      : opts.terminal === true
        ? "closed"
        : sseStatus === "open"
          ? "live"
          : sseStatus === "connecting"
            ? "loading"
            : sseStatus;

  return { messages, streaming, toolStreams, status, totalEvents, liveCost, detailOverlay, subagentByToolCallId };
}

/** Append a `tool.output_chunk` slice into the per-node stdout/stderr
 * buffer. Allocates a fresh top-level Map (so React's setState picks
 * up the change) but mutates the inner ToolStream object — the buffer
 * is short-lived and per-node, so in-place string append is fine. */
function appendToolChunk(
  prev: ReadonlyMap<string, ToolStream>,
  nodeId: string,
  kind: "stdout" | "stderr",
  delta: string,
): ReadonlyMap<string, ToolStream> {
  const next = new Map(prev);
  const existing = next.get(nodeId);
  if (existing) {
    if (kind === "stdout") existing.stdout += delta;
    else existing.stderr += delta;
    return next;
  }
  const fresh: ToolStream = { stdout: kind === "stdout" ? delta : "", stderr: kind === "stderr" ? delta : "" };
  next.set(nodeId, fresh);
  return next;
}

/** Delta-fold: place `delta` at `index` within the streaming buffer's
 * block array, creating a block of the right kind on first hit and
 * appending to its text otherwise. A mismatched kind at the same index
 * (e.g. a toolcall delta landing on an existing text block) is treated
 * as a new block — pi-agent-core shouldn't emit that but we don't want
 * to crash if a provider sends odd frames.
 *
 * Hot-path in-place mutation: a long streaming response can fire
 * thousands of `llm.text_delta` frames, all targeting the same content
 * block. The previous fold rebuilt the blocks array on every delta
 * (`map` + `filter` + spread + `sort`), producing O(deltas × blocks)
 * GC pressure for nothing the UI ever observed. Now the matching block's
 * text is appended in place; only a fresh top-level `StreamingMessage`
 * wrapper is allocated, which is what React's `setState` reference-checks
 * to schedule a render. The streaming buffer is short-lived and not
 * shared with anyone — mutating it is safe. */
function applyDelta(
  prev: StreamingMessage | null,
  nodeId: string | null,
  kind: StreamingBlock["type"],
  index: number,
  delta: string,
): StreamingMessage {
  const base: StreamingMessage = prev ?? { nodeId, blocks: [] };
  const existing = base.blocks.find((b) => b.index === index && b.type === kind);
  if (existing) {
    if (existing.type === "toolCall") existing.argsText += delta;
    else existing.text += delta;
    return { nodeId: base.nodeId ?? nodeId, blocks: base.blocks };
  }
  // Cold path: new (index, kind) pair. Allocate, append, keep sorted by
  // index so blocks render in arrival order regardless of how the
  // provider interleaves them. Bounded by content blocks per message
  // (~5-20 typical), not by delta count.
  const fresh: StreamingBlock =
    kind === "toolCall" ? { type: "toolCall", index, argsText: delta } : { type: kind, index, text: delta };
  const blocks = [...base.blocks, fresh].sort((a, b) => a.index - b.index);
  return { nodeId: base.nodeId ?? nodeId, blocks };
}
