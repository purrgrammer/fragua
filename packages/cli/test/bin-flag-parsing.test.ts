// Guards against a class of bugs where kebab-case flags in the CLI bin are
// read with their literal kebab-case key from cac's `options` object. cac
// camelCases option keys (`--run-id` → `options.runId`), so reading
// `options["run-id"]` silently returns undefined and drops the flag.
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
    .option("--model <id>", "")
    .option("--provider <name>", "")
    .option("--run-id <id>", "")
    .option("--runs-dir <path>", "")
    .option("--cwd <path>", "")
    .option("--mock", "")
    .option("-v, --verbose", "")
    .option("-q, --quiet", "")
    .option("--allow-env-keys", "")
    .option("--no-worktree", "")
    .option("--interviewer <mode>", "")
    .action((_workflow: string, options: Record<string, unknown>) => {
      captured = options;
    });
  cli.parse(["node", "swarm", ...argv], { run: true });
  return captured;
}

describe("swarm run — CLI argv → options mapping (cac camelCase contract)", () => {
  test("--run-id lands on options.runId (NOT options['run-id'])", () => {
    const opts = parseRun(["run", "w.yaml", "--run-id", "abc"]);
    expect(opts["runId"]).toBe("abc");
    expect(opts["run-id"]).toBeUndefined();
  });

  test("every kebab-case flag camelCases consistently", () => {
    const opts = parseRun(["run", "w.yaml", "--run-id", "r1", "--runs-dir", ".runs", "--allow-env-keys"]);
    expect(opts["runId"]).toBe("r1");
    expect(opts["runsDir"]).toBe(".runs");
    expect(opts["allowEnvKeys"]).toBe(true);
    // Negative controls: the kebab keys must NOT be populated.
    for (const k of ["run-id", "runs-dir", "allow-env-keys"]) {
      expect(opts[k]).toBeUndefined();
    }
  });

  test("--no-worktree sets options.worktree to false (cac negated-flag idiom)", () => {
    // cac's `--no-X` convention: declaring `--no-worktree` implies a
    // default-on flag surfaced as `options.worktree`. Without the flag
    // cac fills in `true`; passing it explicitly flips to `false`.
    // Our action handler reads `options.worktree !== false` so either
    // default resolves to worktree: true.
    const withFlag = parseRun(["run", "w.yaml", "--no-worktree"]);
    expect(withFlag["worktree"]).toBe(false);
    const withoutFlag = parseRun(["run", "w.yaml"]);
    expect(withoutFlag["worktree"]).toBe(true);
  });

  test("single-word flags remain bare (no camelCasing surprise)", () => {
    const opts = parseRun(["run", "w.yaml", "--mock", "--input", "hi"]);
    expect(opts["mock"]).toBe(true);
    expect(opts["input"]).toBe("hi");
  });
});
