import { describe, expect, test } from "bun:test";
import { applyStylesheet, parseStylesheet } from "../../src/engine/stylesheet.ts";
import { parseDotSource } from "../../src/parser/parser.ts";

describe("parseStylesheet — mini-CSS parser", () => {
  test("id selector with single declaration", () => {
    const rules = parseStylesheet("#explore { model: claude-opus-4-7 }");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selector).toEqual({ kind: "id", id: "explore" });
    expect(rules[0]!.decl.model).toBe("claude-opus-4-7");
  });

  test("class selector with multiple declarations", () => {
    const rules = parseStylesheet(".heavy { model: claude-opus-4-7; provider: anthropic; reasoning_effort: high }");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selector).toEqual({ kind: "class", cls: "heavy" });
    expect(rules[0]!.decl).toEqual({
      model: "claude-opus-4-7",
      provider: "anthropic",
      reasoning_effort: "high",
    });
  });

  test("attr selector (shape)", () => {
    const rules = parseStylesheet("[shape=box] { model: claude-haiku-4-5 }");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selector).toEqual({ kind: "attr", key: "shape", value: "box" });
  });

  test("multiple rules", () => {
    const rules = parseStylesheet(`
      [shape=box] { model: haiku }
      .heavy { model: opus }
      #explore { provider: openai }
    `);
    expect(rules).toHaveLength(3);
  });

  test("strips /* C-style comments */", () => {
    const rules = parseStylesheet("/* default */ [shape=box] { model: haiku } /* end */");
    expect(rules).toHaveLength(1);
  });

  test("ignores rules without valid selectors", () => {
    const rules = parseStylesheet("??? { model: haiku }");
    expect(rules).toHaveLength(0);
  });

  test("ignores rules without any recognized declarations", () => {
    const rules = parseStylesheet("[shape=box] { unknown: value }");
    expect(rules).toHaveLength(0);
  });

  test("skips invalid reasoning_effort values", () => {
    const rules = parseStylesheet(".heavy { reasoning_effort: extreme }");
    expect(rules).toHaveLength(0);
  });

  test("empty stylesheet returns no rules", () => {
    expect(parseStylesheet("")).toEqual([]);
    expect(parseStylesheet("  /* nothing here */  ")).toEqual([]);
  });
});

describe("applyStylesheet — fill in missing node attrs", () => {
  test("fills in model via id selector", () => {
    const graph = parseDotSource(`
      digraph {
        model_stylesheet = "#explore { model: claude-opus-4-7 }"
        s [shape=Mdiamond]
        explore [shape=box, prompt="explore"]
        done [shape=Msquare]
        s -> explore -> done
      }
    `);
    applyStylesheet(graph);
    expect(graph.nodes["explore"]!.attrs.model).toBe("claude-opus-4-7");
  });

  test("fills in model via shape selector", () => {
    const graph = parseDotSource(`
      digraph {
        model_stylesheet = "[shape=box] { model: haiku }"
        s [shape=Mdiamond]
        a [shape=box, prompt="a"]
        b [shape=box, prompt="b"]
        done [shape=Msquare]
        s -> a -> b -> done
      }
    `);
    applyStylesheet(graph);
    expect(graph.nodes["a"]!.attrs.model).toBe("haiku");
    expect(graph.nodes["b"]!.attrs.model).toBe("haiku");
  });

  test("node-level model always wins over stylesheet", () => {
    const graph = parseDotSource(`
      digraph {
        model_stylesheet = "[shape=box] { model: haiku }"
        s [shape=Mdiamond]
        a [shape=box, prompt="a", model="opus"]
        done [shape=Msquare]
        s -> a -> done
      }
    `);
    applyStylesheet(graph);
    expect(graph.nodes["a"]!.attrs.model).toBe("opus");
  });

  test("class selector matches node.attrs.class", () => {
    const graph = parseDotSource(`
      digraph {
        model_stylesheet = ".heavy { model: opus; reasoning_effort: high }"
        s [shape=Mdiamond]
        hard [shape=box, prompt="hard", class="heavy"]
        done [shape=Msquare]
        s -> hard -> done
      }
    `);
    applyStylesheet(graph);
    expect(graph.nodes["hard"]!.attrs.model).toBe("opus");
    expect(graph.nodes["hard"]!.attrs.reasoning_effort).toBe("high");
  });

  test("later rule overrides earlier rule when both match", () => {
    const graph = parseDotSource(`
      digraph {
        model_stylesheet = "[shape=box] { model: haiku } #special { model: opus }"
        s [shape=Mdiamond]
        special [shape=box, prompt="s"]
        plain [shape=box, prompt="p"]
        done [shape=Msquare]
        s -> special -> plain -> done
      }
    `);
    applyStylesheet(graph);
    expect(graph.nodes["special"]!.attrs.model).toBe("opus");
    expect(graph.nodes["plain"]!.attrs.model).toBe("haiku");
  });

  test("no model_stylesheet attr → no-op", () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        a [shape=box, prompt="a"]
        done [shape=Msquare]
        s -> a -> done
      }
    `);
    applyStylesheet(graph);
    expect(graph.nodes["a"]!.attrs.model).toBeUndefined();
  });
});
