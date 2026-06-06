// Outputs index — rebuildable projection of structured step outputs.
// Keyed (run_id, node_id, iteration) → struct JSON.
// Written in the same transaction as fact.node_completed (no await/JSON.stringify
// inside the txn — the caller pre-serialises the payload).
// See docs/proposals/structured-outputs.md §3 "Consumption and size".

import type { Database } from "bun:sqlite";

export interface OutputRow {
  nodeId: string;
  iteration: number;
  struct: string;
}

const INSERT_OUTPUTS_SQL = `
  INSERT OR REPLACE INTO outputs (run_id, node_id, iteration, struct)
  VALUES (?1, ?2, ?3, ?4)
`;

/** Insert or replace an outputs row. `structJson` must be pre-serialised
 * (no JSON.stringify inside the txn — invariant I1). */
export function insertOutput(db: Database, runId: string, nodeId: string, iteration: number, structJson: string): void {
  db.query(INSERT_OUTPUTS_SQL).run(runId, nodeId, iteration, structJson);
}

const GET_OUTPUTS_FOR_RUN_SQL = `
  SELECT node_id AS nodeId, iteration, struct
  FROM outputs
  WHERE run_id = ?1
  ORDER BY node_id ASC, iteration ASC
`;

/** All outputs for a run, ordered by (node_id, iteration). */
export function getOutputsForRun(db: Database, runId: string): OutputRow[] {
  return db.query<OutputRow, [string]>(GET_OUTPUTS_FOR_RUN_SQL).all(runId);
}

const GET_LATEST_OUTPUT_SQL = `
  SELECT struct
  FROM outputs
  WHERE run_id = ?1 AND node_id = ?2
  ORDER BY iteration DESC
  LIMIT 1
`;

/** Latest-iteration struct for a node, or null when not present. */
export function getLatestOutput(db: Database, runId: string, nodeId: string): string | null {
  const row = db.query<{ struct: string }, [string, string]>(GET_LATEST_OUTPUT_SQL).get(runId, nodeId);
  return row?.struct ?? null;
}

const ALL_OUTPUT_STRUCTS_SQL = `SELECT struct FROM outputs`;

/** Every stored output struct across all runs — used by blob GC to protect
 * spilled-output blob refs (a struct may itself be a `{$fragua_blob}` ref). */
export function getAllOutputStructs(db: Database): string[] {
  return db
    .query<{ struct: string }, []>(ALL_OUTPUT_STRUCTS_SQL)
    .all()
    .map((r) => r.struct);
}

const DELETE_OUTPUTS_FOR_RUN_SQL = `DELETE FROM outputs WHERE run_id = ?1`;

/** Remove all output rows for a run (used by the bundle rebuild path). */
export function deleteOutputsForRun(db: Database, runId: string): void {
  db.query(DELETE_OUTPUTS_FOR_RUN_SQL).run(runId);
}
