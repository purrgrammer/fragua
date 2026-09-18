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

const WF = (forEach: string, keep = "    keep: {holds: 0.6}\n", questions?: string) => `
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
    expect(messages(WF("${{ outputs.read.findings }}", "    keep: {nope: 0.5}\n"), "E049").join("\n")).toMatch(
      /names question "nope", which is not declared/,
    );
    expect(messages(WF("${{ outputs.read.findings }}", "    keep: {sev: 0.5}\n"), "E049").join("\n")).toMatch(
      /is a `score` — only a `noul`/,
    );
  });

  test("a consumer reading kept from a keep-less judge is E035", () => {
    expect(errors(WF("${{ outputs.read.findings }}", ""))).toContain("E035");
  });

  test("E050: a backticked item path into a field the producer's items do not declare", () => {
    const src = WF(
      "${{ outputs.read.findings }}",
      "    keep: {holds: 0.6}\n",
      "      holds: {type: noul, instructions: Does `item.cod` hold?}\n",
    );
    expect(messages(src, "E050").join("\n")).toMatch(
      /references `item.cod` but the items .* have no field "cod" \(fields: claim\)/,
    );
    // a valid path, a bare `item`, and an index into a nested array are all fine
    const ok = WF(
      "${{ outputs.read.findings }}",
      "    keep: {holds: 0.6}\n",
      "      holds: {type: noul, instructions: Is `item` about `item.claim`?}\n",
    );
    expect(messages(ok, "E050")).toEqual([]);
  });

  test("W022: item.<field> outside backticks is never re-aimed", () => {
    const src = WF(
      "${{ outputs.read.findings }}",
      "    keep: {holds: 0.6}\n",
      "      holds: {type: noul, instructions: Does item.claim hold given `item.claim`?}\n",
    );
    expect(messages(src, "W022").join("\n")).toMatch(/mentions `item.…` outside backticks/);
    const fine = WF("${{ outputs.read.findings }}", "    keep: {holds: 0.6}\n");
    expect(messages(fine, "W022")).toEqual([]);
  });

  test("E051: a producer item field named judge would be overwritten on kept / dropped", () => {
    const src = `
name: wf
steps:
  read:
    prompt: p
    outputs:
      findings:
        type: array
        items: {type: object, fields: {claim: {type: string}, judge: {type: string}}}
    next: j
  j:
    type: judge
    for-each: \${{ outputs.read.findings }}
    questions:
      holds: {type: noul, instructions: Does \`item.claim\` hold?}
    keep: {holds: 0.6}
    next: exit
`;
    expect(messages(src, "E051").join("\n")).toMatch(/carry a field named "judge"/);
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
