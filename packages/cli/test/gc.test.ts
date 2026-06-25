import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { SqliteStore } from "@fragua/store";
import { gcCommand, parseDuration } from "../src/commands/gc.ts";

const workdirs: string[] = [];

afterEach(() => {
  while (workdirs.length > 0) {
    const d = workdirs.pop();
    try {
      if (d != null) rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return r.stdout?.trim() ?? "";
}

function refExists(cwd: string, ref: string): boolean {
  return spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", ref]).status === 0;
}

/** Build a repo + DB with a terminal run that owns
 * `refs/fragua/{snapshots,heads}/<id>`, backdated by `ageMs`. When `pending`,
 * the run's terminal snapshot leaves recoverable work (inbox_status=pending,
 * so GC must keep it). */
function makeRepoWithSnapshotRun(opts: { runId: string; ageMs: number; pending?: boolean }): string {
  const cwd = mkdtempSync(join(tmpdir(), "fragua-gc-"));
  workdirs.push(cwd);
  mkdirSync(join(cwd, ".fragua"), { recursive: true });

  spawnSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
  git(cwd, "config", "user.email", "test@test");
  git(cwd, "config", "user.name", "test");
  git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "README.md"), "# x\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "init");
  const head = git(cwd, "rev-parse", "HEAD");
  git(cwd, "update-ref", `refs/fragua/snapshots/${opts.runId}`, head);
  git(cwd, "update-ref", `refs/fragua/heads/${opts.runId}`, head);

  const dbPath = join(cwd, ".fragua/fragua.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow(
    "sha",
    "wf",
    "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
    serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x}\n")),
    CURRENT_IR_VERSION,
  );
  store.enqueueRun({ runId: opts.runId, workflowSha: "sha", cwd });
  const s0 = store.getState(opts.runId)!;
  store.appendFact(
    opts.runId,
    [
      {
        type: "fact.run_started",
        payload: {
          workflowSha: "sha",
          contractVersion: s0.contractVersion,
          startNode: "work",
          baseGitSha: head,
          baseGitRef: "main",
        },
      },
    ],
    s0.version,
  );
  const s1 = store.getState(opts.runId)!;
  store.appendFact(
    opts.runId,
    [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "work" } }],
    s1.version,
  );
  if (opts.pending === true) {
    const s2 = store.getState(opts.runId)!;
    store.appendFact(
      opts.runId,
      [
        {
          type: "fact.snapshot_recorded",
          payload: {
            eventIdx: 3,
            treeSha: head,
            commitSha: head,
            parentSnap: "",
            headSha: null,
            headRef: null,
            diffBaseSha: head,
            committed: null,
            uncommitted: { filesChanged: 1, insertions: 2, deletions: 0 },
          },
        },
      ],
      s2.version,
    );
  }
  store.close();

  const db = new Database(dbPath);
  db.query("UPDATE run_state SET updated_at = ? WHERE run_id = ?").run(Date.now() - opts.ageMs, opts.runId);
  db.close();

  return cwd;
}

const MONTH = 30 * 24 * 60 * 60 * 1000;

describe("fragua gc --snapshots", () => {
  test("dry-run reports eligible refs without deleting", async () => {
    const cwd = makeRepoWithSnapshotRun({ runId: "old-run", ageMs: 60 * 24 * 60 * 60 * 1000 });
    const code = await gcCommand({ target: "snapshots", cwd, olderThanMs: MONTH, dryRun: true });
    expect(code).toBe(0);
    expect(refExists(cwd, "refs/fragua/snapshots/old-run")).toBe(true);
    expect(refExists(cwd, "refs/fragua/heads/old-run")).toBe(true);
  });

  test("deletes both refs for a settled run outside the retention window", async () => {
    const cwd = makeRepoWithSnapshotRun({ runId: "old-run", ageMs: 60 * 24 * 60 * 60 * 1000 });
    const code = await gcCommand({ target: "snapshots", cwd, olderThanMs: MONTH });
    expect(code).toBe(0);
    expect(refExists(cwd, "refs/fragua/snapshots/old-run")).toBe(false);
    expect(refExists(cwd, "refs/fragua/heads/old-run")).toBe(false);
  });

  test("refs inside the retention window survive", async () => {
    const cwd = makeRepoWithSnapshotRun({ runId: "fresh-run", ageMs: 1 * 24 * 60 * 60 * 1000 });
    const code = await gcCommand({ target: "snapshots", cwd, olderThanMs: MONTH });
    expect(code).toBe(0);
    expect(refExists(cwd, "refs/fragua/snapshots/fresh-run")).toBe(true);
  });

  test("pending (inbox) runs are kept regardless of age", async () => {
    const cwd = makeRepoWithSnapshotRun({ runId: "pending-run", ageMs: 60 * 24 * 60 * 60 * 1000, pending: true });
    const code = await gcCommand({ target: "snapshots", cwd, olderThanMs: MONTH });
    expect(code).toBe(0);
    expect(refExists(cwd, "refs/fragua/snapshots/pending-run")).toBe(true);
    expect(refExists(cwd, "refs/fragua/heads/pending-run")).toBe(true);
  });
});

describe("parseDuration", () => {
  test("default", () => {
    expect(parseDuration(undefined)).toBe(MONTH);
    expect(parseDuration("")).toBe(MONTH);
  });

  test("days, hours, weeks, minutes", () => {
    expect(parseDuration("30d")).toBe(MONTH);
    expect(parseDuration("12h")).toBe(12 * 60 * 60 * 1000);
    expect(parseDuration("2w")).toBe(2 * 7 * 24 * 60 * 60 * 1000);
    expect(parseDuration("90m")).toBe(90 * 60 * 1000);
  });

  test("rejects garbage", () => {
    expect(() => parseDuration("abc")).toThrow(/invalid duration/);
    expect(() => parseDuration("30")).toThrow(/invalid duration/);
  });
});
