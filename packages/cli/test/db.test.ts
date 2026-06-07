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

// `db` verbs default to the home store now; tests target their temp store
// explicitly via `dbPath` (the operator's `--db <project store>` path).
const dbOf = (cwd: string): string => join(cwd, ".fragua/fragua.db");
const run = (o: Parameters<typeof dbCommand>[0]): Promise<number> =>
  dbCommand({ ...o, dbPath: o.dbPath ?? dbOf(o.cwd ?? "") });

describe("fragua db", () => {
  test("vacuum completes", async () => {
    const cwd = makeStore();
    const code = await run({ action: "vacuum", cwd });
    expect(code).toBe(0);
  });

  test("gc-blobs reports 0 when nothing is orphaned", async () => {
    const cwd = makeStore();
    const code = await run({ action: "gc-blobs", cwd });
    expect(code).toBe(0);
  });

  test("backup writes a readable copy", async () => {
    const cwd = makeStore();
    const dest = join(cwd, "out/backup.db");
    const code = await run({ action: "backup", cwd, to: dest });
    expect(code).toBe(0);
    expect(statSync(dest).size).toBeGreaterThan(0);
  });

  test("backup without --to fails", async () => {
    const cwd = makeStore();
    const code = await run({ action: "backup", cwd });
    expect(code).toBe(1);
  });

  test("error when store missing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fragua-empty-"));
    workdirs.push(cwd);
    const code = await run({ action: "vacuum", cwd });
    expect(code).toBe(1);
  });

  test("defaults to the home store, not the cwd", async () => {
    // Home is empty; the cwd HAS a store. With no `dbPath`, the default must
    // resolve to $FRAGUA_HOME/fragua.db (empty ⇒ fails) rather than the cwd
    // store (would succeed) — the regression guarding `db` pointing at cwd.
    const home = mkdtempSync(join(tmpdir(), "fragua-home-"));
    workdirs.push(home);
    const cwd = makeStore();
    const prev = process.env["FRAGUA_HOME"];
    process.env["FRAGUA_HOME"] = home;
    try {
      expect(await dbCommand({ action: "vacuum", cwd })).toBe(1);
    } finally {
      if (prev === undefined) delete process.env["FRAGUA_HOME"];
      else process.env["FRAGUA_HOME"] = prev;
    }
  });

  test("migrate is a no-op on a store already at the current version", async () => {
    const cwd = makeStore();
    expect(await run({ action: "migrate", cwd })).toBe(0);
    expect(await run({ action: "migrate", cwd, dryRun: true })).toBe(0);
  });

  test("migrate refuses a store newer than the binary", async () => {
    const cwd = makeStore();
    // Hand-bump the pinned version past CURRENT to simulate a newer producer.
    const db = new Database(join(cwd, ".fragua/fragua.db"));
    db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(CURRENT_SCHEMA_VERSION + 1);
    db.close();
    expect(await run({ action: "migrate", cwd })).toBe(1);
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
    const cwd = makeStore(); // at CURRENT: schedules.title
    expect(schedulesCols(cwd)).toContain("title");

    expect(await run({ action: "migrate", cwd, to: "1" })).toBe(0);

    expect(schedulesCols(cwd)).toContain("input");
    expect(schedulesCols(cwd)).not.toContain("title");
    const backups = readdirSync(join(cwd, ".fragua/backups"));
    const prefix = `pre-migrate-v${CURRENT_SCHEMA_VERSION}-to-v1-`;
    expect(backups.some((f) => f.startsWith(prefix) && f.endsWith(".db"))).toBe(true);
  });

  test("migrate --to 1 --dry-run prints the plan and mutates nothing", async () => {
    const cwd = makeStore();
    expect(await run({ action: "migrate", cwd, to: "1", dryRun: true })).toBe(0);
    expect(schedulesCols(cwd)).toContain("title"); // untouched
    expect(existsSync(join(cwd, ".fragua/backups"))).toBe(false); // no backup on dry-run
  });

  test("migrate --no-backup skips the pre-migrate dump", async () => {
    const cwd = makeStore();
    expect(await run({ action: "migrate", cwd, to: "1", noBackup: true })).toBe(0);
    expect(schedulesCols(cwd)).toContain("input");
    expect(existsSync(join(cwd, ".fragua/backups"))).toBe(false);
  });

  test("migrate --to forward lands the rename again", async () => {
    const cwd = makeStore();
    expect(await run({ action: "migrate", cwd, to: "1", noBackup: true })).toBe(0);
    expect(await run({ action: "migrate", cwd, to: String(CURRENT_SCHEMA_VERSION), noBackup: true })).toBe(0);
    expect(schedulesCols(cwd)).toContain("title");
  });

  test("migrate refuses to race a live harness (fresh daemon_lock heartbeat)", async () => {
    const cwd = makeStore();
    const db = new Database(join(cwd, ".fragua/fragua.db"));
    // Future-stamp the heartbeat so the liveness gate (heartbeat within
    // DAEMON_LOCK_TTL_MS) fires regardless of scheduler jitter — a `Date.now()`
    // stamp could age past the TTL if the runner pauses before the gate.
    db.query("INSERT INTO daemon_lock (id, pid, hostname, started_at, heartbeat_at) VALUES (1, 999, 'h', ?, ?)").run(
      Date.now(),
      Date.now() + 60_000,
    );
    db.close();
    expect(await run({ action: "migrate", cwd, to: "1", noBackup: true })).toBe(1);
    expect(schedulesCols(cwd)).toContain("title"); // refused before mutating
  });

  test("migrate proceeds past a STALE daemon_lock heartbeat", async () => {
    const cwd = makeStore();
    const db = new Database(join(cwd, ".fragua/fragua.db"));
    db.query("INSERT INTO daemon_lock (id, pid, hostname, started_at, heartbeat_at) VALUES (1, 999, 'h', 0, 0)").run();
    db.close();
    expect(await run({ action: "migrate", cwd, to: "1", noBackup: true })).toBe(0);
    expect(schedulesCols(cwd)).toContain("input");
  });

  test("migrate --to below the floor is refused", async () => {
    const cwd = makeStore();
    pinVersion(cwd, CURRENT_SCHEMA_VERSION); // ensure known start
    expect(await run({ action: "migrate", cwd, to: "0", noBackup: true })).toBe(1);
  });

  test("migrate --to a non-integer is refused", async () => {
    const cwd = makeStore();
    expect(await run({ action: "migrate", cwd, to: "abc", noBackup: true })).toBe(1);
  });

  test("a failed migrate removes its pre-migrate backup", async () => {
    const cwd = makeStore(); // v2
    // Drop schedules so the v2→v1 down step's ALTER throws inside the walk,
    // AFTER the pre-migrate backup is written — exercising the cleanup path.
    const db = new Database(join(cwd, ".fragua/fragua.db"));
    db.exec("DROP TABLE schedules");
    db.close();
    expect(await run({ action: "migrate", cwd, to: "1" })).toBe(1);
    const backupsDir = join(cwd, ".fragua/backups");
    const orphans = existsSync(backupsDir) ? readdirSync(backupsDir).filter((f) => f.startsWith("pre-migrate-")) : [];
    expect(orphans).toEqual([]);
  });

  test("migrate --to a numeric-but-non-integer literal is refused", async () => {
    // `Number.isInteger` coerces all of these to whole numbers; the literal
    // guard must reject them so a typo doesn't silently retarget the migrate.
    const cwd = makeStore();
    for (const to of ["2.0", "0x2", "2e0", " 2 ", "1.5"]) {
      expect(await run({ action: "migrate", cwd, to, noBackup: true })).toBe(1);
    }
    expect(schedulesCols(cwd)).toContain("title"); // never mutated
  });
});
