// Pure-function tests for GlobalFeed's payload-aware verb resolver.

import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "@swarm/types";
import { isFeedRowHidden, metaForEvent } from "../../src/components/GlobalFeed.tsx";

function evt(type: string, payload: Record<string, unknown> = {}): FeedEvent {
  return { runId: "r", seq: 1, type, writer: "web", payload, ts: 0 } as unknown as FeedEvent;
}

describe("metaForEvent", () => {
  test("fact.run_resumed verb varies by fromStatus", () => {
    expect(metaForEvent(evt("fact.run_resumed", { fromStatus: "paused_hitl" })).verb).toBe("resumed");
    expect(metaForEvent(evt("fact.run_resumed", { fromStatus: "paused_provider_error" })).verb).toBe("resumed (retry)");
    expect(metaForEvent(evt("fact.run_resumed", {})).verb).toBe("resumed");
  });

  test("static verbs pass through unchanged", () => {
    expect(metaForEvent(evt("fact.run_started")).verb).toBe("started");
    expect(metaForEvent(evt("fact.run_completed")).verb).toBe("completed");
    expect(metaForEvent(evt("fact.run_paused_hitl")).verb).toBe("awaiting input");
  });

  test("unknown event types fall back to empty verb", () => {
    expect(metaForEvent(evt("never.heard.of.it")).verb).toBe("");
  });
});

describe("isFeedRowHidden", () => {
  test("hides fact.run_branched (mechanical worktree noise)", () => {
    expect(isFeedRowHidden(evt("fact.run_branched", { branch: "swarm/runs/abc" }))).toBe(true);
  });

  test("keeps user-facing run lifecycle facts visible", () => {
    expect(isFeedRowHidden(evt("fact.run_started"))).toBe(false);
    expect(isFeedRowHidden(evt("fact.run_completed"))).toBe(false);
    expect(isFeedRowHidden(evt("fact.run_paused_hitl"))).toBe(false);
  });
});
