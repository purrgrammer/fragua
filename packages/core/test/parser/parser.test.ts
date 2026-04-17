import { describe, expect, test } from "bun:test";
import { ParseError, parseDotSource } from "../../src/parser/parser.ts";

describe("parseDotSource", () => {
  test("empty digraph", () => {
    const g = parseDotSource("digraph G {}");
    expect(g.id).toBe("G");
    expect(g.directed).toBe(true);
    expect(Object.keys(g.nodes)).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });

  test("unnamed digraph defaults to 'main'", () => {
    const g = parseDotSource("digraph {}");
    expect(g.id).toBe("main");
  });

  test("node statement creates a node with default box shape", () => {
    const g = parseDotSource("digraph { hello }");
    expect(g.nodes["hello"]).toBeDefined();
    expect(g.nodes["hello"]!.shape).toBe("box");
  });

  test("node with shape attribute", () => {
    const g = parseDotSource(`digraph { hello [shape=Mdiamond, label="Hi"] }`);
    expect(g.nodes["hello"]!.shape).toBe("Mdiamond");
    expect(g.nodes["hello"]!.attrs.label).toBe("Hi");
  });

  test("edge creates both endpoints", () => {
    const g = parseDotSource("digraph { a -> b }");
    expect(g.nodes["a"]).toBeDefined();
    expect(g.nodes["b"]).toBeDefined();
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.from).toBe("a");
    expect(g.edges[0]!.to).toBe("b");
  });

  test("chained edge expands to multiple edges", () => {
    const g = parseDotSource(`digraph { a -> b -> c [label="next"] }`);
    expect(g.edges).toHaveLength(2);
    expect(g.edges[0]!.from).toBe("a");
    expect(g.edges[0]!.to).toBe("b");
    expect(g.edges[1]!.from).toBe("b");
    expect(g.edges[1]!.to).toBe("c");
    expect(g.edges[0]!.attrs.label).toBe("next");
    expect(g.edges[1]!.attrs.label).toBe("next");
  });

  test("node defaults apply to subsequent nodes", () => {
    const g = parseDotSource(`
      digraph {
        node [shape=diamond]
        a
        b [shape=box]
        c
      }
    `);
    expect(g.nodes["a"]!.shape).toBe("diamond");
    expect(g.nodes["b"]!.shape).toBe("box");
    expect(g.nodes["c"]!.shape).toBe("diamond");
  });

  test("graph-level attributes stored on attrs", () => {
    const g = parseDotSource(`digraph { goal = "ship it"; label = "build"; }`);
    expect(g.attrs.goal).toBe("ship it");
    expect(g.attrs.label).toBe("build");
  });

  test("graph attr block", () => {
    const g = parseDotSource(`digraph { graph [default_fidelity="compact"] }`);
    expect(g.attrs.default_fidelity).toBe("compact");
  });

  test("boolean coercion: goal_gate=true", () => {
    const g = parseDotSource(`digraph { done [shape=Msquare, goal_gate=true] }`);
    expect(g.nodes["done"]!.attrs.goal_gate).toBe(true);
  });

  test("weight coerced to number", () => {
    const g = parseDotSource(`digraph { a -> b [weight=3] }`);
    expect(g.edges[0]!.attrs.weight).toBe(3);
  });

  test("allowed_tools parsed as string array", () => {
    const g = parseDotSource(`digraph { n [allowed_tools="read_file, write_file, bash"] }`);
    expect(g.nodes["n"]!.attrs.allowed_tools).toEqual(["read_file", "write_file", "bash"]);
  });

  test("context_files parsed as string array", () => {
    const g = parseDotSource(`digraph { n [context_files="AGENTS.md, docs/SPEC.md"] }`);
    expect(g.nodes["n"]!.attrs.context_files).toEqual(["AGENTS.md", "docs/SPEC.md"]);
  });

  test("subgraph contributes derived class to nodes", () => {
    const g = parseDotSource(`
      digraph {
        subgraph cluster_loop_a {
          label = "Loop A"
          a
          b
        }
        c
      }
    `);
    expect(g.nodes["a"]!.classes).toContain("loop-a");
    expect(g.nodes["b"]!.classes).toContain("loop-a");
    expect(g.nodes["c"]!.classes).not.toContain("loop-a");
    expect(g.subgraphs).toHaveLength(1);
    expect(g.subgraphs[0]!.derived_class).toBe("loop-a");
  });

  test("subgraph without label uses cluster_ prefix stripped", () => {
    const g = parseDotSource(`
      digraph {
        subgraph cluster_inner {
          x
        }
      }
    `);
    expect(g.nodes["x"]!.classes).toContain("inner");
  });

  test("node can be merged across multiple mentions", () => {
    const g = parseDotSource(`
      digraph {
        n [label="first"]
        n [shape=diamond]
      }
    `);
    expect(g.nodes["n"]!.attrs.label).toBe("first");
    expect(g.nodes["n"]!.shape).toBe("diamond");
  });

  test("explicit class attribute parsed", () => {
    const g = parseDotSource(`digraph { n [class="critical,review"] }`);
    expect(g.nodes["n"]!.classes).toEqual(["critical", "review"]);
  });

  test("string escapes and unicode pass through", () => {
    const g = parseDotSource(`digraph { n [prompt="line1\\nline2 α β γ"] }`);
    expect(g.nodes["n"]!.attrs.prompt).toBe("line1\nline2 α β γ");
  });

  test("chained edge with chained attribute blocks", () => {
    const g = parseDotSource(`digraph { a -> b [label="x"] [weight=5] }`);
    expect(g.edges[0]!.attrs.label).toBe("x");
    expect(g.edges[0]!.attrs.weight).toBe(5);
  });

  test("comments ignored", () => {
    const g = parseDotSource(`
      // line comment
      digraph G {
        /* block
           comment */
        a -> b
      }
    `);
    expect(g.edges).toHaveLength(1);
  });

  test("strict keyword is rejected", () => {
    expect(() => parseDotSource("strict digraph {}")).toThrow(ParseError);
  });

  test("semicolons are optional separators", () => {
    const g = parseDotSource(`digraph { a; b; a -> b; }`);
    expect(Object.keys(g.nodes).sort()).toEqual(["a", "b"]);
    expect(g.edges).toHaveLength(1);
  });

  test("node ids can be quoted strings", () => {
    const g = parseDotSource(`digraph { "hello world" -> b }`);
    expect(g.nodes["hello world"]).toBeDefined();
    expect(g.edges[0]!.from).toBe("hello world");
  });

  test("condition attribute passes through verbatim", () => {
    const g = parseDotSource(`digraph { a -> b [condition="outcome=success && context.tests=true"] }`);
    expect(g.edges[0]!.attrs.condition).toBe("outcome=success && context.tests=true");
  });

  test("fidelity attribute preserved", () => {
    const g = parseDotSource(`digraph { a -> b [fidelity="summary:medium"] }`);
    expect(g.edges[0]!.attrs.fidelity).toBe("summary:medium");
  });

  test("malformed parse throws ParseError with position", () => {
    try {
      parseDotSource("digraph { a -> }");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).line).toBeGreaterThan(0);
    }
  });
});
