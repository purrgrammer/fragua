import type { FeedEvent } from "@fragua/types";
import { createStore } from "jotai";
import { describe, expect, test } from "vitest";
import { appendFeedEventsAtom, FEED_HIDDEN_KINDS, feedAtom } from "./globalFeed.ts";

function makeEvent(type: string, seq = 1): FeedEvent {
  return { type, runId: "run-1", seq, ts: 1000 } as FeedEvent;
}

describe("appendFeedEventsAtom — FEED_HIDDEN_KINDS filter", () => {
  test("fact.snapshot_recorded is in FEED_HIDDEN_KINDS", () => {
    expect(FEED_HIDDEN_KINDS.has("fact.snapshot_recorded")).toBe(true);
  });

  test("hidden kind is NOT added to feedAtom (backfill batch)", () => {
    const store = createStore();
    store.set(appendFeedEventsAtom, [makeEvent("fact.snapshot_recorded", 1)]);
    expect(store.get(feedAtom)).toHaveLength(0);
  });

  test("non-hidden kind IS added to feedAtom", () => {
    const store = createStore();
    store.set(appendFeedEventsAtom, [makeEvent("fact.run_completed", 1)]);
    expect(store.get(feedAtom)).toHaveLength(1);
  });

  test("mixed batch: hidden kind dropped, non-hidden kind kept", () => {
    const store = createStore();
    store.set(appendFeedEventsAtom, [
      makeEvent("fact.run_completed", 1),
      makeEvent("fact.snapshot_recorded", 2),
      makeEvent("fact.run_started", 3),
    ]);
    const feed = store.get(feedAtom);
    expect(feed).toHaveLength(2);
    expect(feed.some((e) => e.type === "fact.snapshot_recorded")).toBe(false);
  });
});
