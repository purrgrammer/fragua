// parseAndPrepare — proves the §8 model_stylesheet cascade actually
// lands on `node.attrs` for the web layer, so GraphView can render
// model / provider / effort uniformly.

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseAndPrepare } from "../../src/lib/parse-workflow.ts";

describe("parseAndPrepare", () => {
  test("expands wildcard model_stylesheet onto every node attrs", () => {
    const graph = parseAndPrepare(`
      digraph G {
        graph [model_stylesheet="* { llm_model: opus; llm_provider: anthropic; }"]
        s [shape=Mdiamond]
        a [shape=box]
        b [shape=box]
        done [shape=Msquare]
        s -> a -> b -> done
      }
    `);
    for (const id of ["s", "a", "b", "done"]) {
      expect(graph.nodes[id]?.attrs.llm_model).toBe("opus");
      expect(graph.nodes[id]?.attrs.llm_provider).toBe("anthropic");
    }
  });

  test("class selector lands on matching nodes only", () => {
    const graph = parseAndPrepare(`
      digraph G {
        graph [model_stylesheet=".dev { reasoning_effort: high; }"]
        s [shape=Mdiamond]
        a [shape=box, class="dev"]
        b [shape=box]
        done [shape=Msquare]
        s -> a -> b -> done
      }
    `);
    expect(graph.nodes["a"]?.attrs.reasoning_effort).toBe("high");
    expect(graph.nodes["b"]?.attrs.reasoning_effort).toBeUndefined();
  });

  test("id selector overrides class which overrides wildcard", () => {
    const graph = parseAndPrepare(`
      digraph G {
        graph [model_stylesheet="
          * { llm_model: wild; }
          .dev { llm_model: classy; }
          #a { llm_model: idy; }
        "]
        s [shape=Mdiamond]
        a [shape=box, class="dev"]
        done [shape=Msquare]
        s -> a -> done
      }
    `);
    expect(graph.nodes["a"]?.attrs.llm_model).toBe("idy");
  });

  test("explicit per-node attr beats stylesheet", () => {
    const graph = parseAndPrepare(`
      digraph G {
        graph [model_stylesheet="* { llm_model: opus; }"]
        s [shape=Mdiamond]
        a [shape=box, llm_model="explicit"]
        done [shape=Msquare]
        s -> a -> done
      }
    `);
    expect(graph.nodes["a"]?.attrs.llm_model).toBe("explicit");
  });

  test("malformed stylesheet does not throw — parse still succeeds", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const graph = parseAndPrepare(`
        digraph G {
          graph [model_stylesheet="* { llm_model bad }"]
          s [shape=Mdiamond]
          a [shape=box]
          done [shape=Msquare]
          s -> a -> done
        }
      `);
      // Graph still parses; the malformed cascade leaves attrs empty.
      expect(graph.nodes["a"]?.attrs.llm_model).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

afterEach(() => {
  mock.restore();
});
