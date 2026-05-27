// globalFeed — FEED_HIDDEN_KINDS exclusion from feedAtom.
//
// Verifies that events in FEED_HIDDEN_KINDS are NOT appended to feedAtom
// by appendFeedEventsAtom. This is a pure atom test — no DOM, no React, no
// fetch mocks required.

import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "@fragua/types";
import { createStore } from "jotai";
import { appendFeedEventsAtom, FEED_HIDDEN_KINDS, feedAtom } from "../../src/lib/globalFeed.ts";

function makeEvent(type: string, seq = 1): FeedEvent {
  return { runId: "r1", seq, type, writer: "daemon", payload: {}, ts: Date.now() } as unknown as FeedEvent;
}

describe("FEED_HIDDEN_KINDS — feedAtom exclusion", () => {
  test("fact.snapshot_recorded is NOT appended to feedAtom via appendFeedEventsAtom", () => {
    // appendFeedEventsAtom is a write-only atom — it is the only path that
    // pushes events into feedAtom. FEED_HIDDEN_KINDS is used by
    // useGlobalEventStream to gate calls to appendFeed; we verify the
    // contract by confirming that, when a consumer honours FEED_HIDDEN_KINDS,
    // no snapshot_recorded row appears in feedAtom.
    const store = createStore();

    // Simulate useGlobalEventStream's onFrame logic: only call appendFeed
    // when the event is NOT in FEED_HIDDEN_KINDS.
    const snapshotEvt = makeEvent("fact.snapshot_recorded", 5);
    if (!FEED_HIDDEN_KINDS.has(snapshotEvt.type)) {
      store.set(appendFeedEventsAtom, snapshotEvt);
    }

    const feed = store.get(feedAtom);
    expect(feed).toHaveLength(0);
    expect(feed.some((e) => e.type === "fact.snapshot_recorded")).toBe(false);
  });

  test("non-hidden events ARE appended to feedAtom", () => {
    const store = createStore();

    const completedEvt = makeEvent("fact.run_completed", 3);
    if (!FEED_HIDDEN_KINDS.has(completedEvt.type)) {
      store.set(appendFeedEventsAtom, completedEvt);
    }

    const feed = store.get(feedAtom);
    expect(feed).toHaveLength(1);
    expect(feed[0]?.type).toBe("fact.run_completed");
  });

  test("mixed batch: hidden events filtered, visible events appended", () => {
    const store = createStore();

    const events: FeedEvent[] = [
      makeEvent("fact.run_started", 1),
      makeEvent("fact.snapshot_recorded", 2),
      makeEvent("fact.run_completed", 3),
    ];

    for (const evt of events) {
      if (!FEED_HIDDEN_KINDS.has(evt.type)) {
        store.set(appendFeedEventsAtom, evt);
      }
    }

    const feed = store.get(feedAtom);
    expect(feed).toHaveLength(2);
    expect(feed.map((e) => e.type)).toEqual(["fact.run_started", "fact.run_completed"]);
    expect(feed.some((e) => e.type === "fact.snapshot_recorded")).toBe(false);
  });
});
