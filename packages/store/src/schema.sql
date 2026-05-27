-- fragua event store schema — Revision 1 (0.1.0 baseline)
-- All tables STRICT. Run-scoped tables cascade on run deletion.
-- `blobs` is a rowid table so BLOB overflow pages handle large values efficiently.
-- This file is the canonical shape every DB starts at. There is no
-- walk-forward migration chain yet; `migrate()` creates this shape and
-- pins `schema_version` to 1. The first post-0.1.0 schema change bumps
-- the version and registers a step-delta in `migrations.ts`.

CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS workflows (
  sha TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  -- Canonical IR: the parsed Graph serialized as JSON with `loc` (validator-
  -- only metadata) stripped. The dispatch GraphLoader deserializes this — it
  -- is the executable artifact; `source` stays the human/provenance artifact.
  -- `ir_version` is the IR contract version (a third axis, distinct from the
  -- DB-migration `schema_version`, a run's `contract_version`, and the workflow
  -- sha). Both NOT NULL — every workflow is
  -- parsed once at mint and carries its IR. `sha` is still sha256(source);
  -- IR-hash identity (proposal move B) is deferred until the graph shape is
  -- feature-complete.
  ir TEXT NOT NULL,
  ir_version INTEGER NOT NULL,
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
    'queued','running','paused','paused_human','paused_auto',
    'completed','cancelled','halted','quarantined'
  )),
  current_node TEXT,
  workflow_sha TEXT NOT NULL REFERENCES workflows(sha),
  -- Event-contract version pinned at enqueue (EVENT_CONTRACT_VERSION). The
  -- executor's run-resume gate, DISTINCT from the singleton `schema_version`
  -- DB-migration counter above — see docs/proposals/archive/event-contract-version.md.
  contract_version INTEGER NOT NULL,
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
  -- Per-machine LOCATION binding: the resolved project root on this box
  -- (the dir holding the matched .fragua/config.yaml). NULL for runs
  -- without a filesystem context (CI stubs, integration tests).
  cwd TEXT,
  -- Project IDENTITY + denormalized label. `project_id` is the stable,
  -- committed `id` from .fragua/config.yaml (a UUIDv7), decoupled from cwd
  -- so a run attributes to the same project across clones / machines /
  -- imports. `project_name` is the display label captured at enqueue.
  -- Both NOT NULL — every run carries an identity (the CLI auto-inits a
  -- real id when none is found; imports carry theirs).
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  -- Resolved workflow name when bare-name resolution succeeded; NULL
  -- when the caller passed a path.
  workflow_name TEXT,
  workflow_scope TEXT CHECK (workflow_scope IN ('global','local','path','ephemeral')),
  -- Filesystem path of the .yaml file at resolution time. Diagnostic
  -- only; the daemon contract still keys on `workflow_sha`.
  workflow_path TEXT,
  -- Git SHA of the worktree's HEAD at provision time. Replay reconstructs
  -- the run's starting tree from this sha + the workflow's source,
  -- independent of the worktree directory or `branch` survival. NULL for
  -- runs without a provisioner (LocalEnvironment, ephemeral stubs).
  base_git_sha TEXT,
  -- Schedule lineage: when set, the run was fired by the named schedule
  -- (see `schedules.id`). Informational only — schedule deletion does
  -- NOT cascade here, so a run keeps its lineage even after the schedule
  -- is removed. No `REFERENCES schedules(id)` constraint by design.
  schedule_id TEXT,
  total_cost_usd REAL GENERATED ALWAYS AS
    (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
  billed_tokens INTEGER GENERATED ALWAYS AS
    (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED,
  -- Worktree snapshot + inbox projection, written by the terminal
  -- `fact.snapshot_recorded`. `base_git_ref` is the merge/commit target
  -- default captured at provision; `diff_base_sha` is the honest diff base
  -- at terminal (== base_git_sha unless the workflow relocated HEAD);
  -- `change_stat` is JSON {committed, uncommitted}; `inbox_status` drives
  -- the inbox.
  base_git_ref TEXT,
  final_git_sha TEXT,
  final_head_ref TEXT,
  diff_base_sha TEXT,
  change_stat TEXT CHECK (change_stat IS NULL OR length(change_stat) < 1024),
  inbox_status TEXT CHECK (inbox_status IS NULL OR inbox_status IN ('pending','acted','discarded')),
  -- Tip of the operator's branch after the last `accept` (run → commit
  -- traceability). Set by `fact.run_accepted`, folded from `intent.accept_run`.
  accepted_sha TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_run_state_queue
  ON run_state(priority DESC, ready_at ASC)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_run_state_status ON run_state(status);
CREATE INDEX IF NOT EXISTS idx_run_state_workflow ON run_state(workflow_sha);
CREATE INDEX IF NOT EXISTS idx_run_state_updated ON run_state(updated_at);
CREATE INDEX IF NOT EXISTS idx_run_state_cwd ON run_state(cwd);
CREATE INDEX IF NOT EXISTS idx_run_state_project_id ON run_state(project_id);
CREATE INDEX IF NOT EXISTS idx_run_state_inbox
  ON run_state(updated_at DESC)
  WHERE inbox_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_runs_by_schedule
  ON run_state(schedule_id)
  WHERE schedule_id IS NOT NULL;

-- Local inert marker — one row per run merged in by `fragua import`, NEVER
-- carried in a bundle (the bundle has no run_state; this sidecar is local by
-- construction). Its presence holds the run permanently OUT of dispatch,
-- concurrency capacity, and the crash sweep: an imported run executed
-- elsewhere and is inspect-only here. This is the AUTHORITATIVE inert gate —
-- the run's derived `cwd` is also null, but dispatch keys on this marker, not
-- on cwd (a legitimately-enqueued run can have a null cwd).
CREATE TABLE IF NOT EXISTS imported_runs (
  run_id      TEXT PRIMARY KEY REFERENCES run_state(run_id) ON DELETE CASCADE,
  imported_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  -- Provenance tag, deliberately UNconstrained: the value space (daemon =
  -- facts; client = intents, from the web UI or the CLI) is documented by
  -- `EventWriter` in @fragua/types and set by a couple of hardcoded literals,
  -- not user input. No CHECK so the set can evolve (a future direct-store CLI
  -- writer, etc.) without a table rebuild — SQLite can't ALTER a CHECK.
  writer TEXT NOT NULL,
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

-- Daemon coordination — pure liveness (single daemon per store; pid +
-- heartbeat). Where to reach the HTTP server lives in `server_endpoint`,
-- not here: the harness co-locates daemon + server, but the CI primitive
-- runs them as separate processes, so "is the daemon alive" and "where is
-- the server" are distinct facts.
CREATE TABLE IF NOT EXISTS daemon_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
) STRICT;

-- Server discovery rendezvous — the singleton row whoever binds the HTTP
-- listener (the harness's in-process server OR a standalone `fragua serve`)
-- writes after binding and clears on shutdown. CLIs discover the server via
-- the DB itself; the only filesystem rendezvous is the DB path. Replaces the
-- former `<db-dir>/serve.json` discovery file (one coordination surface).
CREATE TABLE IF NOT EXISTS server_endpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  url TEXT NOT NULL,
  port INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
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

-- Recurring-run primitive.
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
  project_id      TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_schedules_project_id ON schedules(project_id);

-- Built-in provider credentials.
-- One row per provider id; `payload` carries the full AuthCredential JSON
-- (api_key form or OAuthCredentials). `kind` is denormalised from
-- `payload.type` for cheap SELECTs in post-mortems. No indexes — the PK
-- on `provider` is the only access pattern (lookup by id, full table
-- scan for `list`, both <20 rows in practice).
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider   TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('api_key','oauth')),
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Custom-provider definitions.
-- One row per provider id; `config` carries the per-provider definition
-- blob (baseUrl, headers, compat, models, modelOverrides) — the
-- `ProviderConfigSchema` body minus `apiKey`. Credentials always come
-- from `provider_credentials`. Per-row Ajv validation lives in the
-- agent layer (`ModelRegistry.loadCustomModels`) so one corrupt
-- provider can be skipped without torching the rest of the registry.
-- No indexes — PK on `provider` is the only access pattern (lookup by
-- id, full table scan for `list`, both <20 rows in practice). No SQL
-- CHECK on `api` / `provider` shape: pi-ai's `Api` and `Provider`
-- types are extensible.
CREATE TABLE IF NOT EXISTS provider_config (
  provider   TEXT PRIMARY KEY,
  config     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
