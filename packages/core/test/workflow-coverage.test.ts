// Workflow-coverage smoke test.
//
// Two invariants over the shipped `.swarm/workflows/*.dot` examples:
//
//   1. Every .dot file in the repo's `.swarm/workflows/` directory
//      parses AND validates cleanly. A broken example is broken
//      onboarding.
//
//   2. Together, the shipped workflows exercise every canonical node
//      handler kind from attractor-spec §2.8 — so when someone removes
//      a shape from NodeShape without an accompanying workflow update,
//      this test fails and the omission is visible in CI instead of
//      showing up as a runtime dispatch mismatch months later.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDLER_BY_SHAPE, type HandlerType, type NodeShape, parseDotSource, validate } from "../src/index.ts";

const WORKFLOWS_DIR = join(import.meta.dir, "..", "..", "..", ".swarm", "workflows");

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".dot"))
    .map((f) => join(WORKFLOWS_DIR, f));
}

function shapeOf(node: { shape?: string; attrs?: { shape?: string } }): NodeShape {
  const s = node.shape ?? node.attrs?.shape ?? "box";
  return s as NodeShape;
}

describe(".swarm/workflows/*.dot — coverage + validity", () => {
  const files = listWorkflowFiles();

  test("repo ships at least one workflow", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const path of files) {
    test(`${path.split("/").pop()} parses + validates without errors`, () => {
      const src = readFileSync(path, "utf8");
      const graph = parseDotSource(src);
      const diags = validate(graph);
      const errors = diags.filter((d) => d.severity === "error");
      if (errors.length > 0) {
        console.error(`[${path}] errors:`, errors);
      }
      expect(errors).toHaveLength(0);
    });
  }

  test("every canonical handler kind appears in at least one shipped workflow", () => {
    const expectedKinds = new Set<HandlerType>(Object.values(HANDLER_BY_SHAPE));
    const seen = new Set<HandlerType>();
    for (const path of files) {
      const src = readFileSync(path, "utf8");
      const graph = parseDotSource(src);
      for (const node of Object.values(graph.nodes)) {
        const kind = HANDLER_BY_SHAPE[shapeOf(node)];
        seen.add(kind);
      }
    }
    const missing = [...expectedKinds].filter((k) => !seen.has(k));
    if (missing.length > 0) {
      throw new Error(
        `No shipped workflow demonstrates handler kind(s): ${missing.join(", ")}. ` +
          "Add a node with the corresponding shape to one of .swarm/workflows/*.dot.",
      );
    }
    expect(missing).toEqual([]);
  });
});
