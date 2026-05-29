import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
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

  function pinVersion(cwd: string, v: number): void {
    const db = new Database(join(cwd, ".fragua/fragua.db"));
    db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(v);
    db.close();
  }
  function schedulesCols(cwd: string): string[] {
    const db = new Database(join(cwd, ".fragua/fragua.db"), { readonly: true });
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(schedules)")
      .all()
      .map((c) => c.name);
    db.close();
    return cols;
  }

  test("migrate --to 1 walks DOWN, reverses the rename, and backs up first", async () => {
    const cwd = makeStore(); // at CURRENT (v2): schedules.title
    expect(schedulesCols(cwd)).toContain("title");

    expect(await dbCommand({ action: "migrate", cwd, to: "1" })).toBe(0);

    expect(schedulesCols(cwd)).toContain("input");
    expect(schedulesCols(cwd)).not.toContain("title");
    const backups = readdirSync(join(cwd, ".fragua/backups"));
    expect(backups.some((f) => f.startsWith("pre-migrate-v2-to-v1-") && f.endsWith(".db"))).toBe(true);
  });

  test("migrate --to 1 --dry-run prints the plan and mutates nothing", async () => {
    const cwd = makeStore();
    expect(await dbCommand({ action: "migrate", cwd, to: "1", dryRun: true })).toBe(0);
    expect(schedulesCols(cwd)).toContain("title"); // untouched
    expect(existsSync(join(cwd, ".fragua/backups"))).toBe(false); // no backup on dry-run
  });

  test("migrate --no-backup skips the pre-migrate dump", async () => {
    const cwd = makeStore();
    expect(await dbCommand({ action: "migrate", cwd, to: "1", noBackup: true })).toBe(0);
    expect(schedulesCols(cwd)).toContain("input");
    expect(existsSync(join(cwd, ".fragua/backups"))).toBe(false);
  });

  test("migrate --to forward lands the rename again", async () => {
    const cwd = makeStore();
    expect(await dbCommand({ action: "migrate", cwd, to: "1", noBackup: true })).toBe(0);
    expect(await dbCommand({ action: "migrate", cwd, to: String(CURRENT_SCHEMA_VERSION), noBackup: true })).toBe(0);
    expect(schedulesCols(cwd)).toContain("title");
  });

  test("migrate refuses to race a live harness (fresh daemon_lock heartbeat)", async () => {
    const cwd = makeStore();
    const db = new Database(join(cwd, ".fragua/fragua.db"));
    db.query("INSERT INTO daemon_lock (id, pid, hostname, started_at, heartbeat_at) VALUES (1, 999, 'h', ?, ?)").run(
      Date.now(),
      Date.now(),
    );
    db.close();
    expect(await dbCommand({ action: "migrate", cwd, to: "1", noBackup: true })).toBe(1);
    expect(schedulesCols(cwd)).toContain("title"); // refused before mutating
  });

  test("migrate proceeds past a STALE daemon_lock heartbeat", async () => {
    const cwd = makeStore();
    const db = new Database(join(cwd, ".fragua/fragua.db"));
    db.query("INSERT INTO daemon_lock (id, pid, hostname, started_at, heartbeat_at) VALUES (1, 999, 'h', 0, 0)").run();
    db.close();
    expect(await dbCommand({ action: "migrate", cwd, to: "1", noBackup: true })).toBe(0);
    expect(schedulesCols(cwd)).toContain("input");
  });

  test("migrate --to below the floor is refused", async () => {
    const cwd = makeStore();
    pinVersion(cwd, CURRENT_SCHEMA_VERSION); // ensure known start
    expect(await dbCommand({ action: "migrate", cwd, to: "0", noBackup: true })).toBe(1);
  });

  test("migrate --to a non-integer is refused", async () => {
    const cwd = makeStore();
    expect(await dbCommand({ action: "migrate", cwd, to: "abc", noBackup: true })).toBe(1);
  });
});
