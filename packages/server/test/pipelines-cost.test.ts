// Cost / token / duration aggregation in deriveSummary + deriveDetail.
//
// We test the pure reducers (not the HTTP handler) because the arithmetic
// is the interesting bit and a reducer test isolates it from Hono.

import { describe, expect, test } from "bun:test";
import { deriveDetail, deriveSummary } from "../src/routes/pipelines.ts";
import { ev } from "./helpers.ts";

describe("deriveSummary — cost aggregation", () => {
  test("no cost.recorded events → zeros across the board", () => {
    const events = [
      ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" }),
      ev({ type: "node.started", node_id: "a", timestamp: "2024-01-01T00:00:01.000Z" }),
      ev({ type: "node.completed", node_id: "a", timestamp: "2024-01-01T00:00:02.000Z" }),
      ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:00:03.000Z" }),
    ];
    const s = deriveSummary("r1", events);
    expect(s.costUsd).toBe(0);
    expect(s.inputTokens).toBe(0);
    expect(s.outputTokens).toBe(0);
  });

  test("single cost.recorded → fields accumulate with exact values", () => {
    const events = [
      ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" }),
      ev({
        type: "cost.recorded",
        timestamp: "2024-01-01T00:00:01.000Z",
        data: { cost_usd: 0.0123, input_tokens: 100, output_tokens: 42, provider: "openai", model: "gpt-4" },
      }),
      ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:00:02.000Z" }),
    ];
    const s = deriveSummary("r1", events);
    expect(s.costUsd).toBeCloseTo(0.0123, 10);
    expect(s.inputTokens).toBe(100);
    expect(s.outputTokens).toBe(42);
  });

  test("multiple cost.recorded → totals sum", () => {
    const events = [
      ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" }),
      ev({
        type: "cost.recorded",
        timestamp: "2024-01-01T00:00:01.000Z",
        data: { cost_usd: 0.01, input_tokens: 100, output_tokens: 10 },
      }),
      ev({
        type: "cost.recorded",
        timestamp: "2024-01-01T00:00:02.000Z",
        data: { cost_usd: 0.02, input_tokens: 200, output_tokens: 20 },
      }),
      ev({
        type: "cost.recorded",
        timestamp: "2024-01-01T00:00:03.000Z",
        data: { cost_usd: 0.005, input_tokens: 50, output_tokens: 5 },
      }),
      ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:00:04.000Z" }),
    ];
    const s = deriveSummary("r1", events);
    expect(s.costUsd).toBeCloseTo(0.035, 10);
    expect(s.inputTokens).toBe(350);
    expect(s.outputTokens).toBe(35);
  });

  test("missing numeric fields coerce to 0 (partial cost events don't crash)", () => {
    const events = [
      ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" }),
      // Provider reported tokens but no cost.
      ev({
        type: "cost.recorded",
        timestamp: "2024-01-01T00:00:01.000Z",
        data: { input_tokens: 10, output_tokens: 20 },
      }),
      // Another one reports only a cost number.
      ev({ type: "cost.recorded", timestamp: "2024-01-01T00:00:02.000Z", data: { cost_usd: 0.5 } }),
    ];
    const s = deriveSummary("r1", events);
    expect(s.costUsd).toBe(0.5);
    expect(s.inputTokens).toBe(10);
    expect(s.outputTokens).toBe(20);
  });
});

describe("deriveSummary — durationMs", () => {
  test("fewer than two events → undefined (no meaningful span)", () => {
    const s0 = deriveSummary("r0", []);
    expect(s0.durationMs).toBeUndefined();
    const s1 = deriveSummary("r1", [ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" })]);
    expect(s1.durationMs).toBeUndefined();
  });

  test("terminal run → lastTs − firstTs in ms", () => {
    const events = [
      ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" }),
      ev({ type: "node.started", node_id: "a", timestamp: "2024-01-01T00:00:01.500Z" }),
      ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:01:30.000Z" }),
    ];
    const s = deriveSummary("r1", events);
    expect(s.durationMs).toBe(90_000); // 1m30s
  });

  test("running run → span up to the latest observed event", () => {
    const events = [
      ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" }),
      ev({ type: "node.started", node_id: "a", timestamp: "2024-01-01T00:00:05.000Z" }),
    ];
    const s = deriveSummary("r1", events);
    expect(s.status).toBe("running");
    expect(s.durationMs).toBe(5_000);
  });

  test("unparseable timestamps → undefined", () => {
    const events = [
      ev({ type: "pipeline.started", timestamp: "nope" }),
      ev({ type: "pipeline.completed", timestamp: "also-nope" }),
    ];
    const s = deriveSummary("r1", events);
    expect(s.durationMs).toBeUndefined();
  });
});

describe("deriveDetail — mirrors summary metrics", () => {
  test("costUsd / tokens / durationMs match deriveSummary", () => {
    const events = [
      ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" }),
      ev({
        type: "cost.recorded",
        timestamp: "2024-01-01T00:00:01.000Z",
        data: { cost_usd: 0.07, input_tokens: 1000, output_tokens: 250 },
      }),
      ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:00:02.500Z" }),
    ];
    const summary = deriveSummary("r1", events);
    const detail = deriveDetail("r1", events);
    expect(detail.costUsd).toBe(summary.costUsd);
    expect(detail.inputTokens).toBe(summary.inputTokens);
    expect(detail.outputTokens).toBe(summary.outputTokens);
    // Both are `number | undefined`; the next line pins the concrete value.
    expect(detail.durationMs).toBe(2_500);
    expect(summary.durationMs).toBe(2_500);
  });
});
