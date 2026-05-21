// Workflow-coverage smoke test.
//
// Every `.yaml` file in the repo's `.fragua/workflows/` directory parses
// AND validates cleanly. A broken example is broken onboarding.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow, validate } from "../src/index.ts";

const WORKFLOWS_DIR = join(import.meta.dir, "..", "..", "..", ".fragua", "workflows");

function listWorkflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => join(WORKFLOWS_DIR, f));
}

describe(".fragua/workflows/*.yaml — coverage + validity", () => {
  const files = listWorkflowFiles();

  test("repo ships at least one workflow", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const path of files) {
    test(`${path.split("/").pop()} parses + validates without errors`, () => {
      const src = readFileSync(path, "utf8");
      const graph = parseWorkflow(src);
      const diags = validate(graph);
      const errors = diags.filter((d) => d.severity === "error");
      if (errors.length > 0) {
        console.error(`[${path}] errors:`, errors);
      }
      expect(errors).toHaveLength(0);
    });
  }
});
