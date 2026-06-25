// Validator tests for run-level outputs: E046 (broken projection, hard error)
// and W018 (producer may not run on every completing path, advisory).
// Proposal §11.4.

import { describe, expect, test } from "bun:test";
import { validate } from "../../src/engine/validator.ts";
import { parseWorkflow } from "../../src/parser/yaml.ts";

function diags(yaml: string) {
  return validate(parseWorkflow(yaml));
}

const codes = (yaml: string) => diags(yaml).map((d) => d.code);

// A producer step "review" declaring a typed outputs struct, always on the
// success path to exit (so it run-dominates the exit → no W018 by default).
const REVIEW = [
  "  review:",
  "    type: llm",
  "    prompt: Review.",
  "    outputs:",
  "      verdict: { type: string }",
  "      scores:",
  "        type: object",
  "        fields:",
  "          total: { type: number }",
  "    next: exit",
].join("\n");

describe("E046 — broken run-output projection", () => {
  test("from: names a nonexistent node is E046", () => {
    const src = ["name: wf", "outputs:", "  v: { from: ghost.verdict }", "steps:", REVIEW].join("\n");
    expect(codes(src)).toContain("E046");
  });

  test("from: names a node that declares no outputs: is E046", () => {
    const src = [
      "name: wf",
      "outputs:",
      "  v: { from: plain.verdict }",
      "steps:",
      "  plain:",
      "    type: llm",
      "    prompt: Hi.",
      "    next: exit",
    ].join("\n");
    expect(codes(src)).toContain("E046");
  });

  test("from: path the producer's schema doesn't declare is E046", () => {
    const src = ["name: wf", "outputs:", "  v: { from: review.nope }", "steps:", REVIEW].join("\n");
    expect(codes(src)).toContain("E046");
  });

  test("dotting into a scalar leaf is a dead path → E046", () => {
    const src = ["name: wf", "outputs:", "  v: { from: review.verdict.deeper }", "steps:", REVIEW].join("\n");
    expect(codes(src)).toContain("E046");
  });

  test("a valid leaf projection emits no E046", () => {
    const src = ["name: wf", "outputs:", "  v: { from: review.verdict }", "steps:", REVIEW].join("\n");
    expect(codes(src)).not.toContain("E046");
  });

  test("a valid dotted sub-record projection emits no E046", () => {
    const src = ["name: wf", "outputs:", "  t: { from: review.scores.total }", "steps:", REVIEW].join("\n");
    expect(codes(src)).not.toContain("E046");
  });

  test("a bare from: a producer that declares outputs is valid (whole struct)", () => {
    const src = ["name: wf", "outputs:", "  whole: { from: review }", "steps:", REVIEW].join("\n");
    expect(codes(src)).not.toContain("E046");
  });
});

describe("W018 — producer may not run on every completing path", () => {
  // A producer behind one route branch: the other branch reaches exit without
  // running it, so it doesn't run-dominate the exit.
  const ROUTED = [
    "name: wf",
    "outputs:",
    "  v: { from: review.verdict }",
    "steps:",
    "  pick:",
    "    type: llm",
    "    prompt: Pick.",
    "    routes:",
    "      a: review",
    "      b: exit",
    REVIEW,
  ].join("\n");

  test("producer reachable but not dominating the exit warns W018", () => {
    const ds = diags(ROUTED);
    const w018 = ds.find((d) => d.code === "W018");
    expect(w018).toBeDefined();
    expect(w018?.severity).toBe("warning");
    expect(ds.some((d) => d.code === "E046")).toBe(false);
  });

  test("a producer that run-dominates the exit is silent (no W018)", () => {
    const src = ["name: wf", "outputs:", "  v: { from: review.verdict }", "steps:", REVIEW].join("\n");
    expect(codes(src)).not.toContain("W018");
  });

  test("W018 stays a warning under non-strict validate", () => {
    const ds = diags(ROUTED);
    expect(ds.filter((d) => d.code === "W018").every((d) => d.severity === "warning")).toBe(true);
  });

  test("strict mode promotes W018 to an error", () => {
    const ds = validate(parseWorkflow(ROUTED), { strict: true });
    expect(ds.filter((d) => d.code === "W018").every((d) => d.severity === "error")).toBe(true);
  });

  test("a wait_all fan-out branch terminal is not W018 (it always runs)", () => {
    const src = [
      "name: wf",
      "outputs:",
      "  a: { from: scan_a.findings }",
      "  b: { from: scan_b.findings }",
      "steps:",
      "  fan:",
      "    type: parallel",
      "    branches: [scan_a, scan_b]",
      "    next: join",
      "  scan_a:",
      "    type: llm",
      "    prompt: A.",
      "    allowed-tools: [read]",
      "    outputs: { findings: { type: array, items: { type: string } } }",
      "    next: join",
      "  scan_b:",
      "    type: llm",
      "    prompt: B.",
      "    allowed-tools: [read]",
      "    outputs: { findings: { type: array, items: { type: string } } }",
      "    next: join",
      "  join:",
      "    type: llm",
      "    prompt: Join.",
      "    next: exit",
    ].join("\n");
    const ds = diags(src);
    expect(ds.some((d) => d.code === "W018")).toBe(false);
    expect(ds.some((d) => d.code === "E046")).toBe(false);
  });
});
