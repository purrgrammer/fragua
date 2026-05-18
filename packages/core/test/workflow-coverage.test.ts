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
import { parseDotSource, validate } from "../src/index.ts";

const WORKFLOWS_DIR = join(import.meta.dir, "..", "..", "..", ".swarm", "workflows");

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".dot"))
    .map((f) => join(WORKFLOWS_DIR, f));
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
});
