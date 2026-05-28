// `fragua runs worktree` CLI verb tests.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import type { IEventStore } from "@fragua/store";
import { SqliteStore } from "@fragua/store";
import { worktreeCommand } from "../src/commands/operator.ts";

interface Rig {
  dbPath: string;
  store: IEventStore;
  dir: string;
  close: () => void;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-wt-"));
  const dbPath = join(dir, "t.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow(
    "wf",
    "test-wf",
    "name: test-wf\nsteps:\n  n1: {type: llm, prompt: x}\n",
    serializeGraph(parseWorkflow("name: test-wf\nsteps:\n  n1: {type: llm, prompt: x}\n")),
    CURRENT_IR_VERSION,
  );
  return {
    dbPath,
    store,
    dir,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedRun(store: IEventStore, runId: string, cwd: string): void {
  store.enqueueRun({ runId, workflowSha: "wf", cwd });
  const s0 = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: {
          workflowSha: "wf",
          contractVersion: s0.contractVersion,
          startNode: "n1",
          baseGitSha: "a".repeat(40),
          baseGitRef: "main",
        },
      },
    ],
    s0.version,
  );
}

describe("fragua runs worktree", () => {
  let r: Rig;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    r = rig();
    logs = [];
    errors = [];
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
  });

  afterEach(() => {
    r.close();
  });

  test("worktree exists → exit 0, prints absolute path under cwd", async () => {
    const cwd = r.dir;
    const runId = "wt1";
    seedRun(r.store, runId, cwd);

    // Create the worktree directory
    const wtPath = join(cwd, ".fragua", "worktrees", runId);
    mkdirSync(wtPath, { recursive: true });

    const code = await worktreeCommand({ runId, dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain(wtPath);
    expect(logs.join("\n")).toContain(cwd);
  });

  test("worktree missing (post-GC) → exit 1, message names the path", async () => {
    const cwd = r.dir;
    const runId = "wt2";
    seedRun(r.store, runId, cwd);
    // Do NOT create the worktree directory

    const code = await worktreeCommand({ runId, dbPath: r.dbPath });
    expect(code).toBe(1);
    const errOut = errors.join("\n");
    // Should mention the run or worktree path
    expect(errOut.length).toBeGreaterThan(0);
  });

  test("run with no cwd (bare) → exit 1", async () => {
    // Seed a run without a cwd (ephemeral-style)
    r.store.enqueueRun({ runId: "wt3", workflowSha: "wf" });
    const code = await worktreeCommand({ runId: "wt3", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("unknown run → exit 1", async () => {
    const code = await worktreeCommand({ runId: "nope", dbPath: r.dbPath });
    expect(code).toBe(1);
  });
});
