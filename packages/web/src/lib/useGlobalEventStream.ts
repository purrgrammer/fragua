// useGlobalEventStream — single top-level hook that drives:
//   (1) the global feed atom (powers <GlobalFeed/> on Home)
//   (2) cross-app run-query invalidation (replaces the 15s polling
//       window — TanStack Query refetches whenever a run-lifecycle
//       event lands, so RunsList / Home tiles stay in sync without
//       wasting requests in between)
//
// Bootstrap order matters: backfill THEN open SSE. The backfill
// returns the latest N events (oldest-first) and we use the max ts
// as the SSE cursor — that way the stream picks up exactly where
// the backfill ended, with the server's `ts >= cursor` semantics
// absorbing any boundary-ms appends via per-connection dedup.

import type { FeedEvent } from "@fragua/types";
import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { getFeedEvents, getFeedStreamUrl } from "./api.ts";
import { appendFeedEventsAtom, FEED_HIDDEN_KINDS, feedLoadingAtom, feedSseStatusAtom } from "./globalFeed.ts";
import { queries } from "./queries.ts";
import { useEventSource } from "./useEventSource.ts";

/** Event kinds that imply the runs-list / run-detail caches are stale.
 * On any of these, invalidate the relevant queries so subscribed
 * components refetch. The set is intentionally narrow — node-level
 * progress doesn't change the runs-list summary. */
const RUN_INVALIDATE_KINDS = new Set<string>([
  "intent.run_enqueued",
  "fact.run_started",
  "fact.run_completed",
  "fact.run_paused_human",
  "fact.run_paused",
  "fact.run_resumed",
  "fact.run_cancelled",
  "fact.run_halted",
  "fact.run_quarantined",
  "fact.run_requeued_after_crash",
  // Post-terminal operator actions: inbox_status transitions (pending → acted/discarded)
  // must clear the WorktreeInbox row in any open tab, not just the tab that fired the action.
  "fact.run_accepted",
  "fact.run_discarded",
  // Terminal worktree snapshot: written AFTER fact.run_completed in the executor's
  // finally-block dispose path. It sets inbox_status=pending on run_state, so the
  // inbox=pending list query must refetch when this fact arrives — fact.run_completed
  // alone races the snapshot write and the list may return before inbox_status is set.
  "fact.snapshot_recorded",
  // Auto-titler: run card title stays stale after enqueue until the title lands.
  "run.title_generated",
]);

export interface UseGlobalEventStreamOptions {
  /** Test injection. */
  eventSourceImpl?: typeof EventSource;
  /** Test override: shrinks the SSE reconnect backoff so reconnect
   * paths don't add a real-world second to test runtime. */
  reconnectBaseMs?: number;
  /** Test override: shrinks the stall watchdog so tests can drive the
   * "half-dead socket" path without sleeping 35s. */
  stallMs?: number;
}

/**
 * Mount once, near the app root. Returns nothing — the hook drives
 * the `feedAtom` and the React Query cache as side effects.
 *
 * Idempotent: re-mounting (e.g. via React 18 strict-mode double-
 * invoke or HMR) just runs another bootstrap; the feed atom dedupes
 * the resulting overlap.
 */
export function useGlobalEventStream(opts: UseGlobalEventStreamOptions = {}): void {
  const qc = useQueryClient();
  const appendFeed = useSetAtom(appendFeedEventsAtom);
  const setLoading = useSetAtom(feedLoadingAtom);
  const setSseStatus = useSetAtom(feedSseStatusAtom);

  // Cursor for the live SSE: undefined until backfill resolves. The
  // SSE URL is gated on this so we don't open a stream that immediately
  // re-replays the entire history. Once set, the URL stays stable
  // until the hook re-mounts.
  const [fromTs, setFromTs] = useState<number | null>(null);

  // Backfill on mount: fetch the latest N events, seed the atom,
  // capture the max ts as the SSE cursor.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getFeedEvents()
      .then((events) => {
        if (cancelled) return;
        appendFeed(events);
        const last = events[events.length - 1];
        // If the backfill is empty, start from "now" so the stream
        // doesn't replay a whole DB worth of history. Slightly past
        // the wall clock so we don't accidentally land before any
        // event the server stamped at this exact ms.
        setFromTs(last ? last.ts : Date.now());
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn("[useGlobalEventStream] backfill failed:", err);
        // Still open the stream from now — the feed will just be
        // empty until live events arrive.
        setFromTs(Date.now());
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // appendFeed/setLoading are stable jotai atom setters; listing them
    // satisfies the exhaustive-deps rule without changing behaviour.
  }, [appendFeed, setLoading]);

  const onFrame = useCallback(
    (ev: MessageEvent): void => {
      let parsed: FeedEvent | { type?: string } | null = null;
      try {
        parsed = JSON.parse(String(ev.data ?? "")) as FeedEvent | { type?: string };
      } catch {
        return;
      }
      if (parsed == null) return;
      // Server keepalive: fires `useEventSource`'s stall watchdog rearm
      // (in the layer above) but isn't a feed event — has no runId/seq
      // and shouldn't trigger query invalidations. Drop it before the
      // envelope check so it doesn't show up in any future "rejected
      // frame" instrumentation either.
      if ((parsed as { type?: string }).type === "fragua.ping") return;
      if (typeof (parsed as FeedEvent).runId !== "string" || typeof (parsed as FeedEvent).seq !== "number") return;
      const evt = parsed as FeedEvent;

      if (!FEED_HIDDEN_KINDS.has(evt.type)) {
        appendFeed(evt);
      }

      // Invalidate just the queries that *this* event's lifecycle
      // change actually affects. Blanket-invalidating queries.runs.all
      // would force every mounted run-detail query to refetch (the
      // global feed has up to 50 of those at once), which is overkill
      // for a single run's status flip.
      if (RUN_INVALIDATE_KINDS.has(evt.type)) {
        // Prefix-match every list variant — unfiltered (Stats),
        // `{status:["running"]}` (Control Center's Running), and
        // `{status:["paused_human",...]}` (Inbox) all refetch from one
        // invalidate.
        void qc.invalidateQueries({ queryKey: queries.runs.lists() });
        void qc.invalidateQueries({ queryKey: queries.runs.detail(evt.runId).queryKey });
        // Project list rolls up `lastUpdatedAt` / `runCount` per cwd —
        // any run lifecycle change shifts at least one of those.
        void qc.invalidateQueries({ queryKey: queries.projects.all() });
      }
    },
    [appendFeed, qc],
  );

  // Keep onFrame stable across renders so useEventSource doesn't
  // re-key on every parent render. The hook's own ref handling absorbs
  // the closure update.
  const sseUrl = fromTs != null ? getFeedStreamUrl(fromTs) : null;
  const sseOpts: Parameters<typeof useEventSource>[2] = {};
  if (opts.eventSourceImpl) sseOpts.eventSourceImpl = opts.eventSourceImpl;
  if (opts.reconnectBaseMs !== undefined) sseOpts.reconnectBaseMs = opts.reconnectBaseMs;
  if (opts.stallMs !== undefined) sseOpts.stallMs = opts.stallMs;
  const { status } = useEventSource(sseUrl, onFrame, sseOpts);

  // Mirror the SSE status into a global atom so the sidebar pill (and
  // anything else that cares) can read it without prop-drilling — this
  // hook is mounted at the app root, sibling to the router subtree
  // where the sidebar lives, so context wiring would have to thread
  // through the router boundary.
  useEffect(() => {
    setSseStatus(status);
  }, [status, setSseStatus]);
}

/** Internal export — exposed for tests so they can assert which run
 * kinds trigger invalidation without coupling the test to the
 * mount-order of the runs cache. */
export const __invalidateKinds = RUN_INVALIDATE_KINDS;
