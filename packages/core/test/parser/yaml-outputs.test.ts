import { describe, expect, test } from "bun:test";
import { ParseError, parseWorkflow } from "../../src/parser/yaml.ts";

describe("parseWorkflow with outputs:", () => {
  test("llm step outputs: land in node.attrs.outputs canonically", () => {
    const src = `
name: wf
steps:
  scope:
    type: llm
    prompt: Do something.
    outputs:
      pr_number:
        type: string
      loc:
        type: number
    next: exit
`;
    const g = parseWorkflow(src);
    const node = g.nodes["scope"]!;
    expect(node.attrs.outputs).toBeDefined();
    const outputs = node.attrs.outputs!;
    expect(outputs["pr_number"]).toEqual({ kind: "string" });
    expect(outputs["loc"]).toEqual({ kind: "number" });
  });

  test("tool step outputs: throws ParseError (llm-only in the MVP)", () => {
    const src = `
name: wf
steps:
  collect:
    type: tool
    run: ./collect.sh
    outputs:
      total:
        type: number
    next: exit
`;
    expect(() => parseWorkflow(src)).toThrow(ParseError);
    try {
      parseWorkflow(src);
    } catch (e) {
      expect((e as ParseError).message).toContain("only supported on `llm`");
    }
  });

  test("llm step declaring both outputs: and routes: throws ParseError", () => {
    const src = `
name: wf
steps:
  scope:
    type: llm
    prompt: Classify.
    routes:
      a: exit
      b: exit
    outputs:
      pr:
        type: string
`;
    expect(() => parseWorkflow(src)).toThrow(ParseError);
    try {
      parseWorkflow(src);
    } catch (e) {
      expect((e as ParseError).message).toContain("mutually exclusive");
    }
  });

  test("human step with outputs: throws ParseError", () => {
    const src = `
name: wf
steps:
  gate:
    type: human
    text: Approve?
    routes:
      approve: exit
    outputs:
      answer:
        type: string
`;
    expect(() => parseWorkflow(src)).toThrow(ParseError);
    try {
      parseWorkflow(src);
    } catch (e) {
      expect(e instanceof ParseError).toBe(true);
      expect((e as ParseError).message).toContain("human");
    }
  });

  test("outputs: with disallowed profile construct throws ParseError", () => {
    const src = `
name: wf
steps:
  scope:
    type: llm
    prompt: Do something.
    outputs:
      name:
        type: string
        pattern: "^[a-z]+$"
    next: exit
`;
    expect(() => parseWorkflow(src)).toThrow(ParseError);
    try {
      parseWorkflow(src);
    } catch (e) {
      expect(e instanceof ParseError).toBe(true);
      expect((e as ParseError).message).toMatch(/pattern|disallowed/);
    }
  });

  test("step without outputs: has attrs.outputs === undefined", () => {
    const src = `
name: wf
steps:
  impl:
    type: llm
    prompt: Do it.
    next: exit
`;
    const g = parseWorkflow(src);
    expect(g.nodes["impl"]!.attrs.outputs).toBeUndefined();
  });

  test("outputs fields are preserved through parse and round-trip", () => {
    const src = `
name: wf
steps:
  produce:
    type: llm
    prompt: Produce.
    outputs:
      env:
        type: choice
        options:
          - dev
          - prod
      bumps:
        type: array
        items:
          type: object
          fields:
            pkg:
              type: string
    next: exit
`;
    const g = parseWorkflow(src);
    const outputs = g.nodes["produce"]!.attrs.outputs!;
    const env = outputs["env"]!;
    expect(env.kind).toBe("choice");
    if (env.kind === "choice") expect(env.options).toContain("dev");

    const bumps = outputs["bumps"]!;
    expect(bumps.kind).toBe("array");
    if (bumps.kind === "array") {
      expect(bumps.items.kind).toBe("record");
    }
  });
});
