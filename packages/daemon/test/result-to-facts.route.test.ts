// resultToFacts — route propagation onto fact.node_completed,
// and the new routing-node halt reasons flowing through verbatim.
//
// Additive: existing payload fields are untouched; `route` only lands
// when the handler set it.

import { describe, expect, test } from "bun:test";
import type * as handler from "@fragua/core/handler";
import type { FactEvent, RunState } from "@fragua/store";
import { resultToFacts } from "../src/result-to-facts.ts";

type HandlerResult = handler.HandlerResult;

function minimalRunState(currentNode: string): RunState {
  // resultToFacts only reads `currentNode` and `routing` from RunState
  // for the transition + halt arms exercised here. Cast a minimal stub
  // to dodge the unrelated RunState surface.
  return {
    currentNode,
    routing: {},
  } as unknown as RunState;
}

function findFact<T extends FactEvent["type"]>(
  facts: FactEvent[],
  type: T,
): Extract<FactEvent, { type: T }> | undefined {
  return facts.find((f) => f.type === type) as Extract<FactEvent, { type: T }> | undefined;
}

describe("resultToFacts — route propagation", () => {
  test("transition.route lands on fact.node_completed.payload.route", () => {
    const result: HandlerResult = {
      kind: "transition",
      nextNode: "plan",
      outcomeStatus: "success",
      route: "feature",
      tokens: 0,
      costUsd: 0,
    };
    const facts = resultToFacts(result, { state: minimalRunState("triage"), appliedIntentSeqs: [] });
    const completed = findFact(facts, "fact.node_completed");
    expect(completed).toBeDefined();
    expect(completed!.payload.route).toBe("feature");
    expect(completed!.payload.outcomeStatus).toBe("success");
  });

  test("transition without route omits the route field", () => {
    const result: HandlerResult = {
      kind: "transition",
      nextNode: "plan",
      outcomeStatus: "success",
      tokens: 0,
      costUsd: 0,
    };
    const facts = resultToFacts(result, { state: minimalRunState("triage"), appliedIntentSeqs: [] });
    const completed = findFact(facts, "fact.node_completed");
    expect(completed).toBeDefined();
    expect("route" in completed!.payload).toBe(false);
  });

  test("transition.route='' is treated as absent (defensive)", () => {
    const result: HandlerResult = {
      kind: "transition",
      nextNode: "plan",
      outcomeStatus: "success",
      route: "",
      tokens: 0,
      costUsd: 0,
    };
    const facts = resultToFacts(result, { state: minimalRunState("triage"), appliedIntentSeqs: [] });
    const completed = findFact(facts, "fact.node_completed");
    expect("route" in completed!.payload).toBe(false);
  });
});

describe("resultToFacts — routing-node halt reasons", () => {
  test("halt.reason=route_not_picked surfaces on fact.run_halted", () => {
    const result: HandlerResult = {
      kind: "halt",
      reason: "route_not_picked",
      detail: "agent ended turn without calling route()",
    };
    const facts = resultToFacts(result, { state: minimalRunState("triage"), appliedIntentSeqs: [] });
    const halted = findFact(facts, "fact.run_halted");
    expect(halted).toBeDefined();
    expect(halted!.payload.reason).toBe("route_not_picked");
    expect(halted!.payload.detail).toBe("agent ended turn without calling route()");
  });

  test("halt.reason=route_call_not_isolated surfaces on fact.run_halted", () => {
    const result: HandlerResult = {
      kind: "halt",
      reason: "route_call_not_isolated",
      detail: "route() shared an assistant response with other tool calls",
    };
    const facts = resultToFacts(result, { state: minimalRunState("triage"), appliedIntentSeqs: [] });
    const halted = findFact(facts, "fact.run_halted");
    expect(halted?.payload.reason).toBe("route_call_not_isolated");
  });

  test("halt.reason=edge_no_match surfaces on fact.run_halted", () => {
    const result: HandlerResult = {
      kind: "halt",
      reason: "edge_no_match",
      detail: 'no edge keyed route="hard" from triage',
    };
    const facts = resultToFacts(result, { state: minimalRunState("triage"), appliedIntentSeqs: [] });
    const halted = findFact(facts, "fact.run_halted");
    expect(halted?.payload.reason).toBe("edge_no_match");
    expect(halted?.payload.detail).toContain("hard");
  });
});

describe("resultToFacts — structured outputs", () => {
  test("transition.outputs lands on fact.node_completed.payload.outputs", () => {
    const result: HandlerResult = {
      kind: "transition",
      nextNode: "merge",
      outcomeStatus: "success",
      outputs: { pr_number: "42", loc: 100 },
      tokens: 0,
      costUsd: 0,
    };
    const facts = resultToFacts(result, { state: minimalRunState("scope"), appliedIntentSeqs: [] });
    const completed = findFact(facts, "fact.node_completed");
    expect(completed!.payload.outputs).toEqual({ pr_number: "42", loc: 100 });
  });

  test("oversize outputs are attached as-is (no halt) — the store spills them", () => {
    // result-to-facts is size-agnostic: it attaches the struct regardless of
    // size and never halts on size. The store spills >3 KiB structs to the
    // blob CAS at append time.
    const result: HandlerResult = {
      kind: "transition",
      nextNode: "merge",
      outcomeStatus: "success",
      outputs: { blob: "x".repeat(8000) },
      tokens: 0,
      costUsd: 0,
    };
    const facts = resultToFacts(result, { state: minimalRunState("scope"), appliedIntentSeqs: [] });
    const completed = findFact(facts, "fact.node_completed");
    expect(completed!.payload.outcomeStatus).toBe("success");
    expect((completed!.payload.outputs as { blob: string }).blob.length).toBe(8000);
    expect(findFact(facts, "fact.run_halted")).toBeUndefined();
  });
});
