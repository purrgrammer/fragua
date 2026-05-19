// Tests for the YAML workflow parser. Parser-grammar coverage only —
// engine behaviour (validator codes, edge selection, etc.) is tested
// at the engine layer with Graph objects constructed via mkGraph.

import { describe, expect, test } from "bun:test";
import { ParseError, parseWorkflow } from "../../src/parser/yaml.ts";

describe("parseWorkflow — basics", () => {
  test("minimal workflow with name + start/exit", () => {
    const g = parseWorkflow(`
name: t
nodes:
  start: {type: start}
  done:  {type: exit}
edges:
  - {from: start, to: done}
`);
    expect(g.id).toBe("t");
    expect(g.directed).toBe(true);
    expect(g.nodes["start"]?.shape).toBe("Mdiamond");
    expect(g.nodes["done"]?.shape).toBe("Msquare");
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.from).toBe("start");
    expect(g.edges[0]?.to).toBe("done");
  });

  test("llm / human / tool types map to in-memory shapes", () => {
    const g = parseWorkflow(`
name: t
nodes:
  s: {type: start}
  a: {type: llm, prompt: hi}
  b: {type: human, routes: [yes, no]}
  c: {type: tool, tool_command: ls}
  done: {type: exit}
edges: [{from: s, to: a}]
`);
    expect(g.nodes["a"]?.shape).toBe("box");
    expect(g.nodes["b"]?.shape).toBe("hexagon");
    expect(g.nodes["c"]?.shape).toBe("parallelogram");
  });

  test("block-scalar prompts read cleanly without escaping", () => {
    const g = parseWorkflow(`
name: t
nodes:
  s: {type: start}
  work:
    type: llm
    prompt: |
      Line one with "quotes" and a backtick \`.
      Line two follows naturally.
  done: {type: exit}
edges: [{from: s, to: work}]
`);
    const prompt = g.nodes["work"]?.attrs.prompt;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain('"quotes"');
    expect(prompt).toContain("Line two");
  });

  test("graph-level attrs at root", () => {
    const g = parseWorkflow(`
name: t
goal: ship it
label: build
budget_usd: 0.5
budget_policy: warn
nodes:
  s: {type: start}
  done: {type: exit}
edges: [{from: s, to: done}]
`);
    expect(g.attrs.goal).toBe("ship it");
    expect(g.attrs.label).toBe("build");
    expect(g.attrs.budget_usd).toBe(0.5);
    expect(g.attrs.budget_policy).toBe("warn");
  });
});

describe("parseWorkflow — attribute coercion", () => {
  test("boolean coercion via YAML native types", () => {
    const g = parseWorkflow(`
name: t
nodes:
  s: {type: start}
  work: {type: llm, prompt: hi, goal_gate: true}
  done: {type: exit}
edges: [{from: s, to: work}]
`);
    expect(g.nodes["work"]?.attrs.goal_gate).toBe(true);
  });

  test("number coercion (max_cost_usd, budget_usd)", () => {
    const g = parseWorkflow(`
name: t
budget_usd: 1.25
nodes:
  s: {type: start}
  work: {type: llm, prompt: hi, max_cost_usd: 0.10}
  done: {type: exit}
edges: [{from: s, to: work}]
`);
    expect(g.attrs.budget_usd).toBe(1.25);
    expect(g.nodes["work"]?.attrs.max_cost_usd).toBe(0.1);
  });

  test("integer coercion (max_retries, idle_timeout)", () => {
    const g = parseWorkflow(`
name: t
nodes:
  s: {type: start}
  work: {type: llm, prompt: hi, max_retries: 3, idle_timeout: 60}
  done: {type: exit}
edges: [{from: s, to: work}]
`);
    expect(g.nodes["work"]?.attrs.max_retries).toBe(3);
    expect(g.nodes["work"]?.attrs.idle_timeout).toBe(60);
  });

  test("string arrays accept YAML array form", () => {
    const g = parseWorkflow(`
name: t
nodes:
  s: {type: start}
  work:
    type: llm
    prompt: hi
    allowed_tools: [read, bash, edit]
    skills: [frontend, backend]
  done: {type: exit}
edges: [{from: s, to: work}]
`);
    expect(g.nodes["work"]?.attrs.allowed_tools).toEqual(["read", "bash", "edit"]);
    expect(g.nodes["work"]?.attrs.skills).toEqual(["frontend", "backend"]);
  });

  test("string arrays also accept comma-separated string form (back-compat)", () => {
    const g = parseWorkflow(`
name: t
nodes:
  s: {type: start}
  work:
    type: llm
    prompt: hi
    allowed_tools: "read, bash, edit"
  done: {type: exit}
edges: [{from: s, to: work}]
`);
    expect(g.nodes["work"]?.attrs.allowed_tools).toEqual(["read", "bash", "edit"]);
  });

  test("enum: summary accepts low|medium|high", () => {
    const g = parseWorkflow(`
name: t
nodes:
  s: {type: start}
  work: {type: llm, prompt: hi, thread_id: x, summary: medium}
  done: {type: exit}
edges: [{from: s, to: work}]
`);
    expect(g.nodes["work"]?.attrs.summary).toBe("medium");
  });

  test("enum: summary rejects unknown values at parse time", () => {
    expect(() =>
      parseWorkflow(`
name: t
nodes:
  s: {type: start}
  work: {type: llm, prompt: hi, thread_id: x, summary: huge}
  done: {type: exit}
edges: [{from: s, to: work}]
`),
    ).toThrow(ParseError);
  });

  test("enum: budget_policy rejects unknown values", () => {
    expect(() =>
      parseWorkflow(`
name: t
budget_policy: halt
nodes:
  s: {type: start}
  done: {type: exit}
edges: [{from: s, to: done}]
`),
    ).toThrow(/budget_policy/);
  });

  test("edge outcome and route as separate fields", () => {
    const g = parseWorkflow(`
name: t
nodes:
  s: {type: start}
  a: {type: llm, prompt: x, routes: [yes, no]}
  done: {type: exit}
edges:
  - {from: s, to: a}
  - {from: a, to: done, outcome: fail}
  - {from: a, to: done, route: yes}
`);
    expect(g.edges[1]?.attrs.outcome).toBe("fail");
    expect(g.edges[2]?.attrs.route).toBe("yes");
  });
});

describe("parseWorkflow — error paths", () => {
  test("missing name", () => {
    expect(() =>
      parseWorkflow(`
nodes: {s: {type: start}, done: {type: exit}}
edges: [{from: s, to: done}]
`),
    ).toThrow(/name/);
  });

  test("missing nodes mapping", () => {
    expect(() =>
      parseWorkflow(`
name: t
edges: [{from: s, to: done}]
`),
    ).toThrow(/nodes/);
  });

  test("missing edges sequence", () => {
    expect(() =>
      parseWorkflow(`
name: t
nodes: {s: {type: start}, done: {type: exit}}
`),
    ).toThrow(/edges/);
  });

  test("unknown node type", () => {
    expect(() =>
      parseWorkflow(`
name: t
nodes:
  s: {type: start}
  weird: {type: subgraph}
  done: {type: exit}
edges: [{from: s, to: weird}]
`),
    ).toThrow(/unknown type/);
  });

  test("malformed YAML throws with line/col", () => {
    try {
      parseWorkflow(`name: t\nnodes:\n  bad: [unclosed`);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).line).toBeGreaterThan(0);
    }
  });
});
