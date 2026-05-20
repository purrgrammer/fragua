// Tests for the YAML workflow parser. Parser-grammar coverage only —
// engine behaviour (validator codes, edge selection, etc.) is tested
// at the engine layer with Graph objects constructed via mkGraph.

import { describe, expect, test } from "bun:test";
import { validate } from "../../src/engine/validator.ts";
import { ParseError, parseWorkflow } from "../../src/parser/yaml.ts";

describe("parseWorkflow — basics", () => {
  test("minimal workflow with single llm step", () => {
    const g = parseWorkflow(`
name: t
steps:
  work:
    type: llm
    prompt: hi
`);
    expect(g.id).toBe("t");
    expect(g.directed).toBe(true);
    // Synthetic start node + user step + synthetic exit (linear default → exit).
    expect(g.nodes["start"]?.type).toBe("start");
    expect(g.nodes["work"]?.type).toBe("llm");
    expect(g.nodes["exit"]?.type).toBe("exit");
  });

  test("llm / human / tool / exit types map to in-memory shapes", () => {
    const g = parseWorkflow(`
name: t
steps:
  a:
    type: llm
    prompt: hi
    next: b
  b:
    type: human
    text: choose
    routes:
      yes: c
      no:  exit
  c:
    type: tool
    run: ls
`);
    expect(g.nodes["a"]?.type).toBe("llm");
    expect(g.nodes["b"]?.type).toBe("human");
    expect(g.nodes["c"]?.type).toBe("tool");
  });

  test("block-scalar prompts read cleanly without escaping", () => {
    const g = parseWorkflow(`
name: t
steps:
  work:
    type: llm
    prompt: |
      Line one with "quotes" and a backtick \`.
      Line two follows naturally.
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
description: build pipeline
budget: 0.5
budget-policy: warn
steps:
  work: {type: llm, prompt: hi}
`);
    expect(g.attrs.goal).toBe("ship it");
    expect(g.attrs.label).toBe("build pipeline");
    expect(g.attrs.budget_usd).toBe(0.5);
    expect(g.attrs.budget_policy).toBe("warn");
  });
});

describe("parseWorkflow — kebab-case lowering", () => {
  test("authoring kebab attrs lower to snake_case IR keys", () => {
    const g = parseWorkflow(`
name: t
steps:
  work:
    type: llm
    model: claude-sonnet-4-6
    provider: anthropic
    thread: dev
    effort: high
    allowed-tools: [read, bash]
    denied-tools: [agent]
    max-cost: 0.50
    max-tokens: 80000
    max-retries: 3
    timeout-minutes: 5
    prompt: hi
`);
    const a = g.nodes["work"]!.attrs;
    expect(a.model).toBe("claude-sonnet-4-6");
    expect(a.provider).toBe("anthropic");
    expect(a.thread_id).toBe("dev");
    expect(a.reasoning_effort).toBe("high");
    expect(a.allowed_tools).toEqual(["read", "bash"]);
    expect(a.denied_tools).toEqual(["agent"]);
    expect(a.max_cost_usd).toBe(0.5);
    expect(a.max_tokens).toBe(80000);
    expect(a.max_retries).toBe(3);
    expect(a.max_ms).toBe(300_000);
  });

  test("`run:` lowers to tool_command on tool steps", () => {
    const g = parseWorkflow(`
name: t
steps:
  build: {type: tool, run: "bun run build"}
`);
    expect(g.nodes["build"]?.attrs.tool_command).toBe("bun run build");
  });

  test("defaults: block populates llm steps when attr is absent", () => {
    const g = parseWorkflow(`
name: t
defaults:
  provider: anthropic
  model: claude-sonnet-4-6
steps:
  a: {type: llm, prompt: x}
  b: {type: llm, prompt: y, model: claude-haiku-4-5}
`);
    expect(g.nodes["a"]?.attrs.provider).toBe("anthropic");
    expect(g.nodes["a"]?.attrs.model).toBe("claude-sonnet-4-6");
    // explicit overrides default
    expect(g.nodes["b"]?.attrs.provider).toBe("anthropic");
    expect(g.nodes["b"]?.attrs.model).toBe("claude-haiku-4-5");
  });
});

describe("parseWorkflow — graph attrs", () => {
  test("`max-goal-gate-retries` is no longer a known graph attr — becomes W013 unknown-attr warning", () => {
    // After the removal from GRAPH_KEY_TO_IR it passes through as an
    // unrecognised key and trips the W013 unknown-graph-attr warning.
    const g = parseWorkflow(`
name: t
max-goal-gate-retries: 3
steps:
  work: {type: llm, prompt: x}
`);
    const diags = validate(g);
    const w013 = diags.filter((d) => d.code === "W013");
    expect(
      w013.some((d) => d.message.includes("max_goal_gate_retries") || d.message.includes("max-goal-gate-retries")),
    ).toBe(true);
    // The key must NOT land on graph.attrs as a recognised integer field.
    expect((g.attrs as Record<string, unknown>)["max_goal_gate_retries"]).toBeUndefined();
  });
});

describe("parseWorkflow — edge synthesis", () => {
  test("implicit linear: step with no routing flows to next declared step", () => {
    const g = parseWorkflow(`
name: t
steps:
  a: {type: llm, prompt: x}
  b: {type: llm, prompt: y}
  c: {type: llm, prompt: z}
`);
    // Success-only chain: start -> a, a -> b, b -> c, c -> exit. No fail
    // edges are synthesized — an unhandled failure halts the run.
    const edgeKeys = g.edges.map((e) => `${e.from}->${e.to}:${e.attrs.outcome ?? ""}:${e.attrs.route ?? ""}`);
    expect(edgeKeys).toContain("start->a::");
    expect(edgeKeys).toContain("a->b:success:");
    expect(edgeKeys).toContain("b->c:success:");
    expect(edgeKeys).toContain("c->exit:success:");
    expect(edgeKeys.filter((k) => k.includes(":fail:"))).toEqual([]);
  });

  test("`next: X` is shorthand for on.success — no fail edge synthesized", () => {
    const g = parseWorkflow(`
name: t
steps:
  a:
    type: llm
    prompt: x
    next: c
  b: {type: llm, prompt: y}
  c: {type: llm, prompt: z}
`);
    const aOut = g.edges.filter((e) => e.from === "a");
    expect(aOut.length).toBe(1);
    expect(aOut[0]?.attrs.outcome).toBe("success");
    expect(aOut[0]?.to).toBe("c");
  });

  test("explicit `on: {fail: exit}` is the only way to route failure to the sink", () => {
    const g = parseWorkflow(`
name: t
steps:
  a:
    type: tool
    run: make
    on: {success: b, fail: exit}
  b: {type: llm, prompt: y}
`);
    const aOut = g.edges.filter((e) => e.from === "a");
    expect(aOut.find((e) => e.attrs.outcome === "fail")?.to).toBe("exit");
    expect(g.nodes["exit"]?.type).toBe("exit");
  });

  test("`on: {success: X, fail: Y}` produces two outcome edges", () => {
    const g = parseWorkflow(`
name: t
steps:
  ci:
    type: tool
    run: bun test
    on:
      success: ship
      fail: fix
  ship: {type: llm, prompt: s}
  fix: {type: llm, prompt: f, next: ci}
`);
    const ciOut = g.edges.filter((e) => e.from === "ci");
    expect(ciOut.find((e) => e.attrs.outcome === "success")?.to).toBe("ship");
    expect(ciOut.find((e) => e.attrs.outcome === "fail")?.to).toBe("fix");
  });

  test("`routes:` compact form maps each key to a route edge", () => {
    const g = parseWorkflow(`
name: t
steps:
  triage:
    type: llm
    prompt: classify
    routes:
      small: plan
      blocked: exit
  plan: {type: llm, prompt: p}
`);
    const triageOut = g.edges.filter((e) => e.from === "triage");
    expect(triageOut.find((e) => e.attrs.route === "small")?.to).toBe("plan");
    expect(triageOut.find((e) => e.attrs.route === "blocked")?.to).toBe("exit");
    expect(g.nodes["triage"]?.attrs.routes).toEqual(["small", "blocked"]);
  });

  test("`routes:` expanded form preserves label", () => {
    const g = parseWorkflow(`
name: t
steps:
  approve:
    type: human
    text: ok?
    routes:
      yes: {to: ship, label: "Promote"}
      no:  {to: exit, label: "Send back"}
  ship: {type: llm, prompt: s}
`);
    const yes = g.edges.find((e) => e.from === "approve" && e.attrs.route === "yes");
    expect(yes?.to).toBe("ship");
    expect(yes?.attrs.label).toBe("Promote");
  });

  test("`retry: <step>` lowers to goal_gate + retry_target", () => {
    const g = parseWorkflow(`
name: t
steps:
  implement: {type: llm, prompt: i}
  review:
    type: llm
    prompt: r
    retry: implement
    max-retries: 3
`);
    expect(g.nodes["review"]?.attrs.goal_gate).toBe(true);
    expect(g.nodes["review"]?.attrs.retry_target).toBe("implement");
    expect(g.nodes["review"]?.attrs.max_retries).toBe(3);
  });

  test("mutex: next/on/routes triple is rejected", () => {
    expect(() =>
      parseWorkflow(`
name: t
steps:
  a:
    type: llm
    prompt: x
    next: b
    on: {success: c}
  b: {type: llm, prompt: b}
  c: {type: llm, prompt: c}
`),
    ).toThrow(/more than one of/);
  });
});

describe("parseWorkflow — inputs", () => {
  test("typed inputs block parses with all field kinds", () => {
    const g = parseWorkflow(`
name: t
inputs:
  ticket:
    type: string
    required: true
    description: Bug ticket id
  dry-run:
    type: boolean
    default: false
  env:
    type: choice
    options: [dev, staging, prod]
steps:
  work: {type: llm, prompt: hi}
`);
    const inputs = g.attrs["inputs"] as unknown as Array<{
      name: string;
      type: string;
      required: boolean;
      options?: string[];
    }>;
    expect(inputs).toHaveLength(3);
    const byName = Object.fromEntries(inputs.map((i) => [i.name, i]));
    expect(byName["ticket"]?.type).toBe("string");
    expect(byName["ticket"]?.required).toBe(true);
    expect(byName["dry-run"]?.type).toBe("boolean");
    expect(byName["env"]?.type).toBe("choice");
    expect(byName["env"]?.options).toEqual(["dev", "staging", "prod"]);
  });

  test("type=choice without options[] is a parse error", () => {
    expect(() =>
      parseWorkflow(`
name: t
inputs:
  env:
    type: choice
steps:
  work: {type: llm, prompt: hi}
`),
    ).toThrow(/no options/);
  });
});

describe("parseWorkflow — error paths", () => {
  test("missing name field", () => {
    expect(() => parseWorkflow(`steps: {a: {type: llm, prompt: x}}`)).toThrow(/missing required `name:`/);
  });

  test("missing steps mapping", () => {
    expect(() => parseWorkflow(`name: t`)).toThrow(/missing `steps:`/);
  });

  test("unknown step type", () => {
    expect(() =>
      parseWorkflow(`
name: t
steps:
  weird: {type: subgraph}
`),
    ).toThrow(/unknown type/);
  });

  test("malformed YAML throws with line/col", () => {
    try {
      parseWorkflow(`name: t\nsteps:\n  a: : invalid`);
      throw new Error("expected ParseError");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
    }
  });
});
