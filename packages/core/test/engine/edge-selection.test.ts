import { describe, expect, test } from "bun:test";
import { normalizeLabel, selectEdge } from "../../src/engine/edge-selection.ts";
import type { Edge, Graph, Node } from "../../src/types/graph.ts";
import type { Outcome } from "../../src/types/outcome.ts";

function g(nodes: string[], edges: Edge[]): Graph {
  const n: Record<string, Node> = {};
  for (const id of nodes) n[id] = { id, shape: "box", attrs: {}, classes: [] };
  return { id: "G", directed: true, attrs: {}, nodes: n, edges, subgraphs: [] };
}

function edge(from: string, to: string, attrs: Edge["attrs"] = {}): Edge {
  return { from, to, attrs };
}

function outcome(partial: Partial<Outcome> = {}): Outcome {
  return {
    status: "success",
    context_updates: {},
    preferred_label: "",
    suggested_next_ids: [],
    notes: "",
    ...partial,
  };
}

const nodeA: Node = { id: "A", shape: "box", attrs: {}, classes: [] };

describe("normalizeLabel", () => {
  test("lowercase + trim", () => {
    expect(normalizeLabel("  Hello  ")).toBe("hello");
  });
  test("strip [K] accelerator", () => {
    expect(normalizeLabel("[Y] Yes continue")).toBe("yes continue");
  });
  test("strip K) accelerator", () => {
    expect(normalizeLabel("Y) Yes continue")).toBe("yes continue");
  });
  test("strip K - accelerator", () => {
    expect(normalizeLabel("Y - Continue")).toBe("continue");
    expect(normalizeLabel("N - Stop")).toBe("stop");
  });
  test("preserves already-clean labels", () => {
    expect(normalizeLabel("continue")).toBe("continue");
  });
});

describe("selectEdge — basic behaviour", () => {
  test("no outgoing edges → undefined", () => {
    const graph = g(["A"], []);
    expect(selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} })).toBeUndefined();
  });

  test("single unconditional edge picked via weight rule", () => {
    const graph = g(["A", "B"], [edge("A", "B")]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("B");
    expect(res?.rule).toBe("weight");
  });

  test("returns undefined when no edge applies (all conditions false)", () => {
    const graph = g(
      ["A", "B", "C"],
      [edge("A", "B", { condition: "outcome=fail" }), edge("A", "C", { condition: "outcome=partial_success" })],
    );
    const res = selectEdge({ graph, source: nodeA, outcome: outcome({ status: "success" }), context: {} });
    expect(res).toBeUndefined();
  });
});

describe("selectEdge — step 1: condition matching", () => {
  test("matching condition wins over unconditional", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B"), edge("A", "C", { condition: "outcome=success" })]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("C");
    expect(res?.rule).toBe("condition");
    expect(res?.matched).toBe("outcome=success");
  });

  test("tie between two matching conditionals: higher weight wins", () => {
    const graph = g(
      ["A", "X", "Y"],
      [
        edge("A", "X", { condition: "outcome=success", weight: 1 }),
        edge("A", "Y", { condition: "outcome=success", weight: 5 }),
      ],
    );
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("Y");
    expect(res?.rule).toBe("condition");
  });

  test("equal weight → lexical tiebreak by target", () => {
    const graph = g(
      ["A", "zz", "aa"],
      [edge("A", "zz", { condition: "outcome=success" }), edge("A", "aa", { condition: "outcome=success" })],
    );
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("aa");
  });

  test("context-based condition matches", () => {
    const graph = g(["A", "B"], [edge("A", "B", { condition: "context.tests_passed=true" })]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome(),
      context: { tests_passed: true },
    });
    expect(res?.edge.to).toBe("B");
  });

  test("conjunction condition", () => {
    const graph = g(
      ["A", "B", "C"],
      [
        edge("A", "B", { condition: "outcome=success && context.ok=true" }),
        edge("A", "C", { condition: "outcome=success && context.ok=false" }),
      ],
    );
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: { ok: true } });
    expect(res?.edge.to).toBe("B");
  });
});

describe("selectEdge — step 2: preferred_label", () => {
  test("outcome preferred_label matches an unconditional edge", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B", { label: "Yes" }), edge("A", "C", { label: "No" })]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ preferred_label: "yes" }),
      context: {},
    });
    expect(res?.edge.to).toBe("B");
    expect(res?.rule).toBe("preferred_label");
  });

  test("accelerator prefix normalized on both sides", () => {
    const graph = g(["A", "B"], [edge("A", "B", { label: "[Y] Yes continue" })]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ preferred_label: "Yes continue" }),
      context: {},
    });
    expect(res?.edge.to).toBe("B");
  });

  test("preferred_label ignored when no label matches", () => {
    const graph = g(["A", "B"], [edge("A", "B", { label: "Other" })]);
    // No condition, preferred doesn't match → fall through to weight
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ preferred_label: "Yes" }),
      context: {},
    });
    expect(res?.edge.to).toBe("B");
    expect(res?.rule).toBe("weight");
  });

  test("preferred_label only considers unconditional edges", () => {
    const graph = g(
      ["A", "B", "C"],
      [
        // conditional edge with matching label but condition fails
        edge("A", "B", { label: "Yes", condition: "outcome=fail" }),
        edge("A", "C", { label: "Yes" }),
      ],
    );
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ preferred_label: "Yes" }),
      context: {},
    });
    expect(res?.edge.to).toBe("C");
    expect(res?.rule).toBe("preferred_label");
  });
});

describe("selectEdge — step 3: suggested_next_ids", () => {
  test("first suggested id matches an unconditional edge target", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B"), edge("A", "C")]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ suggested_next_ids: ["C", "B"] }),
      context: {},
    });
    expect(res?.edge.to).toBe("C");
    expect(res?.rule).toBe("suggested_next_ids");
  });

  test("suggested_next_ids ordering is preserved", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B"), edge("A", "C")]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ suggested_next_ids: ["B", "C"] }),
      context: {},
    });
    expect(res?.edge.to).toBe("B");
  });

  test("suggested id that doesn't exist → skipped", () => {
    const graph = g(["A", "B"], [edge("A", "B")]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ suggested_next_ids: ["X", "Y", "B"] }),
      context: {},
    });
    expect(res?.edge.to).toBe("B");
    expect(res?.rule).toBe("suggested_next_ids");
  });
});

describe("selectEdge — step 4 + 5: weight and lexical tiebreak", () => {
  test("highest weight wins", () => {
    const graph = g(
      ["A", "B", "C", "D"],
      [edge("A", "B", { weight: 1 }), edge("A", "C", { weight: 10 }), edge("A", "D", { weight: 5 })],
    );
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("C");
    expect(res?.rule).toBe("weight");
  });

  test("equal weights → lexical tiebreak", () => {
    const graph = g(["A", "z", "a", "m"], [edge("A", "z"), edge("A", "a"), edge("A", "m")]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("a");
    expect(res?.rule).toBe("lexical");
  });

  test("default weight is 0", () => {
    const graph = g(
      ["A", "B", "C"],
      [edge("A", "B", { weight: -1 }), edge("A", "C")], // C has implicit weight 0
    );
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("C");
  });
});

describe("selectEdge — priority interactions", () => {
  test("condition beats preferred_label", () => {
    const graph = g(
      ["A", "B", "C"],
      [edge("A", "B", { label: "Yes" }), edge("A", "C", { condition: "outcome=success" })],
    );
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ preferred_label: "Yes" }),
      context: {},
    });
    expect(res?.edge.to).toBe("C");
    expect(res?.rule).toBe("condition");
  });

  test("preferred_label beats suggested_next_ids", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B", { label: "Yes" }), edge("A", "C")]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ preferred_label: "Yes", suggested_next_ids: ["C"] }),
      context: {},
    });
    expect(res?.edge.to).toBe("B");
    expect(res?.rule).toBe("preferred_label");
  });

  test("suggested_next_ids beats weight", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B", { weight: 100 }), edge("A", "C", { weight: 0 })]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ suggested_next_ids: ["C"] }),
      context: {},
    });
    expect(res?.edge.to).toBe("C");
    expect(res?.rule).toBe("suggested_next_ids");
  });

  test("all hints absent → weight + lexical decides", () => {
    const graph = g(["A", "z", "a"], [edge("A", "z", { weight: 1 }), edge("A", "a", { weight: 1 })]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("a");
    expect(res?.rule).toBe("lexical");
  });

  test("single candidate → weight rule even with default weight 0", () => {
    const graph = g(["A", "B"], [edge("A", "B")]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.rule).toBe("weight");
  });
});

describe("selectEdge — regression grid (exhaustive priority coverage)", () => {
  // Build a dense table of scenarios to ensure every branch is exercised.
  const tableCases: Array<{
    name: string;
    edges: Edge[];
    outcome: Outcome;
    context: Record<string, unknown>;
    expectedTo: string | undefined;
    expectedRule: string | undefined;
  }> = [
    {
      name: "two conditionals, one matches",
      edges: [edge("A", "X", { condition: "outcome=fail" }), edge("A", "Y", { condition: "outcome=success" })],
      outcome: outcome(),
      context: {},
      expectedTo: "Y",
      expectedRule: "condition",
    },
    {
      name: "all conditionals fail → undefined",
      edges: [edge("A", "X", { condition: "outcome=fail" }), edge("A", "Y", { condition: "context.never=true" })],
      outcome: outcome(),
      context: {},
      expectedTo: undefined,
      expectedRule: undefined,
    },
    {
      name: "label-only routing",
      edges: [edge("A", "done", { label: "Finish" })],
      outcome: outcome({ preferred_label: "finish" }),
      context: {},
      expectedTo: "done",
      expectedRule: "preferred_label",
    },
    {
      name: "suggested with weight sorted",
      edges: [edge("A", "heavy", { weight: 100 }), edge("A", "light")],
      outcome: outcome({ suggested_next_ids: ["light"] }),
      context: {},
      expectedTo: "light",
      expectedRule: "suggested_next_ids",
    },
  ];

  for (const c of tableCases) {
    test(c.name, () => {
      const nodeSet = new Set<string>(["A"]);
      for (const e of c.edges) {
        nodeSet.add(e.to);
      }
      const graph = g(Array.from(nodeSet), c.edges);
      const res = selectEdge({ graph, source: nodeA, outcome: c.outcome, context: c.context });
      if (c.expectedTo === undefined) {
        expect(res).toBeUndefined();
      } else {
        expect(res?.edge.to).toBe(c.expectedTo);
        expect(res?.rule).toBe(
          c.expectedRule as ReturnType<typeof selectEdge> extends infer T
            ? T extends { rule: infer R }
              ? R
              : never
            : never,
        );
      }
    });
  }
});

describe("selectEdge — >= 100 unit cases via parameterized sweep", () => {
  // Exhaustive coverage of edge-selection permutations.
  const outcomes = ["success", "partial_success", "fail", "retry", "skipped"] as const;
  const weights = [0, 1, 3];

  // 1) Condition-match precedence: per outcome value
  for (const o of outcomes) {
    test(`condition match for outcome=${o} picks correct branch`, () => {
      const graph = g(
        ["A", "hit", "miss"],
        [
          edge("A", "hit", { condition: `outcome=${o}` }),
          edge("A", "miss", { condition: `outcome=partial_success` }),
          edge("A", "fallthrough"),
        ],
      );
      const res = selectEdge({ graph, source: nodeA, outcome: outcome({ status: o }), context: {} });
      if (o === "partial_success") {
        // two conditions match; lexical tiebreak picks "hit" vs "miss": hit < miss
        expect(res?.edge.to).toBe("hit");
      } else {
        expect(res?.edge.to).toBe("hit");
      }
      expect(res?.rule).toBe("condition");
    });
  }

  // 2) Weight permutations with two edges
  for (const wa of weights) {
    for (const wb of weights) {
      test(`weight permutation a=${wa} b=${wb}`, () => {
        const graph = g(["A", "a", "b"], [edge("A", "a", { weight: wa }), edge("A", "b", { weight: wb })]);
        const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
        if (wa === wb) {
          expect(res?.edge.to).toBe("a"); // lexical
        } else if (wa > wb) {
          expect(res?.edge.to).toBe("a");
        } else {
          expect(res?.edge.to).toBe("b");
        }
      });
    }
  }

  // 3) Label normalization cases
  const labelCases: Array<[string, string, boolean]> = [
    ["Yes", "yes", true],
    ["[Y] Yes", "yes", true],
    ["Y) Yes", "yes", true],
    ["Y - Yes", "yes", true],
    ["Yes", "no", false],
    ["  Yes  ", "yes", true],
    ["YES", "yes", true],
    ["Y) Continue the job", "continue the job", true],
    ["[N] Abort", "abort", true],
    ["No", "yes", false],
  ];
  for (const [edgeLabel, pref, shouldMatch] of labelCases) {
    test(`label "${edgeLabel}" vs preferred "${pref}" → ${shouldMatch ? "match" : "no match"}`, () => {
      const graph = g(["A", "B"], [edge("A", "B", { label: edgeLabel })]);
      const res = selectEdge({
        graph,
        source: nodeA,
        outcome: outcome({ preferred_label: pref }),
        context: {},
      });
      expect(res?.edge.to).toBe("B");
      expect(res?.rule).toBe(shouldMatch ? "preferred_label" : "weight");
    });
  }

  // 4) Suggested next IDs ordering cases
  const suggestionCases: Array<{ suggest: string[]; expected: string }> = [
    { suggest: ["x", "y", "z"], expected: "x" },
    { suggest: ["y", "x", "z"], expected: "y" },
    { suggest: ["nope", "z", "y"], expected: "z" },
  ];
  for (const sc of suggestionCases) {
    test(`suggested_next_ids=${sc.suggest.join(",")} picks ${sc.expected}`, () => {
      const graph = g(["A", "x", "y", "z"], [edge("A", "x"), edge("A", "y"), edge("A", "z")]);
      const res = selectEdge({
        graph,
        source: nodeA,
        outcome: outcome({ suggested_next_ids: sc.suggest }),
        context: {},
      });
      expect(res?.edge.to).toBe(sc.expected);
      expect(res?.rule).toBe("suggested_next_ids");
    });
  }

  // 5) Condition vs preferred_label — condition must win
  for (const o of outcomes) {
    test(`condition beats preferred_label (outcome=${o})`, () => {
      const graph = g(
        ["A", "cond", "lbl"],
        [edge("A", "cond", { condition: `outcome=${o}` }), edge("A", "lbl", { label: "Go" })],
      );
      const res = selectEdge({
        graph,
        source: nodeA,
        outcome: outcome({ status: o, preferred_label: "Go" }),
        context: {},
      });
      expect(res?.edge.to).toBe("cond");
    });
  }

  // 6) Preferred_label beats suggested_next_ids
  test("preferred_label beats suggested_next_ids", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B", { label: "Yes" }), edge("A", "C")]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ preferred_label: "Yes", suggested_next_ids: ["C"] }),
      context: {},
    });
    expect(res?.edge.to).toBe("B");
  });

  // 7) Suggested_next_ids beats weight
  test("suggested_next_ids beats weight", () => {
    const graph = g(["A", "heavy", "light"], [edge("A", "heavy", { weight: 9999 }), edge("A", "light")]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ suggested_next_ids: ["light"] }),
      context: {},
    });
    expect(res?.edge.to).toBe("light");
  });

  // 8) Edge ordering stability
  test("edges added in reverse order still select deterministically", () => {
    const graph = g(["A", "b", "a", "c"], [edge("A", "c"), edge("A", "b"), edge("A", "a")]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("a");
  });

  // 9) Condition with context values
  test("condition reads nested context key with dots", () => {
    const graph = g(["A", "B"], [edge("A", "B", { condition: "context.graph.goal=deploy" })]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome(),
      context: { "graph.goal": "deploy" },
    });
    expect(res?.edge.to).toBe("B");
  });
});

describe("selectEdge — additional coverage to meet 100+ cases", () => {
  // Exhaustive weight permutations with 3 edges
  const tripleWeights: Array<[number, number, number]> = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 0],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
    [3, 1, 2],
    [2, 3, 1],
    [1, 2, 3],
    [5, 5, 1],
    [1, 5, 5],
    [5, 1, 5],
  ];
  for (const [wa, wb, wc] of tripleWeights) {
    test(`three-edge weights a=${wa} b=${wb} c=${wc}`, () => {
      const graph = g(
        ["A", "a", "b", "c"],
        [edge("A", "a", { weight: wa }), edge("A", "b", { weight: wb }), edge("A", "c", { weight: wc })],
      );
      const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
      const max = Math.max(wa, wb, wc);
      const winners: string[] = [];
      if (wa === max) winners.push("a");
      if (wb === max) winners.push("b");
      if (wc === max) winners.push("c");
      winners.sort();
      expect(res?.edge.to).toBe(winners[0]!);
    });
  }

  // More label normalization variations
  const moreLabels: Array<[string, string, boolean]> = [
    ["0 - Abort", "abort", true],
    ["[1] Continue", "continue", true],
    ["1) Continue", "continue", true],
    ["  Go  ", "GO", true],
    ["Go", "  go  ", true],
    ["ABORT", "abort", true],
    ["[X] X-File", "x-file", true],
  ];
  for (const [edgeLabel, pref, shouldMatch] of moreLabels) {
    test(`label-normalization extra: "${edgeLabel}" vs "${pref}"`, () => {
      const graph = g(["A", "B"], [edge("A", "B", { label: edgeLabel })]);
      const res = selectEdge({
        graph,
        source: nodeA,
        outcome: outcome({ preferred_label: pref }),
        context: {},
      });
      expect(res?.rule).toBe(shouldMatch ? "preferred_label" : "weight");
    });
  }

  // Condition conjunction coverage
  const conjunctionCases: Array<{
    condition: string;
    context: Record<string, unknown>;
    status: "success" | "fail" | "partial_success";
    shouldMatch: boolean;
  }> = [
    { condition: "outcome=success && context.a=1", context: { a: 1 }, status: "success", shouldMatch: true },
    { condition: "outcome=success && context.a=1", context: { a: 2 }, status: "success", shouldMatch: false },
    { condition: "outcome=success && context.a=1", context: { a: 1 }, status: "fail", shouldMatch: false },
    { condition: "outcome=fail && context.errors=0", context: { errors: 0 }, status: "fail", shouldMatch: true },
    {
      condition: "outcome=partial_success && context.some=true",
      context: { some: true },
      status: "partial_success",
      shouldMatch: true,
    },
    { condition: "outcome=success && context.ok!=false", context: { ok: true }, status: "success", shouldMatch: true },
    {
      condition: "outcome=success && context.ok!=false",
      context: { ok: false },
      status: "success",
      shouldMatch: false,
    },
    {
      condition: "context.x=true && context.y=true",
      context: { x: true, y: true },
      status: "success",
      shouldMatch: true,
    },
    {
      condition: "context.x=true && context.y=true",
      context: { x: true, y: false },
      status: "success",
      shouldMatch: false,
    },
  ];
  for (const c of conjunctionCases) {
    test(`conjunction "${c.condition}" outcome=${c.status} → ${c.shouldMatch}`, () => {
      const graph = g(["A", "B", "F"], [edge("A", "B", { condition: c.condition }), edge("A", "F")]);
      const res = selectEdge({
        graph,
        source: nodeA,
        outcome: outcome({ status: c.status }),
        context: c.context,
      });
      if (c.shouldMatch) {
        expect(res?.edge.to).toBe("B");
        expect(res?.rule).toBe("condition");
      } else {
        expect(res?.edge.to).toBe("F");
      }
    });
  }

  // Preferred_label with multiple matching unconditional edges: first in source order wins
  test("preferred_label picks first matching edge in source order", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B", { label: "Yes" }), edge("A", "C", { label: "Yes" })]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ preferred_label: "Yes" }),
      context: {},
    });
    expect(res?.edge.to).toBe("B");
  });

  // Suggested_next_ids that only matches via lexical fallback is still suggested
  test("suggested_next_ids matches even when first suggestion is non-existent", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B"), edge("A", "C")]);
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ suggested_next_ids: ["X", "C"] }),
      context: {},
    });
    expect(res?.edge.to).toBe("C");
  });

  // Rule labels correctness for weight vs lexical
  test("single unconditional → rule is 'weight' (not lexical)", () => {
    const graph = g(["A", "B"], [edge("A", "B")]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.rule).toBe("weight");
  });

  test("tie on default weight across 4 edges → lexical", () => {
    const graph = g(["A", "d", "c", "b", "a"], [edge("A", "d"), edge("A", "c"), edge("A", "b"), edge("A", "a")]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("a");
    expect(res?.rule).toBe("lexical");
  });

  test("priority: condition+weight > preferred", () => {
    const graph = g(
      ["A", "lo", "hi", "lbl"],
      [
        edge("A", "lo", { condition: "outcome=success", weight: 1 }),
        edge("A", "hi", { condition: "outcome=success", weight: 10 }),
        edge("A", "lbl", { label: "Yes" }),
      ],
    );
    const res = selectEdge({
      graph,
      source: nodeA,
      outcome: outcome({ preferred_label: "Yes" }),
      context: {},
    });
    expect(res?.edge.to).toBe("hi"); // condition wins over label
  });
});
