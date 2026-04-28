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
  test("cancel short-circuits regardless of order; non-cancel intents land in dropped", () => {
    const out = foldIntents(
      [
        ev(1, "intent.pause_requested", {}),
        ev(2, "intent.steering_requested", { text: "hi" }),
        ev(3, "intent.cancel_requested", { reason: "user" }),
        ev(4, "intent.hitl_input", { selected: "A" }),
      ],
      "running",
    );
    expect(out.kind).toBe("cancel");
    if (out.kind === "cancel") {
      expect(out.intentSeq).toBe(3);
      expect(out.reason).toBe("user");
      const dropped = out.dropped.map((d) => `${d.seq}:${d.type}:${d.reason}`).sort();
      expect(dropped).toEqual([
        "1:intent.pause_requested:superseded_by_cancel",
        "2:intent.steering_requested:superseded_by_cancel",
        "4:intent.hitl_input:superseded_by_cancel",
      ]);
    }
  });

  test("merges steering texts and surfaces hitlInput", () => {
    const out = foldIntents(
      [
        ev(1, "intent.steering_requested", { text: "focus tests" }),
        ev(2, "intent.steering_requested", { text: "skip lint" }),
        ev(3, "intent.hitl_input", { selected: "A" }),
      ],
      "running",
    );
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.steering).toBe("focus tests\nskip lint");
      expect(out.hitlInput).toEqual({ selected: "A" });
      expect(out.shouldPause).toBe(false);
      expect(out.shouldPauseAfterDispatch).toBe(false);
      expect(out.appliedSeqs).toEqual([1, 2, 3]);
      expect(out.dropped).toEqual([]);
    }
  });

  test("pause without cancel triggers shouldPause", () => {
    const out = foldIntents([ev(1, "intent.pause_requested", {})], "running");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.shouldPause).toBe(true);
      expect(out.shouldPauseAfterDispatch).toBe(false);
    }
  });

  test("pause + steer → steer applies, pause defers (shouldPauseAfterDispatch)", () => {
    const out = foldIntents(
      [ev(1, "intent.steering_requested", { text: "focus" }), ev(2, "intent.pause_requested", {})],
      "running",
    );
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.steering).toBe("focus");
      expect(out.shouldPause).toBe(false);
      expect(out.shouldPauseAfterDispatch).toBe(true);
      // Pause is APPLIED (just deferred), so it does not appear in dropped.
      expect(out.dropped).toEqual([]);
    }
  });

  test("pause + hitl → hitl applies, pause defers", () => {
    const out = foldIntents(
      [ev(1, "intent.pause_requested", {}), ev(2, "intent.hitl_input", { selected: "A", note: "answer" })],
      "running",
    );
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.hitlInput).toEqual({ selected: "A", note: "answer" });
      expect(out.shouldPause).toBe(false);
      expect(out.shouldPauseAfterDispatch).toBe(true);
      expect(out.dropped).toEqual([]);
    }
  });

  test("empty intents → proceed with no changes", () => {
    const out = foldIntents([], "running");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.shouldPause).toBe(false);
      expect(out.shouldPauseAfterDispatch).toBe(false);
      expect(out.steering).toBeUndefined();
      expect(out.hitlInput).toBeUndefined();
      expect(out.dropped).toEqual([]);
    }
  });

  test("priority adjustment lands in routingDelta", () => {
    const out = foldIntents([ev(1, "intent.priority_adjusted", { newPriority: 9, note: "bump" })], "running");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.routingDelta["priority"]).toBe(9);
    }
  });

  test("multiple hitl_input → last-wins, earlier dropped with later_input_won", () => {
    const out = foldIntents(
      [
        ev(1, "intent.hitl_input", { selected: "A" }),
        ev(2, "intent.hitl_input", { selected: "B" }),
        ev(3, "intent.hitl_input", { selected: "C" }),
      ],
      "running",
    );
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.hitlInput).toEqual({ selected: "C" });
      const dropped = out.dropped.map((d) => `${d.seq}:${d.reason}`).sort();
      expect(dropped).toEqual(["1:later_input_won", "2:later_input_won"]);
    }
  });

  test("multiple priority_adjusted → last-wins, earlier dropped", () => {
    const out = foldIntents(
      [
        ev(1, "intent.priority_adjusted", { newPriority: 1, note: "" }),
        ev(2, "intent.priority_adjusted", { newPriority: 5, note: "" }),
        ev(3, "intent.priority_adjusted", { newPriority: 3, note: "" }),
      ],
      "running",
    );
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.routingDelta["priority"]).toBe(3);
      expect(out.dropped.length).toBe(2);
      expect(out.dropped.every((d) => d.reason === "later_input_won")).toBe(true);
    }
  });

  test("pause on already-paused run is dropped with reason already_paused", () => {
    const out = foldIntents([ev(1, "intent.pause_requested", {})], "paused_hitl");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.shouldPause).toBe(false);
      expect(out.dropped).toEqual([{ seq: 1, type: "intent.pause_requested", reason: "already_paused" }]);
    }
  });

  test("hitl_input on a quarantined run is dropped with reason wrong_state", () => {
    const out = foldIntents([ev(1, "intent.hitl_input", { selected: "A" })], "quarantined");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.hitlInput).toBeUndefined();
      expect(out.dropped).toEqual([{ seq: 1, type: "intent.hitl_input", reason: "wrong_state" }]);
    }
  });

  test("intent.resume reaching the dispatch fold is a no-op (handled by wakePending)", () => {
    const out = foldIntents([ev(1, "intent.resume", { note: "topped up" })], "running");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.appliedSeqs).toEqual([1]);
      expect(out.dropped).toEqual([]);
      expect(out.steering).toBeUndefined();
      expect(out.hitlInput).toBeUndefined();
      expect(out.shouldPause).toBe(false);
    }
  });

  test("steer on paused_provider_error is buffered (treated like paused_hitl)", () => {
    const out = foldIntents([ev(1, "intent.steering_requested", { text: "hint" })], "paused_provider_error");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.steering).toBe("hint");
      expect(out.dropped).toEqual([]);
    }
  });
});
