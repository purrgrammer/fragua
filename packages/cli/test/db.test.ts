import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@swarm/store";
import { dbCommand } from "../src/commands/db.ts";

const workdirs: string[] = [];

afterEach(() => {
  while (workdirs.length > 0) {
    const d = workdirs.pop();
    try {
      if (d != null) rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function makeStore(): string {
  const cwd = mkdtempSync(join(tmpdir(), "swarm-db-"));
  workdirs.push(cwd);
  mkdirSync(join(cwd, ".swarm"), { recursive: true });
  const store = new SqliteStore({ path: join(cwd, ".swarm/swarm.db") });
  store.saveWorkflow("sha", "wf", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
  store.enqueueRun({ runId: "r", workflowSha: "sha" });
  store.close();
  return cwd;
}

describe("swarm db", () => {
  test("vacuum completes", async () => {
    const cwd = makeStore();
    const code = await dbCommand({ action: "vacuum", cwd });
    expect(code).toBe(0);
  });

  test("gc-blobs reports 0 when nothing is orphaned", async () => {
    const cwd = makeStore();
    const code = await dbCommand({ action: "gc-blobs", cwd });
    expect(code).toBe(0);
  });

  test("backup writes a readable copy", async () => {
    const cwd = makeStore();
    const dest = join(cwd, "out/backup.db");
    const code = await dbCommand({ action: "backup", cwd, to: dest });
    expect(code).toBe(0);
    expect(statSync(dest).size).toBeGreaterThan(0);
  });

  test("backup without --to fails", async () => {
    const cwd = makeStore();
    const code = await dbCommand({ action: "backup", cwd });
    expect(code).toBe(1);
  });

  test("error when store missing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "swarm-empty-"));
    workdirs.push(cwd);
    const code = await dbCommand({ action: "vacuum", cwd });
    expect(code).toBe(1);
  });
});
