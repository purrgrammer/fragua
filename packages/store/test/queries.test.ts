// Unit tests for the SQL aggregations in src/queries.ts.
// Exercised against a real `:memory:` SQLite so the JSON-extract +
// window-function behaviour is hit end-to-end. Folding cost.recorded
// events in TypeScript silently dropped most of them on tool-using
// turns (one llm.start, multiple message_end → cost.recorded events,
// each fired AFTER its own llm.done) — these tests pin the new
// SQL window aggregation against the cases the old reducer broke on.

import { describe, expect, test } from "bun:test";
import type { ObservabilityEvent } from "../src/index.ts";
import { freshStore, seedRun } from "./helpers.ts";

function startEv(nodeId: string, extras: Record<string, unknown> = {}): ObservabilityEvent {
  return { type: "llm.start", payload: { nodeId, iteration: 0, prompt: "p", ...extras } };
}
function doneEv(nodeId: string, extras: Record<string, unknown> = {}): ObservabilityEvent {
  return { type: "llm.done", payload: { nodeId, iteration: 0, ...extras } };
}
function costEv(nodeId: string, fields: Record<string, unknown>): ObservabilityEvent {
  return { type: "cost.recorded", payload: { nodeId, iteration: 0, ...fields } };
}

describe("getStepAggregates", () => {
  test("empty run → empty result", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    expect(store.getStepAggregates(runId)).toEqual([]);
    store.close();
  });

  test("one llm.start with one cost.recorded → that cost on that step", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      costEv("n1", { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.001 }),
    ]);
    const [a] = store.getStepAggregates(runId);
    expect(a!.nodeId).toBe("n1");
    expect(a!.costUsd).toBeCloseTo(0.001);
    expect(a!.inputTokens).toBe(10);
    expect(a!.outputTokens).toBe(5);
    expect(a!.billedTokens).toBe(15);
    expect(a!.costEventCount).toBe(1);
    store.close();
  });

  test("cost.recorded AFTER llm.done still attributes to the step (the actual agent flow)", async () => {
    // Reproduces the screenshot-confirmed bug: tool-using turns emit
    // message_end → cost.recorded AFTER message_update(done) → llm.done.
    // The previous TS reducer closed the step on llm.done and dropped
    // every subsequent cost event, under-counting by ~10x on real runs.
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      doneEv("n1", { stop_reason: "tool_use" }),
      costEv("n1", { input_tokens: 100, output_tokens: 20, total_tokens: 120, cost_usd: 0.01 }),
      doneEv("n1", { stop_reason: "tool_use" }),
      costEv("n1", { input_tokens: 200, output_tokens: 40, total_tokens: 240, cost_usd: 0.02 }),
      doneEv("n1", { stop_reason: "end_turn" }),
      costEv("n1", { input_tokens: 50, output_tokens: 10, total_tokens: 60, cost_usd: 0.005 }),
    ]);
    const [a] = store.getStepAggregates(runId);
    expect(a!.costUsd).toBeCloseTo(0.035);
    expect(a!.inputTokens).toBe(350);
    expect(a!.outputTokens).toBe(70);
    expect(a!.billedTokens).toBe(420);
    expect(a!.costEventCount).toBe(3);
    expect(a!.stopReason).toBe("end_turn"); // last one wins
    store.close();
  });

  test("multiple cost.recorded events without llm.done all attribute (defensive)", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      costEv("n1", { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0.001 }),
      costEv("n1", { input_tokens: 2, output_tokens: 2, total_tokens: 4, cost_usd: 0.002 }),
      costEv("n1", { input_tokens: 3, output_tokens: 3, total_tokens: 6, cost_usd: 0.003 }),
    ]);
    const [a] = store.getStepAggregates(runId);
    expect(a!.costUsd).toBeCloseTo(0.006);
    expect(a!.inputTokens).toBe(6);
    expect(a!.outputTokens).toBe(6);
    expect(a!.billedTokens).toBe(12);
    expect(a!.costEventCount).toBe(3);
    store.close();
  });

  test("loop iterations on the same nodeId produce one row per llm.start with split costs", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("body", { iteration: 1 }),
      costEv("body", { input_tokens: 10, output_tokens: 1, total_tokens: 11, cost_usd: 0.01 }),
      doneEv("body"),
      startEv("body", { iteration: 2 }),
      costEv("body", { input_tokens: 20, output_tokens: 2, total_tokens: 22, cost_usd: 0.02 }),
      doneEv("body"),
      startEv("body", { iteration: 3 }),
      costEv("body", { input_tokens: 30, output_tokens: 3, total_tokens: 33, cost_usd: 0.03 }),
    ]);
    const aggs = store.getStepAggregates(runId);
    expect(aggs.length).toBe(3);
    expect(aggs[0]!.costUsd).toBeCloseTo(0.01);
    expect(aggs[1]!.costUsd).toBeCloseTo(0.02);
    expect(aggs[2]!.costUsd).toBeCloseTo(0.03);
    expect(aggs[0]!.inputTokens).toBe(10);
    expect(aggs[1]!.inputTokens).toBe(20);
    expect(aggs[2]!.inputTokens).toBe(30);
    store.close();
  });

  test("interleaved nodes attribute costs to the right node", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("A"),
      startEv("B"),
      costEv("A", { input_tokens: 1, output_tokens: 0, cost_usd: 0.001 }),
      costEv("B", { input_tokens: 2, output_tokens: 0, cost_usd: 0.002 }),
      doneEv("A"),
      doneEv("B"),
    ]);
    const aggs = store.getStepAggregates(runId);
    const a = aggs.find((r) => r.nodeId === "A");
    const b = aggs.find((r) => r.nodeId === "B");
    expect(a!.costUsd).toBeCloseTo(0.001);
    expect(a!.inputTokens).toBe(1);
    expect(b!.costUsd).toBeCloseTo(0.002);
    expect(b!.inputTokens).toBe(2);
    store.close();
  });

  test("cost.recorded under a synthetic node (no llm.start) is excluded from step aggregates", async () => {
    // Summariser / title-generator emit cost.recorded directly under a
    // synthetic node id with no llm.start — these belong to the run
    // total but not to any step. They show up via getRunCostTotals.
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      costEv("n1", { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.01 }),
      // Summariser-style: cost.recorded under a node that never opened.
      costEv("__summary.title", { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.05 }),
    ]);
    const stepAggs = store.getStepAggregates(runId);
    expect(stepAggs).toHaveLength(1);
    expect(stepAggs[0]!.costUsd).toBeCloseTo(0.01);

    const totals = store.getRunCostTotals(runId);
    expect(totals.costUsd).toBeCloseTo(0.06);
    expect(totals.eventCount).toBe(2);
    store.close();
  });

  test("startSeq matches the actual events.seq of the originating llm.start", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const r = store.appendObservabilityEvents(runId, [startEv("n1"), startEv("n2")]);
    const aggs = store.getStepAggregates(runId);
    expect(aggs.map((a) => a.startSeq)).toEqual(r.seqs);
    store.close();
  });

  test("stopReason picks the LAST llm.done in the window, not the first", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      doneEv("n1", { stop_reason: "tool_use" }),
      doneEv("n1", { stop_reason: "tool_use" }),
      doneEv("n1", { stop_reason: "end_turn" }),
    ]);
    const [a] = store.getStepAggregates(runId);
    expect(a!.stopReason).toBe("end_turn");
    store.close();
  });

  test("missing token sub-fields default to 0 (sums coalesce nulls)", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      // No cache_read_tokens / cache_write_tokens fields at all.
      costEv("n1", { input_tokens: 5, output_tokens: 2, cost_usd: 0.001 }),
    ]);
    const [a] = store.getStepAggregates(runId);
    expect(a!.cacheReadTokens).toBe(0);
    expect(a!.cacheWriteTokens).toBe(0);
    expect(a!.billedTokens).toBe(0);
    store.close();
  });
});

describe("getRunCostTotals", () => {
  test("empty run → zero row", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const r = store.getRunCostTotals(runId);
    expect(r.costUsd).toBe(0);
    expect(r.eventCount).toBe(0);
    store.close();
  });

  test("sums every cost.recorded regardless of llm.start containment", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      costEv("n1", { input_tokens: 1, output_tokens: 1, cost_usd: 0.01 }),
      doneEv("n1"),
      costEv("n1", { input_tokens: 2, output_tokens: 2, cost_usd: 0.02 }),
      // Synthetic — outside any step window:
      costEv("__summary", { input_tokens: 3, output_tokens: 3, cost_usd: 0.03 }),
    ]);
    const totals = store.getRunCostTotals(runId);
    expect(totals.costUsd).toBeCloseTo(0.06);
    expect(totals.inputTokens).toBe(6);
    expect(totals.outputTokens).toBe(6);
    expect(totals.eventCount).toBe(3);
    store.close();
  });
});
