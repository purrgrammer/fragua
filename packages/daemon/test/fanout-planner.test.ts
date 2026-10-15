// Unit tests for the PURE fan-out frontier decision (`planFanoutStep`). No
// store, clock, or randomness — every case is the plain-data classification
// `runFanout` reads, calls, then applies.

import { describe, expect, test } from "bun:test";
import { retryCountKey } from "@fragua/core";
import type { FactEvent } from "@fragua/store";
import {
  type FanoutFrontier,
  noteDisposition,
  planBailSettlement,
  planBranchSettlement,
  planBranchTerminal,
  planFanoutStep,
  planJoin,
  planSeedFanout,
} from "../src/fanout-planner.ts";
import { planDispatchStarted } from "../src/lifecycle-planner.ts";

const frontier = (over: Partial<FanoutFrontier>): FanoutFrontier => ({
  active: null,
  redispatch: [],
  branches: ["a", "b"],
  join: "synth",
  ...over,
});

describe("planFanoutStep", () => {
  describe("malformed", () => {
    test("missing join → malformed (before any seed/join/dispatch)", () => {
      expect(planFanoutStep(frontier({ join: undefined }))).toEqual({ kind: "malformed" });
    });

    test("no branches → malformed even when a join is declared", () => {
      expect(planFanoutStep(frontier({ branches: [], join: "synth" }))).toEqual({ kind: "malformed" });
    });

    test("malformed wins over a not-yet-seeded frontier", () => {
      expect(planFanoutStep(frontier({ active: null, branches: [] }))).toEqual({ kind: "malformed" });
    });
  });

  describe("seed (fresh frontier — active is null)", () => {
    test("single-branch → seed that one branch", () => {
      expect(planFanoutStep(frontier({ active: null, branches: ["only"] }))).toEqual({
        kind: "seed",
        branches: ["only"],
      });
    });

    test("multi-branch → seed all declared branches in order", () => {
      expect(planFanoutStep(frontier({ active: null, branches: ["a", "b", "c"] }))).toEqual({
        kind: "seed",
        branches: ["a", "b", "c"],
      });
    });
  });

  describe("join (frontier drained — active is empty)", () => {
    test("single-branch drained → advance to the join, one branch completed", () => {
      expect(planFanoutStep(frontier({ active: [], branches: ["only"], join: "j" }))).toEqual({
        kind: "join",
        nextNode: "j",
        branchesCompleted: 1,
      });
    });

    test("multi-branch drained → branchesCompleted counts the declared branches", () => {
      expect(planFanoutStep(frontier({ active: [], branches: ["a", "b", "c"], join: "synth" }))).toEqual({
        kind: "join",
        nextNode: "synth",
        branchesCompleted: 3,
      });
    });
  });

  describe("dispatch — park-and-run a live frontier", () => {
    test("single live branch, none aborted → dispatch with empty redispatch", () => {
      expect(planFanoutStep(frontier({ active: ["a"], redispatch: [] }))).toEqual({
        kind: "dispatch",
        active: ["a"],
        redispatch: [],
      });
    });

    test("multi live branches, none aborted → dispatch the whole active set", () => {
      expect(planFanoutStep(frontier({ active: ["a", "b"], redispatch: [] }))).toEqual({
        kind: "dispatch",
        active: ["a", "b"],
        redispatch: [],
      });
    });
  });

  describe("redispatch — live frontier with aborted branches to re-mark", () => {
    test("single aborted branch → dispatch carries it in redispatch", () => {
      expect(planFanoutStep(frontier({ active: ["a"], redispatch: ["a"] }))).toEqual({
        kind: "dispatch",
        active: ["a"],
        redispatch: ["a"],
      });
    });

    test("subset of a multi-branch frontier aborted → only that subset re-marked", () => {
      expect(planFanoutStep(frontier({ active: ["a", "b", "c"], redispatch: ["b"] }))).toEqual({
        kind: "dispatch",
        active: ["a", "b", "c"],
        redispatch: ["b"],
      });
    });
  });

  test("pure: identical frontier in ⇒ identical plan out, no mutation of inputs", () => {
    const input = frontier({ active: ["a", "b"], redispatch: ["a"] });
    const snapshot = structuredClone(input);
    const first = planFanoutStep(input);
    const second = planFanoutStep(input);
    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);
  });
});

const halt = (detail: string): FactEvent => ({
  type: "fact.run_terminated",
  payload: { status: "errored", reason: "error", detail },
});
const pause = (nodeId: string): FactEvent => ({
  type: "fact.run_paused",
  payload: { reason: "operator", nodeId },
});

describe("noteDisposition", () => {
  test("keeps the first halt over any subsequent pause", () => {
    const first = halt("a");
    expect(noteDisposition(first, pause("b"))).toBe(first);
  });

  test("a halt overrides a previously-captured pause", () => {
    const incoming = halt("a");
    expect(noteDisposition(pause("b"), incoming)).toBe(incoming);
  });

  test("first halt wins over a later halt", () => {
    const first = halt("a");
    expect(noteDisposition(first, halt("b"))).toBe(first);
  });

  test("first pause wins over a later pause", () => {
    const first = pause("a");
    expect(noteDisposition(first, pause("b"))).toBe(first);
  });

  test("undefined current takes the incoming fact", () => {
    const incoming = pause("a");
    expect(noteDisposition(undefined, incoming)).toBe(incoming);
  });
});

describe("planBranchTerminal", () => {
  test("fails closed with fanout_branch_terminal:<node>", () => {
    expect(planBranchTerminal("scan")).toEqual({
      type: "fact.run_terminated",
      payload: { status: "errored", reason: "error", detail: "fanout_branch_terminal:scan" },
    });
  });
});

describe("planBailSettlement", () => {
  const usage = {
    turnBilled: 30,
    totalCostUsd: 0.25,
    totalInputTokens: 20,
    totalOutputTokens: 10,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  };

  test("planBailSettlement keeps node_completed, drops successor dispatch and run-level facts, credits unsettled usage", () => {
    const completed: FactEvent = {
      type: "fact.node_completed",
      payload: { nodeId: "a", iteration: 0, tokens: 5, costUsd: 0.1, nextNode: "a2" },
    };
    const aborted: FactEvent = {
      type: "fact.node_aborted",
      payload: { nodeId: "b", iteration: 0, cause: "aborted", partialTokens: 3, partialCostUsd: 0.05 },
    };
    const out = planBailSettlement({
      settled: [
        {
          facts: [
            completed,
            ...planDispatchStarted({ nodeId: "a2", iteration: 0, pass: 0, resumeOf: "fresh" }).facts,
            { type: "fact.run_paused", payload: { reason: "operator", nodeId: "a" } },
          ],
        },
        {
          facts: [
            aborted,
            { type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: "boom" } },
          ],
        },
      ],
      unsettled: [{ nodeId: "c", iteration: 2, pass: 1, usage }],
    });
    expect(out).toEqual([
      completed,
      aborted,
      {
        type: "fact.node_aborted",
        payload: {
          nodeId: "c",
          iteration: 2,
          cause: "aborted",
          partialTokens: 30,
          partialCostUsd: 0.25,
          pass: 1,
          partialInputTokens: 20,
          partialOutputTokens: 10,
        },
      },
    ]);
  });

  test("nothing settled and nothing in flight → no facts", () => {
    expect(planBailSettlement({ settled: [], unsettled: [] })).toEqual([]);
  });
});

describe("planSeedFanout", () => {
  test("emits one fact.fanout_started over the branch list with iteration/pass", () => {
    expect(planSeedFanout({ nodeId: "p", iteration: 1, pass: 2, branches: ["a", "b"] })).toEqual([
      { type: "fact.fanout_started", payload: { nodeId: "p", iteration: 1, pass: 2, branches: ["a", "b"] } },
    ]);
  });

  test("pass 0 is omitted from the payload", () => {
    expect(planSeedFanout({ nodeId: "p", iteration: 0, pass: 0, branches: ["a"] })).toEqual([
      { type: "fact.fanout_started", payload: { nodeId: "p", iteration: 0, branches: ["a"] } },
    ]);
  });
});

describe("planJoin", () => {
  test("deferredPause → run_paused{operator}", () => {
    expect(
      planJoin({ deferredPause: true, nodeId: "p", iteration: 0, pass: 0, nextNode: "j", branchesCompleted: 2 }),
    ).toEqual({ type: "fact.run_paused", payload: { reason: "operator", nodeId: "p" } });
  });

  test("else → fanout_joined with nextNode/branchesCompleted", () => {
    expect(
      planJoin({ deferredPause: false, nodeId: "p", iteration: 1, pass: 3, nextNode: "j", branchesCompleted: 2 }),
    ).toEqual({
      type: "fact.fanout_joined",
      payload: { nodeId: "p", iteration: 1, pass: 3, nextNode: "j", branchesCompleted: 2 },
    });
  });
});

const nodeCompleted = (nodeId: string, nextNode: string): FactEvent => ({
  type: "fact.node_completed",
  payload: { nodeId, iteration: 0, tokens: 0, costUsd: 0, nextNode },
});

describe("planBranchSettlement", () => {
  type Args = Parameters<typeof planBranchSettlement>[0];
  const args = (over: Partial<Args>): Args => ({
    nodeId: "b0",
    facts: [],
    nextNode: undefined,
    join: "synth",
    graphNodes: { b0: {}, n1: {}, synth: {} },
    pass: 0,
    liveRouting: {},
    routingPatch: undefined,
    disposition: undefined,
    ...over,
  });

  test("completed run_terminated → branchTerminal, disposition captured, no successor", () => {
    const done: FactEvent = { type: "fact.run_terminated", payload: { status: "completed", finalNode: "synth" } };
    const r = planBranchSettlement(args({ facts: [done], nextNode: "n1" }));
    expect(r.terminal).toBe(true);
    expect(r.successor).toBeUndefined();
    expect(r.branchFacts).toEqual([]);
    expect(r.disposition).toEqual(planBranchTerminal("b0"));
  });

  test("run_paused/run_terminated branch facts route to disposition, node facts to branchFacts", () => {
    const paused: FactEvent = { type: "fact.run_paused", payload: { reason: "operator", nodeId: "b0" } };
    const completed = nodeCompleted("b0", "synth");
    const r = planBranchSettlement(args({ facts: [paused, completed], nextNode: "synth" }));
    expect(r.disposition).toBe(paused);
    expect(r.branchFacts).toEqual([completed]);
    expect(r.successor).toBeUndefined();
    expect(r.terminal).toBe(false);
  });

  test("live successor (≠ join, present in graph) → bundled dispatch_started", () => {
    const completed = nodeCompleted("b0", "n1");
    const r = planBranchSettlement(args({ facts: [completed], nextNode: "n1", pass: 2 }));
    expect(r.successor).toBe("n1");
    expect(r.terminal).toBe(false);
    expect(r.branchFacts).toEqual([
      completed,
      { type: "fact.dispatch_started", payload: { nodeId: "n1", iteration: 0, pass: 2, resumeOf: "fresh" } },
    ]);
  });

  test("successor iteration reads the merged live routing + routingPatch", () => {
    const completed = nodeCompleted("b0", "n1");
    const r = planBranchSettlement(
      args({ facts: [completed], nextNode: "n1", routingPatch: { [retryCountKey("n1")]: 5 } }),
    );
    expect(r.branchFacts[1]).toEqual({
      type: "fact.dispatch_started",
      payload: { nodeId: "n1", iteration: 5, resumeOf: "fresh" },
    });
  });

  test("planBranchSettlement successor marker equals planDispatchStarted output", () => {
    for (const pass of [0, 3]) {
      const r = planBranchSettlement(args({ facts: [nodeCompleted("b0", "n1")], nextNode: "n1", pass }));
      const expected = planDispatchStarted({ nodeId: "n1", iteration: 0, pass, resumeOf: "fresh" }).facts[0];
      expect(JSON.stringify(r.branchFacts[1])).toBe(JSON.stringify(expected));
    }
  });

  test("successor missing from the graph → fail closed to branchTerminal", () => {
    const completed = nodeCompleted("b0", "ghost");
    const r = planBranchSettlement(args({ facts: [completed], nextNode: "ghost" }));
    expect(r.terminal).toBe(true);
    expect(r.successor).toBeUndefined();
    expect(r.disposition).toEqual(planBranchTerminal("b0"));
    expect(r.branchFacts).toEqual([completed]);
  });

  test("null graphNodes (graph absent) → any successor fails closed", () => {
    const completed = nodeCompleted("b0", "n1");
    const r = planBranchSettlement(args({ facts: [completed], nextNode: "n1", graphNodes: null }));
    expect(r.terminal).toBe(true);
    expect(r.successor).toBeUndefined();
  });

  test("node_started facts are dropped, not committed", () => {
    const started: FactEvent = { type: "fact.node_started", payload: { nodeId: "b0", iteration: 0 } };
    const completed = nodeCompleted("b0", "synth");
    const r = planBranchSettlement(args({ facts: [started, completed], nextNode: "synth" }));
    expect(r.branchFacts).toEqual([completed]);
  });

  test("halt-over-pause precedence: incoming disposition halt survives a branch pause", () => {
    const halt: FactEvent = { type: "fact.run_terminated", payload: { status: "errored", reason: "error" } };
    const paused: FactEvent = { type: "fact.run_paused", payload: { reason: "operator", nodeId: "b0" } };
    const r = planBranchSettlement(args({ facts: [paused], nextNode: "synth", disposition: halt }));
    expect(r.disposition).toBe(halt);
  });

  test("pure: same input ⇒ same output, inputs unmutated", () => {
    const input = args({ facts: [nodeCompleted("b0", "n1")], nextNode: "n1", routingPatch: { x: 1 } });
    const factsSnapshot = structuredClone([...input.facts]);
    const routingSnapshot = structuredClone(input.liveRouting);
    const first = planBranchSettlement(input);
    const second = planBranchSettlement(input);
    expect(first).toEqual(second);
    expect(input.facts).toEqual(factsSnapshot);
    expect(input.liveRouting).toEqual(routingSnapshot);
  });
});
