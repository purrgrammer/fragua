import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../src/migrations.ts";
import { insertRunState, markRunImported, selectRunSummaryRows } from "../src/run-state-queries.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.query(
    "INSERT INTO workflows (sha, name, source, ir, ir_version, created_at) VALUES ('wf', 't', 's', '{}', 1, 0)",
  ).run();
  return db;
}

function seedRun(db: Database, runId: string, status = "completed", cwd: string | null = "/repos/proj"): void {
  insertRunState(db, {
    runId,
    workflowSha: "wf",
    contractVersion: 1,
    routing: "{}",
    metrics: "{}",
    priority: 0,
    enqueuedAt: Date.now(),
    readyAt: Date.now(),
    updatedAt: Date.now(),
    cwd,
    projectId: "p1",
    projectName: "proj",
    workflowName: "wf",
    workflowScope: "local",
    workflowPath: null,
    scheduleId: null,
  });
  db.query(`UPDATE run_state SET status='${status}' WHERE run_id=?`).run(runId);
}

describe("selectRunSummaryRows — imported flag", () => {
  test("returns imported=0 for a normal run and imported=1 for a marked run", () => {
    const db = freshDb();
    seedRun(db, "normal");
    seedRun(db, "foreign", "completed", null);
    markRunImported(db, "foreign", Date.now());

    const rows = selectRunSummaryRows(db);
    const byId = Object.fromEntries(rows.map((r) => [r.runId, r]));

    expect(byId["normal"]?.imported).toBe(0);
    expect(byId["foreign"]?.imported).toBe(1);
  });

  test("excludeImported:true filters out marked runs", () => {
    const db = freshDb();
    seedRun(db, "normal");
    seedRun(db, "foreign", "completed", null);
    markRunImported(db, "foreign", Date.now());

    const rows = selectRunSummaryRows(db, { excludeImported: true });

    expect(rows.map((r) => r.runId)).toEqual(["normal"]);
  });

  test("excludeImported combines with status filter", () => {
    const db = freshDb();
    seedRun(db, "paused-normal", "paused");
    seedRun(db, "paused-imported", "paused", null);
    markRunImported(db, "paused-imported", Date.now());

    const rows = selectRunSummaryRows(db, { statuses: ["paused"], excludeImported: true });

    expect(rows.map((r) => r.runId)).toEqual(["paused-normal"]);
  });

  test("excludeImported:true with inbox:pending excludes marked run even when it has a non-null cwd", () => {
    const db = freshDb();
    seedRun(db, "local-pending", "completed", "/repos/local");
    db.query("UPDATE run_state SET inbox_status='pending' WHERE run_id='local-pending'").run();

    seedRun(db, "imported-pending", "completed", "/repos/imported");
    db.query("UPDATE run_state SET inbox_status='pending' WHERE run_id='imported-pending'").run();
    markRunImported(db, "imported-pending", Date.now());

    const rows = selectRunSummaryRows(db, { inbox: "pending", excludeImported: true });

    expect(rows.map((r) => r.runId)).toEqual(["local-pending"]);
  });
});
