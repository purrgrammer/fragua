// `fragua runs review-report` CLI verb tests.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import type { IEventStore } from "@fragua/store";
import { SqliteStore } from "@fragua/store";
import { reviewReportCommand } from "../src/commands/operator.ts";

interface Rig {
  dbPath: string;
  store: IEventStore;
  dir: string;
  close: () => void;
}

const WF = "name: test-wf\nsteps:\n  n1: {type: llm, prompt: x, next: exit}\n";

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-rr-"));
  const dbPath = join(dir, "t.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow("wf", "test-wf", WF, serializeGraph(parseWorkflow(WF)), CURRENT_IR_VERSION);
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

function writeWorktreeReview(cwd: string, runId: string, body: string): void {
  const wt = join(cwd, ".fragua", "worktrees", runId);
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "review.md"), body);
}

describe("fragua runs review-report", () => {
  let r: Rig;
  let logs: string[];
  let errors: string[];
  let stdout: string[];

  beforeEach(() => {
    r = rig();
    logs = [];
    errors = [];
    stdout = [];
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    r.close();
  });

  test("worktree review.md present → exit 0, prints file contents to stdout", async () => {
    const runId = "rr1";
    seedRun(r.store, runId, r.dir);
    writeWorktreeReview(r.dir, runId, "# Code Review\n## Verdict\nconverged\n");

    const code = await reviewReportCommand({ runId, dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("## Verdict");
    expect(stdout.join("")).toContain("converged");
  });

  test("--out writes the report to the path and prints nothing to stdout", async () => {
    const runId = "rr2";
    seedRun(r.store, runId, r.dir);
    writeWorktreeReview(r.dir, runId, "# Code Review\nbody\n");
    const outPath = join(r.dir, "out.md");

    const code = await reviewReportCommand({ runId, out: outPath, dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(readFileSync(outPath, "utf8")).toContain("# Code Review");
    expect(stdout.join("")).toBe("");
    expect(logs.join("\n")).toContain("wrote review report");
  });

  test("artifact-recorded review.md is preferred over the worktree file", async () => {
    const runId = "rr3";
    seedRun(r.store, runId, r.dir);
    writeWorktreeReview(r.dir, runId, "FROM WORKTREE");
    r.store.putArtifact(
      { runId, nodeId: "synthesize", iteration: 0, key: "review.md" },
      new TextEncoder().encode("FROM ARTIFACT"),
    );

    const code = await reviewReportCommand({ runId, dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("FROM ARTIFACT");
    expect(stdout.join("")).not.toContain("FROM WORKTREE");
  });

  test("no review.md and no artifact → exit 1", async () => {
    const runId = "rr4";
    seedRun(r.store, runId, r.dir);
    // worktree dir exists but no review.md
    mkdirSync(join(r.dir, ".fragua", "worktrees", runId), { recursive: true });

    const code = await reviewReportCommand({ runId, dbPath: r.dbPath });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("no review.md found");
  });

  test("unknown run → exit 1", async () => {
    const code = await reviewReportCommand({ runId: "nope", dbPath: r.dbPath });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("run not found");
  });
});
