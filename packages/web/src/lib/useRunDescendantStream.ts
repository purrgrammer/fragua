// useRunDescendantStream \u2014 per-parent SSE for the descendant event
// tree. The hook returns a monotonic `descendantToken` string that
// bumps on every received frame; consumers (today: RunDetail \u2192
// useRunLive's `descendantRefreshToken` prop) react to changes by
// re-fetching merged-descendant data.
//
// The stream is unfiltered by design (full firehose scoped to the
// parent's run tree). The previous transport \u2014 scanning `feedAtom`
// for child runIds with a kind allow-list \u2014 forced noisy types like
// `fact.message_appended` onto the operator Activity feed; this
// split keeps the Activity feed narrow.
//
// docs/proposals/descendant-event-stream.md.

import { useCallback, useRef, useState } from "react";
import { getRunDescendantEventsUrl } from "./api.ts";
import { useEventSource } from "./useEventSource.ts";

export interface UseRunDescendantStreamOptions {
  /** Tri-state terminal flag, derived from the snapshot. Same gate
   * `useRunLive` uses: `undefined` (loading) and `true` (terminal)
   * keep the EventSource closed; only `false` opens it. */
  terminal: boolean | undefined;
  /** Test injection; defaults to global EventSource. */
  eventSourceImpl?: typeof EventSource;
}

export interface UseRunDescendantStreamResult {
  /** Monotonic string token; the value changes on every received SSE
   * event so consumers can use it as a refresh signal. Empty string
   * before any event has landed. */
  descendantToken: string;
}

export function useRunDescendantStream(
  runId: string | null | undefined,
  opts: UseRunDescendantStreamOptions,
): UseRunDescendantStreamResult {
  const [token, setToken] = useState("");
  const counterRef = useRef(0);

  const onFrame = useCallback((ev: MessageEvent): void => {
    // Server keepalive frames (`swarm.ping`) intentionally lack an
    // `id:` field so the client's loose envelope check drops them
    // from the feed atom. Apply the same exclusion here so a ping
    // doesn't bump the token \u2014 the watchdog rearms via the lower-
    // level `useEventSource.onMessage` regardless.
    if (!ev.lastEventId) return;
    counterRef.current += 1;
    setToken(`${ev.lastEventId}#${counterRef.current}`);
  }, []);

  const url = runId && opts.terminal === false ? getRunDescendantEventsUrl(runId) : null;
  const esOpts = opts.eventSourceImpl ? { eventSourceImpl: opts.eventSourceImpl } : {};
  useEventSource(url, onFrame, esOpts);

  return { descendantToken: token };
}
