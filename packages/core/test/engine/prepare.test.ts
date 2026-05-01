// Transform pipeline tests — attractor-spec §9.1.

import { describe, expect, test } from "bun:test";
import { prepareGraph } from "../../src/engine/prepare.ts";
import { StylesheetParseError } from "../../src/engine/stylesheet.ts";
import { parseDotSource } from "../../src/parser/parser.ts";

describe("prepareGraph", () => {
  test("applies stylesheet to fill node attrs", () => {
    const graph = parseDotSource(`
      digraph G {
        graph [model_stylesheet="* { llm_model: opus; llm_provider: anthropic; }"]
        s [shape=Mdiamond]
        a [shape=box]
        done [shape=Msquare]
        s -> a -> done
      }
    `);
    const r = prepareGraph(graph);
    expect(r.errors).toEqual([]);
    expect(graph.nodes["a"]?.attrs.llm_model).toBe("opus");
    expect(graph.nodes["a"]?.attrs.llm_provider).toBe("anthropic");
  });

  test("explicit node attrs survive the transform pass", () => {
    const graph = parseDotSource(`
      digraph G {
        graph [model_stylesheet="* { llm_model: from-stylesheet; }"]
        s [shape=Mdiamond]
        a [shape=box, llm_model="explicit"]
        done [shape=Msquare]
        s -> a -> done
      }
    `);
    prepareGraph(graph);
    expect(graph.nodes["a"]?.attrs.llm_model).toBe("explicit");
  });

  test("malformed stylesheet surfaces as a transform error", () => {
    const graph = parseDotSource(`
      digraph G {
        graph [model_stylesheet="* { llm_model bad }"]
        s [shape=Mdiamond]
        done [shape=Msquare]
        s -> done
      }
    `);
    const r = prepareGraph(graph);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toBeInstanceOf(StylesheetParseError);
  });

  test("absent stylesheet → no errors, no attr fill", () => {
    const graph = parseDotSource(`
      digraph G {
        s [shape=Mdiamond]
        a [shape=box]
        done [shape=Msquare]
        s -> a -> done
      }
    `);
    const r = prepareGraph(graph);
    expect(r.errors).toEqual([]);
    expect(graph.nodes["a"]?.attrs.llm_model).toBeUndefined();
  });

  test("returns the same graph reference for chaining", () => {
    const graph = parseDotSource(`digraph G { s [shape=Mdiamond]; done [shape=Msquare]; s -> done }`);
    const r = prepareGraph(graph);
    expect(r.graph).toBe(graph);
  });
});
