// SQL + typed helpers for the `workflows` catalog. Refreshed on every
// successful workflow upload; queried by enqueueRun for existence checks
// and by the web UI for naming.

import type { Database } from "bun:sqlite";

const SELECT_WORKFLOW_SHA_SQL = `SELECT sha FROM workflows WHERE sha = ?`;

/** Cheap existence check used by `enqueueRun` to validate the workflow
 *  pointer before inserting a run row. */
export function workflowExists(db: Database, sha: string): boolean {
  return db.query<{ sha: string }, [string]>(SELECT_WORKFLOW_SHA_SQL).get(sha) != null;
}

interface WorkflowFullRow {
  sha: string;
  name: string;
  source: string;
  /** Persisted canonical IR (loc-stripped Graph JSON), or NULL for rows
   *  written without it (test seeds; the loader falls back to parsing
   *  `source`). */
  ir: string | null;
  ir_version: number | null;
  created_at: number;
}

const SELECT_WORKFLOW_SQL = `
  SELECT sha, name, source, ir, ir_version, created_at FROM workflows WHERE sha = ?
`;

export function selectWorkflow(db: Database, sha: string): WorkflowFullRow | null {
  return db.query<WorkflowFullRow, [string]>(SELECT_WORKFLOW_SQL).get(sha) ?? null;
}

const INSERT_WORKFLOW_SQL = `
  INSERT INTO workflows (sha, name, source, ir, ir_version, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(sha) DO NOTHING
`;

export function insertWorkflowIfAbsent(
  db: Database,
  sha: string,
  name: string,
  source: string,
  ir: string | null,
  irVersion: number | null,
  now: number,
): void {
  db.query(INSERT_WORKFLOW_SQL).run(sha, name, source, ir, irVersion, now);
}
