import { describe, expect, test } from "bun:test";
import type { FactEvent } from "@fragua/store";
import { spendFactsFor, withoutSpend } from "../src/result-to-facts.ts";

const completed: FactEvent = {
  type: "fact.node_completed",
  payload: {
    nodeId: "a",
    iteration: 2,
    tokens: 100,
    costUsd: 0.25,
    nextNode: "b",
    inputTokens: 60,
    outputTokens: 40,
    inputCostUsd: 0.1,
    outputCostUsd: 0.15,
  },
};
const aborted: FactEvent = {
  type: "fact.node_aborted",
  payload: { nodeId: "b", iteration: 0, cause: "error", partialTokens: 10, partialCostUsd: 0.05 },
};
const spendingHalt: FactEvent = {
  type: "fact.run_terminated",
  payload: { status: "errored", reason: "error", nodeId: "c", partialTokens: 20, partialCostUsd: 0.3 },
};
const started: FactEvent = { type: "fact.node_started", payload: { nodeId: "b", iteration: 0 } };
const freeCompleted: FactEvent = {
  type: "fact.node_completed",
  payload: { nodeId: "z", iteration: 0, tokens: 0, costUsd: 0, nextNode: "b" },
};

function costOf(facts: FactEvent[]): number {
  return facts.reduce((n, f) => n + (f.type === "fact.node_aborted" ? f.payload.partialCostUsd : 0), 0);
}

describe("spendFactsFor", () => {
  test("spendFactsFor converts node_completed, passes node_aborted, splits partial halts, drops the rest", () => {
    const out = spendFactsFor([completed, aborted, spendingHalt, started, freeCompleted], "occ_exhausted", {
      iteration: 1,
      pass: 0,
    });
    expect(out.every((f) => f.type === "fact.node_aborted")).toBe(true);
    expect(out).toHaveLength(3);
    expect(costOf(out)).toBeCloseTo(0.6, 10);
    expect(out[0]!.payload).toMatchObject({
      nodeId: "a",
      iteration: 2,
      cause: "occ_exhausted",
      partialTokens: 100,
      partialCostUsd: 0.25,
      partialInputTokens: 60,
      partialOutputTokens: 40,
      partialInputCostUsd: 0.1,
      partialOutputCostUsd: 0.15,
    });
    expect(out[1]).toBe(aborted);
    expect(out[2]!.payload).toMatchObject({ nodeId: "c", iteration: 1, cause: "occ_exhausted", partialCostUsd: 0.3 });
  });

  test("a batch without spend yields no facts", () => {
    expect(spendFactsFor([started, freeCompleted], "crash")).toEqual([]);
  });

  test("withoutSpend strips a halt's partial fields and leaves other facts unchanged", () => {
    expect(withoutSpend(spendingHalt).payload).toEqual({ status: "errored", reason: "error" });
    expect(withoutSpend(started)).toBe(started);
  });
});
