// Pure-function tests for GlobalFeed's payload-aware verb resolver.

import type { FeedEvent } from "@fragua/types";
import { describe, expect, test } from "vitest";
import { metaForEvent } from "../../src/components/GlobalFeed.tsx";
import { FEED_HIDDEN_KINDS } from "../../src/lib/globalFeed.ts";

function evt(type: string, payload: Record<string, unknown> = {}): FeedEvent {
  return { runId: "r", seq: 1, type, writer: "client", payload, ts: 0 } as unknown as FeedEvent;
}

/** Asserts metaForEvent returned a non-null meta — for tests that exercise
 *  a known KIND_META entry. Keeps the call sites terse without sprinkling
 *  `!` non-null assertions on every `.verb` access. */
function meta(type: string, payload: Record<string, unknown> = {}) {
  const m = metaForEvent(evt(type, payload));
  if (m == null) throw new Error(`metaForEvent returned null for ${type}`);
  return m;
}

describe("metaForEvent", () => {
  test("fact.run_resumed verb varies by fromStatus", () => {
    expect(meta("fact.run_resumed", { fromStatus: "paused_human" }).verb).toBe("resumed");
    expect(meta("fact.run_resumed", { fromStatus: "paused" }).verb).toBe("retrying");
    expect(meta("fact.run_resumed", {}).verb).toBe("resumed");
  });

  test("static verbs pass through unchanged", () => {
    expect(meta("fact.run_started").verb).toBe("started");
    expect(meta("fact.run_completed").verb).toBe("completed");
    expect(meta("fact.run_paused_human").verb).toBe("needs input");
  });

  test("unknown event types return null so FeedRow skips render", () => {
    // Facts the server delivers over SSE for cache-invalidation only
    // (e.g. fact.snapshot_recorded flipping inbox_status=pending) must
    // never appear as a ghost row with a bare icon and an empty verb.
    // Returning null forces the row to skip rendering entirely.
    expect(metaForEvent(evt("never.heard.of.it"))).toBe(null);
    expect(metaForEvent(evt("fact.snapshot_recorded"))).toBe(null);
  });

  test("fact.run_paused honours pause-family palette: operator → yellow, hitl → orange, halted → red", () => {
    // operator-resumable reasons → paused (yellow)
    const opMeta = meta("fact.run_paused", { reason: "operator", nodeId: "n" });
    expect(opMeta.iconClass).toBe("text-sw-accent-pause");
    expect(opMeta.borderVar).toBe("var(--sw-accent-pause)");
    expect(opMeta.verb).toBe("paused");
    expect(opMeta.attention).toBe(true);

    const budgetMeta = meta("fact.run_paused", {
      reason: "budget",
      nodeId: "n",
      scope: "run",
      metric: "cost",
      limit: 1,
      actual: 2,
    });
    expect(budgetMeta.iconClass).toBe("text-sw-accent-pause");

    // workflow-asks → hitl (orange)
    const hitlMeta = meta("fact.run_paused_human", { nodeId: "n", label: "?", options: [] });
    expect(hitlMeta.iconClass).toBe("text-sw-accent-pause-hitl");
    expect(hitlMeta.borderVar).toBe("var(--sw-accent-pause-hitl)");

    // terminal halt → destructive (red), strip + icon
    const haltedMeta = meta("fact.run_halted", { reason: "error" });
    expect(haltedMeta.iconClass).toBe("text-sw-accent-error");
    expect(haltedMeta.borderVar).toBe("var(--sw-accent-error)");
    expect(haltedMeta.attention).toBe(true);
  });

  test("fact.run_paused with auto-wake reason → paused_auto (blue) via reason peek", () => {
    const providerRetry = meta("fact.run_paused", {
      reason: "provider_retry",
      nodeId: "n",
      httpStatus: 429,
      provider: "anthropic",
      errorMessage: "429 Too Many Requests",
      attempt: 1,
      resumeAt: Date.now() + 30_000,
    });
    expect(providerRetry.iconClass).toBe("text-sw-accent-pause-auto");
    expect(providerRetry.borderVar).toBe("var(--sw-accent-pause-auto)");
    expect(providerRetry.verb).toBe("auto-retry");

    const handlerRetry = meta("fact.run_paused", {
      reason: "handler_retry",
      nodeId: "verify",
      attempt: 2,
      delayMs: 1000,
      resumeAt: Date.now() + 1_000,
      maxRetries: 3,
    });
    expect(handlerRetry.iconClass).toBe("text-sw-accent-pause-auto");
  });
});

describe("FEED_HIDDEN_KINDS", () => {
  test("fact.snapshot_recorded is in FEED_HIDDEN_KINDS so it never appears as an Activity row", () => {
    expect(FEED_HIDDEN_KINDS.has("fact.snapshot_recorded")).toBe(true);
  });

  test("common lifecycle facts are NOT in FEED_HIDDEN_KINDS — they must render as Activity rows", () => {
    expect(FEED_HIDDEN_KINDS.has("fact.run_completed")).toBe(false);
    expect(FEED_HIDDEN_KINDS.has("fact.run_started")).toBe(false);
    expect(FEED_HIDDEN_KINDS.has("fact.run_halted")).toBe(false);
    expect(FEED_HIDDEN_KINDS.has("fact.run_paused_human")).toBe(false);
  });
});

describe("metaForEvent — operator-action git-centric verbs", () => {
  test("fact.run_accepted → short verb 'accepted'", () => {
    const m = meta("fact.run_accepted", { sha: "tip1", replayed: 0, tailStaged: true });
    expect(m.verb).toBe("accepted");
    expect(m.attention).toBeFalsy();
  });

  test("fact.run_discarded → 'discarded'", () => {
    const m = meta("fact.run_discarded", { refs: [] });
    expect(m.verb).toBe("discarded");
    expect(m.attention).toBeFalsy();
  });

  test("operator-action facts always return single-word verbs regardless of payload", () => {
    expect(meta("fact.run_accepted", {}).verb).toBe("accepted");
    expect(meta("fact.run_discarded", {}).verb).toBe("discarded");
  });
});
