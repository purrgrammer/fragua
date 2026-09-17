import { describe, expect, test } from "bun:test";
import { validate } from "../../src/engine/validator.ts";
import { parseWorkflow } from "../../src/parser/yaml.ts";

function codes(yaml: string, prefix?: string): string[] {
  return validate(parseWorkflow(yaml))
    .map((d) => d.code)
    .filter((c) => prefix === undefined || c.startsWith(prefix));
}

function messages(yaml: string, code: string): string[] {
  return validate(parseWorkflow(yaml))
    .filter((d) => d.code === code)
    .map((d) => d.message);
}

const SIZE_Q = `
      size:
        type: choice
        instructions: Size it.
        criteria:
          skip: trivial
          quick: small
          full: large
`;

const ROUTED = (decide: string, routes: string) => `
name: wf
steps:
  classify:
    type: judge
    state: \${{ inputs.diff }}
    questions:${SIZE_Q}
    ${decide}
    routes:
${routes}
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

const OK_ROUTES = "      skip: exit\n      quick: quick_review\n      full: full_review\n      unsure: ask";

describe("judge — decide.route consistency (E047)", () => {
  test("well-formed routed judge validates clean", () => {
    const src = ROUTED("decide:\n      route: {question: size, min-confidence: 0.6, below: unsure}", OK_ROUTES);
    expect(codes(src, "E")).toEqual([]);
    expect(codes(src, "W02")).toEqual([]);
  });

  test("below: may coincide with a criteria key", () => {
    const src = ROUTED(
      "decide:\n      route: {question: size, min-confidence: 0.6, below: full}",
      "      skip: exit\n      quick: quick_review\n      full: full_review",
    );
    expect(codes(src, "E")).toEqual([]);
  });

  test("question not declared", () => {
    const src = ROUTED("decide:\n      route: {question: nope}", OK_ROUTES);
    expect(messages(src, "E047").join("\n")).toMatch(/names question "nope", which is not declared/);
  });

  test("question is not a choice", () => {
    const src = ROUTED(
      "decide:\n      route: {question: ok}",
      "      skip: exit\n      quick: quick_review\n      full: full_review",
    ).replace("    questions:", "    questions:\n      ok:\n        type: noul\n        instructions: ok?");
    expect(messages(src, "E047").join("\n")).toMatch(/is a `noul` — only a `choice` can drive routing/);
  });

  test("option with no route, and route with no option", () => {
    const src = ROUTED(
      "decide:\n      route: {question: size}",
      "      skip: exit\n      quick: quick_review\n      extra: ask",
    );
    const m = messages(src, "E047").join("\n");
    expect(m).toMatch(/option "full" has no matching entry in `routes:`/);
    expect(m).toMatch(/route "extra" is neither an option/);
  });

  test("below not declared in routes", () => {
    const src = ROUTED(
      "decide:\n      route: {question: size, min-confidence: 0.5, below: ghost}",
      "      skip: exit\n      quick: quick_review\n      full: full_review",
    );
    expect(messages(src, "E047").join("\n")).toMatch(/`decide.route.below` "ghost" is not declared/);
  });

  test("routes: without decide.route", () => {
    const src = ROUTED("", "      skip: exit\n      quick: quick_review\n      full: full_review");
    expect(messages(src, "E047").join("\n")).toMatch(/declares `routes:` but no `decide.route`/);
  });

  test("decide.route without routes:", () => {
    const src = `
name: wf
steps:
  classify:
    type: judge
    state: x
    questions:${SIZE_Q}
    decide:
      route: {question: size}
    next: exit
`;
    expect(messages(src, "E047").join("\n")).toMatch(/has `decide.route` but no `routes:`/);
  });

  test("W020: ≥ 3-way routed choice without min-confidence", () => {
    const src = ROUTED(
      "decide:\n      route: {question: size}",
      "      skip: exit\n      quick: quick_review\n      full: full_review",
    );
    expect(codes(src, "E")).toEqual([]);
    expect(codes(src, "W020")).toEqual(["W020"]);
  });

  test("W020 silent on a 2-way choice", () => {
    const src = `
name: wf
steps:
  j:
    type: judge
    state: x
    questions:
      go:
        type: choice
        instructions: Go?
        criteria: {yes: y, no: n}
    decide:
      route: {question: go}
    routes:
      yes: exit
      no: exit
`;
    expect(codes(src, "W020")).toEqual([]);
  });
});

describe("judge — decide.outcome consistency (E048)", () => {
  const OUTCOME = (decide: string, extra = "") => `
name: wf
steps:
  produce:
    prompt: p
    next: verify
  verify:
    type: judge
    state: {review: {file: review.md}}
    questions:
      ok:
        type: noul
        instructions: ok?
      depth:
        type: score
        instructions: deep?
        criteria: [a, b]
    ${decide}
    retry: produce
    max-retries: 1
${extra}
`;

  test("well-formed outcome judge validates clean", () => {
    expect(codes(OUTCOME("decide:\n      outcome: {question: ok, min: 0.7}", "    next: exit"), "E")).toEqual([]);
  });

  test("question not declared / not a noul", () => {
    expect(
      messages(OUTCOME("decide:\n      outcome: {question: nope, min: 0.7}", "    next: exit"), "E048").join("\n"),
    ).toMatch(/names question "nope"/);
    expect(
      messages(OUTCOME("decide:\n      outcome: {question: depth, min: 0.7}", "    next: exit"), "E048").join("\n"),
    ).toMatch(/is a `score` — only a `noul`/);
  });

  test("outcome judge with routes: is rejected", () => {
    const src = OUTCOME(
      "decide:\n      outcome: {question: ok, min: 0.7}",
      "    routes:\n      a: exit\n      b: exit",
    );
    expect(messages(src, "E048").join("\n")).toMatch(/has `decide.outcome` and `routes:`/);
  });
});

describe("judge — graph checks that already exist admit the new kind", () => {
  test("a judge with no successor trips the no-success-path error like llm/tool do", () => {
    const src = `
name: wf
steps:
  j:
    type: judge
    state: x
    questions:
      ok: {type: noul, instructions: ok?}
`;
    expect(codes(src, "E032")).toEqual(["E032"]);
  });

  test("E041 admits a judge as a parallel branch node", () => {
    const src = `
name: wf
steps:
  fan:
    type: parallel
    branches: [a, b]
    next: join
  a:
    type: judge
    state: x
    questions:
      ok: {type: noul, instructions: ok?}
    next: join
  b:
    type: judge
    state: y
    questions:
      ok: {type: noul, instructions: ok?}
    next: join
  join:
    prompt: "\${{ outputs.a.ok.noul }} \${{ outputs.b.ok.noul }}"
    next: exit
`;
    expect(codes(src, "E04")).toEqual([]);
  });

  test("E035 sees derived outputs: a good ref passes, a bad one fails", () => {
    const base = (ref: string) => `
name: wf
steps:
  j:
    type: judge
    state: x
    questions:${SIZE_Q}
    next: use
  use:
    prompt: ${ref}
    next: exit
`;
    const tok = (path: string) => `$${"{{"} outputs.j.size.${path} }}`;
    expect(codes(base(tok("probabilities.quick")), "E035")).toEqual([]);
    expect(codes(base(tok("nope")), "E035")).toEqual(["E035"]);
  });

  test("W021 warns on oversized literal state", () => {
    const big = "x".repeat(17 * 1024);
    const src = `
name: wf
steps:
  j:
    type: judge
    state:
      a: ${big}
      b: \${{ inputs.z }}
    questions:
      ok: {type: noul, instructions: ok?}
    next: exit
`;
    expect(codes(src, "W021")).toEqual(["W021"]);
  });
});

describe("judge — decide.outcome with a question list (E048 per entry)", () => {
  test("a non-noul or undeclared entry in the list is flagged, valid entries are not", () => {
    const src = `
name: wf
steps:
  j:
    type: judge
    state: x
    questions:
      a: {type: noul, instructions: a?}
      s: {type: score, instructions: s?, criteria: [lo, hi]}
    decide:
      outcome: {questions: [a, s, ghost], min: 0.6}
    next: exit
`;
    const m = messages(src, "E048").join("\n");
    expect(m).toMatch(/question "s" is a `score`/);
    expect(m).toMatch(/names question "ghost"/);
    expect(m).not.toMatch(/question "a"/);
  });
});

describe("judge — review follow-ups", () => {
  test("E047 on an undeclared route question does not cascade into one error per route", () => {
    const src = ROUTED("decide:\n      route: {question: nope}", OK_ROUTES);
    const m = messages(src, "E047");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/names question "nope"/);
  });

  test("W021 counts the literal spans of a mixed literal + token string", () => {
    const big = "x".repeat(17 * 1024);
    const src = `
name: wf
steps:
  j:
    type: judge
    state:
      a: "${big} \${{ inputs.z }}"
    questions:
      ok: {type: noul, instructions: ok?}
    next: exit
`;
    expect(codes(src, "W021")).toEqual(["W021"]);
  });
});
