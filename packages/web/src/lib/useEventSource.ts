// useEventSource — minimal SSE lifecycle primitive with auto-reconnect
// and a half-dead-socket watchdog.
//
// Single effect keyed on `[url]`. Reconnects re-run `connect()` inside
// the same effect closure rather than bumping a component-state
// counter, so the reconnect path doesn't race a render between
// scheduling and the effect rerunning.
//
// Frame parsing, dedup, and projection live in the consumer hook —
// per-run and global feeds shape their state differently and there's
// no useful abstraction to bake into the primitive. The server emits
// every frame as `data:` (no `event:` field), so a single `message`
// listener catches everything.
//
// Reconnect, two paths:
//   1. EventSource transitions to `readyState=2` (CLOSED): the browser
//      will NOT auto-retry — that state is reserved for non-recoverable
//      errors (non-2xx response, host unreachable, dev proxy timing
//      out an idle stream). The hook schedules its own reconnect with
//      exponential backoff + jitter (500ms → 30s).
//   2. Stall watchdog: when the socket goes silently dead (laptop
//      sleep, NAT rebind, wifi handoff, dropped TCP) the browser keeps
//      `readyState=1` and fires neither `error` nor `message`. We arm
//      a timer on `open` / `message`; if it fires without re-arming,
//      we close the dead ES manually and fall into the same backoff-
//      reconnect path. The server emits `data: {"type":"fragua.ping"}`
//      every ~10s precisely so this timer sees signal on a healthy
//      connection — ANY frame, real or ping, rearms it.

import { useEffect, useRef, useState } from "react";

export type SseStatus = "connecting" | "open" | "closed" | "error";

export interface UseEventSourceOptions {
  /** Test injection. Defaults to `globalThis.EventSource`. */
  eventSourceImpl?: typeof EventSource;
  /** First-attempt backoff in milliseconds (doubles each attempt, capped
   * at `reconnectMaxMs`). Default 500. Tests pass a small value (e.g. 5)
   * so they don't have to mock timers. */
  reconnectBaseMs?: number;
  /** Cap for the exponential backoff curve. Default 30s. Newly exposed
   * so tests can pin deterministic timing. */
  reconnectMaxMs?: number;
  /** ±jitter applied multiplicatively to each backoff delay. 0.2 = ±20%.
   * Default 0.2 in production (multi-tab reconnect storms after a
   * server bounce don't synchronize); pass 0 in tests for determinism. */
  jitter?: number;
  /** Force-reconnect if no `message` (real or ping) arrives in this
   * many ms after `open`. Must exceed the server's keepalive cadence
   * (10s) plus jitter, but be short enough that operators notice a
   * stale connection within a reasonable window. Default 35s. */
  stallMs?: number;
}

const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_STALL_MS = 35_000;
const DEFAULT_JITTER = 0.2;

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
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const baseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const maxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const jitter = opts.jitter ?? DEFAULT_JITTER;

  // biome-ignore lint/correctness/useExhaustiveDependencies: opts is not memo-stable at call sites; the effect deliberately keys only on `url`. baseMs/stallMs/jitter/maxMs are read from the closure.
  useEffect(() => {
    if (!url) {
      setStatus("closed");
      return;
    }
    const Ctor: typeof EventSource | undefined =
      opts.eventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
    if (!Ctor) {
      // SSR or runtime without EventSource — fail closed; consumers
      // treat "closed" as "no live updates".
      setStatus("closed");
      return;
    }
    const ESCtor: typeof EventSource = Ctor;

    // All async paths inside this effect close over `cancelled`; the
    // cleanup flips it to true so a delayed timer or browser callback
    // can't update state on an unmounted hook (or a hook whose `url`
    // has since changed). React 19 + future StrictMode safe.
    let cancelled = false;
    let attempt = 0;
    let es: EventSource | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    /** Detach listeners *before* close() so a late `error` event during
     * teardown can't reach a handler bound to a now-stale connection.
     * Also clears the stall timer — we'll re-arm on next `open`. */
    const teardownEs = (): void => {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
      if (es) {
        es.removeEventListener("open", onOpen);
        es.removeEventListener("error", onError);
        es.removeEventListener("message", onMessage as EventListener);
        try {
          es.close();
        } catch {
          // best-effort
        }
        es = null;
      }
    };

    /** Schedule the next connect attempt. Idempotent — if a reconnect
     * is already pending, this is a no-op. Backoff doubles per attempt
     * up to `maxMs`, with optional ±jitter so multi-tab reconnect
     * storms don't synchronize. */
    const scheduleReconnect = (): void => {
      if (cancelled || reconnectTimer !== undefined) return;
      const exp = Math.min(baseMs * 2 ** attempt, maxMs);
      const delay = jitter > 0 ? exp * (1 + (Math.random() - 0.5) * 2 * jitter) : exp;
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    /** (Re-)arm the stall watchdog. Called on `open` and on every
     * inbound `message` (real event OR server ping). If the timer
     * fires it means we've gone `stallMs` without a single byte from
     * the server — the kind of silence that only happens on a
     * half-open socket the browser hasn't noticed. Force-reconnect. */
    const armStall = (): void => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        teardownEs();
        if (cancelled) return;
        setStatus("closed");
        scheduleReconnect();
      }, stallMs);
    };

    function onOpen(): void {
      if (cancelled) return;
      setStatus("open");
      attempt = 0; // successful connect resets backoff
      armStall();
    }
    function onError(): void {
      if (cancelled || !es) return;
      if (es.readyState !== 2) {
        // Transient — browser is auto-retrying internally. Surface
        // status only; the stall watchdog catches the case where the
        // browser gets stuck retrying without ever succeeding.
        setStatus("error");
        return;
      }
      // Permanent close. Browser won't retry — schedule it ourselves.
      teardownEs();
      setStatus("closed");
      scheduleReconnect();
    }
    function onMessage(ev: MessageEvent): void {
      if (cancelled) return;
      armStall();
      onFrameRef.current(ev);
    }

    function connect(): void {
      if (cancelled) return;
      setStatus("connecting");
      es = new ESCtor(url!);
      es.addEventListener("open", onOpen);
      es.addEventListener("error", onError);
      es.addEventListener("message", onMessage as EventListener);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      teardownEs();
    };
  }, [url]);

  return { status };
}
