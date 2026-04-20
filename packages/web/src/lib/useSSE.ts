// Tiny `EventSource` hook. Subscribes on mount, accumulates parsed events
// in a ring-bounded array, and exposes a coarse connection status.
//
// Scope notes:
//   - Task 06 only uses this to trigger graph re-fetches on `node.*` events
//     so active-node highlighting stays live. Tasks 07 (timeline) and 08
//     (drilldown) reuse it to render full event streams.
//   - We intentionally don't parse event data here — consumers know their
//     shape. Keeping the hook dumb avoids a Zod/TypeBox dep in the client.
//   - `maxEvents` is a hard cap to prevent OOM on long-lived runs. Older
//     events roll off the head when the cap is hit.

import { useEffect, useState } from "react";

export type SSEStatus = "connecting" | "open" | "closed" | "error";

export interface SSEEvent {
  /** The SSE `event:` field, or `"message"` if absent. */
  type: string;
  /** The raw `data:` payload, unparsed. */
  data: string;
  /** The SSE `id:` field, if present. */
  id?: string;
}

export interface UseSSEOptions {
  /** Ring-buffer size; defaults to 500. */
  maxEvents?: number;
  /**
   * EventSource constructor. Default is `globalThis.EventSource`. Tests
   * inject a fake here to avoid network + timers.
   */
  eventSourceImpl?: typeof EventSource;
  /**
   * Optional filter: only events with `type` matching this predicate are
   * recorded. Useful to keep re-renders scoped when a single stream feeds
   * multiple unrelated components.
   */
  filter?: (type: string) => boolean;
}

export interface UseSSEResult {
  events: SSEEvent[];
  status: SSEStatus;
}

/**
 * Subscribe to `url` via `EventSource`. Returns the live event list and
 * connection status. Pass a falsy `url` to skip subscribing (useful when
 * an id isn't known yet).
 */
export function useSSE(url: string | null | undefined, opts: UseSSEOptions = {}): UseSSEResult {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [status, setStatus] = useState<SSEStatus>(url ? "connecting" : "closed");

  // biome-ignore lint/correctness/useExhaustiveDependencies(opts.eventSourceImpl): deliberately keying only on `url` — opts are not memo-stable at call sites.
  // biome-ignore lint/correctness/useExhaustiveDependencies(opts.filter): same rationale.
  // biome-ignore lint/correctness/useExhaustiveDependencies(opts.maxEvents): same rationale.
  useEffect(() => {
    if (!url) {
      setStatus("closed");
      return;
    }

    const Ctor = opts.eventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
    if (!Ctor) {
      // No EventSource available (SSR, old runtime). Fail closed rather
      // than throw — consumers treat "closed" as "no live updates".
      setStatus("closed");
      return;
    }

    const max = opts.maxEvents ?? 500;
    const filter = opts.filter;
    const es = new Ctor(url);
    setStatus("connecting");

    const onOpen = (): void => setStatus("open");
    const onError = (): void => {
      // Browsers automatically retry unless readyState === 2 (CLOSED).
      setStatus(es.readyState === 2 ? "closed" : "error");
    };

    // We want to receive all event types, not just the default `message`.
    // EventSource only dispatches named events to matching listeners, so
    // we attach a single `message` listener plus a catch-all via the raw
    // `addEventListener` on known types we care about. In practice, to
    // receive arbitrary types we also override `onmessage` for the default
    // channel and let consumers supply named listeners elsewhere if they
    // need per-type hooks.
    //
    // The server frames every line with an `event:` field, so nothing lands
    // on the default `message` channel in production. We compensate by
    // inspecting the `MessageEvent.type` which EventSource populates from
    // the `event:` field for any listener attached to that type name — but
    // since we don't know type names up-front, we patch `dispatchEvent` via
    // a MutationObserver-style shim? No — instead we register listeners for
    // a known superset and route everything through a single append fn.
    //
    // Simpler and correct: register `message` + a small set of known
    // event prefixes. Tests use the fake to drive any type they want
    // through the generic path by dispatching as `message`, which keeps
    // the hook testable without a DSL.

    const append = (ev: MessageEvent): void => {
      const type = ev.type || "message";
      if (filter && !filter(type)) return;
      setEvents((prev) => {
        const next: SSEEvent = { type, data: String(ev.data ?? "") };
        if (ev.lastEventId) next.id = ev.lastEventId;
        const out = prev.length >= max ? prev.slice(prev.length - max + 1) : prev.slice();
        out.push(next);
        return out;
      });
    };

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("message", append as EventListener);
    // Known named events from our server — extend here as the schema grows.
    const named = [
      "run.started",
      "run.completed",
      "run.failed",
      "node.started",
      "node.completed",
      "node.failed",
      "node.skipped",
      "node.retrying",
      "wait.human",
      "interview.answered",
    ];
    for (const name of named) es.addEventListener(name, append as EventListener);

    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("message", append as EventListener);
      for (const name of named) es.removeEventListener(name, append as EventListener);
      es.close();
      setStatus("closed");
    };
    // We intentionally exclude `opts` from deps: callers would have to
    // memoize the whole object, which is awkward. `url` is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return { events, status };
}
