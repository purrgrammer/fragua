// Synthetic node-id helpers shared by the summariser + the `agent` tool.

import { describe, expect, test } from "bun:test";
import { agentSyntheticNodeId, agentWorkerCaller, isSyntheticNodeId, summarySyntheticNodeId } from "../src/index.ts";
import { parseWorkflow } from "../src/parser/yaml.ts";

describe("agentSyntheticNodeId", () => {
  test("formats __agent.<caller>#<n>/<toolCallId>", () => {
    expect(agentSyntheticNodeId("implement", { n: 2 }, "toolu_9")).toBe("__agent.implement#2/toolu_9");
  });

  test("distinct tool-call ids under one caller turn never collide", () => {
    const a = agentSyntheticNodeId("implement", { n: 0 }, "toolu_a");
    const b = agentSyntheticNodeId("implement", { n: 0 }, "toolu_b");
    expect(a).not.toBe(b);
  });
});

describe("isSyntheticNodeId", () => {
  test("true for both reserved prefixes", () => {
    expect(isSyntheticNodeId(agentSyntheticNodeId("implement", { n: 0 }, "t1"))).toBe(true);
    expect(isSyntheticNodeId(summarySyntheticNodeId("review", { n: 1 }))).toBe(true);
    expect(isSyntheticNodeId("__summary.title")).toBe(true);
  });

  test("false for a real step id and for nullish", () => {
    expect(isSyntheticNodeId("implement")).toBe(false);
    expect(isSyntheticNodeId("start")).toBe(false);
    expect(isSyntheticNodeId(null)).toBe(false);
    expect(isSyntheticNodeId(undefined)).toBe(false);
  });
});

describe("agentWorkerCaller", () => {
  test("recovers the caller from a synthetic id, including ids with digits and underscores", () => {
    for (const caller of ["implement", "step_2", "A9_b"]) {
      expect(agentWorkerCaller(agentSyntheticNodeId(caller, { n: 3 }, "toolu_x/y#z"))).toBe(caller);
    }
    expect(agentWorkerCaller("implement")).toBeUndefined();
    expect(agentWorkerCaller("__summary.title")).toBeUndefined();
  });

  test("the delimiters cannot appear in a caller id: the parser rejects them", () => {
    for (const bad of ["step#1", "a/b", "x-y"]) {
      const yaml = `name: t\nsteps:\n  "${bad}":\n    type: llm\n    prompt: p\n    next: exit\n`;
      expect(() => parseWorkflow(yaml)).toThrow(/not a valid identifier/);
    }
  });
});
