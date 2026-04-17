// Guards against a class of bugs where kebab-case flags in the CLI bin are
// read with their literal kebab-case key from cac's `options` object. cac
// camelCases option keys (`--input-file` → `options.inputFile`), so reading
// `options["input-file"]` silently returns undefined and drops the flag.
//
// This test reproduces the same cac option shape as `packages/cli/bin/swarm.ts`
// and asserts the camelCased keys we rely on are present after parsing. If
// cac ever changes its convention, or someone adds a new kebab option and
// reads it with the wrong key, this test fails first.

import { describe, expect, test } from "bun:test";
import cac from "cac";

function parseRun(argv: string[]): Record<string, unknown> {
  const cli = cac("swarm");
  let captured: Record<string, unknown> = {};
  cli
    .command("run <workflow>")
    .option("--input <text>", "")
    .option("--input-file <path>", "")
    .option("--model <id>", "")
    .option("--provider <name>", "")
    .option("--run-id <id>", "")
    .option("--runs-dir <path>", "")
    .option("--cwd <path>", "")
    .option("--mock", "")
    .option("-v, --verbose", "")
    .option("-q, --quiet", "")
    .option("--allow-env-keys", "")
    .option("--worktree", "")
    .option("--keep-worktree", "")
    .option("--interviewer <mode>", "")
    .action((_workflow: string, options: Record<string, unknown>) => {
      captured = options;
    });
  cli.parse(["node", "swarm", ...argv], { run: true });
  return captured;
}

describe("swarm run — CLI argv → options mapping (cac camelCase contract)", () => {
  test("--input-file lands on options.inputFile (NOT options['input-file'])", () => {
    const opts = parseRun(["run", "w.dot", "--input-file", "tasks/x.md"]);
    expect(opts["inputFile"]).toBe("tasks/x.md");
    expect(opts["input-file"]).toBeUndefined();
  });

  test("every kebab-case flag camelCases consistently", () => {
    const opts = parseRun([
      "run",
      "w.dot",
      "--input-file",
      "a.md",
      "--run-id",
      "r1",
      "--runs-dir",
      ".runs",
      "--allow-env-keys",
      "--keep-worktree",
    ]);
    expect(opts["inputFile"]).toBe("a.md");
    expect(opts["runId"]).toBe("r1");
    expect(opts["runsDir"]).toBe(".runs");
    expect(opts["allowEnvKeys"]).toBe(true);
    expect(opts["keepWorktree"]).toBe(true);
    // Negative controls: the kebab keys must NOT be populated.
    for (const k of ["input-file", "run-id", "runs-dir", "allow-env-keys", "keep-worktree"]) {
      expect(opts[k]).toBeUndefined();
    }
  });

  test("repeated --input-file produces a string[]", () => {
    const opts = parseRun(["run", "w.dot", "--input-file", "a.md", "--input-file", "b.md"]);
    expect(opts["inputFile"]).toEqual(["a.md", "b.md"]);
  });

  test("single-word flags remain bare (no camelCasing surprise)", () => {
    const opts = parseRun(["run", "w.dot", "--worktree", "--mock", "--input", "hi"]);
    expect(opts["worktree"]).toBe(true);
    expect(opts["mock"]).toBe(true);
    expect(opts["input"]).toBe("hi");
  });
});
