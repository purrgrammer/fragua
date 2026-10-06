// Validator diagnostics for the `agent` tool: W023 (agent allowed on a node
// with no mutator tool), W024 (agent allowed with no run `budget:`) and E058
// (authored step id starting with `__`).

import { describe, expect, test } from "bun:test";
import { validate } from "../../src/engine/validator.ts";
import { mkGraph } from "../helpers/build-graph.ts";

function codes(g: Parameters<typeof validate>[0], code: string): string[] {
  return validate(g)
    .map((d) => d.code)
    .filter((c) => c === code);
}

describe("validate — W023 agent on a node with no mutator tool", () => {
  test("agent allowed with only read → W023", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        work: { type: "llm", attrs: { allowed_tools: ["read", "agent"] } },
        done: "exit",
      },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(codes(g, "W023")).toEqual(["W023"]);
  });

  test("agent allowed alongside a write-class tool → no W023", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        work: { type: "llm", attrs: { allowed_tools: ["read", "bash", "agent"] } },
        done: "exit",
      },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(codes(g, "W023")).toEqual([]);
  });

  test("a node that does not allow agent → no W023", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        work: { type: "llm", attrs: { allowed_tools: ["read"] } },
        done: "exit",
      },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(codes(g, "W023")).toEqual([]);
  });
});

describe("validate — E058 authored step id starting with __", () => {
  test("a step id starting with __ → E058", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        __worker: { type: "llm", attrs: {} },
        done: "exit",
      },
      edges: [
        ["s", "__worker"],
        ["__worker", "done"],
      ],
    });
    expect(codes(g, "E058")).toEqual(["E058"]);
  });

  test("a normal step id → no E058", () => {
    const g = mkGraph({
      nodes: { s: "start", work: "llm", done: "exit" },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(codes(g, "E058")).toEqual([]);
  });
});

describe("validate — W024 agent with no run budget", () => {
  const nodes: Parameters<typeof mkGraph>[0]["nodes"] = {
    s: "start",
    work: { type: "llm", attrs: { allowed_tools: ["read", "bash", "agent"] } },
    done: "exit",
  };
  const edges: NonNullable<Parameters<typeof mkGraph>[0]["edges"]> = [
    ["s", "work"],
    ["work", "done"],
  ];

  test("agent allowed and no budget → W024 once", () => {
    expect(codes(mkGraph({ nodes, edges }), "W024")).toEqual(["W024"]);
  });

  test("agent allowed with a budget → no W024", () => {
    expect(codes(mkGraph({ attrs: { budget_usd: 5 }, nodes, edges }), "W024")).toEqual([]);
  });

  test("no agent, no budget → no W024", () => {
    const g = mkGraph({
      nodes: { s: "start", work: { type: "llm", attrs: { allowed_tools: ["read"] } }, done: "exit" },
      edges,
    });
    expect(codes(g, "W024")).toEqual([]);
  });
});
