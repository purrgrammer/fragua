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
        allowed_tools: ["local:bash"],
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
    expect(s.startedAt).toBe(new Date(1_000_000).toISOString());
    // Body fields should not appear on the snapshot at all.
    expect(s).not.toHaveProperty("prompt");
    expect(s).not.toHaveProperty("systemPrompt");
    expect(s).not.toHaveProperty("messages");
    expect(s).not.toHaveProperty("allowedTools");
    expect(s).not.toHaveProperty("threadId");
    expect(s).not.toHaveProperty("finalText");
  });

  test("llm.done sets durationMs from the LAST llm.done in the window", () => {
    // Tool-using turns emit one llm.done per assistant message under one
    // llm.start. The reducer keeps the step open through all of them and
    // the last done's timestamp wins for durationMs.
    const events = [
      ev("llm.start", 1_000_000, { nodeId: "n1" }),
      ev("llm.done", 1_001_000, { nodeId: "n1", stop_reason: "tool_use" }),
      ev("llm.done", 1_003_200, { nodeId: "n1", stop_reason: "end_turn" }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.durationMs).toBe(3200);
  });

  test("step without an llm.done has no durationMs (in-flight)", () => {
    // The UI ticks `now - startedAt` for these.
    const events = [ev("llm.start", 1000, { nodeId: "n1" })];
    const [s] = eventsToSteps(events);
    expect(s!.durationMs).toBeUndefined();
  });

  test("cost.recorded is NOT folded into the step (cost comes from SQL aggregates)", () => {
    const events = [
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

  test("loop iterations produce one step per llm.start, each with its own iteration metadata", () => {
    const events = [
      ev("llm.start", 1000, { nodeId: "body", iteration: { n: 1, max: 3 } }),
      ev("llm.done", 1020, { nodeId: "body" }),
      ev("llm.start", 2000, { nodeId: "body", iteration: { n: 2, max: 3 } }),
      ev("llm.done", 2020, { nodeId: "body" }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.iteration).toEqual({ n: 1, max: 3 });
    expect(steps[1]!.iteration).toEqual({ n: 2, max: 3 });
    expect(steps[0]!.stepIdx).toBe(0);
    expect(steps[1]!.stepIdx).toBe(1);
  });

  test("llm.done for an unknown nodeId (no open step) is dropped", () => {
    const events = [ev("llm.start", 1000, { nodeId: "n1" }), ev("llm.done", 1100, { nodeId: "different-node" })];
    const [s] = eventsToSteps(events);
    expect(s!.durationMs).toBeUndefined();
  });

  test("attachStepAggregates merges SQL-aggregated cost rows by startSeq", () => {
    const events = [
      { type: "llm.start", ts: 1000, seq: 10, payload: { nodeId: "n1" } },
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
        totalTokens: 750,
        costEventCount: 2,
      },
      {
        startSeq: 20,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costEventCount: 0,
      },
    ]);
    expect(merged[0]!.cost).toEqual({
      input_tokens: 50,
      output_tokens: 200,
      total_tokens: 750,
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
  test("orphan step with a next step → duration = next.startedAt − this.startedAt", () => {
    const steps = eventsToSteps([
      ev("llm.start", 1_000, { nodeId: "a" }), // no llm.done — orphan
      ev("llm.start", 4_500, { nodeId: "b" }),
      ev("llm.done", 5_000, { nodeId: "b" }),
    ]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 5_000, runIsTerminal: true });
    expect(filled[0]!.durationMs).toBe(3_500);
    // step "b" had its own llm.done — durationMs untouched.
    expect(filled[1]!.durationMs).toBe(500);
  });

  test("last orphan step on a terminal run → duration = lastEventTs − startedAt", () => {
    const steps = eventsToSteps([ev("llm.start", 1_000, { nodeId: "a" })]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 9_000, runIsTerminal: true });
    expect(filled[0]!.durationMs).toBe(8_000);
  });

  test("last orphan step on a LIVE run keeps durationMs undefined (client ticks)", () => {
    const steps = eventsToSteps([ev("llm.start", 1_000, { nodeId: "a" })]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 9_000, runIsTerminal: false });
    expect(filled[0]!.durationMs).toBeUndefined();
  });

  test("instant-completing last step (durationMs=0) is upgraded to wall-clock on terminal runs", () => {
    // `merge`-style finalization steps fire llm.done in the same ms as
    // llm.start, so eventsToSteps records durationMs=0. The "stop step"
    // anchor promotes that to lastEventTs − startedAt — the wall-clock
    // time the step was active.
    const steps = eventsToSteps([
      ev("llm.start", 1_000, { nodeId: "merge" }),
      ev("llm.done", 1_000, { nodeId: "merge" }),
    ]);
    expect(steps[0]!.durationMs).toBe(0);
    const filled = fillOrphanDurations(steps, { lastEventTs: 5_000, runIsTerminal: true });
    expect(filled[0]!.durationMs).toBe(4_000);
  });

  test("instant-completing last step on a LIVE run keeps its durationMs (no anchor override)", () => {
    // Same shape as above but the run hasn't terminated — we must NOT
    // override, otherwise live runs would constantly pull in growing
    // wall-clock values from new events.
    const steps = eventsToSteps([
      ev("llm.start", 1_000, { nodeId: "merge" }),
      ev("llm.done", 1_000, { nodeId: "merge" }),
    ]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 5_000, runIsTerminal: false });
    expect(filled[0]!.durationMs).toBe(0);
  });

  test("non-last step with its own durationMs is never overridden", () => {
    // Only the LAST step gets the stop-step anchor. Mid-list steps with
    // a real llm.done duration keep that duration regardless of the
    // following step's startedAt or the run's terminal status.
    const steps = eventsToSteps([
      ev("llm.start", 1_000, { nodeId: "a" }),
      ev("llm.done", 1_500, { nodeId: "a" }),
      ev("llm.start", 9_000, { nodeId: "b" }), // big gap after a's done
      ev("llm.done", 9_100, { nodeId: "b" }),
    ]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 9_100, runIsTerminal: true });
    expect(filled[0]!.durationMs).toBe(500); // a's own llm.done — not 8_000
    expect(filled[1]!.durationMs).toBe(100); // b is last but lastEventTs == its done ts
  });

  test("returns new objects — does not mutate the input array", () => {
    const steps = eventsToSteps([ev("llm.start", 1_000, { nodeId: "a" })]);
    const before = steps[0]!;
    const filled = fillOrphanDurations(steps, { lastEventTs: 5_000, runIsTerminal: true });
    expect(before.durationMs).toBeUndefined();
    expect(filled[0]).not.toBe(before);
    expect(filled[0]!.durationMs).toBe(4_000);
  });
});
