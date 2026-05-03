#!/usr/bin/env bun
// One-off: lift this repo's pre-harness DB into ~/.swarm/swarm.db.
//
// Source:  <repo>/.swarm/swarm.db (v1+ schema, has projects table)
// Target:  ~/.swarm/swarm.db        (v4 schema, no projects table)
//
// Copies workflows, run_state (with cwd backfilled from
// source.projects.project_root), events, messages, blobs, artifacts,
// run-scoped daemon_events. Skips daemon_lock + global daemon_events
// + the projects table itself.
//
// Blob files are hardlinked when the source + target dirs share a
// volume (cheap), copied otherwise.
//
// Source DB renames to swarm.db.pre-harness.<YYYY-MM-DD> as a backup.
//
// Idempotent: refuses to run if any source runId already exists in the
// target. Re-running on a dataset already migrated bails on the first
// collision.

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SOURCE_DB = resolve("/Users/bandarra/swarm/.swarm/swarm.db");
const TARGET_DB = resolve(homedir(), ".swarm/swarm.db");
const SOURCE_BLOBS = resolve(dirname(SOURCE_DB), "blobs");
const TARGET_BLOBS = resolve(dirname(TARGET_DB), "blobs");

if (!existsSync(SOURCE_DB)) {
  console.error(`source DB missing: ${SOURCE_DB}`);
  process.exit(1);
}
if (!existsSync(TARGET_DB)) {
  console.error(`target DB missing: ${TARGET_DB}`);
  console.error("  run `swarm harness` once to bootstrap the target schema, then retry.");
  process.exit(1);
}

console.log(`source: ${SOURCE_DB}`);
console.log(`target: ${TARGET_DB}`);

const src = new Database(SOURCE_DB, { readonly: true });
const dst = new Database(TARGET_DB);

const srcVer = src.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id=1").get()?.version;
const dstVer = dst.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id=1").get()?.version;
console.log(`source schema v${srcVer}; target schema v${dstVer}`);

if (dstVer !== 4) {
  console.error(`target must be at schema v4 (got v${dstVer}). open it with current code first.`);
  process.exit(1);
}

// Refuse if a live daemon is using the target.
const lock = dst.query<{ pid: number; heartbeat_at: number }, []>("SELECT pid, heartbeat_at FROM daemon_lock").get();
if (lock != null) {
  const ageMs = Date.now() - lock.heartbeat_at;
  if (ageMs < 30_000) {
    console.error(`target has an active daemon (pid=${lock.pid}, ${Math.round(ageMs / 1000)}s ago).`);
    console.error("  stop it before migrating: `kill", lock.pid, "` or shut the harness down.");
    process.exit(1);
  }
  console.log(`(stale daemon_lock present, pid=${lock.pid}, ${Math.round(ageMs / 1000)}s ago — proceeding)`);
}

dst.exec(`ATTACH DATABASE '${SOURCE_DB}' AS src`);

// Collision check — refuse if any source runId already exists in target.
const collisions = dst
  .query<{ run_id: string }, []>(`SELECT run_id FROM run_state WHERE run_id IN (SELECT run_id FROM src.run_state)`)
  .all();
if (collisions.length > 0) {
  console.error(`refusing to migrate — ${collisions.length} runId collision(s) in target:`);
  for (const c of collisions.slice(0, 5)) console.error(`  ${c.run_id}`);
  if (collisions.length > 5) console.error(`  … and ${collisions.length - 5} more`);
  process.exit(1);
}

const srcRuns = src.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_state").get()?.n ?? 0;
const srcEvents = src.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
const srcMessages = src.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages").get()?.n ?? 0;
const srcBlobs = src.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM blobs").get()?.n ?? 0;
const srcArtifacts = src.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM artifacts").get()?.n ?? 0;
console.log(
  `to copy: ${srcRuns} runs, ${srcEvents} events, ${srcMessages} messages, ${srcBlobs} blobs, ${srcArtifacts} artifacts`,
);

dst.exec("BEGIN");
try {
  // Workflows. INSERT OR IGNORE so re-uploads of identical sha don't fail.
  dst.exec(`
    INSERT OR IGNORE INTO workflows (sha, name, dot_source, created_at)
    SELECT sha, name, dot_source, created_at FROM src.workflows
  `);

  // Blobs metadata. Same.
  dst.exec(`
    INSERT OR IGNORE INTO blobs (sha256, size_bytes, created_at)
    SELECT sha256, size_bytes, created_at FROM src.blobs
  `);

  // run_state — backfill cwd from source's projects.root_path; drop project_id.
  // Source's status set may include `paused_provider_error` (v1) which v3+
  // collapses into `paused`. Translate inline so the v4 CHECK accepts it.
  dst.exec(`
    INSERT INTO run_state (
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      cwd, workflow_name, workflow_scope, workflow_path,
      base_git_sha, branch
    )
    SELECT
      r.run_id, r.version,
      CASE WHEN r.status = 'paused_provider_error' THEN 'paused' ELSE r.status END,
      r.current_node, r.workflow_sha, r.schema_version,
      r.routing, r.metrics, r.next_seq, r.last_applied_seq, r.priority, r.enqueued_at,
      r.ready_at, r.node_started_at, r.dispatch_started_at, r.updated_at, r.title,
      p.root_path, NULL, NULL, NULL,
      r.base_git_sha, r.branch
    FROM src.run_state r
    LEFT JOIN src.projects p ON p.id = r.project_id
  `);

  // Events. PK is (run_id, seq); foreign key to run_state above.
  dst.exec(`
    INSERT INTO events (run_id, seq, type, writer, payload, ts)
    SELECT run_id, seq,
           CASE WHEN type = 'fact.run_paused_provider_error' THEN 'fact.run_paused' ELSE type END,
           writer, payload, ts
    FROM src.events
  `);

  // Messages — content is AgentMessage JSON; ride the table CHECK as-is.
  dst.exec(`
    INSERT INTO messages (run_id, ordinal, content, node_id, iteration, content_hash)
    SELECT run_id, ordinal, content, node_id, iteration, content_hash
    FROM src.messages
  `);

  // Artifacts — referenced blobs already inserted above.
  dst.exec(`
    INSERT INTO artifacts (run_id, node_id, iteration, key, blob_sha, mime, created_at)
    SELECT run_id, node_id, iteration, key, blob_sha, mime, created_at
    FROM src.artifacts
  `);

  // Daemon events — run-scoped only. Global lifecycle events from the
  // source daemon belong to a different process; not useful in the
  // target audit trail.
  dst.exec(`
    INSERT INTO daemon_events (type, payload, ts, run_id)
    SELECT type, payload, ts, run_id FROM src.daemon_events WHERE run_id IS NOT NULL
  `);

  dst.exec("COMMIT");
} catch (err) {
  dst.exec("ROLLBACK");
  throw err;
}

dst.exec("DETACH DATABASE src");

// Hardlink blob files. Same volume → linkSync (~free). Cross-volume → copy.
mkdirSync(TARGET_BLOBS, { recursive: true });
let linked = 0;
let copied = 0;
let already = 0;

if (existsSync(SOURCE_BLOBS)) {
  for (const shard of readdirSync(SOURCE_BLOBS)) {
    const srcShard = join(SOURCE_BLOBS, shard);
    if (!statSync(srcShard).isDirectory()) continue;
    const dstShard = join(TARGET_BLOBS, shard);
    mkdirSync(dstShard, { recursive: true });
    for (const file of readdirSync(srcShard)) {
      const srcFile = join(srcShard, file);
      const dstFile = join(dstShard, file);
      if (existsSync(dstFile)) {
        already++;
        continue;
      }
      try {
        linkSync(srcFile, dstFile);
        linked++;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EXDEV") {
          copyFileSync(srcFile, dstFile);
          copied++;
        } else {
          throw err;
        }
      }
    }
  }
}

console.log(`blobs: ${linked} hardlinked, ${copied} copied, ${already} already present`);

src.close();
dst.close();

// Rename source DB + WAL/SHM as backup.
const today = new Date().toISOString().slice(0, 10);
const backupBase = `${SOURCE_DB}.pre-harness.${today}`;
console.log(`renaming source → ${backupBase}`);
renameSync(SOURCE_DB, backupBase);
for (const suffix of ["-wal", "-shm"]) {
  const p = SOURCE_DB + suffix;
  if (existsSync(p)) renameSync(p, backupBase + suffix);
}

// Final tallies for confirmation.
const verify = new Database(TARGET_DB, { readonly: true });
const totals = verify
  .query<{ runs: number; events: number; messages: number; blobs: number; artifacts: number }, []>(`
  SELECT
    (SELECT COUNT(*) FROM run_state) AS runs,
    (SELECT COUNT(*) FROM events)    AS events,
    (SELECT COUNT(*) FROM messages)  AS messages,
    (SELECT COUNT(*) FROM blobs)     AS blobs,
    (SELECT COUNT(*) FROM artifacts) AS artifacts
`)
  .get();
verify.close();

console.log(`target totals after migration: ${JSON.stringify(totals)}`);
console.log("done.");
