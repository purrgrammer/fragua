// useRunConversation — primary data hook for the pipeline conversation view.
//
// Why a purpose-built hook instead of `useSSE` + batch reducer:
//   - Runs produce tens of thousands of events. Keeping a raw event
//     buffer on the client doesn't scale and, more importantly, caps the
//     reducer's visibility — a ring buffer of 500 drops the
//     `agent.turn_start` / `agent.message_start` / `llm.*_delta` events
//     that live near the top of each turn, leaving sections with zero
//     turns and the UI rendering "(no agent turns for this node)" for
//     every node on a finished run.
//
// Architecture:
//   1. On mount, fetch the full historical event array from
//      `GET /api/pipelines/:id/events.json`. Fold every event through
//      `applyEvent` into a single `ReducerState`. This produces the
//      complete conversation tree for whatever has already happened.
//   2. Open an EventSource on the same `/events` path (text/event-stream).
//      The server replays from the beginning by default, but each frame
//      carries `id: <seq>` (1-based). We skip any frame with
//      `seq <= lastSeq` from the bootstrap, and apply the rest to the
//      same ReducerState.
//   3. Expose the folded conversation plus a coarse connection status.
//      We never keep raw events on the client past the fold, so
//      memory scales with conversation content (a few KB per turn),
//      not event count.
//
// In-progress vs finished runs are handled identically: a finished run
// just has no new SSE frames after the initial replay catches up.
//
// Re-render strategy: the reducer mutates state in place. After each
// applyEvent we publish a fresh `PipelineConversation` via
// `toConversation(state)` — React's shallow compare sees a new top-level
// array and re-renders. A small `revision` counter is also exposed so
// consumers can key memoized children on it when fine-grained control
// matters.

import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api.ts";
import {
  applyEvent,
  createReducerState,
  type PipelineConversation,
  type RawEvent,
  type ReducerState,
  toConversation,
} from "./events-to-conversation.ts";

export type RunConversationStatus =
  | "idle" // no runId yet
  | "loading" // bootstrap fetch in flight
  | "live" // SSE open, receiving updates
  | "closed" // SSE closed cleanly (finished run)
  | "error"; // bootstrap or stream failed

export interface UseRunConversationResult {
  /** Folded conversation tree. Fresh top-level array on each update. */
  conversation: PipelineConversation;
  /** Connection status across both bootstrap and stream phases. */
  status: RunConversationStatus;
  /** Last SSE sequence id applied. Useful for diagnostics and manual resume. */
  lastSeq: number;
  /** Monotonic counter bumped on each applied event. */
  revision: number;
  /** Total raw events seen (historical + streamed). Diagnostic only. */
  totalEvents: number;
}

export interface UseRunConversationOptions {
  /** EventSource constructor. Tests inject a fake to avoid network + timers. */
  eventSourceImpl?: typeof EventSource;
  /** Fetch implementation. Tests inject a fake; default is `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/** All swarm event types, mirrored from `@swarm/core` (packages/core/src/types/events.ts).
 * EventSource only dispatches `event:`-named frames to listeners attached by
 * that exact name, so we register all known types up-front. Extend this list
 * when new event types land in core. */
const KNOWN_EVENT_TYPES: readonly string[] = [
  "pipeline.started",
  "pipeline.completed",
  "pipeline.failed",
  "node.started",
  "node.completed",
  "node.failed",
  "node.retrying",
  "node.skipped",
  "edge.selected",
  "checkpoint.saved",
  "interview.started",
  "interview.completed",
  "interview.timeout",
  "agent.start",
  "agent.end",
  "agent.turn_start",
  "agent.turn_end",
  "agent.message_start",
  "agent.message_update",
  "agent.message_end",
  "agent.warning",
  "llm.start",
  "llm.text_delta",
  "llm.thinking_delta",
  "llm.toolcall_delta",
  "llm.done",
  "llm.error",
  "tool.execution_start",
  "tool.execution_update",
  "tool.execution_end",
  "steering.requested",
  "steering.injected",
  "cost.recorded",
];

/** Parse one SSE frame into the reducer's input shape. Opaque on failure. */
function toRawEvent(type: string, data: string): RawEvent | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      type: String(parsed["type"] ?? type),
      node_id: (parsed["node_id"] ?? null) as string | null,
      session_id: (parsed["session_id"] ?? null) as string | null,
      data: (parsed["data"] ?? null) as Record<string, unknown> | null,
      timestamp: parsed["timestamp"] as string | undefined,
    };
  } catch {
    return null;
  }
}

/** Coerce arbitrary unknown[] from the REST payload into RawEvents. Drops
 * entries that don't look like events rather than throwing; the wire
 * format should always be valid but we never crash the UI over a
 * malformed frame. */
function coerceRawEvents(items: readonly unknown[]): RawEvent[] {
  const out: RawEvent[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o["type"] !== "string") continue;
    out.push({
      type: o["type"],
      node_id: (o["node_id"] ?? null) as string | null,
      session_id: (o["session_id"] ?? null) as string | null,
      data: (o["data"] ?? null) as Record<string, unknown> | null,
      timestamp: o["timestamp"] as string | undefined,
    });
  }
  return out;
}

export function useRunConversation(
  api: ApiClient,
  runId: string | null | undefined,
  opts: UseRunConversationOptions = {},
): UseRunConversationResult {
  const [conversation, setConversation] = useState<PipelineConversation>([]);
  const [status, setStatus] = useState<RunConversationStatus>(runId ? "loading" : "idle");
  const [lastSeq, setLastSeq] = useState(0);
  const [revision, setRevision] = useState(0);
  const [totalEvents, setTotalEvents] = useState(0);

  // Hold the reducer state across renders without triggering React updates
  // on every mutation. We publish via setConversation() at controlled points.
  const stateRef = useRef<ReducerState>(createReducerState());
  const lastSeqRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: opts.fetchImpl and opts.eventSourceImpl are test injections; the hook keys on runId only. Callers don't memoize opts.
  useEffect(() => {
    // Reset on runId change or mount.
    stateRef.current = createReducerState();
    lastSeqRef.current = 0;
    setConversation([]);
    setLastSeq(0);
    setRevision(0);
    setTotalEvents(0);

    if (!runId) {
      setStatus("idle");
      return;
    }

    setStatus("loading");
    let cancelled = false;

    // ── Phase 1: bootstrap via REST ──────────────────────────────────
    api
      .getPipelineEvents(runId)
      .then((payload) => {
        if (cancelled) return;
        const historical = coerceRawEvents(payload.events);
        const s = stateRef.current;
        for (const ev of historical) applyEvent(s, ev);
        lastSeqRef.current = payload.lastSeq;
        setConversation(toConversation(s));
        setLastSeq(payload.lastSeq);
        setRevision((r) => r + 1);
        setTotalEvents(historical.length);
        startStream();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[useRunConversation] bootstrap failed for", runId, "—", message);
        setStatus("error");
      });

    // ── Phase 2: SSE stream (resumes from lastSeq) ───────────────────
    let es: EventSource | null = null;
    const append = (ev: MessageEvent): void => {
      const idNum = ev.lastEventId ? Number.parseInt(ev.lastEventId, 10) : Number.NaN;
      // Skip anything we already folded through the REST bootstrap. The
      // server replays from the beginning of the file on every SSE
      // connection; we use the seq id on each frame to dedupe.
      if (Number.isFinite(idNum) && idNum <= lastSeqRef.current) return;

      const raw = toRawEvent(ev.type || "message", String(ev.data ?? ""));
      if (!raw) return;

      applyEvent(stateRef.current, raw);
      if (Number.isFinite(idNum)) {
        lastSeqRef.current = idNum;
        setLastSeq(idNum);
      }
      setTotalEvents((n) => n + 1);
      setConversation(toConversation(stateRef.current));
      setRevision((r) => r + 1);
    };

    function startStream(): void {
      if (cancelled) return;
      const Ctor = opts.eventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
      if (!Ctor) {
        // No EventSource available (SSR / bare test runtime). Bootstrap
        // data is already rendered; we just don't get live updates.
        setStatus("closed");
        return;
      }
      const url = api.getPipelineEventsUrl(runId!);
      es = new Ctor(url);
      setStatus("live");

      const onOpen = (): void => {
        if (!cancelled) setStatus("live");
      };
      const onError = (): void => {
        if (cancelled) return;
        // EventSource auto-reconnects unless readyState === 2 (CLOSED).
        setStatus(es && es.readyState === 2 ? "closed" : "error");
      };

      es.addEventListener("open", onOpen);
      es.addEventListener("error", onError);
      es.addEventListener("message", append as EventListener);
      for (const t of KNOWN_EVENT_TYPES) {
        es.addEventListener(t, append as EventListener);
      }
    }

    return () => {
      cancelled = true;
      if (es) {
        es.close();
        es = null;
      }
    };
  }, [api, runId]);

  return { conversation, status, lastSeq, revision, totalEvents };
}
