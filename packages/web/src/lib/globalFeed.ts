// Global event feed — single source of truth for the Home page
// timeline AND the cross-app run-query invalidation that used to live
// behind a 15s polling window.
//
// The atom is a bounded ring buffer (oldest at index 0, newest at
// the end). The SSE wire shape carries the full `(runId, seq)` triple
// per event, which we use to dedupe identity across reconnects (the
// server's `ts >= cursor` filter intentionally re-emits at the
// boundary millisecond).

import type { FeedEvent } from "@swarm/types";
import { atom } from "jotai";
import type { SseStatus } from "./useEventSource.ts";

/** Hard cap on feed length — events past this fall off the head as
 * new ones arrive. 50 is enough to fill several screens of timeline
 * UI without retaining unbounded state on long-lived pages. */
export const FEED_MAX_EVENTS = 50;

/** The feed itself. Read-only from components; appends happen via
 * `appendFeedEventsAtom` below to keep the dedup logic in one place. */
export const feedAtom = atom<FeedEvent[]>([]);

/** True until the initial `GET /events` backfill resolves. Lets the
 * UI render a skeleton instead of jumping from "No recent events" to a
 * full list when the response lands a few hundred ms after mount. Set
 * by `useGlobalEventStream`. */
export const feedLoadingAtom = atom<boolean>(true);

/** Live SSE connection status for the global feed. Surfaced in the
 * sidebar so operators see when the live update channel degrades —
 * a `closed`/`error` pill is the signal that the dashboard might be
 * showing stale data even though the rest of the page renders fine.
 * Set by `useGlobalEventStream`; defaults to `connecting` so the pill
 * doesn't flash "open" before the first SSE handshake completes. */
export const feedSseStatusAtom = atom<SseStatus>("connecting");

/**
 * Identity for a feed event, used for client-side dedup. The triple
 * `(runId, seq)` is globally unique (`(run_id, seq)` is the events
 * table primary key), so `runId.seq` is a stable, compact string key.
 */
export function feedEventKey(e: Pick<FeedEvent, "runId" | "seq">): string {
  return `${e.runId}.${e.seq}`;
}

/**
 * Write-only atom that appends events to the feed, deduping by
 * `(runId, seq)` and trimming to {@link FEED_MAX_EVENTS}. Accepts a
 * single event or an array (backfill batches).
 *
 * Insertion preserves chronological order: incoming events are sorted
 * by `(ts, runId, seq)` before merging, then merged with existing feed
 * via a small two-pointer pass. The merge handles the "server replays
 * at cursor.ts on reconnect" case — already-seen events at the
 * boundary are filtered, anything new at the same ts gets inserted at
 * the right position.
 */
export const appendFeedEventsAtom = atom(null, (get, set, incoming: FeedEvent | FeedEvent[]) => {
  const arr = Array.isArray(incoming) ? incoming : [incoming];
  if (arr.length === 0) return;

  const prev = get(feedAtom);
  const seen = new Set<string>(prev.map(feedEventKey));
  const additions: FeedEvent[] = [];
  for (const e of arr) {
    const key = feedEventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(e);
  }
  if (additions.length === 0) return;

  // Sort additions chronologically by (ts, runId, seq). Backfill is
  // already sorted; live appends typically arrive monotonic too —
  // sort is cheap on near-sorted small arrays.
  additions.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
    return a.seq - b.seq;
  });

  // Merge: concat then re-sort. The feed is bounded at FEED_MAX_EVENTS
  // so this is O(N log N) on a tiny N — simpler and faster than a
  // two-pointer merge for the sizes involved.
  const merged = [...prev, ...additions].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
    return a.seq - b.seq;
  });
  // Trim to cap from the head — keep the most recent FEED_MAX_EVENTS.
  const trimmed = merged.length > FEED_MAX_EVENTS ? merged.slice(merged.length - FEED_MAX_EVENTS) : merged;
  set(feedAtom, trimmed);
});

/** Reset atom — clears the feed. Used by tests; production code
 * shouldn't need it (the feed survives across navigations). */
export const resetFeedAtom = atom(null, (_get, set) => {
  set(feedAtom, []);
});
