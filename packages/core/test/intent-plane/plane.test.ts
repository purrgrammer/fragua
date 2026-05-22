import { describe, expect, test } from "bun:test";
import type { IEventStore } from "@fragua/store";
import type { IntentEvent } from "@fragua/types";
import { makeIntentPlane } from "../../src/intent-plane/index.ts";

// build* never touches the store, so a stub that records appendIntent is
// enough for the whole suite. The pure build half is what we exhaustively
// cover; commit is a single passthrough, smoke-tested at the end.
function rig() {
  const appended: { runId: string; intent: IntentEvent }[] = [];
  const store = {
    appendIntent(runId: string, intent: IntentEvent) {
      appended.push({ runId, intent });
      return { seq: appended.length, ts: 0 };
    },
  } as unknown as IEventStore;
  return { plane: makeIntentPlane({ store }), appended };
}

describe("intent plane — build* (validate + construct)", () => {
  test("steer: text required, constructs intent.steering_requested", () => {
    const { plane } = rig();
    expect(plane.buildSteer({ text: "go left" })).toEqual({
      ok: true,
      intent: { type: "intent.steering_requested", payload: { text: "go left" } },
    });
    expect(plane.buildSteer({ text: "" }).ok).toBe(false);
    expect(plane.buildSteer({}).ok).toBe(false);
    expect(plane.buildSteer({ text: "x", extra: 1 }).ok).toBe(false); // additionalProperties
  });

  test("pause: empty body, constructs intent.pause_requested", () => {
    const { plane } = rig();
    expect(plane.buildPause({})).toEqual({ ok: true, intent: { type: "intent.pause_requested", payload: {} } });
    expect(plane.buildPause({ nope: 1 }).ok).toBe(false);
  });

  test("cancel: optional reason omitted when absent", () => {
    const { plane } = rig();
    expect(plane.buildCancel({})).toEqual({ ok: true, intent: { type: "intent.cancel_requested", payload: {} } });
    expect(plane.buildCancel({ reason: "obsolete" })).toEqual({
      ok: true,
      intent: { type: "intent.cancel_requested", payload: { reason: "obsolete" } },
    });
  });

  test("human: route required (non-empty), note optional", () => {
    const { plane } = rig();
    expect(plane.buildHuman({ route: "approve" })).toEqual({
      ok: true,
      intent: { type: "intent.human_input", payload: { route: "approve" } },
    });
    expect(plane.buildHuman({ route: "approve", note: "lgtm" })).toEqual({
      ok: true,
      intent: { type: "intent.human_input", payload: { route: "approve", note: "lgtm" } },
    });
    expect(plane.buildHuman({}).ok).toBe(false);
    expect(plane.buildHuman({ route: "" }).ok).toBe(false);
  });

  test("resume: optional note", () => {
    const { plane } = rig();
    expect(plane.buildResume({})).toEqual({ ok: true, intent: { type: "intent.resume", payload: {} } });
    expect(plane.buildResume({ note: "fixed creds" }).ok).toBe(true);
  });

  test("unquarantine: resolution ∈ enum", () => {
    const { plane } = rig();
    expect(plane.buildUnquarantine({ resolution: "retry" })).toEqual({
      ok: true,
      intent: { type: "intent.unquarantine", payload: { resolution: "retry" } },
    });
    expect(plane.buildUnquarantine({ resolution: "treat_as_done", note: "verified" }).ok).toBe(true);
    expect(plane.buildUnquarantine({ resolution: "bogus" }).ok).toBe(false);
    expect(plane.buildUnquarantine({}).ok).toBe(false);
  });

  test("priority: newPriority is any number (incl. negative)", () => {
    const { plane } = rig();
    expect(plane.buildPriority({ newPriority: 10 })).toEqual({
      ok: true,
      intent: { type: "intent.priority_adjusted", payload: { newPriority: 10 } },
    });
    expect(plane.buildPriority({ newPriority: -5 }).ok).toBe(true);
    expect(plane.buildPriority({}).ok).toBe(false);
    expect(plane.buildPriority({ newPriority: "10" }).ok).toBe(false);
  });

  test("budget: scope/metric enums + newLimit > 0 finite", () => {
    const { plane } = rig();
    expect(plane.buildBudget({ scope: "run", metric: "cost", newLimit: 5 })).toEqual({
      ok: true,
      intent: { type: "intent.budget_adjusted", payload: { scope: "run", metric: "cost", newLimit: 5 } },
    });
    for (const bad of [
      { scope: "global", metric: "cost", newLimit: 5 },
      { scope: "run", metric: "time", newLimit: 5 },
      { scope: "run", metric: "cost", newLimit: 0 },
      { scope: "run", metric: "cost", newLimit: -1 },
      { scope: "run", metric: "cost", newLimit: Number.POSITIVE_INFINITY },
      { scope: "run", metric: "cost" },
    ]) {
      expect(plane.buildBudget(bad).ok).toBe(false);
    }
  });

  test("max_retries / goal_gate / max_loops: newLimit > 0; max_retries needs nodeId", () => {
    const { plane } = rig();
    expect(plane.buildMaxRetries({ nodeId: "build", newLimit: 3 }).ok).toBe(true);
    expect(plane.buildMaxRetries({ newLimit: 3 }).ok).toBe(false);
    expect(plane.buildMaxRetries({ nodeId: "", newLimit: 3 }).ok).toBe(false);
    expect(plane.buildGoalGate({ newLimit: 2 }).ok).toBe(true);
    expect(plane.buildGoalGate({ newLimit: 0 }).ok).toBe(false);
    expect(plane.buildMaxLoops({ newLimit: 20 }).ok).toBe(true);
    expect(plane.buildMaxLoops({ newLimit: -1 }).ok).toBe(false);
  });

  test("a non-object body is rejected, not thrown", () => {
    const { plane } = rig();
    for (const body of [null, undefined, 42, "x", []]) {
      expect(plane.buildSteer(body).ok).toBe(false);
    }
  });
});

describe("intent plane — commit", () => {
  test("forwards the built intent to store.appendIntent and returns seq", () => {
    const { plane, appended } = rig();
    const built = plane.buildPause({});
    if (!built.ok) throw new Error("build failed");
    const { seq } = plane.commit("run-1", built.intent);
    expect(seq).toBe(1);
    expect(appended).toEqual([{ runId: "run-1", intent: { type: "intent.pause_requested", payload: {} } }]);
  });
});
