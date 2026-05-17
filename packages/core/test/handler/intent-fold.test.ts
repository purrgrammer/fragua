import { describe, expect, test } from "bun:test";
import type { RunStatus } from "@swarm/types";
import fc from "fast-check";
import { foldIntents, type IntentFoldEvent } from "../../src/handler/intent-fold.ts";

function ev(seq: number, type: string, payload: unknown): IntentFoldEvent {
  return {
    seq,
    type,
    payload,
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

  test("steer on paused is buffered (treated like paused_hitl)", () => {
    const out = foldIntents([ev(1, "intent.steering_requested", { text: "hint" })], "paused");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.steering).toBe("hint");
      expect(out.dropped).toEqual([]);
    }
  });

  test("steer on paused_auto is buffered (treated like paused_hitl)", () => {
    const out = foldIntents([ev(1, "intent.steering_requested", { text: "hint" })], "paused_auto");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.steering).toBe("hint");
      expect(out.dropped).toEqual([]);
    }
  });

  test("hitl_input on paused_auto is buffered, not dropped", () => {
    const out = foldIntents([ev(1, "intent.hitl_input", { selected: "A" })], "paused_auto");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.hitlInput).toEqual({ selected: "A" });
      expect(out.dropped).toEqual([]);
    }
  });

  test("intent.max_retries_adjusted writes routing.max_retries_override.<nodeId>", () => {
    const out = foldIntents([ev(1, "intent.max_retries_adjusted", { nodeId: "verify", newLimit: 5 })], "paused");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.routingDelta["max_retries_override.verify"]).toBe(5);
      expect(out.dropped).toEqual([]);
    }
  });

  test("intent.max_retries_adjusted with non-positive newLimit drops with wrong_state", () => {
    const out = foldIntents([ev(1, "intent.max_retries_adjusted", { nodeId: "verify", newLimit: 0 })], "paused");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.dropped[0]?.reason).toBe("wrong_state");
    }
  });

  test("intent.goal_gate_adjusted writes routing.max_goal_gate_retries_override", () => {
    const out = foldIntents([ev(1, "intent.goal_gate_adjusted", { newLimit: 7 })], "paused");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.routingDelta["max_goal_gate_retries_override"]).toBe(7);
    }
  });

  test("intent.max_loops_adjusted writes routing.max_loops_override", () => {
    const out = foldIntents([ev(1, "intent.max_loops_adjusted", { newLimit: 2000 })], "paused");
    expect(out.kind).toBe("proceed");
    if (out.kind === "proceed") {
      expect(out.routingDelta["max_loops_override"]).toBe(2000);
    }
  });

  describe("intent.context_set", () => {
    test("writes key/value into routingDelta and operatorContextWrites", () => {
      const out = foldIntents([ev(1, "intent.context_set", { key: "foo", value: "bar" })], "running");
      expect(out.kind).toBe("proceed");
      if (out.kind === "proceed") {
        expect(out.routingDelta["foo"]).toBe("bar");
        expect(out.operatorContextWrites).toEqual([{ key: "foo", value: "bar" }]);
        expect(out.dropped).toEqual([]);
      }
    });

    test("rejects keys with dots", () => {
      const out = foldIntents([ev(1, "intent.context_set", { key: "a.b", value: "x" })], "running");
      expect(out.kind).toBe("proceed");
      if (out.kind === "proceed") {
        expect(out.dropped[0]?.reason).toBe("wrong_state");
        expect(out.routingDelta["a.b"]).toBeUndefined();
        expect(out.operatorContextWrites).toBeUndefined();
      }
    });

    test("accepts null values", () => {
      const out = foldIntents([ev(1, "intent.context_set", { key: "k", value: null })], "running");
      expect(out.kind).toBe("proceed");
      if (out.kind === "proceed") {
        expect(out.routingDelta["k"]).toBeNull();
      }
    });
  });

  describe("intent.output_set", () => {
    test("surfaces (nodeId, data) on operatorOutputs", () => {
      const out = foldIntents(
        [ev(1, "intent.output_set", { nodeId: "classify", data: { label: "billing" } })],
        "running",
      );
      expect(out.kind).toBe("proceed");
      if (out.kind === "proceed") {
        expect(out.operatorOutputs).toEqual([{ nodeId: "classify", data: { label: "billing" } }]);
        expect(out.dropped).toEqual([]);
      }
    });

    test("rejects empty nodeId", () => {
      const out = foldIntents([ev(1, "intent.output_set", { nodeId: "", data: {} })], "running");
      expect(out.kind).toBe("proceed");
      if (out.kind === "proceed") {
        expect(out.dropped[0]?.reason).toBe("wrong_state");
        expect(out.operatorOutputs).toBeUndefined();
      }
    });
  });
});

// ─── Purity contract (P0.1 of docs/proposals/parallel.md) ────────────
//
// foldIntents is the same reducer for top-level runs and sub-runs (post
// P2). Locking the purity contract here so the cutover can rely on it.

describe("foldIntents — purity contract", () => {
  const ALL_STATUSES: RunStatus[] = [
    "queued",
    "running",
    "paused",
    "paused_hitl",
    "paused_auto",
    "completed",
    "halted",
    "cancelled",
    "quarantined",
  ];

  // Generators over the intent types the fold actually consumes. Keeps
  // payloads in a sensible range; the fold doesn't validate beyond the
  // shape checks it already runs.
  const intentArb = fc.oneof(
    fc.record({
      type: fc.constant("intent.pause_requested" as const),
      payload: fc.constant({}),
    }),
    fc.record({
      type: fc.constant("intent.cancel_requested" as const),
      payload: fc.record({ reason: fc.option(fc.string(), { nil: undefined }) }),
    }),
    fc.record({
      type: fc.constant("intent.steering_requested" as const),
      payload: fc.record({ text: fc.string() }),
    }),
    fc.record({
      type: fc.constant("intent.hitl_input" as const),
      payload: fc.record({
        selected: fc.string({ minLength: 1, maxLength: 5 }),
        note: fc.option(fc.string(), { nil: undefined }),
      }),
    }),
    fc.record({
      type: fc.constant("intent.priority_adjusted" as const),
      payload: fc.record({ newPriority: fc.integer({ min: -100, max: 100 }) }),
    }),
    fc.record({
      type: fc.constant("intent.budget_adjusted" as const),
      payload: fc.record({
        scope: fc.constantFrom("node" as const, "run" as const),
        metric: fc.constantFrom("cost" as const, "tokens" as const),
        newLimit: fc.double({ min: Math.fround(0.0001), max: 1000, noNaN: true, noDefaultInfinity: true }),
      }),
    }),
    fc.record({
      type: fc.constant("intent.max_retries_adjusted" as const),
      payload: fc.record({
        nodeId: fc.string({ minLength: 1, maxLength: 10 }),
        newLimit: fc.integer({ min: 1, max: 100 }),
      }),
    }),
    fc.record({
      type: fc.constant("intent.goal_gate_adjusted" as const),
      payload: fc.record({ newLimit: fc.integer({ min: 1, max: 100 }) }),
    }),
    fc.record({
      type: fc.constant("intent.max_loops_adjusted" as const),
      payload: fc.record({ newLimit: fc.integer({ min: 1, max: 10_000 }) }),
    }),
  );

  function buildEvent(seq: number, sample: { type: string; payload: unknown }): IntentFoldEvent {
    return {
      seq,
      type: sample.type,
      payload: sample.payload,
    };
  }

  test("deterministic: same inputs → byte-identical output", () => {
    fc.assert(
      fc.property(
        fc.array(intentArb, { minLength: 0, maxLength: 20 }),
        fc.constantFrom(...ALL_STATUSES),
        (samples, status) => {
          const intents = samples.map((s, i) => buildEvent(i + 1, s));
          const a = foldIntents(intents, status);
          const b = foldIntents(intents, status);
          expect(a).toEqual(b);
        },
      ),
    );
  });

  test("total over RunStatus: never throws", () => {
    fc.assert(
      fc.property(
        fc.array(intentArb, { minLength: 0, maxLength: 10 }),
        fc.constantFrom(...ALL_STATUSES),
        (samples, status) => {
          const intents = samples.map((s, i) => buildEvent(i + 1, s));
          expect(() => foldIntents(intents, status)).not.toThrow();
        },
      ),
    );
  });

  test("does not mutate the input array (no in-place sort or push)", () => {
    fc.assert(
      fc.property(
        fc.array(intentArb, { minLength: 0, maxLength: 10 }),
        fc.constantFrom(...ALL_STATUSES),
        (samples, status) => {
          const intents = samples.map((s, i) => buildEvent(i + 1, s));
          const snapshot = JSON.parse(JSON.stringify(intents));
          foldIntents(intents, status);
          expect(intents).toEqual(snapshot);
        },
      ),
    );
  });

  test("empty input → proceed with no side-effect fields", () => {
    for (const status of ALL_STATUSES) {
      const out = foldIntents([], status);
      expect(out.kind).toBe("proceed");
      if (out.kind === "proceed") {
        expect(out.shouldPause).toBe(false);
        expect(out.shouldPauseAfterDispatch).toBe(false);
        expect(out.appliedSeqs).toEqual([]);
        expect(out.dropped).toEqual([]);
        expect(out.routingDelta).toEqual({});
        expect(out.steering).toBeUndefined();
        expect(out.hitlInput).toBeUndefined();
      }
    }
  });
});
