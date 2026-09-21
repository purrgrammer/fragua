import { describe, expect, test } from "bun:test";
import { CURRENT_IR_VERSION, convertIr, deserializeGraph, serializeGraph } from "../../src/ir.ts";
import { ParseError, parseWorkflow } from "../../src/parser/yaml.ts";
import { JUDGE_DEFAULT_STATE_MAX_BYTES } from "../../src/types/judge.ts";

const VERIFY = `
name: wf
steps:
  synthesize:
    prompt: Write review.md
    outputs:
      focus: {type: string}
    next: verify
  verify:
    type: judge
    state:
      review: {file: review.md}
      focus: \${{ outputs.synthesize.focus }}
      nested:
        a: literal text
    questions:
      schema_ok:
        type: noul
        instructions: Does \`review\` follow the schema?
      depth:
        type: score
        instructions: How thorough is \`review\`?
        criteria:
          - superficial
          - adequate
          - thorough
    decide:
      outcome: {schema_ok: 0.7}
    retry: synthesize
    max-retries: 2
    next: exit
`;

const CLASSIFY = `
name: wf
steps:
  classify:
    type: judge
    state: \${{ inputs.diff }}
    questions:
      size:
        type: choice
        instructions:
          question: Size the change.
          focus: semantic surface, not line count
        criteria:
          skip: {what: no semantic change, examples: [typo, whitespace]}
          quick: one concern, small
          full: anything else
    decide:
      route: {question: size, min-confidence: 0.6, below: unsure}
    routes:
      skip: exit
      quick: quick_review
      full: full_review
      unsure: ask
  quick_review:
    prompt: q
    next: exit
  full_review:
    prompt: f
    next: exit
  ask:
    type: human
    text: Which?
    routes:
      quick: quick_review
      full: full_review
`;

describe("parseWorkflow — judge steps", () => {
  test("lowers state / questions / decide.outcome and derives outputs", () => {
    const g = parseWorkflow(VERIFY);
    const n = g.nodes["verify"]!;
    expect(n.type).toBe("judge");
    expect(n.attrs.judge_state).toEqual({
      review: { file: "review.md" },
      focus: "${{ outputs.synthesize.focus }}",
      nested: { a: "literal text" },
    });
    expect(n.attrs.judge_questions).toEqual({
      schema_ok: { type: "noul", instructions: "Does `review` follow the schema?" },
      depth: {
        type: "score",
        instructions: "How thorough is `review`?",
        criteria: ["superficial", "adequate", "thorough"],
      },
    });
    expect(n.attrs.judge_decide).toEqual({ outcome: { rules: [{ question: "schema_ok", min: 0.7 }] } });
    expect(n.attrs.judge_state_max_bytes).toBe(JUDGE_DEFAULT_STATE_MAX_BYTES);
    expect(n.attrs.goal_gate).toBe(true);
    expect(n.attrs.retry_target).toBe("synthesize");
    expect(n.attrs.outputs).toEqual({
      schema_ok: { kind: "record", fields: { noul: { kind: "number" } }, required: ["noul"] },
      depth: {
        kind: "record",
        fields: {
          score: { kind: "number" },
          level: { kind: "number" },
          confidence: { kind: "number" },
          probabilities: { kind: "array", items: { kind: "number" } },
        },
        required: ["confidence", "level", "probabilities", "score"],
      },
    });
    expect(g.edges.filter((e) => e.from === "verify")).toEqual([
      { from: "verify", to: "exit", attrs: { outcome: "success" } },
    ]);
  });

  test("decide.route + routes: coexist with derived outputs on one node", () => {
    const g = parseWorkflow(CLASSIFY);
    const n = g.nodes["classify"]!;
    expect(n.attrs.judge_state).toBe("${{ inputs.diff }}");
    expect(n.attrs.judge_decide).toEqual({ route: { question: "size", min_confidence: 0.6, below: "unsure" } });
    expect(n.attrs.routes).toEqual(["skip", "quick", "full", "unsure"]);
    const q = n.attrs.judge_questions!["size"]!;
    expect(q.type).toBe("choice");
    expect(q.instructions).toEqual({ question: "Size the change.", focus: "semantic surface, not line count" });
    if (q.type === "choice") {
      expect(q.criteria["skip"]).toEqual({ what: "no semantic change", examples: ["typo", "whitespace"] });
    }
    expect(n.attrs.outputs!["size"]).toEqual({
      kind: "record",
      fields: {
        choice: { kind: "choice", options: ["full", "quick", "skip"] },
        confidence: { kind: "number" },
        probabilities: {
          kind: "record",
          fields: { skip: { kind: "number" }, quick: { kind: "number" }, full: { kind: "number" } },
          required: ["full", "quick", "skip"],
        },
      },
      required: ["choice", "confidence", "probabilities"],
    });
    expect(g.edges.filter((e) => e.from === "classify").map((e) => e.attrs.route)).toEqual([
      "skip",
      "quick",
      "full",
      "unsure",
    ]);
  });

  test("judge nodes survive the IR round-trip at the current version", () => {
    const g = parseWorkflow(CLASSIFY);
    const json = serializeGraph(g);
    const back = deserializeGraph(json);
    expect(back.nodes["classify"]!.attrs.judge_questions).toEqual(g.nodes["classify"]!.attrs.judge_questions!);
    expect(convertIr(JSON.parse(json), CURRENT_IR_VERSION).version).toBe(CURRENT_IR_VERSION);
  });

  test("state-max-bytes overrides the default; out-of-range is rejected", () => {
    const ok = parseWorkflow(VERIFY.replace("    decide:", "    state-max-bytes: 4096\n    decide:"));
    expect(ok.nodes["verify"]!.attrs.judge_state_max_bytes).toBe(4096);
    expect(() => parseWorkflow(VERIFY.replace("    decide:", "    state-max-bytes: 99999999\n    decide:"))).toThrow(
      /state-max-bytes/,
    );
  });
});

describe("parseWorkflow — judge step rejections", () => {
  const judge = (body: string) => `name: wf\nsteps:\n  j:\n    type: judge\n${body}\n    next: exit\n`;
  const Q = "    questions:\n      ok:\n        type: noul\n        instructions: Is it ok?\n";

  test.each<[string, string, RegExp]>([
    ["missing state", `${Q}`, /needs a `state:` block/],
    ["missing questions", "    state: hi\n", /needs a `questions:` block/],
    ["empty state", `    state: ""\n${Q}`, /`state` is empty/],
    ["state file absolute", `    state: {file: /etc/passwd}\n${Q}`, /relative to the worktree/],
    ["state file escapes", `    state: {file: ../x}\n${Q}`, /may not contain `\.\.`/],
    ["state leaf wrong type", `    state: {n: 42}\n${Q}`, /must be text/],
    [
      "question id not identifier",
      "    state: hi\n    questions:\n      bad-id:\n        type: noul\n        instructions: x\n",
      /not a valid identifier/,
    ],
    [
      "unknown question type",
      "    state: hi\n    questions:\n      q:\n        type: rank\n        instructions: x\n",
      /unknown type "rank"/,
    ],
    [
      "missing instructions",
      "    state: hi\n    questions:\n      q:\n        type: noul\n",
      /non-empty `instructions`/,
    ],
    [
      "unknown question key",
      "    state: hi\n    questions:\n      q:\n        type: noul\n        instructions: x\n        prompt: y\n",
      /unknown key "prompt"/,
    ],
    [
      "choice criteria as list",
      "    state: hi\n    questions:\n      q:\n        type: choice\n        instructions: x\n        criteria: [a, b]\n",
      /mapping of ≥ 2 option ids/,
    ],
    [
      "choice single option",
      "    state: hi\n    questions:\n      q:\n        type: choice\n        instructions: x\n        criteria: {a: one}\n",
      /≥ 2 option ids/,
    ],
    [
      "choice option not identifier",
      "    state: hi\n    questions:\n      q:\n        type: choice\n        instructions: x\n        criteria: {a: one, 'b c': two}\n",
      /option "b c" is not a valid identifier/,
    ],
    [
      "score criteria as map",
      "    state: hi\n    questions:\n      q:\n        type: score\n        instructions: x\n        criteria: {1: low, 3: high}\n",
      /ordered list of ≥ 2/,
    ],
    [
      "score single level",
      "    state: hi\n    questions:\n      q:\n        type: score\n        instructions: x\n        criteria: [only]\n",
      /ordered list of ≥ 2/,
    ],
    [
      "noul criteria wrong keys",
      "    state: hi\n    questions:\n      q:\n        type: noul\n        instructions: x\n        criteria: {yes: a, no: b}\n",
      /only have `true:` \/ `false:`/,
    ],
    [
      "decide with both arms",
      `    state: hi\n${Q}    decide:\n      route: {question: ok}\n      outcome: {ok: 0.5}\n`,
      /exactly one of `route:` \/ `outcome:`/,
    ],
    ["decide empty", `    state: hi\n${Q}    decide: {}\n`, /exactly one of/],
    [
      "decide.route min-confidence without below",
      `    state: hi\n${Q}    decide:\n      route: {question: ok, min-confidence: 0.5}\n`,
      /needs `below` together with a floor/,
    ],
    [
      "decide.route below without a floor",
      `    state: hi\n${Q}    decide:\n      route: {question: ok, below: x}\n`,
      /needs `below` together with a floor/,
    ],
    [
      "decide.route min-probability out of range",
      `    state: hi\n${Q}    decide:\n      route: {question: ok, min-probability: 2, below: x}\n`,
      /in \[0, 1\]/,
    ],
    [
      "decide.route min-confidence out of range",
      `    state: hi\n${Q}    decide:\n      route: {question: ok, min-confidence: 1.5, below: x}\n`,
      /in \[0, 1\]/,
    ],
    [
      "decide.outcome no bound",
      `    state: hi\n${Q}    decide:\n      outcome: {ok: {}}\n`,
      /at least one of min \/ max/,
    ],
    [
      "decide.outcome unknown key",
      `    state: hi\n${Q}    decide:\n      outcome: {ok: {min: 0.5, below: 1}}\n`,
      /decide\.outcome\.ok\.below.*not a recognised key/,
    ],
    [
      "authored outputs on a judge",
      `    state: hi\n${Q}    outputs:\n      x: {type: string}\n`,
      /outputs are only supported on `llm` steps/,
    ],
    ["prompt on a judge", `    state: hi\n${Q}    prompt: hello\n`, /declares `prompt:` — a judge runs no agent turn/],
    ["allowed-tools on a judge", `    state: hi\n${Q}    allowed-tools: [read]\n`, /declares `allowed-tools:`/],
    ["thread on a judge", `    state: hi\n${Q}    thread: t\n`, /declares `thread:`/],
  ])("%s", (_name, body, re) => {
    expect(() => parseWorkflow(judge(body))).toThrow(ParseError);
    expect(() => parseWorkflow(judge(body))).toThrow(re);
  });

  test("judge-only keys on other step types are rejected", () => {
    for (const [type, key] of [
      ["llm", "state: x"],
      ["tool", "questions: {q: {type: noul, instructions: x}}"],
      ["human", "decide: {outcome: {q: 0.5}}"],
    ] as const) {
      const src = `name: wf\nsteps:\n  s:\n    type: ${type}\n    ${type === "tool" ? "run: true" : type === "human" ? "text: hi" : "prompt: hi"}\n    ${key}\n    next: exit\n`;
      expect(() => parseWorkflow(src)).toThrow(/is only supported on `judge` steps/);
    }
  });

  test("ParseError carries the offending block's line", () => {
    try {
      parseWorkflow(judge(`    state: hi\n    questions:\n      q:\n        type: rank\n        instructions: x\n`));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).line).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("parseWorkflow — decide.outcome over several nouls", () => {
  const src = (decide: string) => `
name: wf
steps:
  j:
    type: judge
    state: x
    questions:
      a: {type: noul, instructions: a?}
      b: {type: noul, instructions: b?}
    decide:
${decide}
    next: exit
`;
  test("a mapping of ids lowers to rules, a number is a min, a mapping may carry max", () => {
    const g = parseWorkflow(src("      outcome: {a: 0.6, b: {min: 0.5, max: 0.9}, c: {max: 0.3}}"));
    expect(g.nodes["j"]!.attrs.judge_decide).toEqual({
      outcome: {
        rules: [
          { question: "a", min: 0.6 },
          { question: "b", min: 0.5, max: 0.9 },
          { question: "c", max: 0.3 },
        ],
      },
    });
  });
  test("one id lowers to a one-rule list", () => {
    const g = parseWorkflow(src("      outcome: {a: 0.6}"));
    expect(g.nodes["j"]!.attrs.judge_decide).toEqual({ outcome: { rules: [{ question: "a", min: 0.6 }] } });
  });
  test.each<[string, string, RegExp]>([
    ["no bound", "      outcome: {a: {}}", /at least one of min \/ max/],
    ["unknown key", "      outcome: {a: {min: 0.5, below: 1}}", /not a recognised key/],
    ["empty mapping", "      outcome: {}", /mapping of noul id/],
    ["min above max", "      outcome: {a: {min: 0.8, max: 0.2}}", /min 0.8 above max 0.2/],
    ["out of range", "      outcome: {a: 1.5}", /in \[0, 1\]/],
  ])("%s is rejected", (_n, decide, re) => {
    expect(() => parseWorkflow(src(decide))).toThrow(re);
  });
});
