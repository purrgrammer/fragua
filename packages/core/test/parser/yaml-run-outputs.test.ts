// Parser tests for the top-level run-level `outputs:` block (proposal §11).

import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "../../src/parser/yaml.ts";

const producer = (extra = "") =>
  [
    "  review:",
    "    type: llm",
    "    prompt: Review it.",
    "    outputs:",
    "      verdict: { type: string }",
    "      findings:",
    "        type: array",
    "        items: { type: string }",
    "      scores:",
    "        type: object",
    "        fields:",
    "          total: { type: number }",
    "    next: exit",
    extra,
  ]
    .filter((l) => l.length > 0)
    .join("\n");

describe("run-level outputs: block", () => {
  test("parses { from: node.field } into a RunOutputDecl with node + path", () => {
    const src = [
      "name: wf",
      "outputs:",
      "  verdict: { from: review.verdict }",
      "  findings: { from: review.findings }",
      "steps:",
      producer(),
    ].join("\n");
    const g = parseWorkflow(src);
    expect(g.attrs.outputs).toEqual([
      { name: "verdict", node: "review", path: ["verdict"] },
      { name: "findings", node: "review", path: ["findings"] },
    ]);
  });

  test("bare from: node yields an empty path (whole struct)", () => {
    const src = ["name: wf", "outputs:", "  whole: { from: review }", "steps:", producer()].join("\n");
    const g = parseWorkflow(src);
    expect(g.attrs.outputs).toEqual([{ name: "whole", node: "review", path: [] }]);
  });

  test("dotted suffix splits into a multi-segment path", () => {
    const src = ["name: wf", "outputs:", "  total: { from: review.scores.total }", "steps:", producer()].join("\n");
    const g = parseWorkflow(src);
    expect(g.attrs.outputs).toEqual([{ name: "total", node: "review", path: ["scores", "total"] }]);
  });

  test("missing/empty from is a parse error", () => {
    const src = ["name: wf", "outputs:", "  v: { description: nope }", "steps:", producer()].join("\n");
    expect(() => parseWorkflow(src)).toThrow(/must declare a non-empty `from/);
  });

  test("default: on a run output is rejected as not-yet-supported", () => {
    const src = ["name: wf", "outputs:", "  v: { from: review.verdict, default: skipped }", "steps:", producer()].join(
      "\n",
    );
    expect(() => parseWorkflow(src)).toThrow(/default.*not yet supported/);
  });

  test("an empty path segment (trailing dot) is a parse error", () => {
    const src = ["name: wf", "outputs:", "  v: { from: review. }", "steps:", producer()].join("\n");
    expect(() => parseWorkflow(src)).toThrow(/empty path segment/);
  });

  test("outputs: block absent leaves graph.attrs.outputs undefined", () => {
    const src = ["name: wf", "steps:", producer()].join("\n");
    const g = parseWorkflow(src);
    expect(g.attrs.outputs).toBeUndefined();
  });
});
