// useEventSource — minimal SSE lifecycle primitive with auto-reconnect.
//
// One-line job: subscribe to `url`, hand the consumer every `message`
// frame, surface a coarse connection status, clean up on unmount or
// `url` change. Parsing, state shape, and dedup all live in the
// consumer hook — different streams (per-run, global feed) project
// their frames into different state shapes, and there's no useful
// abstraction to bake into the primitive.
//
// Server frames arrive without an `event:` field (see @swarm/server
// `routes.ts`), so a single `message` listener catches everything.
// The frame's actual swarm event type lives inside the JSON `data`
// payload, which the consumer reads.
//
// Reconnect: when EventSource transitions to readyState=2 (CLOSED),
// the browser will NOT auto-retry — that state is reserved for
// non-recoverable errors (non-2xx response, host unreachable, dev
// proxy timing out an idle stream). The hook schedules its own
// reconnect with exponential backoff (1s → 30s) so the global feed
// survives transient drops without needing a page reload.

import { useEffect, useRef, useState } from "react";

export type SseStatus = "connecting" | "open" | "closed" | "error";

export interface UseEventSourceOptions {
  /** Test injection. Defaults to `globalThis.EventSource`. */
  eventSourceImpl?: typeof EventSource;
  /** First-attempt backoff in milliseconds (doubles each attempt, capped
   * at 30s). Default 1000. Tests pass a small value (e.g. 5) so they
   * don't have to mock timers. */
  reconnectBaseMs?: number;
}

const RECONNECT_MAX_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;

/**
 * Subscribe to `url` via EventSource. The `onFrame` callback fires on
 * every `message` frame; consumers parse `event.data` and dispatch on
 * the type they care about.
 *
 * Pass a falsy `url` to skip subscribing (useful when an id isn't known
 * yet). The `onFrame` reference is held in a ref so changing it across
 * renders doesn't tear down the connection — only `url` re-keys the
 * effect.
 */
export function useEventSource(
  url: string | null | undefined,
  onFrame: (ev: MessageEvent) => void,
  opts: UseEventSourceOptions = {},
): { status: SseStatus } {
  const [status, setStatus] = useState<SseStatus>(url ? "connecting" : "closed");
  // Bumps when a permanent close should force a reconnect. Included in
  // the effect's deps; the reconnect attempt count itself rides in
  // `attemptRef` so successful re-opens don't re-trigger the effect.
  const [reconnectKey, setReconnectKey] = useState(0);
  const attemptRef = useRef(0);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const baseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;

  // Reset the backoff counter when the caller swaps URLs. Otherwise a
  // long-running session that hit retries on the previous URL would
  // start the new URL's reconnect attempts mid-curve. The body doesn't
  // read `url`, but the dep is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: url is intentionally the trigger; body reads no values.
  useEffect(() => {
    attemptRef.current = 0;
  }, [url]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: opts is not memo-stable at call sites; the effect deliberately keys only on (url, reconnectKey). baseMs is read from the closure.
  useEffect(() => {
    if (!url) {
      setStatus("closed");
      return;
    }
    const Ctor = opts.eventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
    if (!Ctor) {
      // SSR or runtime without EventSource — fail closed; consumers
      // treat "closed" as "no live updates".
      setStatus("closed");
      return;
    }

    const es = new Ctor(url);
    setStatus("connecting");

    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const onOpen = (): void => {
      setStatus("open");
      // Successful connect resets backoff — next drop starts at base.
      attemptRef.current = 0;
    };
    const onError = (): void => {
      if (es.readyState !== 2) {
        // Transient (browser auto-retries internally). Just surface.
        setStatus("error");
        return;
      }
      // Permanent close. Browser won't retry — schedule it ourselves.
      setStatus("closed");
      if (reconnectTimer) return;
      const attempt = attemptRef.current;
      const delayMs = Math.min(baseMs * 2 ** attempt, RECONNECT_MAX_MS);
      attemptRef.current = attempt + 1;
      reconnectTimer = setTimeout(() => {
        setReconnectKey((k) => k + 1);
      }, delayMs);
    };
    const onMessage = (ev: MessageEvent): void => onFrameRef.current(ev);

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("message", onMessage as EventListener);

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("message", onMessage as EventListener);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, reconnectKey]);

  return { status };
}
