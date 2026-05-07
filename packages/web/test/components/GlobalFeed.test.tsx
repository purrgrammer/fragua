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
    expect(metaForEvent(evt("fact.run_resumed", { fromStatus: "paused" })).verb).toBe("retrying");
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
    const hitlMeta = metaForEvent(evt("fact.run_paused_hitl", { nodeId: "n", label: "?", options: [] }));
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
