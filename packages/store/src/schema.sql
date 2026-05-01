-- swarm event store schema — Revision 1
-- All tables STRICT. Run-scoped tables cascade on run deletion.
-- `blobs` is a rowid table so BLOB overflow pages handle large values efficiently.

CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workflows (
  sha TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dot_source TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- run_state is projection + queue + per-run seq counter.
-- `total_cost_usd` and `billed_tokens` are generated columns extracted from
-- the metrics JSON. They let the web UI aggregate without parsing blobs.
-- `billed_tokens` is the all-buckets sum (input+output+cacheRead+cacheWrite),
-- exposed as `billed_tokens` on `/metrics/global`. Fresh tokens
-- (input+output) are computed on demand from `$.totalInputTokens` +
-- `$.totalOutputTokens`; `budget_tokens` fences against fresh.
CREATE TABLE IF NOT EXISTS run_state (
  run_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued','running','paused_hitl','paused_provider_error','paused_retry',
    'completed','cancelled','halted','quarantined'
  )),
  current_node TEXT,
  workflow_sha TEXT NOT NULL REFERENCES workflows(sha),
  schema_version INTEGER NOT NULL,
  routing TEXT NOT NULL CHECK (length(routing) < 8192),
  metrics TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,
  last_applied_seq INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL,
  ready_at INTEGER NOT NULL,
  node_started_at INTEGER,
  dispatch_started_at INTEGER,
  updated_at INTEGER NOT NULL,
  title TEXT,
  -- UUIDv7 from `<project>/.swarm/config.jsonc` `id`. NULL for ephemeral
  -- runs (no project file). Indexed for `WHERE project_id = ?` listings
  -- and cross-project aggregation under the global daemon.
  project_id TEXT,
  -- Git SHA of the worktree's HEAD at provision time. Replay reconstructs
  -- the run's starting tree from this sha + the workflow's dot_source,
  -- independent of the worktree directory or `branch` survival. NULL for
  -- runs without a provisioner (LocalEnvironment, ephemeral stubs).
  base_git_sha TEXT,
  -- Branch name preserved by `dispose()` when the worktree had any working-
  -- copy delta (tracked + untracked) at terminal time. Convention:
  -- `swarm/runs/<run_id>`. NULL for clean runs (no work to commit) and for
  -- runs without a worktree.
  branch TEXT,
  total_cost_usd REAL GENERATED ALWAYS AS
    (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
  billed_tokens INTEGER GENERATED ALWAYS AS
    (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
) STRICT;

CREATE INDEX IF NOT EXISTS idx_run_state_queue
  ON run_state(priority DESC, ready_at ASC)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_run_state_status ON run_state(status);
CREATE INDEX IF NOT EXISTS idx_run_state_workflow ON run_state(workflow_sha);
CREATE INDEX IF NOT EXISTS idx_run_state_updated ON run_state(updated_at);
CREATE INDEX IF NOT EXISTS idx_run_state_project ON run_state(project_id);

-- Display cache for project ids. Source of truth is each project's
-- `<root>/.swarm/config.jsonc` `name`; this table is a denormalized
-- copy so the UI can label runs without filesystem access (the daemon
-- may not have it under the eventual harness model). Refreshed on
-- every `POST /runs`: last-runner wins, so an active project is always
-- current. Rows persist after the project's directory is gone so
-- historical run listings keep their labels.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  writer TEXT NOT NULL CHECK (writer IN ('daemon','web')),
  payload TEXT NOT NULL CHECK (length(payload) < 4096),
  ts INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, run_id, seq);
-- Cross-run, time-ordered scans for the global Home feed. Cursor is the
-- (ts, run_id, seq) tuple — per-run `seq` can't carry a global ordering
-- on its own. With this index, `WHERE (ts, run_id, seq) > (?, ?, ?)
-- ORDER BY ts, run_id, seq` walks the index without a sort step.
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts, run_id, seq);

-- messages.content stores a pi-agent-core `AgentMessage` as JSON — the
-- same shape pi-ai hands us at message_end and hands back as
-- `priorMessages`. Round-trips through JSON.parse/stringify losslessly.
-- `json_valid` catches writers that forget to stringify; `role` is
-- extracted from the message JSON into a real column so UI filters and
-- debug queries don't pay `json_extract` on hot paths.
-- `length(content)` is bytes for BLOB and characters for TEXT; here content is
-- TEXT, so the cap is in characters. 1 MiB of characters is far beyond any
-- legitimate LLM turn — anything over that must spill to artifacts via
-- `ctx.artifacts.put` (which is content-addressed and doesn't ride the WAL
-- for every write).
CREATE TABLE IF NOT EXISTS messages (
  run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content) AND length(content) < 1048576),
  role TEXT GENERATED ALWAYS AS (json_extract(content, '$.role')) STORED,
  node_id TEXT,
  iteration INTEGER NOT NULL DEFAULT 0,
  -- sha256 of the serialised content. Backs the opt-in replay dedup
  -- path — `appendMessage(runId, row, { dedup: true })` looks up an
  -- existing row by `(run, node, iteration, content_hash)` and returns
  -- its ordinal instead of minting a new row. Default is OFF: agent
  -- transcripts carry per-call timestamps that legitimately differ
  -- across attempts, so caller-asserted dedup is the right contract.
  content_hash TEXT,
  PRIMARY KEY (run_id, ordinal)
) STRICT, WITHOUT ROWID;

-- Blob metadata only — the bytes live on the filesystem under the store's
-- `blobsDir`, keyed by sha256. Keeping raw content out of SQLite keeps the
-- WAL small under large-artifact workloads; the `blobs` row + content file
-- are committed in that order so crashes leak orphan files (GC sweeps),
-- never dangling row pointers.
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS artifacts (
  run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha256),
  mime TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id, iteration, key)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_artifacts_blob ON artifacts(blob_sha);

CREATE TABLE IF NOT EXISTS daemon_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
) STRICT;

-- Daemon-level audit log for process lifecycle, sweep activity,
-- reaper takeovers, GC, leak detection, and worktree provisioning.
-- Separate from the per-run `events` table because some entries are
-- global (no run scope). Read paths: getDaemonEvents (latest N) and
-- a future "infrastructure" UI surface; the per-run feed is unaffected.
CREATE TABLE IF NOT EXISTS daemon_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (length(payload) < 4096),
  ts INTEGER NOT NULL,
  -- Optional reference for run-scoped events (leak_detected,
  -- worktree_provisioned). Global events leave it NULL. ON DELETE
  -- SET NULL keeps the audit trail intact when runs are GC'd.
  run_id TEXT REFERENCES run_state(run_id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_daemon_events_ts ON daemon_events(ts, seq);
CREATE INDEX IF NOT EXISTS idx_daemon_events_type ON daemon_events(type, ts);
CREATE INDEX IF NOT EXISTS idx_daemon_events_run ON daemon_events(run_id, seq) WHERE run_id IS NOT NULL;
