// Pure-function tests for GlobalFeed's payload-aware verb resolver.

import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "@swarm/types";
import { isFeedRowHidden, metaForEvent } from "../../src/components/GlobalFeed.tsx";

function evt(type: string, payload: Record<string, unknown> = {}): FeedEvent {
  return { runId: "r", seq: 1, type, writer: "web", payload, ts: 0 } as unknown as FeedEvent;
}

describe("metaForEvent", () => {
  test("fact.run_resumed verb varies by fromStatus", () => {
    expect(metaForEvent(evt("fact.run_resumed", { fromStatus: "paused_human" })).verb).toBe("resumed");
    expect(metaForEvent(evt("fact.run_resumed", { fromStatus: "paused" })).verb).toBe("retrying");
    expect(metaForEvent(evt("fact.run_resumed", {})).verb).toBe("resumed");
  });

  test("static verbs pass through unchanged", () => {
    expect(metaForEvent(evt("fact.run_started")).verb).toBe("started");
    expect(metaForEvent(evt("fact.run_completed")).verb).toBe("completed");
    expect(metaForEvent(evt("fact.run_paused_human")).verb).toBe("awaiting input");
  });

  test("unknown event types fall back to empty verb", () => {
    expect(metaForEvent(evt("never.heard.of.it")).verb).toBe("");
  });

  test("fact.run_paused honours pause-family palette: operator → yellow, hitl → orange, halted → red", () => {
    // operator-resumable reasons → paused (yellow)
    const opMeta = metaForEvent(evt("fact.run_paused", { reason: "operator", nodeId: "n" }));
    expect(opMeta.iconClass).toBe("text-sw-accent-pause");
    expect(opMeta.borderVar).toBe("var(--sw-accent-pause)");
    expect(opMeta.verb).toBe("paused");
    expect(opMeta.attention).toBe(true);

    const budgetMeta = metaForEvent(
      evt("fact.run_paused", { reason: "budget", nodeId: "n", scope: "run", metric: "cost", limit: 1, actual: 2 }),
    );
    expect(budgetMeta.iconClass).toBe("text-sw-accent-pause");

    // workflow-asks → hitl (orange)
    const hitlMeta = metaForEvent(evt("fact.run_paused_human", { nodeId: "n", label: "?", options: [] }));
    expect(hitlMeta.iconClass).toBe("text-sw-accent-pause-hitl");
    expect(hitlMeta.borderVar).toBe("var(--sw-accent-pause-hitl)");

    // terminal halt → destructive (red), strip + icon
    const haltedMeta = metaForEvent(evt("fact.run_halted", { reason: "error" }));
    expect(haltedMeta.iconClass).toBe("text-sw-accent-error");
    expect(haltedMeta.borderVar).toBe("var(--sw-accent-error)");
    expect(haltedMeta.attention).toBe(true);
  });

  test("fact.run_paused with auto-wake reason → paused_auto (blue) via reason peek", () => {
    const providerRetry = metaForEvent(
      evt("fact.run_paused", {
        reason: "provider_retry",
        nodeId: "n",
        httpStatus: 429,
        provider: "anthropic",
        errorMessage: "429 Too Many Requests",
        attempt: 1,
        resumeAt: Date.now() + 30_000,
      }),
    );
    expect(providerRetry.iconClass).toBe("text-sw-accent-pause-auto");
    expect(providerRetry.borderVar).toBe("var(--sw-accent-pause-auto)");
    expect(providerRetry.verb).toBe("auto-retry");

    const handlerRetry = metaForEvent(
      evt("fact.run_paused", {
        reason: "handler_retry",
        nodeId: "verify",
        attempt: 2,
        delayMs: 1000,
        resumeAt: Date.now() + 1_000,
        maxRetries: 3,
      }),
    );
    expect(handlerRetry.iconClass).toBe("text-sw-accent-pause-auto");
  });
});

describe("metaForEvent — operator-action git-centric verbs", () => {
  test("fact.run_accepted → short verb 'accepted'", () => {
    const m = metaForEvent(evt("fact.run_accepted", { sha: "tip1", replayed: 0, tailStaged: true }));
    expect(m.verb).toBe("accepted");
    expect(m.attention).toBeFalsy();
  });

  test("fact.run_discarded → 'discarded'", () => {
    const m = metaForEvent(evt("fact.run_discarded", { refs: [] }));
    expect(m.verb).toBe("discarded");
    expect(m.attention).toBeFalsy();
  });

  test("operator-action facts always return single-word verbs regardless of payload", () => {
    expect(metaForEvent(evt("fact.run_accepted", {})).verb).toBe("accepted");
    expect(metaForEvent(evt("fact.run_discarded", {})).verb).toBe("discarded");
  });
});

describe("isFeedRowHidden", () => {
  test("hides fact.subrun_completed as defense in depth", () => {
    expect(isFeedRowHidden(evt("fact.subrun_completed", { runId: "child-1" }))).toBe(true);
  });

  test("does not hide fact.message_appended (server no longer ships it)", () => {
    expect(isFeedRowHidden(evt("fact.message_appended", { ordinal: 0, role: "assistant" }))).toBe(false);
  });

  test("does not hide fact.run_accepted / fanout_started / fanout_completed", () => {
    // fact.run_accepted is in FEED_EVENT_KINDS and ships through the feed.
    expect(isFeedRowHidden(evt("fact.run_accepted", { sha: "tip1", replayed: 1, tailStaged: false }))).toBe(false);
    expect(isFeedRowHidden(evt("fact.fanout_started", { fanoutId: "f1", count: 2 }))).toBe(false);
    expect(isFeedRowHidden(evt("fact.fanout_completed", { fanoutId: "f1" }))).toBe(false);
  });

  test("keeps user-facing run lifecycle facts visible", () => {
    expect(isFeedRowHidden(evt("fact.run_started"))).toBe(false);
    expect(isFeedRowHidden(evt("fact.run_completed"))).toBe(false);
    expect(isFeedRowHidden(evt("fact.run_paused_human"))).toBe(false);
  });
});
