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
//   - `controlEvents` — filtered slice for `usePendingSteers`.

import { useEffect, useRef, useState } from "react";
import { getRunEventsUrl, getRunMessages, type RunMessageRow } from "./api.ts";
import { type CostAggregate, EMPTY_COST_AGGREGATE, foldCostFrame } from "./useLiveCostAggregate.ts";

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

export interface UseRunLiveResult {
  /** All persisted messages for the run, ordered by ordinal. */
  messages: RunMessageRow[];
  /** In-flight assistant message being streamed, or `null` when the
   * agent is idle or between turns. */
  streaming: StreamingMessage | null;
  /** Connection status across bootstrap + stream. */
  status: RunLiveStatus;
  /** Last SSE sequence id seen. Used by sibling queries to dedupe. */
  lastSeq: number;
  /** Monotonic counter bumped on every SSE frame. Cheap invalidation
   * trigger for queries keyed on it. */
  totalEvents: number;
  /** Filtered slice of control-channel events (steering, control) for
   * `usePendingSteers` reconciliation. */
  controlEvents: ReadonlyArray<{ type: string; data?: Record<string, unknown> | null }>;
  /** Running cost/token aggregate folded from `cost.recorded` SSE frames.
   * O(1) memory — only the running totals are kept, not the underlying
   * events. Reset on `runId` change. Use this for live header tiles;
   * the server snapshot remains the source of truth post-terminal. */
  liveCost: CostAggregate;
}

export interface UseRunLiveOptions {
  /** Test injection; defaults to global EventSource. */
  eventSourceImpl?: typeof EventSource;
  /** Skip the historical backlog by telling the server to start
   * replaying after this seq. Pass the snapshot's `lastEventSeq` so the
   * initial connect doesn't flood the browser with thousands of frames
   * the snapshot already accounts for. */
  sinceSeq?: number;
  /** When true, the run has already reached a terminal status — no new
   * SSE frames will ever arrive. The hook skips opening EventSource
   * entirely, saving a server round-trip + listener overhead per
   * historical run the user opens. */
  terminal?: boolean;
}

/** Event types that imply new rows have landed in the messages table.
 * On any of these we re-fetch `?sinceOrdinal=<last>`. */
const MESSAGE_SIGNAL_TYPES = new Set<string>(["agent.message_end", "fact.message_appended", "fact.run_started"]);

/** Bound on `controlEvents` slice — `usePendingSteers` only ever cares
 * about the most recent reconcile events; an unbounded slice on a
 * long-lived page leaks memory for no UI benefit. */
const MAX_CONTROL_EVENTS = 100;

/** Narrow reconcile predicate — only events `usePendingSteers`
 * matches on. Keeping it tight bounds `controlEvents` to O(steer
 * count) instead of O(run-event count). */
function isControlReconcileEvent(type: string, data: Record<string, unknown> | null): boolean {
  if (type === "steering.injected") return true;
  if (type === "control.requested") return data?.["command"] === "steer";
  return false;
}

export function useRunLive(runId: string | null | undefined, opts: UseRunLiveOptions = {}): UseRunLiveResult {
  const [messages, setMessages] = useState<RunMessageRow[]>([]);
  const [streaming, setStreaming] = useState<StreamingMessage | null>(null);
  const [status, setStatus] = useState<RunLiveStatus>(runId ? "loading" : "idle");
  const [lastSeq, setLastSeq] = useState(0);
  const [totalEvents, setTotalEvents] = useState(0);
  const [controlEvents, setControlEvents] = useState<UseRunLiveResult["controlEvents"]>([]);
  const [liveCost, setLiveCost] = useState<CostAggregate>(EMPTY_COST_AGGREGATE);

  // Latest ordinal persisted so incremental fetches don't re-load the world.
  const lastOrdinalRef = useRef(0);
  // Coalesce refetches — a burst of message_end events under 30ms triggers a single fetch.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: eventSourceImpl is a stable test injection; effect keys on runId + terminal + sinceSeq.
  useEffect(() => {
    setMessages([]);
    setStreaming(null);
    setLastSeq(0);
    setTotalEvents(0);
    setControlEvents([]);
    setLiveCost(EMPTY_COST_AGGREGATE);
    lastOrdinalRef.current = 0;

    if (!runId) {
      setStatus("idle");
      return;
    }

    setStatus("loading");
    let cancelled = false;

    const refetchMessages = (): void => {
      if (cancelled) return;
      const since = lastOrdinalRef.current;
      getRunMessages(runId, since)
        .then((rows) => {
          if (cancelled || rows.length === 0) return;
          lastOrdinalRef.current = rows[rows.length - 1]!.ordinal;
          setMessages((prev) => (since === 0 ? rows : [...prev, ...rows]));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          console.warn("[useRunLive] messages fetch failed for", runId, "—", err);
        });
    };

    const scheduleRefetch = (): void => {
      if (refetchTimerRef.current) return;
      refetchTimerRef.current = setTimeout(() => {
        refetchTimerRef.current = null;
        refetchMessages();
      }, 30);
    };

    // ── Bootstrap: always fetch messages ────────────────────────
    refetchMessages();

    // Skip SSE entirely on terminal runs — no new frames will ever
    // arrive, and the snapshot+messages fetch already loaded everything.
    // Saves ~30 listeners + a server connection per historical run view.
    if (opts.terminal === true) {
      setStatus("closed");
      return () => {
        cancelled = true;
        if (refetchTimerRef.current) {
          clearTimeout(refetchTimerRef.current);
          refetchTimerRef.current = null;
        }
      };
    }

    const Ctor = opts.eventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
    if (!Ctor) {
      setStatus("closed");
      return () => {
        cancelled = true;
        if (refetchTimerRef.current) {
          clearTimeout(refetchTimerRef.current);
          refetchTimerRef.current = null;
        }
      };
    }

    // `sinceSeq` short-circuits the historical replay: the server
    // resumes from sinceSeq+1 instead of seq 0. Without this, opening
    // a 14k-event run lit up the browser with every prior event before
    // any new one could arrive — the `setStreaming` accumulator alone
    // ran tens of thousands of state updates.
    const es = new Ctor(getRunEventsUrl(runId, opts.sinceSeq));
    setStatus("live");

    const onFrame = (ev: MessageEvent): void => {
      const idNum = ev.lastEventId ? Number.parseInt(ev.lastEventId, 10) : Number.NaN;
      if (Number.isFinite(idNum)) {
        setLastSeq(idNum);
      }
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

      if (type === "cost.recorded" && payload != null) {
        setLiveCost((prev) => foldCostFrame(prev, payload));
      }

      if (isControlReconcileEvent(type, payload)) {
        setControlEvents((prev) => {
          const next = [...prev, { type, data: payload }];
          // Cap the slice so a long-lived page doesn't grow this array
          // forever. usePendingSteers only matches recent events.
          return next.length > MAX_CONTROL_EVENTS ? next.slice(-MAX_CONTROL_EVENTS) : next;
        });
      }
      if (MESSAGE_SIGNAL_TYPES.has(type)) {
        scheduleRefetch();
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
    };

    const onOpen = (): void => {
      if (!cancelled) setStatus("live");
    };
    const onError = (): void => {
      if (cancelled) return;
      setStatus(es.readyState === 2 ? "closed" : "error");
    };

    // Single listener — the server emits frames without an `event:`
    // field so they all dispatch as `message`. The frame's actual type
    // lives in the JSON payload (`parsed["type"]`), which `onFrame`
    // reads directly. Previously we registered 45 typed listeners per
    // mount; the closure chain alone added measurable retention.
    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("message", onFrame as EventListener);

    return () => {
      cancelled = true;
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("message", onFrame as EventListener);
      es.close();
    };
  }, [runId, opts.terminal, opts.sinceSeq]);

  return { messages, streaming, status, lastSeq, totalEvents, controlEvents, liveCost };
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
