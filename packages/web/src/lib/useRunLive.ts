// useRunLive — data hook for the run conversation view.
//
// Fetches the run's messages table (AgentMessage JSON per row, §I9)
// and keeps it live by listening to the run's SSE event stream. On
// any `agent.message_end` / `fact.*` / intent frame, triggers an
// incremental re-fetch (`?sinceOrdinal=<last>`) and appends.
//
// The old reducer (`events-to-conversation.ts`, ~700 lines) folded
// every raw event into a derived conversation tree. It scaled poorly
// on long runs and duplicated work pi-agent-core already does. The
// messages endpoint is the persisted transcript — fetch it directly,
// render from it.
//
// Side channels carried by the same SSE subscription:
//   - `totalEvents` — a monotonic counter used as a cheap "something
//     happened" signal to invalidate sibling queries (run detail,
//     EventLog, StepInspector).
//   - `controlEvents` — a filtered slice for `usePendingSteers` to
//     reconcile optimistic steer/cancel/pause queues without keeping
//     the full event stream in React state.

import { ALL_EVENT_TYPES } from "@swarm/types";
import { useEffect, useRef, useState } from "react";
import { getRunEventsUrl, getRunMessages, type RunMessageRow } from "./api.ts";

export type RunLiveStatus = "idle" | "loading" | "live" | "closed" | "error";

export interface UseRunLiveResult {
  /** All messages for the run, ordered by ordinal. */
  messages: RunMessageRow[];
  /** Connection status across bootstrap + stream. */
  status: RunLiveStatus;
  /** Last SSE sequence id seen. Used by sibling queries to dedupe. */
  lastSeq: number;
  /** Monotonic counter bumped on every SSE frame. Cheap invalidation
   * trigger for queries keyed on it. */
  totalEvents: number;
  /** Filtered slice of control-channel events (steering, control) for
   * `usePendingSteers` reconciliation. Small by design — on a run
   * with K steers the array carries ~2K entries. */
  controlEvents: ReadonlyArray<{ type: string; data?: Record<string, unknown> | null }>;
}

export interface UseRunLiveOptions {
  /** Test injection; defaults to global EventSource. */
  eventSourceImpl?: typeof EventSource;
}

/** Event types that imply new rows have landed in the messages table.
 * On any of these we re-fetch `?sinceOrdinal=<last>`. */
const MESSAGE_SIGNAL_TYPES = new Set<string>(["agent.message_end", "fact.message_appended", "fact.run_started"]);

/** Same reconcile predicate as the old hook, kept narrow so
 * `controlEvents` doesn't balloon on long runs. */
function isControlReconcileEvent(type: string, data: Record<string, unknown> | null): boolean {
  if (type === "steering.injected") return true;
  if (type === "control.requested") return data?.["command"] === "steer";
  return false;
}

export function useRunLive(runId: string | null | undefined, opts: UseRunLiveOptions = {}): UseRunLiveResult {
  const [messages, setMessages] = useState<RunMessageRow[]>([]);
  const [status, setStatus] = useState<RunLiveStatus>(runId ? "loading" : "idle");
  const [lastSeq, setLastSeq] = useState(0);
  const [totalEvents, setTotalEvents] = useState(0);
  const [controlEvents, setControlEvents] = useState<UseRunLiveResult["controlEvents"]>([]);

  // Latest ordinal persisted so incremental fetches don't re-load the world.
  const lastOrdinalRef = useRef(0);
  // Coalesce refetches — a burst of message_end events under 30ms triggers a single fetch.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: eventSourceImpl is a stable test injection; effect keys on runId.
  useEffect(() => {
    setMessages([]);
    setLastSeq(0);
    setTotalEvents(0);
    setControlEvents([]);
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

      if (isControlReconcileEvent(type, payload)) {
        setControlEvents((prev) => [...prev, { type, data: payload }]);
      }
      if (MESSAGE_SIGNAL_TYPES.has(type)) {
        scheduleRefetch();
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

  return { messages, status, lastSeq, totalEvents, controlEvents };
}
