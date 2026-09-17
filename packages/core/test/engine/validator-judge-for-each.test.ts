import { describe, expect, test } from "bun:test";
import { validate } from "../../src/engine/validator.ts";
import { parseWorkflow } from "../../src/parser/yaml.ts";

function messages(yaml: string, code: string): string[] {
  return validate(parseWorkflow(yaml))
    .filter((d) => d.code === code)
    .map((d) => d.message);
}

function errors(yaml: string): string[] {
  return validate(parseWorkflow(yaml))
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

const WF = (forEach: string, keep = "    keep: {question: holds, min: 0.6}\n", questions?: string) => `
name: wf
steps:
  read:
    prompt: p
    outputs:
      findings:
        type: array
        items: {type: object, fields: {claim: {type: string}}}
      title: {type: string}
      meta: {type: object, fields: {count: {type: number}}}
    next: judge
  judge:
    type: judge
    for-each: ${forEach}
    questions:
${questions ?? "      holds: {type: noul, instructions: Does `item.claim` hold?}\n      sev: {type: score, instructions: how bad?, criteria: [a, b]}\n"}${keep}    next: synth
  synth:
    prompt: |
      \${{ outputs.judge.kept }}
      \${{ outputs.judge.answers }}
    next: exit
`;

describe("judge for-each — validator (E049)", () => {
  test("well-formed for-each judge validates clean, and its kept/answers refs resolve", () => {
    expect(errors(WF("${{ outputs.read.findings }}"))).toEqual([]);
  });

  test("reference to a missing step", () => {
    expect(messages(WF("${{ outputs.nope.findings }}"), "E049").join("\n")).toMatch(/does not exist/);
  });

  test("reference to an undeclared field", () => {
    expect(messages(WF("${{ outputs.read.nothing }}"), "E049").join("\n")).toMatch(/declares no such output/);
  });

  test("reference to a non-array output", () => {
    expect(messages(WF("${{ outputs.read.title }}"), "E049").join("\n")).toMatch(
      /a `string` — for-each needs an array/,
    );
    expect(messages(WF("${{ outputs.read.meta }}"), "E049").join("\n")).toMatch(/a `record`/);
  });

  test("keep must name a declared noul", () => {
    expect(
      messages(WF("${{ outputs.read.findings }}", "    keep: {question: nope, min: 0.5}\n"), "E049").join("\n"),
    ).toMatch(/names question "nope", which is not declared/);
    expect(
      messages(WF("${{ outputs.read.findings }}", "    keep: {question: sev, min: 0.5}\n"), "E049").join("\n"),
    ).toMatch(/is a `score` — only a `noul`/);
  });

  test("a consumer reading kept from a keep-less judge is E035", () => {
    expect(errors(WF("${{ outputs.read.findings }}", ""))).toContain("E035");
  });

  test("string state leaves are E035-checked like a prompt", () => {
    const src = `
name: wf
steps:
  a:
    prompt: p
    next: j
  j:
    type: judge
    state:
      x: \${{ outputs.nope.field }}
    questions:
      ok: {type: noul, instructions: ok?}
    next: exit
`;
    expect(errors(src)).toContain("E035");
  });
});
