// useEventSource — minimal SSE lifecycle primitive.
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

import { useEffect, useRef, useState } from "react";

export type SseStatus = "connecting" | "open" | "closed" | "error";

export interface UseEventSourceOptions {
  /** Test injection. Defaults to `globalThis.EventSource`. */
  eventSourceImpl?: typeof EventSource;
}

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: opts is not memo-stable at call sites; the effect deliberately keys only on url.
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

    const onOpen = (): void => setStatus("open");
    const onError = (): void => {
      // Browsers retry automatically unless readyState === 2 (CLOSED).
      setStatus(es.readyState === 2 ? "closed" : "error");
    };
    const onMessage = (ev: MessageEvent): void => onFrameRef.current(ev);

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("message", onMessage as EventListener);

    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("message", onMessage as EventListener);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return { status };
}
