// SQL + typed helpers for the `artifacts` and `blobs` tables.
//
// Artifacts are content-addressed via `blobs.sha256`. The actual bytes
// live on disk under `BlobFS`; the DB stores only the metadata + ref.

import type { Database } from "bun:sqlite";
import type { ArtifactListRow } from "./types.ts";

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

interface ArtifactListSqlRow {
  node_id: string;
  iteration: number;
  key: string;
  mime: string | null;
  blob_sha: string;
  size_bytes: number;
  created_at: number;
}

const SELECT_ARTIFACTS_FOR_RUN_SQL = `
  SELECT a.node_id, a.iteration, a.key, a.mime, a.blob_sha, b.size_bytes, a.created_at
    FROM artifacts a
    JOIN blobs b ON b.sha256 = a.blob_sha
   WHERE a.run_id = ?
   ORDER BY a.created_at
`;

/** Every artifact a run produced, oldest-first. Metadata only — the bytes
 *  come from `getArtifact(scope)`. */
export function selectArtifactsForRun(db: Database, runId: string): ArtifactListRow[] {
  return db
    .query<ArtifactListSqlRow, [string]>(SELECT_ARTIFACTS_FOR_RUN_SQL)
    .all(runId)
    .map((r) => ({
      nodeId: r.node_id,
      iteration: r.iteration,
      key: r.key,
      mime: r.mime,
      blobSha: r.blob_sha,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
    }));
}

// ─────────────────────────────────────────────────────────────────────
// Blob garbage collection
// ─────────────────────────────────────────────────────────────────────

const DELETE_ORPHAN_BLOBS_SQL = `
  WITH protected AS (
    SELECT value AS sha256 FROM json_each(?)
  ),
  orphans AS (
    SELECT b.sha256
      FROM blobs b
      LEFT JOIN artifacts a ON a.blob_sha = b.sha256
     WHERE a.blob_sha IS NULL
       AND b.sha256 NOT IN (SELECT sha256 FROM protected)
     LIMIT ?
  )
  DELETE FROM blobs
   WHERE sha256 IN (SELECT sha256 FROM orphans)
  RETURNING sha256
`;

/** Delete up to `limit` orphan blob rows (no artifact referent AND not a
 *  routing-referenced blob root) and return their sha256s so the file-side
 *  delete pass can drop the on-disk content. RETURNING ensures row-without-file
 *  is impossible mid-sweep.
 *
 *  `protectedShasJson` is a JSON array string of sha256 hex strings that must
 *  not be collected — routing-spilled input blobs live here. Pass `"[]"` when
 *  no routing roots are known. */
export function deleteOrphanBlobs(db: Database, limit: number, protectedShasJson: string): string[] {
  return db
    .query<{ sha256: string }, [string, number]>(DELETE_ORPHAN_BLOBS_SQL)
    .all(protectedShasJson, limit)
    .map((r) => r.sha256);
}

const SELECT_BLOB_BY_SHA_SQL = `SELECT sha256 FROM blobs WHERE sha256 = ?`;

export function blobRowExists(db: Database, sha256: string): boolean {
  return db.query<{ sha256: string }, [string]>(SELECT_BLOB_BY_SHA_SQL).get(sha256) != null;
}
