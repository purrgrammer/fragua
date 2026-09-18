import { describe, expect, test } from "bun:test";
import { ParseError, parseWorkflow } from "../../src/parser/yaml.ts";
import { JUDGE_DEFAULT_FOR_EACH_MAX_ITEMS } from "../../src/types/judge.ts";
import type { OutputArray, OutputRecord } from "../../src/types/outputs.ts";

const READ = `
  read:
    prompt: Open each cited location.
    outputs:
      findings:
        type: array
        items:
          type: object
          fields:
            claim: {type: string}
            cited_code: {type: string}
            fix: {type: string, optional: true}
    next: judge
`;

const FOR_EACH = (extra = "", keep = "    keep: {holds: 0.6}\n") => `
name: wf
steps:${READ}
  judge:
    type: judge
    for-each: \${{ outputs.read.findings }}
${extra}    questions:
      holds:
        type: noul
        instructions: Does \`item.cited_code\` show \`item.claim\`?
      severity:
        type: score
        instructions: How severe is \`item.claim\`?
        criteria: [low, medium, high]
${keep}    next: exit
`;

describe("judge for-each — parser", () => {
  test("lowers for-each, keep, and the default cap; state is optional", () => {
    const g = parseWorkflow(FOR_EACH());
    const j = g.nodes["judge"]!;
    expect(j.attrs.judge_for_each).toBe("${{ outputs.read.findings }}");
    expect(j.attrs.judge_keep).toEqual({ rules: [{ question: "holds", min: 0.6 }] });
    expect(j.attrs.judge_for_each_max_items).toBe(JUDGE_DEFAULT_FOR_EACH_MAX_ITEMS);
    expect(j.attrs.judge_state).toBeUndefined();
  });

  test("derives answers plus kept/dropped typed with the producer's item fields", () => {
    const g = parseWorkflow(FOR_EACH());
    const outputs = g.nodes["judge"]!.attrs.outputs!;
    expect(Object.keys(outputs).sort()).toEqual(["answers", "dropped", "kept"]);
    const answers = outputs["answers"] as OutputArray;
    expect(answers.kind).toBe("array");
    expect(Object.keys((answers.items as OutputRecord).fields).sort()).toEqual(["holds", "severity"]);
    const kept = (outputs["kept"] as OutputArray).items as OutputRecord;
    expect(Object.keys(kept.fields).sort()).toEqual(["cited_code", "claim", "fix", "judge"]);
    expect(kept.required).toEqual(["cited_code", "claim", "judge"]);
    expect((kept.fields["judge"] as OutputRecord).fields["holds"]).toEqual({
      kind: "record",
      fields: { noul: { kind: "number" } },
      required: ["noul"],
    });
  });

  test("without keep only answers is derived", () => {
    const g = parseWorkflow(FOR_EACH("", ""));
    expect(Object.keys(g.nodes["judge"]!.attrs.outputs!)).toEqual(["answers"]);
  });

  test("shared state leaves and an explicit cap are accepted", () => {
    const g = parseWorkflow(
      FOR_EACH("    state:\n      diff: {file: review-diff.patch}\n    for-each-max-items: 20\n"),
    );
    const j = g.nodes["judge"]!;
    expect(j.attrs.judge_state).toEqual({ diff: { file: "review-diff.patch" } });
    expect(j.attrs.judge_for_each_max_items).toBe(20);
  });

  test("a non-record item type is typed under `item`", () => {
    const src = `
name: wf
steps:
  read:
    prompt: p
    outputs:
      paths: {type: array, items: {type: string}}
    next: judge
  judge:
    type: judge
    for-each: \${{ outputs.read.paths }}
    questions:
      relevant: {type: noul, instructions: Is \`item\` relevant?}
    keep: {relevant: 0.5}
    next: exit
`;
    const kept = (parseWorkflow(src).nodes["judge"]!.attrs.outputs!["kept"] as OutputArray).items as OutputRecord;
    expect(kept.fields["item"]).toEqual({ kind: "string" });
    expect(kept.required).toEqual(["item", "judge"]);
  });

  test("for-each must be exactly one outputs reference", () => {
    expect(() =>
      parseWorkflow(FOR_EACH().replace("${{ outputs.read.findings }}", "some ${{ outputs.read.findings }}")),
    ).toThrow(/exactly one/);
    expect(() => parseWorkflow(FOR_EACH().replace("${{ outputs.read.findings }}", "${{ inputs.list }}"))).toThrow(
      ParseError,
    );
  });

  test("decide and for-each are exclusive; keep needs for-each", () => {
    expect(() => parseWorkflow(FOR_EACH("    decide:\n      outcome: {holds: 0.5}\n"))).toThrow(
      /both `for-each:` and `decide:`/,
    );
    const noForEach = FOR_EACH().replace("    for-each: ${{ outputs.read.findings }}\n", "    state: x\n");
    expect(() => parseWorkflow(noForEach)).toThrow(/`keep:` without `for-each:`/);
  });

  test("keep accepts several ids with their own bounds", () => {
    const g = parseWorkflow(
      FOR_EACH("", "    keep: {holds: 0.5, holds2: {max: 0.4}}\n").replace(
        "      severity:",
        "      holds2: {type: noul, instructions: also?}\n      severity:",
      ),
    );
    expect(g.nodes["judge"]!.attrs.judge_keep).toEqual({
      rules: [
        { question: "holds", min: 0.5 },
        { question: "holds2", max: 0.4 },
      ],
    });
  });

  test("keep shape errors name the key", () => {
    expect(() => parseWorkflow(FOR_EACH("", "    keep: {holds: 1.5}\n"))).toThrow(/keep.holds/);
    expect(() => parseWorkflow(FOR_EACH("", "    keep: {holds: {min: 0.5, extra: 1}}\n"))).toThrow(/keep.holds.extra/);
    expect(() => parseWorkflow(FOR_EACH("", "    keep: {holds: {}}\n"))).toThrow(/at least one of min/);
  });
});
