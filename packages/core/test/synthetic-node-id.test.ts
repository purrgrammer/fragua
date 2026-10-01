// Synthetic node-id helpers shared by the summariser + the `agent` tool.

import { describe, expect, test } from "bun:test";
import { agentSyntheticNodeId, isSyntheticNodeId, summarySyntheticNodeId } from "../src/index.ts";

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
