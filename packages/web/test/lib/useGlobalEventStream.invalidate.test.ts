// useGlobalEventStream — __invalidateKinds membership tests.
//
// Verifies that every event kind that should trigger a runs-list/detail
// cache invalidation is present in the exported set.  Pure membership
// check: no DOM, no React, no fetch mocks required.
//
// Invariant: every kind that the client LISTENS FOR in __invalidateKinds
// must also be in FEED_EVENT_KINDS (the server-side SSE allow-list).
// Otherwise the server silently drops the event before it reaches the
// client and the invalidation never fires — stale UI.

import { FEED_EVENT_KINDS } from "@fragua/types";
import { describe, expect, test } from "vitest";
import { FEED_HIDDEN_KINDS } from "../../src/lib/globalFeed.ts";
import { __invalidateKinds } from "../../src/lib/useGlobalEventStream.ts";

describe("useGlobalEventStream — RUN_INVALIDATE_KINDS membership", () => {
  // Core lifecycle kinds (already present before this PR)
  test("includes core run lifecycle facts", () => {
    expect(__invalidateKinds.has("fact.run_started")).toBe(true);
    expect(__invalidateKinds.has("fact.run_completed")).toBe(true);
    expect(__invalidateKinds.has("fact.run_paused_human")).toBe(true);
    expect(__invalidateKinds.has("fact.run_paused")).toBe(true);
    expect(__invalidateKinds.has("fact.run_resumed")).toBe(true);
    expect(__invalidateKinds.has("fact.run_cancelled")).toBe(true);
    expect(__invalidateKinds.has("fact.run_halted")).toBe(true);
    expect(__invalidateKinds.has("fact.run_quarantined")).toBe(true);
    expect(__invalidateKinds.has("fact.run_requeued_after_crash")).toBe(true);
    expect(__invalidateKinds.has("intent.run_enqueued")).toBe(true);
  });

  // Operator-action facts — inbox rows must clear in all tabs
  test("includes the post-terminal operator-action facts (inbox rows clear)", () => {
    expect(__invalidateKinds.has("fact.run_accepted")).toBe(true);
    expect(__invalidateKinds.has("fact.run_discarded")).toBe(true);
  });

  // Terminal snapshot: written AFTER fact.run_completed in the dispose path;
  // sets inbox_status=pending, so the inbox=pending list must refetch on this fact.
  test("includes fact.snapshot_recorded so inbox=pending list refetches after the snapshot writes inbox_status", () => {
    expect(__invalidateKinds.has("fact.snapshot_recorded")).toBe(true);
  });

  // Auto-titler: run card title updates live after enqueue
  test("includes run.title_generated so titles appear live in run cards", () => {
    expect(__invalidateKinds.has("run.title_generated")).toBe(true);
  });

  // ── SSE delivery invariant ────────────────────────────────────────
  //
  // Every kind in __invalidateKinds that is a "fact.*" event MUST be
  // present in FEED_EVENT_KINDS (the server-side SSE allow-list in
  // packages/types/src/events.ts).  If it isn't, the server silently
  // drops the event before it reaches the browser, so the client's
  // invalidation handler never fires and the Inbox (or any other
  // query-driven section) stays stale after that fact lands.
  //
  // The canonical failure: fact.snapshot_recorded sets
  // inbox_status=pending on run_state AFTER fact.run_completed, but
  // the SSE stream never delivers it because it is absent from
  // FEED_EVENT_KINDS.  The inbox=pending list query therefore never
  // refetches and the completed run's worktree item never appears in
  // Watchtower or /inbox without a manual reload.
  test("every fact.* kind in RUN_INVALIDATE_KINDS is present in FEED_EVENT_KINDS so the SSE stream delivers it", () => {
    const feedSet = new Set<string>(FEED_EVENT_KINDS);
    const missingFromFeed: string[] = [];
    for (const kind of __invalidateKinds) {
      if (!kind.startsWith("fact.")) continue;
      if (!feedSet.has(kind)) {
        missingFromFeed.push(kind);
      }
    }
    expect(missingFromFeed).toEqual([]);
  });
});

describe("useGlobalEventStream — FEED_HIDDEN_KINDS decoupling", () => {
  // These tests verify the two invariants for hidden kinds:
  //   (a) They remain in RUN_INVALIDATE_KINDS — invalidation path is intact.
  //   (b) They are in FEED_HIDDEN_KINDS — they will be excluded from feedAtom.
  //   (c) They are in FEED_EVENT_KINDS — SSE delivery is intact.
  //
  // The behavioural integration test lives in Home.live.test.tsx (the
  // fact.snapshot_recorded scenario confirms the Inbox section updates
  // in real time).

  test("fact.snapshot_recorded is in RUN_INVALIDATE_KINDS (invalidation path intact)", () => {
    expect(__invalidateKinds.has("fact.snapshot_recorded")).toBe(true);
  });

  test("fact.snapshot_recorded is in FEED_HIDDEN_KINDS (excluded from feedAtom)", () => {
    expect(FEED_HIDDEN_KINDS.has("fact.snapshot_recorded")).toBe(true);
  });

  test("fact.snapshot_recorded is in FEED_EVENT_KINDS (SSE delivery intact)", () => {
    const feedSet = new Set<string>(FEED_EVENT_KINDS);
    expect(feedSet.has("fact.snapshot_recorded")).toBe(true);
  });

  test("no kind in FEED_HIDDEN_KINDS is absent from RUN_INVALIDATE_KINDS — hidden kinds must still invalidate", () => {
    const missingFromInvalidate: string[] = [];
    for (const kind of FEED_HIDDEN_KINDS) {
      if (!__invalidateKinds.has(kind)) {
        missingFromInvalidate.push(kind);
      }
    }
    expect(missingFromInvalidate).toEqual([]);
  });

  test("no kind in FEED_HIDDEN_KINDS is absent from FEED_EVENT_KINDS — hidden kinds must still arrive over SSE", () => {
    const feedSet = new Set<string>(FEED_EVENT_KINDS);
    const missingFromFeed: string[] = [];
    for (const kind of FEED_HIDDEN_KINDS) {
      if (!feedSet.has(kind)) {
        missingFromFeed.push(kind);
      }
    }
    expect(missingFromFeed).toEqual([]);
  });
});
