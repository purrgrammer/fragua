// SQL + typed helpers for the `artifacts` and `blobs` tables, plus the
// `node_completed`-projection scan that powers the executor's
// `getNodeOutputs` substitution map.
//
// Artifacts are content-addressed via `blobs.sha256`. The actual bytes
// live on disk under `BlobFS`; the DB stores only the metadata + ref.

import type { Database } from "bun:sqlite";

// ─────────────────────────────────────────────────────────────────────
// Artifact row reads + writes
// ─────────────────────────────────────────────────────────────────────

const INSERT_BLOB_SQL = `
  INSERT OR IGNORE INTO blobs (sha256, size_bytes, created_at)
  VALUES (?, ?, ?)
`;

export function insertBlobIfAbsent(db: Database, sha256: string, sizeBytes: number, now: number): void {
  db.query(INSERT_BLOB_SQL).run(sha256, sizeBytes, now);
}

const UPSERT_ARTIFACT_SQL = `
  INSERT INTO artifacts
    (run_id, node_id, iteration, key, blob_sha, mime, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id, node_id, iteration, key) DO UPDATE SET
    blob_sha   = excluded.blob_sha,
    mime       = excluded.mime,
    created_at = excluded.created_at
`;

export function upsertArtifact(
  db: Database,
  args: {
    runId: string;
    nodeId: string;
    iteration: number;
    key: string;
    blobSha: string;
    mime: string | null;
    now: number;
  },
): void {
  db.query(UPSERT_ARTIFACT_SQL).run(
    args.runId,
    args.nodeId,
    args.iteration,
    args.key,
    args.blobSha,
    args.mime,
    args.now,
  );
}

interface ArtifactRefRow {
  blob_sha: string;
  mime: string | null;
  size_bytes: number;
}

const SELECT_ARTIFACT_REF_SQL = `
  SELECT a.blob_sha, a.mime, b.size_bytes
    FROM artifacts a
    JOIN blobs b ON b.sha256 = a.blob_sha
   WHERE a.run_id = ? AND a.node_id = ? AND a.iteration = ? AND a.key = ?
`;

export function selectArtifactRef(
  db: Database,
  scope: { runId: string; nodeId: string; iteration: number; key: string },
): ArtifactRefRow | null {
  return (
    db
      .query<ArtifactRefRow, [string, string, number, string]>(SELECT_ARTIFACT_REF_SQL)
      .get(scope.runId, scope.nodeId, scope.iteration, scope.key) ?? null
  );
}

// ─────────────────────────────────────────────────────────────────────
// node_completed → artifact projection (executor's nodeOutputs map)
// ─────────────────────────────────────────────────────────────────────
//
// Filtering at the SQL layer matters: `fact.node_completed` is a small
// fraction of the events table on a real run (the bulk is
// `llm.text_delta`), and we re-fold this on every dispatch. A static-SQL
// filter on `type = 'fact.node_completed'` keeps the read O(completed
// nodes) instead of O(total events).

/** One captured node output ref (latest iteration per node, success or fail —
 *  the executor's fold prefers the most recent entry). */
export interface NodeOutputRefRow {
  nodeId: string;
  iteration: number;
  outcomeStatus: string | null;
  outputRefKey: string;
  seq: number;
}

const SELECT_NODE_OUTPUT_REFS_SQL = `
  SELECT
    json_extract(payload, '$.nodeId')        AS nodeId,
    CAST(COALESCE(json_extract(payload, '$.iteration'), 0) AS INTEGER) AS iteration,
    json_extract(payload, '$.outcomeStatus') AS outcomeStatus,
    json_extract(payload, '$.outputRef')     AS outputRefKey,
    seq                                      AS seq
  FROM events
  WHERE run_id = ?1
    AND type = 'fact.node_completed'
    AND json_extract(payload, '$.outputRef') IS NOT NULL
  ORDER BY seq ASC
`;

/** All node output refs for a run, ordered oldest-first. Caller is
 *  responsible for keeping latest-per-node and dereferencing artifacts. */
export function selectNodeOutputRefs(db: Database, runId: string): NodeOutputRefRow[] {
  return db.query<NodeOutputRefRow, [string]>(SELECT_NODE_OUTPUT_REFS_SQL).all(runId);
}

// ─────────────────────────────────────────────────────────────────────
// Blob garbage collection
// ─────────────────────────────────────────────────────────────────────

const DELETE_ORPHAN_BLOBS_SQL = `
  WITH orphans AS (
    SELECT b.sha256
      FROM blobs b
      LEFT JOIN artifacts a ON a.blob_sha = b.sha256
     WHERE a.blob_sha IS NULL
     LIMIT ?
  )
  DELETE FROM blobs
   WHERE sha256 IN (SELECT sha256 FROM orphans)
  RETURNING sha256
`;

/** Delete up to `limit` orphan blob rows (no artifact referent) and
 *  return their sha256s so the file-side delete pass can drop the
 *  on-disk content. RETURNING ensures row-without-file is impossible
 *  mid-sweep. */
export function deleteOrphanBlobs(db: Database, limit: number): string[] {
  return db
    .query<{ sha256: string }, [number]>(DELETE_ORPHAN_BLOBS_SQL)
    .all(limit)
    .map((r) => r.sha256);
}

const SELECT_BLOB_BY_SHA_SQL = `SELECT sha256 FROM blobs WHERE sha256 = ?`;

export function blobRowExists(db: Database, sha256: string): boolean {
  return db.query<{ sha256: string }, [string]>(SELECT_BLOB_BY_SHA_SQL).get(sha256) != null;
}
