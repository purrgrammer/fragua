// Unit tests for the cost aggregator. Covers the single call path used by
// ConsoleSink and the bulk path used by deriveSummary.

import { describe, expect, test } from "bun:test";
import type { Event } from "@swarm/core";
import { accumulateCost, aggregateCost, emptyCostTotals } from "../src/cost.ts";

function makeEvent(partial: Partial<Event> & Pick<Event, "type">): Event {
  return {
    run_id: "r1",
    type: partial.type,
    timestamp: partial.timestamp ?? "2024-01-01T00:00:00.000Z",
    workflow_sha: "sha",
    data: partial.data ?? {},
  };
}

describe("emptyCostTotals", () => {
  test("returns all-zero totals", () => {
    expect(emptyCostTotals()).toEqual({
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      calls: 0,
    });
  });
});

describe("accumulateCost", () => {
  test("non-cost events are a no-op", () => {
    const t = emptyCostTotals();
    accumulateCost(t, makeEvent({ type: "node.started" }));
    accumulateCost(t, makeEvent({ type: "pipeline.completed" }));
    expect(t).toEqual({
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      calls: 0,
    });
  });

  test("folds a cost.recorded event with full payload", () => {
    const t = emptyCostTotals();
    accumulateCost(
      t,
      makeEvent({
        type: "cost.recorded",
        data: {
          cost_usd: 0.25,
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 100,
          cache_write_tokens: 20,
        },
      }),
    );
    expect(t).toEqual({
      cost_usd: 0.25,
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 100,
      cache_write_tokens: 20,
      calls: 1,
    });
  });

  test("missing numeric fields default to 0 (partial payloads don't crash)", () => {
    const t = emptyCostTotals();
    accumulateCost(t, makeEvent({ type: "cost.recorded", data: { cost_usd: 0.1 } }));
    expect(t).toEqual({
      cost_usd: 0.1,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      calls: 1,
    });
  });

  test("is cumulative across multiple calls", () => {
    const t = emptyCostTotals();
    accumulateCost(
      t,
      makeEvent({
        type: "cost.recorded",
        data: { cost_usd: 0.1, input_tokens: 1, output_tokens: 2, cache_read_tokens: 50, cache_write_tokens: 10 },
      }),
    );
    accumulateCost(
      t,
      makeEvent({
        type: "cost.recorded",
        data: { cost_usd: 0.2, input_tokens: 3, output_tokens: 4, cache_read_tokens: 75, cache_write_tokens: 5 },
      }),
    );
    expect(t.cost_usd).toBeCloseTo(0.3, 10);
    expect(t.input_tokens).toBe(4);
    expect(t.output_tokens).toBe(6);
    expect(t.cache_read_tokens).toBe(125);
    expect(t.cache_write_tokens).toBe(15);
    expect(t.calls).toBe(2);
  });

  test("returns the same totals object for chaining", () => {
    const t = emptyCostTotals();
    const out = accumulateCost(t, makeEvent({ type: "cost.recorded", data: { cost_usd: 1 } }));
    expect(out).toBe(t);
  });
});

describe("aggregateCost", () => {
  test("empty iterable → all zeros", () => {
    expect(aggregateCost([])).toEqual({
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      calls: 0,
    });
  });

  test("mixed stream folds only the cost events", () => {
    const events: Event[] = [
      makeEvent({ type: "pipeline.started" }),
      makeEvent({
        type: "cost.recorded",
        data: { cost_usd: 0.01, input_tokens: 10, output_tokens: 1, cache_read_tokens: 100, cache_write_tokens: 5 },
      }),
      makeEvent({ type: "node.started", node_id: "a" }),
      makeEvent({
        type: "cost.recorded",
        data: { cost_usd: 0.02, input_tokens: 20, output_tokens: 2, cache_read_tokens: 200 },
      }),
      makeEvent({ type: "pipeline.completed" }),
    ];
    const t = aggregateCost(events);
    expect(t.cost_usd).toBeCloseTo(0.03, 10);
    expect(t.input_tokens).toBe(30);
    expect(t.output_tokens).toBe(3);
    expect(t.cache_read_tokens).toBe(300);
    expect(t.cache_write_tokens).toBe(5);
    expect(t.calls).toBe(2);
  });
});
