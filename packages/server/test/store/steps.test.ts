// Unit tests for the eventsToSteps reducer.

import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "@swarm/store";
import { attachStepAggregates, eventsToSteps, fillOrphanDurations } from "../../src/store/steps.ts";

function ev(type: string, ts: number, payload: Record<string, unknown>): StoredEvent {
  return { runId: "r", seq: ts, type, writer: "daemon", payload, ts };
}

describe("eventsToSteps", () => {
  test("returns empty array when no llm.start events are present", () => {
    const events = [ev("fact.run_started", 1000, { startNode: "n1" })];
    expect(eventsToSteps(events)).toEqual([]);
  });

  test("one llm.start → one step with the wire-shape envelope", () => {
    const events = [
      ev("fact.node_started", 900_000, { nodeId: "n1" }),
      ev("llm.start", 1_000_000, {
        nodeId: "n1",
        iteration: { n: 1, max: 3 },
        provider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
        fidelity: "compact",
        // Body fields below are intentionally ignored by the trimmed
        // reducer — the snapshot is for CostInspector only.
        prompt: "Do the thing",
        system_prompt: "You are a helpful assistant",
        thread_id: "dev",
        allowed_tools: ["bash"],
        denied_tools: [],
        messages: [{ role: "user", content: "hi" }],
        context_files: [],
      }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(1);
    const s = steps[0]!;
    expect(s.stepIdx).toBe(0);
    expect(s.nodeId).toBe("n1");
    expect(s.iteration).toEqual({ n: 1, max: 3 });
    expect(s.provider).toBe("openrouter");
    expect(s.model).toBe("anthropic/claude-haiku-4.5");
    expect(s.fidelity).toBe("compact");
    // `startedAt` anchors to fact.node_started.ts (truthful), not
    // llm.start.ts (pi-agent-core-buffered).
    expect(s.startedAt).toBe(new Date(900_000).toISOString());
    // Body fields should not appear on the snapshot at all.
    expect(s).not.toHaveProperty("prompt");
    expect(s).not.toHaveProperty("systemPrompt");
    expect(s).not.toHaveProperty("messages");
    expect(s).not.toHaveProperty("allowedTools");
    expect(s).not.toHaveProperty("threadId");
    expect(s).not.toHaveProperty("finalText");
  });

  test("startedAt anchors to fact.node_started.ts when present (pi-agent-core buffers llm.start)", () => {
    // pi-agent-core flushes llm.start at the end of the call, so its
    // ts trails the actual node start by tens of seconds. The reducer
    // must use fact.node_started.ts (daemon-written sync) instead.
    const events = [
      ev("fact.node_started", 1_000, { nodeId: "n1" }),
      ev("llm.start", 25_000, { nodeId: "n1" }), // 24s later — buffered
    ];
    const [s] = eventsToSteps(events);
    expect(s!.startedAt).toBe(new Date(1_000).toISOString());
  });

  test("startedAt falls back to llm.start.ts when no fact.node_started precedes it", () => {
    // Defensive: older runs / weird event orderings shouldn't crash.
    const events = [ev("llm.start", 5_000, { nodeId: "n1" })];
    const [s] = eventsToSteps(events);
    expect(s!.startedAt).toBe(new Date(5_000).toISOString());
  });

  test("loop iterations: first step uses fact.node_started, subsequent use llm.start.ts", () => {
    // We don't have a per-iteration fact event, so loop iterations 2+
    // fall back to the (buffered) llm.start.ts. Better than nothing —
    // and the simple non-loop case (the common one) is fully truthful.
    const events = [
      ev("fact.node_started", 900, { nodeId: "body" }),
      ev("llm.start", 1_000, { nodeId: "body", iteration: { n: 1, max: 3 } }),
      ev("llm.start", 2_000, { nodeId: "body", iteration: { n: 2, max: 3 } }),
      ev("llm.start", 3_000, { nodeId: "body", iteration: { n: 3, max: 3 } }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(3);
    expect(steps[0]!.startedAt).toBe(new Date(900).toISOString()); // fact.node_started
    expect(steps[1]!.startedAt).toBe(new Date(2_000).toISOString()); // llm.start
    expect(steps[2]!.startedAt).toBe(new Date(3_000).toISOString()); // llm.start
    expect(steps[0]!.iteration).toEqual({ n: 1, max: 3 });
    expect(steps[2]!.iteration).toEqual({ n: 3, max: 3 });
  });

  test("a fresh fact.node_started reopens the window — next llm.start anchors to its ts", () => {
    // After the first node window closes (next fact.node_started for
    // the same node), the loop-iteration fallback resets and the next
    // first-step in that window anchors to the new fact.node_started.
    const events = [
      ev("fact.node_started", 100, { nodeId: "n1" }),
      ev("llm.start", 200, { nodeId: "n1" }),
      ev("fact.node_completed", 300, { nodeId: "n1" }),
      // ... time passes, node re-runs (e.g. in a parent loop) ...
      ev("fact.node_started", 1_000, { nodeId: "n1" }),
      ev("llm.start", 1_500, { nodeId: "n1" }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.startedAt).toBe(new Date(100).toISOString());
    expect(steps[1]!.startedAt).toBe(new Date(1_000).toISOString());
  });

  test("cost.recorded is NOT folded into the step (cost comes from SQL aggregates)", () => {
    const events = [
      ev("fact.node_started", 950, { nodeId: "n1" }),
      ev("llm.start", 1000, { nodeId: "n1" }),
      ev("cost.recorded", 1100, {
        nodeId: "n1",
        input_tokens: 100,
        output_tokens: 42,
        cost_usd: 0.003,
      }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.cost).toBeUndefined();
  });

  test("attachStepAggregates merges SQL-aggregated cost rows by startSeq", () => {
    const events = [
      { type: "fact.node_started", ts: 900, seq: 5, payload: { nodeId: "n1" } },
      { type: "llm.start", ts: 1000, seq: 10, payload: { nodeId: "n1" } },
      { type: "fact.node_started", ts: 1900, seq: 15, payload: { nodeId: "n2" } },
      { type: "llm.start", ts: 2000, seq: 20, payload: { nodeId: "n2" } },
    ];
    const baseSteps = eventsToSteps(events);
    expect(baseSteps[0]!.startSeq).toBe(10);
    expect(baseSteps[1]!.startSeq).toBe(20);

    const merged = attachStepAggregates(baseSteps, [
      {
        startSeq: 10,
        costUsd: 0.006,
        inputTokens: 50,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        billedTokens: 750,
        costEventCount: 2,
      },
      {
        startSeq: 20,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        billedTokens: 0,
        costEventCount: 0,
      },
    ]);
    expect(merged[0]!.cost).toEqual({
      input_tokens: 50,
      output_tokens: 200,
      billed_tokens: 750,
      cost_usd: 0.006,
      cache_read_tokens: 500,
      cache_write_tokens: 0,
    });
    // No cost events → no cost attached, even with a row present.
    expect(merged[1]!.cost).toBeUndefined();
  });

  test("attachStepAggregates leaves steps untouched when no aggregate matches their startSeq", () => {
    const events = [{ type: "llm.start", ts: 1000, seq: 99, payload: { nodeId: "n1" } }];
    const baseSteps = eventsToSteps(events);
    const merged = attachStepAggregates(baseSteps, []);
    expect(merged[0]!.cost).toBeUndefined();
    expect(merged[0]!.startSeq).toBe(99);
  });
});

describe("fillOrphanDurations", () => {
  test("each step's duration = next step's startedAt − this step's startedAt", () => {
    // The full picture: step starts anchor to fact.node_started (truthful),
    // and end at the next step's start. That gives wall-clock node duration.
    const steps = eventsToSteps([
      ev("fact.node_started", 1_000, { nodeId: "a" }),
      ev("llm.start", 1_500, { nodeId: "a" }), // buffered ts — ignored for startedAt
      ev("fact.node_started", 4_500, { nodeId: "b" }),
      ev("llm.start", 5_000, { nodeId: "b" }),
    ]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 6_000, runIsTerminal: true });
    expect(filled[0]!.durationMs).toBe(3_500); // 4500 − 1000
    expect(filled[1]!.durationMs).toBe(1_500); // 6000 − 4500 (last step on terminal)
  });

  test("last step on a terminal run → duration = lastEventTs − startedAt", () => {
    const steps = eventsToSteps([
      ev("fact.node_started", 1_000, { nodeId: "a" }),
      ev("llm.start", 1_500, { nodeId: "a" }),
    ]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 9_000, runIsTerminal: true });
    expect(filled[0]!.durationMs).toBe(8_000); // 9000 − 1000
  });

  test("last step on a LIVE run keeps durationMs undefined (client ticks)", () => {
    const steps = eventsToSteps([
      ev("fact.node_started", 1_000, { nodeId: "a" }),
      ev("llm.start", 1_500, { nodeId: "a" }),
    ]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 9_000, runIsTerminal: false });
    expect(filled[0]!.durationMs).toBeUndefined();
  });

  test("returns new objects — does not mutate the input array", () => {
    const steps = eventsToSteps([
      ev("fact.node_started", 1_000, { nodeId: "a" }),
      ev("llm.start", 1_500, { nodeId: "a" }),
    ]);
    const before = steps[0]!;
    const filled = fillOrphanDurations(steps, { lastEventTs: 5_000, runIsTerminal: true });
    expect(before.durationMs).toBeUndefined();
    expect(filled[0]).not.toBe(before);
    expect(filled[0]!.durationMs).toBe(4_000); // 5000 − 1000
  });
});
