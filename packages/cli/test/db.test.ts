import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { CURRENT_SCHEMA_VERSION, SqliteStore } from "@fragua/store";
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
  const cwd = mkdtempSync(join(tmpdir(), "fragua-db-"));
  workdirs.push(cwd);
  mkdirSync(join(cwd, ".fragua"), { recursive: true });
  const store = new SqliteStore({ path: join(cwd, ".fragua/fragua.db") });
  store.saveWorkflow(
    "sha",
    "wf",
    "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
    serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x}\n")),
    CURRENT_IR_VERSION,
  );
  store.enqueueRun({ runId: "r", workflowSha: "sha" });
  store.close();
  return cwd;
}

describe("fragua db", () => {
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
    const cwd = mkdtempSync(join(tmpdir(), "fragua-empty-"));
    workdirs.push(cwd);
    const code = await dbCommand({ action: "vacuum", cwd });
    expect(code).toBe(1);
  });

  test("migrate is a no-op on a store already at the current version", async () => {
    const cwd = makeStore();
    expect(await dbCommand({ action: "migrate", cwd })).toBe(0);
    expect(await dbCommand({ action: "migrate", cwd, dryRun: true })).toBe(0);
  });

  test("migrate refuses a store newer than the binary", async () => {
    const cwd = makeStore();
    // Hand-bump the pinned version past CURRENT to simulate a newer producer.
    const db = new Database(join(cwd, ".fragua/fragua.db"));
    db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(CURRENT_SCHEMA_VERSION + 1);
    db.close();
    expect(await dbCommand({ action: "migrate", cwd })).toBe(1);
  });
});
