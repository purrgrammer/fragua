// useEventSource — minimal SSE lifecycle primitive with auto-reconnect
// and a half-dead-socket watchdog.
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
// Reconnect, two paths:
//   1. EventSource transitions to readyState=2 (CLOSED): the browser
//      will NOT auto-retry — that state is reserved for non-recoverable
//      errors (non-2xx response, host unreachable, dev proxy timing
//      out an idle stream). The hook schedules its own reconnect with
//      exponential backoff (1s → 30s).
//   2. Stall watchdog: when the socket goes silently dead (laptop
//      sleep, NAT rebind, wifi handoff, dropped TCP) the browser keeps
//      `readyState=1` and fires neither `error` nor `message`. We arm
//      a timer on `open`/`message`; if it fires without re-arming, we
//      treat the connection as dead, close it manually, and fall into
//      the same backoff-reconnect path. The server emits a `data:
//      {"type":"swarm.ping"}` keepalive every ~10s precisely so this
//      timer sees signal on a healthy connection — ANY frame, real or
//      ping, rearms it.

import { useEffect, useRef, useState } from "react";

export type SseStatus = "connecting" | "open" | "closed" | "error";

export interface UseEventSourceOptions {
  /** Test injection. Defaults to `globalThis.EventSource`. */
  eventSourceImpl?: typeof EventSource;
  /** First-attempt backoff in milliseconds (doubles each attempt, capped
   * at 30s). Default 1000. Tests pass a small value (e.g. 5) so they
   * don't have to mock timers. */
  reconnectBaseMs?: number;
  /** Force-reconnect if no `message` (real or ping) arrives in this
   * many ms after `open`. Must exceed the server's keepalive cadence
   * (10s) plus jitter, but be short enough that operators notice a
   * stale connection within a reasonable window. Default 35s. Tests
   * pass a small value to drive the watchdog deterministically. */
  stallMs?: number;
}

const RECONNECT_MAX_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_STALL_MS = 35_000;

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
  // Bumps when a connection should be torn down and reopened — for both
  // permanent-close errors and stall-watchdog firings. The reconnect
  // attempt count itself rides in `attemptRef` so successful re-opens
  // don't re-trigger the effect.
  const [reconnectKey, setReconnectKey] = useState(0);
  const attemptRef = useRef(0);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const baseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;

  // biome-ignore lint/correctness/useExhaustiveDependencies: opts is not memo-stable at call sites; the effect deliberately keys only on (url, reconnectKey). baseMs/stallMs are read from the closure.
  useEffect(() => {
    if (!url) {
      setStatus("closed");
      return;
    }
    // Reset the backoff counter when the caller swaps URLs. Otherwise
    // a long-running session that hit retries on the previous URL
    // would start the new URL's reconnect attempts mid-curve. The
    // `reconnectKey` path doesn't reset (consecutive reconnects on the
    // same URL accumulate backoff correctly).
    attemptRef.current = 0;

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
    let stallTimer: ReturnType<typeof setTimeout> | undefined;

    /** Schedule a forced reconnect, identical to the readyState=2
     *  branch. Used by both onError(permanent close) and the stall
     *  watchdog. Idempotent — if a reconnect is already pending, this
     *  is a no-op. */
    const scheduleReconnect = (): void => {
      if (reconnectTimer) return;
      const attempt = attemptRef.current;
      const delayMs = Math.min(baseMs * 2 ** attempt, RECONNECT_MAX_MS);
      attemptRef.current = attempt + 1;
      reconnectTimer = setTimeout(() => {
        setReconnectKey((k) => k + 1);
      }, delayMs);
    };

    /** (Re-)arm the stall watchdog. Called on `open` and on every
     *  inbound `message` (real event OR server ping). If the timer
     *  fires it means we've gone `stallMs` without a single byte from
     *  the server — the kind of silence that only happens on a
     *  half-open socket the browser hasn't noticed. Force-reconnect. */
    const armStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        // Mirror the readyState=2 path: close the dead ES, surface
        // "closed" so the UI flips out of "open", and schedule a
        // reconnect. Closing here also prevents any later browser
        // event on this stale ES from interfering with the new one.
        try {
          es.close();
        } catch {
          // ignore — close() is best-effort.
        }
        setStatus("closed");
        scheduleReconnect();
      }, stallMs);
    };

    const onOpen = (): void => {
      setStatus("open");
      // Successful connect resets backoff — next drop starts at base.
      attemptRef.current = 0;
      armStall();
    };
    const onError = (): void => {
      if (es.readyState !== 2) {
        // Transient (browser auto-retries internally). Just surface
        // status; the stall watchdog catches the case where the
        // browser gets stuck retrying without ever succeeding.
        setStatus("error");
        return;
      }
      // Permanent close. Browser won't retry — schedule it ourselves.
      setStatus("closed");
      scheduleReconnect();
    };
    const onMessage = (ev: MessageEvent): void => {
      // Any frame — real event OR server ping — proves the socket is
      // alive; rearm the watchdog before delegating to the consumer.
      armStall();
      onFrameRef.current(ev);
    };

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("message", onMessage as EventListener);

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (stallTimer) clearTimeout(stallTimer);
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("message", onMessage as EventListener);
      es.close();
    };
  }, [url, reconnectKey]);

  return { status };
}
