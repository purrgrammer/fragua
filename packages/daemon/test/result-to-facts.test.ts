// resultToFacts \u2014 expands HandlerResult.transition's contextWriteLog
// and outputEmitted flag into per-write fact events alongside
// `fact.node_completed`.
//
// See docs/proposals/codergen-context-output-tools.md \u00a72.1 / \u00a72.2.

import { describe, expect, test } from "bun:test";
import type * as handler from "@swarm/core/handler";
import type { RunState } from "@swarm/store";
import { resultToFacts } from "../src/result-to-facts.ts";

function stateFor(nodeId: string): RunState {
  // Cast through unknown because RunState carries a large projection
  // surface; resultToFacts only reads `currentNode` and `routing`.
  return {
    runId: "r1",
    currentNode: nodeId,
    routing: {},
  } as unknown as RunState;
}

function baseTransition(
  extras: Partial<Extract<handler.HandlerResult, { kind: "transition" }>> = {},
): Extract<handler.HandlerResult, { kind: "transition" }> {
  return {
    kind: "transition",
    nextNode: "next",
    tokens: 0,
    costUsd: 0,
    outcomeStatus: "success",
    ...extras,
  };
}

describe("resultToFacts \u2014 context_written facts", () => {
  test("expands contextWriteLog into fact.context_written events with source=agent", () => {
    const facts = resultToFacts(
      baseTransition({
        contextWriteLog: [
          { key: "foo", value: "bar" },
          { key: "sev", value: "high", prevValue: "low" },
        ],
      }),
      { state: stateFor("classify"), appliedIntentSeqs: [] },
    );
    const writes = facts.filter((f) => f.type === "fact.context_written");
    expect(writes.length).toBe(2);
    expect(writes[0]?.payload).toEqual({
      source: "agent",
      nodeId: "classify",
      key: "foo",
      value: "bar",
    });
    expect(writes[1]?.payload).toEqual({
      source: "agent",
      nodeId: "classify",
      key: "sev",
      value: "high",
      prevValue: "low",
    });
  });

  test("no contextWriteLog \u2192 no fact.context_written emitted", () => {
    const facts = resultToFacts(baseTransition(), {
      state: stateFor("plan"),
      appliedIntentSeqs: [],
    });
    expect(facts.some((f) => f.type === "fact.context_written")).toBe(false);
  });
});

describe("resultToFacts \u2014 output_emitted fact", () => {
  test("emits fact.output_emitted { source: agent } when outputEmitted=true", () => {
    const facts = resultToFacts(baseTransition({ outputEmitted: true }), {
      state: stateFor("classify"),
      appliedIntentSeqs: [],
    });
    const emits = facts.filter((f) => f.type === "fact.output_emitted");
    expect(emits.length).toBe(1);
    expect(emits[0]?.payload).toEqual({ source: "agent", nodeId: "classify" });
  });

  test("outputEmitted=false / unset \u2192 no fact.output_emitted", () => {
    const facts = resultToFacts(baseTransition({ outputEmitted: false }), {
      state: stateFor("plan"),
      appliedIntentSeqs: [],
    });
    expect(facts.some((f) => f.type === "fact.output_emitted")).toBe(false);
  });
});
