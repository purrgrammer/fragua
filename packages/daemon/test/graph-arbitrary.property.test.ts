// Bootstrap property for the graph arbitrary — docs/proposals/
// executor-pbt-decomposition.md.
//
// "Every graph the generator emits validates clean." This is the generator's
// own correctness check: the real validator (packages/core/src/engine/
// validator.ts) is the post-condition. If the generator ever emits a graph the
// validator rejects, fast-check shrinks a minimal counterexample — a generator
// bug, surfaced as a build failure rather than silent junk feeding the
// downstream executor properties. This is an assertion, never a rejection
// sampler (no fc.pre, no filter): generate-and-filter shrinks terribly.

import { describe, expect, test } from "bun:test";
import { validate } from "@fragua/core";
import fc from "fast-check";
import { arbGraph, arbGraphWithCurrentNode, featuresOf } from "./arbitraries/graph.ts";

describe("graph arbitrary — bootstrap", () => {
  test("every generated graph validates clean (zero diagnostics)", () => {
    fc.assert(
      fc.property(arbGraph, (graph) => {
        const diags = validate(graph);
        // Surface code + message so a shrink failure is self-explaining.
        if (diags.length > 0) {
          throw new Error(
            `validate() returned ${diags.length} diagnostic(s): ${diags.map((d) => `${d.code} ${d.message}`).join(" | ")}`,
          );
        }
      }),
      { numRuns: 2000 },
    );
  });

  test("the slice always names a non-terminal node that exists in the graph", () => {
    fc.assert(
      fc.property(arbGraphWithCurrentNode, ({ graph, nodeId }) => {
        const node = graph.nodes[nodeId];
        expect(node).toBeDefined();
        // non-terminal: a dispatchable node (llm / tool / human), never start/exit.
        expect(node!.type !== "start" && node!.type !== "exit").toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  // Not an assertion — prints the structural-feature distribution so coverage
  // is eyeballable. A run dominated by tiny chains with no gates/cycles would
  // mean the planner/executor properties aren't exercising the interesting
  // machinery.
  test("coverage distribution (reported, not asserted)", () => {
    fc.statistics(arbGraph, (g) => featuresOf(g), { numRuns: 1000 });
    expect(true).toBe(true);
  });
});
