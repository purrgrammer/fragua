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

/** Latest-iteration struct for each of `nodeIds` in ONE query (collapses the
 * per-node N+1 in `runDetail`). Returns rows only for nodes that emitted; a
 * node with no output is simply absent from the result. The correlated
 * subquery keeps the latest iteration per node without a `GROUP BY` over the
 * blob-bearing `struct` column. */
const GET_LATEST_OUTPUT_BATCH_SQL = `
  SELECT node_id AS nodeId, struct
  FROM outputs o
  WHERE run_id = ?1
    AND node_id IN (SELECT value FROM json_each(?2))
    AND iteration = (
      SELECT MAX(iteration) FROM outputs
      WHERE run_id = o.run_id AND node_id = o.node_id
    )
`;

export function getLatestOutputBatch(
  db: Database,
  runId: string,
  nodeIds: readonly string[],
): Array<{ nodeId: string; struct: string }> {
  if (nodeIds.length === 0) return [];
  return db
    .query<{ nodeId: string; struct: string }, [string, string]>(GET_LATEST_OUTPUT_BATCH_SQL)
    .all(runId, JSON.stringify(nodeIds));
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
