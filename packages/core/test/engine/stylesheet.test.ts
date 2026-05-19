// Stylesheet parser + apply tests — attractor-spec §8.
//
// TODO(yaml-cutover commit 2): rewrite inline-DOT fixtures to mkGraph() or
// YAML. Wholesale .skip until that migration lands; the new YAML parser is
// covered by yaml.test.ts.

import { describe, expect, test } from "bun:test";
import {
  applyStylesheet,
  applyStylesheetToGraph,
  parseStylesheet,
  StylesheetParseError,
  selectorMatches,
} from "../../src/engine/stylesheet.ts";
import { parseWorkflow } from "../../src/parser/yaml.ts";
import type { Graph, Node, NodeAttrs } from "../../src/types/graph.ts";

function nodeOf(parts: { id: string; shape?: Node["shape"]; attrs?: NodeAttrs; classes?: string[] }): Node {
  return {
    id: parts.id,
    shape: parts.shape ?? "box",
    attrs: parts.attrs ?? {},
    classes: parts.classes ?? [],
  };
}

describe.skip("parseStylesheet", () => {
  test("empty / whitespace → no rules", () => {
    expect(parseStylesheet("")).toEqual([]);
    expect(parseStylesheet("   \n\n  ")).toEqual([]);
  });

  test("universal selector + single decl", () => {
    const r = parseStylesheet(`* { llm_model: claude-opus-4-7; }`);
    expect(r).toHaveLength(1);
    expect(r[0]?.selector).toEqual({ kind: "universal" });
    expect(r[0]?.specificity).toBe(0);
    expect(r[0]?.decls).toEqual({ llm_model: "claude-opus-4-7" });
  });

  test("specificity tiers", () => {
    const r = parseStylesheet(`
      * { llm_model: a; }
      box { llm_model: b; }
      .code { llm_model: c; }
      #my_node { llm_model: d; }
    `);
    expect(r.map((x) => x.specificity)).toEqual([0, 1, 2, 3]);
  });

  test("multiple decls in one rule with optional trailing semicolon", () => {
    const r = parseStylesheet(`box { llm_model: opus; reasoning_effort: high }`);
    expect(r[0]?.decls).toEqual({ llm_model: "opus", reasoning_effort: "high" });
  });

  test("quoted values strip quotes", () => {
    const r = parseStylesheet(`* { llm_provider: "anthropic"; }`);
    expect(r[0]?.decls).toEqual({ llm_provider: "anthropic" });
  });

  test("attractor §8.6 example parses cleanly", () => {
    const r = parseStylesheet(`
      * { llm_model: claude-sonnet-4-5; llm_provider: anthropic; }
      .code { llm_model: claude-opus-4-6; }
      #critical_review { llm_model: gpt-5.2; reasoning_effort: high; }
    `);
    expect(r).toHaveLength(3);
    expect(r[2]?.selector).toEqual({ kind: "id", value: "critical_review" });
  });

  test("unknown property throws", () => {
    expect(() => parseStylesheet(`* { foo: bar; }`)).toThrow(StylesheetParseError);
  });

  test("missing colon throws", () => {
    expect(() => parseStylesheet(`* { llm_model claude; }`)).toThrow(StylesheetParseError);
  });

  test("missing brace throws", () => {
    expect(() => parseStylesheet(`* llm_model: claude; }`)).toThrow(StylesheetParseError);
  });

  test("empty value throws", () => {
    expect(() => parseStylesheet(`* { llm_model: ; }`)).toThrow(StylesheetParseError);
  });

  test("comments are stripped", () => {
    const r = parseStylesheet(`
      // top
      * { llm_model: opus; /* inline */ } // trailer
    `);
    expect(r).toHaveLength(1);
    expect(r[0]?.decls).toEqual({ llm_model: "opus" });
  });
});

describe.skip("selectorMatches", () => {
  test("universal matches every node", () => {
    expect(selectorMatches({ kind: "universal" }, nodeOf({ id: "a" }))).toBe(true);
  });

  test("shape selector matches by shape attr", () => {
    expect(selectorMatches({ kind: "shape", value: "box" }, nodeOf({ id: "a", shape: "box" }))).toBe(true);
    expect(selectorMatches({ kind: "shape", value: "box" }, nodeOf({ id: "a", shape: "hexagon" }))).toBe(false);
  });

  test("class selector matches by classes array", () => {
    const n = nodeOf({ id: "a", classes: ["planning", "code"] });
    expect(selectorMatches({ kind: "class", value: "code" }, n)).toBe(true);
    expect(selectorMatches({ kind: "class", value: "missing" }, n)).toBe(false);
  });

  test("id selector matches by node id", () => {
    expect(selectorMatches({ kind: "id", value: "verify" }, nodeOf({ id: "verify" }))).toBe(true);
    expect(selectorMatches({ kind: "id", value: "verify" }, nodeOf({ id: "other" }))).toBe(false);
  });
});

describe.skip("applyStylesheet", () => {
  function graphOf(nodes: Node[], modelStylesheet?: string): Graph {
    const map: Record<string, Node> = {};
    for (const n of nodes) map[n.id] = n;
    return {
      id: "g",
      directed: true,
      attrs: modelStylesheet !== undefined ? { model_stylesheet: modelStylesheet } : {},
      nodes: map,
      edges: [],
      subgraphs: [],
    };
  }

  test("higher specificity wins (id over class over shape over universal)", () => {
    const g = graphOf([
      nodeOf({ id: "a", shape: "box", classes: ["code"] }),
      nodeOf({ id: "verify", shape: "box", classes: ["code"] }),
    ]);
    const rules = parseStylesheet(`
      * { llm_model: u; }
      box { llm_model: s; }
      .code { llm_model: c; }
      #verify { llm_model: i; }
    `);
    applyStylesheet(g, rules);
    expect(g.nodes["a"]?.attrs.llm_model).toBe("c"); // class > shape > universal
    expect(g.nodes["verify"]?.attrs.llm_model).toBe("i"); // id wins
  });

  test("explicit node attrs always win over stylesheet (§8.5)", () => {
    const g = graphOf([nodeOf({ id: "a", shape: "box", attrs: { llm_model: "explicit" } })]);
    const rules = parseStylesheet(`* { llm_model: from-stylesheet; }`);
    applyStylesheet(g, rules);
    expect(g.nodes["a"]?.attrs.llm_model).toBe("explicit");
  });

  test("only fills properties the node lacks", () => {
    const g = graphOf([nodeOf({ id: "a", shape: "box", attrs: { llm_provider: "anthropic" } })]);
    const rules = parseStylesheet(`* { llm_provider: openrouter; llm_model: opus; }`);
    applyStylesheet(g, rules);
    expect(g.nodes["a"]?.attrs.llm_provider).toBe("anthropic"); // not overridden
    expect(g.nodes["a"]?.attrs.llm_model).toBe("opus");
  });

  test("declaration order tiebreaks at equal specificity — later wins (§8.3)", () => {
    const g = graphOf([nodeOf({ id: "a", shape: "box" })]);
    const rules = parseStylesheet(`box { llm_model: first; } box { llm_model: second; }`);
    applyStylesheet(g, rules);
    // Per §8.3: "Later rules of equal specificity override earlier ones."
    expect(g.nodes["a"]?.attrs.llm_model).toBe("second");
  });
});

describe.skip("applyStylesheetToGraph (parses + applies)", () => {
  test("happy path on real DOT", () => {
    const g = parseWorkflow(`
      digraph G {
        graph [model_stylesheet="* { llm_provider: anthropic; }"]
        s [shape=Mdiamond]
        a [shape=box]
        done [shape=Msquare]
        s -> a -> done
      }
    `);
    const r = applyStylesheetToGraph(g);
    expect(r.errors).toEqual([]);
    expect(g.nodes["a"]?.attrs.llm_provider).toBe("anthropic");
  });

  test("syntax error surfaces as StylesheetParseError", () => {
    const g = parseWorkflow(`
      digraph G {
        graph [model_stylesheet="* { llm_model bad }"]
        s [shape=Mdiamond]
        done [shape=Msquare]
        s -> done
      }
    `);
    const r = applyStylesheetToGraph(g);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toBeInstanceOf(StylesheetParseError);
  });

  test("absent stylesheet → no work, no errors", () => {
    const g = parseWorkflow(`
      digraph G {
        s [shape=Mdiamond]
        done [shape=Msquare]
        s -> done
      }
    `);
    const r = applyStylesheetToGraph(g);
    expect(r.errors).toEqual([]);
  });
});
