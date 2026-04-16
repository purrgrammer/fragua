// Property-based fuzz tests for the DOT parser.
// We generate structured DOT input (well-formed by construction) and assert
// that the resulting Graph carries the expected node + edge counts.

import { describe, test } from "bun:test";
import fc from "fast-check";
import { parseDotSource } from "../../src/parser/parser.ts";

const dotIdent = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,15}$/).filter((s) => {
  const reserved = ["digraph", "subgraph", "graph", "node", "edge", "strict", "true", "false"];
  return !reserved.includes(s);
});

const quotedAttrValue = fc.string({ minLength: 0, maxLength: 40 }).map((s) => s.replace(/[\\"]/g, ""));

describe("parseDotSource — fuzz", () => {
  test("random nodes + edges parse without crashing", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(dotIdent, { minLength: 2, maxLength: 12 }),
        fc.integer({ min: 0, max: 30 }),
        (ids, edgeCount) => {
          const edges: Array<[string, string]> = [];
          // Deterministic edge synthesis using modular arithmetic
          for (let i = 0; i < edgeCount; i++) {
            const from = ids[i % ids.length]!;
            const to = ids[(i + 1) % ids.length]!;
            if (from !== to) edges.push([from, to]);
          }
          const lines = ["digraph G {", ...ids.map((id) => `  ${id}`), ...edges.map(([f, t]) => `  ${f} -> ${t}`), "}"];
          const src = lines.join("\n");
          const g = parseDotSource(src);
          // Every id must appear in graph.nodes
          for (const id of ids) if (!g.nodes[id]) return false;
          if (g.edges.length !== edges.length) return false;
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  test("quoted attribute values round-trip through the parser", () => {
    fc.assert(
      fc.property(dotIdent, dotIdent, quotedAttrValue, (a, b, label) => {
        const src = `digraph G { ${a} -> ${b} [label="${label}"] }`;
        const g = parseDotSource(src);
        return g.edges[0]?.attrs.label === label;
      }),
      { numRuns: 200 },
    );
  });

  test("chained edges always produce N-1 edges", () => {
    fc.assert(
      fc.property(fc.uniqueArray(dotIdent, { minLength: 2, maxLength: 6 }), (ids) => {
        const chain = ids.join(" -> ");
        const g = parseDotSource(`digraph { ${chain} }`);
        return g.edges.length === ids.length - 1;
      }),
      { numRuns: 100 },
    );
  });

  test("multiple attribute blocks merge", () => {
    fc.assert(
      fc.property(dotIdent, fc.integer({ min: 0, max: 99 }), quotedAttrValue, (id, weight, label) => {
        const src = `digraph { ${id} [label="${label}"] [shape=diamond] }`;
        const g = parseDotSource(src);
        const node = g.nodes[id];
        if (!node) return false;
        if (node.attrs.label !== label) return false;
        return node.shape === "diamond";
      }),
      { numRuns: 100 },
    );
  });
});
