import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { insertEventWeb } from "../src/event-queries.ts";
import { migrate } from "../src/migrations.ts";
import { insertRunState, selectInboxActionCandidates, selectRunSummaryRows } from "../src/run-state-queries.ts";

// A run is in the inbox only if it can be landed *here* — accept/discard both
// gate on a non-null `cwd` (`checkGate` → `no_worktree`). Imported runs are
// inert (`cwd` null) yet re-derive `inbox_status='pending'` from their folded
// log, so the inbox queries must drop them or they'd show READY TO LAND while
// refusing both verbs. Same `cwd IS NOT NULL` predicate, both inbox queries.

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.query(
    "INSERT INTO workflows (sha, name, source, ir, ir_version, created_at) VALUES ('wf', 't', 's', '{}', 1, 0)",
  ).run();
  return db;
}

function seedTerminalInboxRun(db: Database, runId: string, cwd: string | null): void {
  insertRunState(db, {
    runId,
    workflowSha: "wf",
    contractVersion: 1,
    routing: "{}",
    metrics: "{}",
    priority: 0,
    enqueuedAt: 1,
    readyAt: 1,
    updatedAt: 1,
    cwd,
    projectId: "p",
    projectName: "p",
    workflowName: "wf",
    workflowScope: "local",
    workflowPath: null,
    scheduleId: null,
  });
  db.query("UPDATE run_state SET status='completed', inbox_status='pending' WHERE run_id=?").run(runId);
}

describe("inbox queries — landable-here gate (cwd IS NOT NULL)", () => {
  test("selectRunSummaryRows({inbox:'pending'}) excludes bare-cwd (imported) runs", () => {
    const db = freshDb();
    seedTerminalInboxRun(db, "local", "/repos/alpha");
    seedTerminalInboxRun(db, "imported", null);

    const rows = selectRunSummaryRows(db, { inbox: "pending" });

    expect(rows.map((r) => r.runId)).toEqual(["local"]);
  });

  test("selectInboxActionCandidates excludes bare-cwd runs even with an unapplied accept intent", () => {
    const db = freshDb();
    seedTerminalInboxRun(db, "local", "/repos/alpha");
    seedTerminalInboxRun(db, "imported", null);
    // last_applied_seq is 0; an intent at seq 1 is unapplied for both runs.
    insertEventWeb(db, "local", 1, "intent.accept_run", "{}", 2);
    insertEventWeb(db, "imported", 1, "intent.discard_run", "{}", 2);

    const candidates = selectInboxActionCandidates(db);

    expect(candidates.map((c) => c.runId)).toEqual(["local"]);
  });
});
