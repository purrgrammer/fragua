-- swarm event store schema — Revision 10
-- All tables STRICT. Run-scoped tables cascade on run deletion.
-- `blobs` is a rowid table so BLOB overflow pages handle large values efficiently.
-- This file is the canonical shape every new DB starts at; the migration
-- map in `migrations.ts` walks older DBs forward to the same shape.
-- v1 → v2: pause unification. `paused_provider_error` collapses into the
-- generic `paused` status; reason lives on `fact.run_paused.payload.reason`.
-- v2 → v3: harness-by-default. `run_state.project_id` and the `projects`
-- table are gone — `cwd` is the only project identifier. `daemon_lock`
-- gains URL columns so CLIs discover the harness via the DB. `run_state`
-- gains `workflow_name` / `_scope` / `_path` so resolution metadata
-- survives the daemon contract.
-- v3 → v4: `workflow_scope` enum widens to include 'local' so bare-name
-- resolution can fall back to <cwd>/.swarm/workflows/<name>.dot when
-- the global directory misses.
-- v4 → v5: conversation runs as a kind (since abandoned, see v7).
-- v5 → v6: scheduled runs (docs/proposals/scheduled-runs.md). New
-- `schedules` table holds the recurring (workflow_ref, cwd, interval)
-- triples; `run_state.schedule_id` carries lineage from each fired run
-- back to the schedule that produced it. Schedule deletion is hard
-- DELETE while runs persist — `run_state.schedule_id` is informational,
-- not a foreign-key cascade target.
-- v6 → v7: drop the v5 conversation scaffolding. Sub-agents are a tool
-- implementation that runs inline against the parent's stream, not a
-- separate run kind, so `kind` and the parent-linkage columns
-- (`parent_run_id` / `parent_node_id` / `parent_iteration`) are
-- removed and `workflow_sha` returns to `NOT NULL`. See
-- docs/proposals/agent-tool.md for the in-tool design.
-- v7 → v8: pause unification — auto-wake family.
-- `paused_provider_retry` and `paused_retry` collapse into one
-- `paused_auto` status. `fact.run_paused_retry` retires; handler
-- retries fold into `fact.run_paused{reason:"handler_retry"}`.
-- Provider auto-retry promotes to its own reason `provider_retry`
-- (was: `provider_error` + `policy:"auto-retry"`). Migration deletes
-- in-flight runs in the legacy auto-wake states (pre-release, no
-- prior-state compat — AGENTS.md ground rule #11). See
-- docs/proposals/recoverable-budget-pause.md Stage 2.
-- v8 → v9: parallel sub-runs (P1.1 of docs/proposals/parallel.md).
-- `run_state` gains the additive linkage columns `parent_run_id`,
-- `parent_node_id`, `parallel_index`, `subgraph_root_node_id`,
-- `subgraph_terminal_node_id`. All NULLable; top-level runs keep them
-- NULL. `idx_run_state_parent` covers `parent_run_id` lookups (cancel
-- propagation, cost rollup, sweep). `parent_run_id` is FK to
-- `run_state(run_id)` with ON DELETE SET NULL so a parent GC leaves the
-- sub-run as a free-standing row whose own GC is independent.
-- v9 → v10: `running_children` status (P1.2 of docs/proposals/parallel.md).
-- Adds `running_children` to `run_state.status` CHECK. Parent runs that
-- fanned out into sub-runs sit in this status until every sub-run
-- reaches a terminal-or-paused-class state; the wake-pending sweep
-- transitions the parent back to `queued` (collect phase).

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
    'queued','running','running_children','paused','paused_hitl','paused_auto',
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
  -- Absolute project root the run was enqueued from. Only project
  -- identifier in the harness-by-default model. NULL for runs without
  -- a filesystem context (CI, integration tests).
  cwd TEXT,
  -- Resolved workflow name when bare-name resolution succeeded; NULL
  -- when the caller passed a path.
  workflow_name TEXT,
  workflow_scope TEXT CHECK (workflow_scope IN ('global','local','path','ephemeral')),
  -- Filesystem path of the .dot file at resolution time. Diagnostic
  -- only; the daemon contract still keys on `workflow_sha`.
  workflow_path TEXT,
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
  -- Schedule lineage: when set, the run was fired by the named schedule
  -- (see `schedules.id`). Informational only — schedule deletion does
  -- NOT cascade here, so a run keeps its lineage even after the schedule
  -- is removed. No `REFERENCES schedules(id)` constraint by design.
  schedule_id TEXT,
  -- Parallel sub-run linkage (P1.1 of docs/proposals/parallel.md). All
  -- NULL on top-level runs. A sub-run row carries its parent's run id,
  -- the component node that fanned out, its 0-based position in the
  -- fan-out, and the subgraph slice it dispatches through (root
  -- inclusive, terminal exclusive — the parent's collect phase reads
  -- outcomes when the terminal would be entered).
  parent_run_id TEXT REFERENCES run_state(run_id) ON DELETE SET NULL,
  parent_node_id TEXT,
  parallel_index INTEGER,
  subgraph_root_node_id TEXT,
  subgraph_terminal_node_id TEXT,
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
CREATE INDEX IF NOT EXISTS idx_run_state_cwd ON run_state(cwd);
CREATE INDEX IF NOT EXISTS idx_runs_by_schedule
  ON run_state(schedule_id)
  WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_run_state_parent
  ON run_state(parent_run_id)
  WHERE parent_run_id IS NOT NULL;

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

-- Daemon coordination. `http_url` / `http_port` / `harness_version` let
-- CLIs discover the running daemon (or harness) via the DB itself —
-- the only filesystem rendezvous is the DB path. NULL on rows written
-- by `swarm daemon --db <path>` directly (CI primitives don't expose
-- HTTP unless paired with `swarm serve`).
CREATE TABLE IF NOT EXISTS daemon_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  http_url TEXT,
  http_port INTEGER,
  harness_version TEXT
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

-- Recurring-run primitive (docs/proposals/scheduled-runs.md).
-- `(workflow_ref, cwd, interval_ms, optional input)` triple plus a
-- `next_fire_at` cursor; the daemon's `schedule-dispatcher` fiber
-- selects rows where `next_fire_at <= now AND paused_at IS NULL` once
-- per minute, fires runs by calling `enqueueRun` with `schedule_id` set,
-- then advances `next_fire_at = now + interval_ms` (anchored to actual
-- fire time, not to the original target — avoids drift compounding into
-- thundering herds across schedules whose targets happen to align).
--
-- `workflow_ref` stores the workflow name or path as a string, NOT a
-- workflow sha. Resolution happens at fire time so schedules survive
-- workflow edits; if the file is missing or fails to validate, the
-- dispatcher records `fact.schedule_invalid_workflow` and auto-pauses.
CREATE TABLE IF NOT EXISTS schedules (
  id              TEXT PRIMARY KEY,
  workflow_ref    TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  interval_ms     INTEGER NOT NULL,
  interval_text   TEXT NOT NULL,
  input           TEXT,
  overlap_policy  TEXT NOT NULL DEFAULT 'skip'
                  CHECK (overlap_policy IN ('skip','queue','concurrent')),
  next_fire_at    INTEGER NOT NULL,
  last_fire_at    INTEGER,
  last_run_id     TEXT,
  paused_at       INTEGER,
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_schedules_due
  ON schedules(next_fire_at)
  WHERE paused_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_schedules_cwd ON schedules(cwd);
