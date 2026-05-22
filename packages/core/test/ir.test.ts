// Round-trip + loc-stripping tests for the canonical IR codec (proposal
// workflow-ir, move A). The invariant: deserialize(serialize(parse(src))) is
// executor-equivalent to parse(src) — i.e. equal modulo `loc`, which is
// validator-only metadata that must NOT survive into the persisted IR.

import { describe, expect, test } from "bun:test";
import { CURRENT_IR_VERSION, deserializeGraph, serializeGraph, stripLoc } from "../src/ir.ts";
import { parseWorkflow } from "../src/parser/yaml.ts";

const FIXTURES: Record<string, string> = {
  "single llm step": `name: solo
steps:
  work: {type: llm, prompt: do it}
`,
  "multi-step with outcome + route edges": `name: pipeline
steps:
  plan:
    type: llm
    prompt: plan it
    routes: {build: impl, finish: done}
  impl:
    type: llm
    prompt: build it
    on: {success: verify, fail: plan}
  verify: {type: tool, run: "make test"}
  done: {type: exit}
`,
  "inputs block + numeric/array attrs": `name: configured
inputs:
  ticket: {type: string, required: true}
  dry_run: {type: boolean, default: false}
defaults:
  model: claude-opus-4-7
  provider: anthropic
steps:
  impl:
    type: llm
    prompt: "fix \${{ inputs.ticket }}"
    allowed-tools: [read, write, bash]
    context-files: [docs/A.md, docs/B.md]
    max_cost_usd: 1.5
    max-retries: 3
    next: exit
`,
};

describe("IR codec — round-trip modulo loc", () => {
  for (const [label, source] of Object.entries(FIXTURES)) {
    test(`${label}: deserialize(serialize(parse)) ≡ stripLoc(parse)`, () => {
      const parsed = parseWorkflow(source);
      const roundTripped = deserializeGraph(serializeGraph(parsed));
      expect(roundTripped).toEqual(stripLoc(parsed));
    });

    test(`${label}: serialized IR carries no "loc" key`, () => {
      const ir = serializeGraph(parseWorkflow(source));
      expect(ir).not.toContain('"loc"');
    });
  }

  test("stripLoc removes loc from nodes and edges but preserves everything else", () => {
    const parsed = parseWorkflow(FIXTURES["multi-step with outcome + route edges"]!);
    // parse output carries loc on real (authored) nodes/edges
    const hadLoc = Object.values(parsed.nodes).some((n) => n.loc != null) || parsed.edges.some((e) => e.loc != null);
    expect(hadLoc).toBe(true);

    const stripped = stripLoc(parsed);
    expect(Object.values(stripped.nodes).every((n) => n.loc === undefined)).toBe(true);
    expect(stripped.edges.every((e) => e.loc === undefined)).toBe(true);
    // identity + structure intact
    expect(stripped.id).toBe(parsed.id);
    expect(Object.keys(stripped.nodes).sort()).toEqual(Object.keys(parsed.nodes).sort());
    expect(stripped.edges.length).toBe(parsed.edges.length);
  });

  test("stripLoc does not mutate the input graph", () => {
    const parsed = parseWorkflow(FIXTURES["single llm step"]!);
    const before = JSON.stringify(parsed);
    stripLoc(parsed);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  test("CURRENT_IR_VERSION is 1 at 0.1.0", () => {
    expect(CURRENT_IR_VERSION).toBe(1);
  });
});
