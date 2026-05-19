import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@swarm/store";
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

/** Build a repo with a populated DB and a `swarm/runs/<id>` branch
 * pointing at a real commit, then mutate the run's `updated_at` to
 * simulate aging. Returns the cwd. */
function makeRepoWithBranchedRun(opts: { runId: string; ageMs: number }): string {
  const cwd = mkdtempSync(join(tmpdir(), "swarm-gc-"));
  workdirs.push(cwd);
  mkdirSync(join(cwd, ".swarm"), { recursive: true });

  spawnSync("git", ["init", "-b", "main", cwd], { stdio: "ignore" });
  spawnSync("git", ["-C", cwd, "config", "user.email", "test@test"], { stdio: "ignore" });
  spawnSync("git", ["-C", cwd, "config", "user.name", "test"], { stdio: "ignore" });
  spawnSync("git", ["-C", cwd, "config", "commit.gpgsign", "false"], { stdio: "ignore" });
  writeFileSync(join(cwd, "README.md"), "# x\n");
  spawnSync("git", ["-C", cwd, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", cwd, "commit", "-m", "init"], { stdio: "ignore" });
  spawnSync("git", ["-C", cwd, "branch", `swarm/runs/${opts.runId}`], { stdio: "ignore" });

  const dbPath = join(cwd, ".swarm/swarm.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow("sha", "wf", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
  store.enqueueRun({ runId: opts.runId, workflowSha: "sha" });
  store.close();

  // Backdate the run so it falls outside / inside the retention window.
  const fakedUpdatedAt = Date.now() - opts.ageMs;
  const db = new Database(dbPath);
  db.query("UPDATE run_state SET updated_at = ? WHERE run_id = ?").run(fakedUpdatedAt, opts.runId);
  db.close();

  return cwd;
}

describe("swarm gc --branches", () => {
  test("dry-run reports old branches without deleting", async () => {
    const cwd = makeRepoWithBranchedRun({
      runId: "old-run",
      ageMs: 60 * 24 * 60 * 60 * 1000, // 60 days ago
    });

    const code = await gcCommand({
      target: "branches",
      cwd,
      olderThanMs: 30 * 24 * 60 * 60 * 1000,
      dryRun: true,
    });
    expect(code).toBe(0);

    const branches = spawnSync("git", ["-C", cwd, "branch"], { encoding: "utf8" });
    expect(branches.stdout).toContain("swarm/runs/old-run");
  });

  test("real run deletes branches outside the retention window", async () => {
    const cwd = makeRepoWithBranchedRun({
      runId: "old-run",
      ageMs: 60 * 24 * 60 * 60 * 1000,
    });

    const code = await gcCommand({
      target: "branches",
      cwd,
      olderThanMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(code).toBe(0);

    const branches = spawnSync("git", ["-C", cwd, "branch"], { encoding: "utf8" });
    expect(branches.stdout).not.toContain("swarm/runs/old-run");
  });

  test("branches inside the retention window survive", async () => {
    const cwd = makeRepoWithBranchedRun({
      runId: "fresh-run",
      ageMs: 1 * 24 * 60 * 60 * 1000, // 1 day ago
    });

    const code = await gcCommand({
      target: "branches",
      cwd,
      olderThanMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(code).toBe(0);

    const branches = spawnSync("git", ["-C", cwd, "branch"], { encoding: "utf8" });
    expect(branches.stdout).toContain("swarm/runs/fresh-run");
  });

  test("branches with no run_state row are left alone", async () => {
    const cwd = makeRepoWithBranchedRun({
      runId: "tracked",
      ageMs: 60 * 24 * 60 * 60 * 1000,
    });
    // Manually create a stray branch — no matching DB row.
    spawnSync("git", ["-C", cwd, "branch", "swarm/runs/stray-branch"], { stdio: "ignore" });

    await gcCommand({
      target: "branches",
      cwd,
      olderThanMs: 30 * 24 * 60 * 60 * 1000,
    });

    const branches = spawnSync("git", ["-C", cwd, "branch"], { encoding: "utf8" });
    expect(branches.stdout).toContain("swarm/runs/stray-branch");
    expect(branches.stdout).not.toContain("swarm/runs/tracked");
  });
});

describe("parseDuration", () => {
  test("default", () => {
    expect(parseDuration(undefined)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseDuration("")).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("days, hours, weeks, minutes", () => {
    expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseDuration("12h")).toBe(12 * 60 * 60 * 1000);
    expect(parseDuration("2w")).toBe(2 * 7 * 24 * 60 * 60 * 1000);
    expect(parseDuration("90m")).toBe(90 * 60 * 1000);
  });

  test("rejects garbage", () => {
    expect(() => parseDuration("abc")).toThrow(/invalid duration/);
    expect(() => parseDuration("30")).toThrow(/invalid duration/);
  });
});
