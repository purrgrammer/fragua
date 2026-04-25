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

import { ALL_EVENT_TYPES } from "@swarm/types";
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
}

/** Event types that imply new rows have landed in the messages table.
 * On any of these we re-fetch `?sinceOrdinal=<last>`. */
const MESSAGE_SIGNAL_TYPES = new Set<string>(["agent.message_end", "fact.message_appended", "fact.run_started"]);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: eventSourceImpl is a stable test injection; effect keys on runId.
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

    // ── Bootstrap: fetch messages once, open SSE ───────────────
    refetchMessages();

    const Ctor = opts.eventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
    if (!Ctor) {
      setStatus("closed");
      return;
    }

    const es = new Ctor(getRunEventsUrl(runId));
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
        setControlEvents((prev) => [...prev, { type, data: payload }]);
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

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("message", onFrame as EventListener);
    for (const t of ALL_EVENT_TYPES) {
      es.addEventListener(t, onFrame as EventListener);
    }

    return () => {
      cancelled = true;
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
      es.close();
    };
  }, [runId]);

  return { messages, streaming, status, lastSeq, totalEvents, controlEvents, liveCost };
}

/** Pure delta-fold: place `delta` at `index` within the streaming
 * buffer's block array, creating a block of the right kind on first
 * hit and appending to its text otherwise. A mismatched kind at the
 * same index (e.g. a toolcall delta landing on an existing text
 * block) is treated as a new block — pi-agent-core shouldn't emit
 * that but we don't want to crash if a provider sends odd frames. */
function applyDelta(
  prev: StreamingMessage | null,
  nodeId: string | null,
  kind: StreamingBlock["type"],
  index: number,
  delta: string,
): StreamingMessage {
  const base: StreamingMessage = prev ?? { nodeId, blocks: [] };
  const existing = base.blocks.find((b) => b.index === index);
  if (existing && existing.type === kind) {
    const next = base.blocks.map((b) =>
      b === existing
        ? b.type === "toolCall"
          ? { ...b, argsText: b.argsText + delta }
          : { ...b, text: b.text + delta }
        : b,
    );
    return { nodeId: base.nodeId ?? nodeId, blocks: next };
  }
  // New block: insert sorted by index so rendering preserves arrival order
  // even if frames arrive out-of-order within a single message.
  const fresh: StreamingBlock =
    kind === "toolCall" ? { type: "toolCall", index, argsText: delta } : { type: kind, index, text: delta };
  const next = [...base.blocks.filter((b) => b.index !== index || b.type !== kind), fresh].sort(
    (a, b) => a.index - b.index,
  );
  return { nodeId: base.nodeId ?? nodeId, blocks: next };
}
