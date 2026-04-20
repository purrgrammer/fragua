import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "@swarm/store";
import { foldIntents } from "../../src/handler/intent-fold.ts";

function ev(seq: number, type: string, payload: unknown): StoredEvent {
  return {
    runId: "r",
    seq,
    type: type as StoredEvent["type"],
    writer: "web",
    payload: payload as StoredEvent["payload"],
    ts: seq,
  };
}

describe("foldIntents", () => {
  test("cancel short-circuits regardless of order", () => {
    const out = foldIntents([
      ev(1, "intent.pause_requested", {}),
      ev(2, "intent.steering_requested", { text: "hi" }),
      ev(3, "intent.cancel_requested", { reason: "user" }),
      ev(4, "intent.hitl_input", { input: { answer: "yes" } }),
    ]);
    expect(out.kind).toBe("cancel");
    if (out.kind === "cancel") {
      expect(out.intentSeq).toBe(3);
      expect(out.reason).toBe("user");
    }
  });

  test("merges steering texts and surfaces hitlInput", () => {
    const out = foldIntents([
      ev(1, "intent.steering_requested", { text: "focus tests" }),
      ev(2, "intent.steering_requested", { text: "skip lint" }),
      ev(3, "intent.hitl_input", { input: 42 }),
    ]);
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.steering).toBe("focus tests\nskip lint");
      expect(out.hitlInput).toBe(42);
      expect(out.shouldPause).toBe(false);
      expect(out.appliedSeqs).toEqual([1, 2, 3]);
    }
  });

  test("pause without cancel triggers shouldPause", () => {
    const out = foldIntents([ev(1, "intent.pause_requested", {})]);
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") expect(out.shouldPause).toBe(true);
  });

  test("empty intents → proceed with no changes", () => {
    const out = foldIntents([]);
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.shouldPause).toBe(false);
      expect(out.steering).toBeUndefined();
      expect(out.hitlInput).toBeUndefined();
    }
  });

  test("priority adjustment lands in routingDelta", () => {
    const out = foldIntents([ev(1, "intent.priority_adjusted", { newPriority: 9, note: "bump" })]);
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.routingDelta["priority"]).toBe(9);
    }
  });
});
