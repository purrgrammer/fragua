# swarm — Architecture

> **Authoritative.** The design the codebase implements. Companion to [`SPEC.md`](./SPEC.md) (goals) and [`handler-contract.md`](./handler-contract.md) (writing handlers).
>
> SQLite-backed event store with projection-in-transaction, intent/fact split, hard-abort semantics, content-addressed blob storage. No filesystem coordination surface.

---

## 0. Context and decisions

### What we're committing to
- **Single coordination surface: one SQLite database.** All state, events, queue, locks, and artifact metadata. The harness supervises a daemon subprocess + in-process HTTP server against `~/.swarm/swarm.db` by default; both halves read and write. WAL mode handles multi-process access. Artifact *content* lives on the filesystem under `blobsDir`, keyed by sha256 — keeping raw bytes out of the WAL. The CI primitives (`swarm daemon --db <path>` + `swarm serve --db <path>`) hit the same store contract against an explicit DB path.
- **Event sourcing with projection-in-transaction.** Events are the immutable log of truth. A materialized projection (`run_state`) is updated inside the same transaction as the event append. Reads of current state are one row; event fold is only used for migration/debug.
- **Intent/fact split.** Web writes intents (always-appendable, no OCC). Daemon writes facts (OCC-checked against `run_state.version`). 90% of retry pressure disappears.
- **Hard abort for all interrupts.** Pause, cancel, and steer all trip a single `AbortSignal`. Handlers unwind, emit `fact.node_aborted` with partial metrics, executor re-enters (or halts) based on new state.
- **Durable HITL via unwind-and-rehydrate.** `kind=human` nodes return `yield_human`, the executor emits `fact.run_paused_human`, the process is free. Human input (`intent.human_input`) wakes the daemon; it rehydrates from the projection and resumes at the route-matched edge.
- **Content-addressed blobs on disk.** Tool outputs never inline in event payloads or the WAL. Handlers write raw content to `<blobsDir>/<first2>/<sha256>`; a metadata row in `blobs` points at it. Events carry a ref + bounded preview. File-then-row commit ordering: a crash can leave orphan files (GC sweeps), never dangling rows.
- **Orphan-side-effect quarantine.** External tools use provider idempotency keys; on crash-replay, orphaned `SIDE_EFFECT_INTENT` without matching `DONE` quarantines the run for operator review. No blind retry.
- **No IPC.** Daemon↔web coordination is SQLite polling (50ms daemon supervisor, 100ms SSE). No unix socket. No stale `.sock` cleanup. No `EADDRINUSE`.
- **Singleton daemon via `daemon_lock` row with heartbeat.** Zombie detection on reclaim + startup sweep of mid-flight runs. The same row carries the harness's `http_url`/`http_port`/`harness_version` columns so CLIs discover the running URL by opening the DB read-only — one `open()` + one `SELECT` per invocation, no JSON rendezvous file.
- **Web UI works daemon-down.** Reads hit SQLite directly; intents queue; SSE continues polling. No daemon required for observability or control-plane writes.

### Invariants (the contract)

| # | Invariant | Enforced by |
|---|---|---|
| **I1** | Every write is one SQLite transaction; events + projection updated together | Store module API; lint rule: no `await`/`fetch`/`JSON.stringify` inside `db.transaction()` bodies |
| **I2** | No handler state outside the projection | HandlerContext API; pure-function handler signature |
| **I3** | Intents always-appendable; facts OCC-checked | Two distinct store methods (`appendIntent`, `appendFact`) |
| **I4** | Handlers receive `AbortSignal`; respecting it is contract | HandlerContext carries signal; pre-wired LLM/HTTP clients auto-propagate |
| **I5** | External side effects carry a provider idempotency key; orphan `INTENT` quarantines the run on crash-replay | `SideEffectEnvelope.idempotencyKey`; startup sweep emits `fact.run_quarantined` |
| **I6** | `run_state.routing` ≤ 8KB; payload lives in messages/artifacts | `CHECK (length(routing) < 8192)` column constraint |
| **I7** | Event payloads ≤ 4KB | `CHECK (length(payload) < 4096)` column constraint |
| **I8** | Raw tool output addressed by sha256 on the filesystem under `blobsDir`; `blobs` row holds metadata only; artifacts are named refs scoped by `(run, node, iteration, key)`; replay-safe by default — same-content rewrite is a no-op, different-content rewrite at the same scope throws `ArtifactCollisionError` unless the caller passes `{ replace: true }` | Store API writes file→row in that order so orphans are always files, never dangling rows; `putArtifact` checks existing ref and either matches sha (no-op), throws collision, or overwrites with explicit replace |
| **I9** | LLM-visible preview (`messages`) is distinct from system-recorded raw (`artifacts`); individual messages ≤ 1 MiB | Handler API exposes `messages.append()` and `artifacts.put()` separately; `CHECK (length(content) < 1048576)` + pre-check throws `MessageTooLargeError` |
| **I10** | Seq assignment is O(1) via per-run counter on `run_state.next_seq`; never scanned | Store module; `UPDATE run_state SET next_seq = next_seq + 1 RETURNING ...` inside append txn |

---

## 1. Adversarial review — findings and resolutions

### 1.1 Orphan `SIDE_EFFECT_INTENT` after crash
**Attack.** Daemon crashes after `fact.side_effect_intent` is committed but before `fact.side_effect_done`. The external API call actually happened (credit charged, PR merged). On replay, absence of `DONE` is not proof of non-execution — blindly re-running doubles the effect.

**Resolution.**
1. **Provider-level idempotency keys.** External tool envelope carries `idempotencyKey = sha256(runId + nodeId + iteration + argsHash + attempt)`. Handler passes this as `Idempotency-Key` header (or provider-equivalent). Provider dedupes server-side; jointly we achieve at-most-once.
2. **Pre-commit recorder.** `fact.side_effect_intent` is committed in its own short SQLite transaction *before* the handler invokes `fn(idempotencyKey)`. The recorder (`packages/daemon/src/recorder.ts` — `CommittingRecorder`) advances `run_state.version` synchronously on each commit; the executor's terminal `node_completed` / `node_aborted` append uses the recorder's evolved version. This makes the intent durable even if a hard crash (SIGKILL / OOM / panic) destroys the process before `fn` returns — an in-memory buffer would be lost; a committed row is not. `fact.side_effect_done` / `fact.side_effect_failed` are committed the same way, on completion.
3. **Startup quarantine.** On daemon start, scan for `fact.side_effect_intent` events without a matching `fact.side_effect_done`/`fact.side_effect_failed` (joined by `idempotencyKey`). Any run with such an orphan enters `quarantined` status. Run does not resume until a human writes `intent.unquarantine { resolution: "treat_as_done" | "retry" | "cancel", note }`.
4. **Retry uses the same key.** If operator chooses `retry`, the handler re-executes with the same `idempotencyKey`. If the provider already processed the prior attempt, it returns the cached response. Safe under operator error.
5. **Tools without provider dedup** get a warning label at registration; operator is the only safety net. Documented as handler-author responsibility.

### 1.2 Artifact key collision under loops
**Attack.** Node `A` runs in iteration 1 of a graph cycle, calls `artifacts.put("result", ...)`. On iteration 2, same node, same user key → `UNIQUE` constraint violation.

**Resolution.** `artifacts` PK becomes `(run_id, node_id, iteration, key)` explicitly — no string encoding. Handler API auto-scopes:

```typescript
ctx.artifacts.put(key, content, mime?)                          // implicit (nodeId, iteration)
ctx.artifacts.get(key)                                          // implicit current scope
ctx.artifacts.getFrom({ nodeId, iteration, key })               // explicit cross-scope
```

`iteration` is the per-node retry counter (attractor §3.6), bumped each time a backward edge re-enters a node after a non-success outcome (0 on first entry). Downstream nodes receive `ArtifactRef { runId, nodeId, iteration, key }` through routing, never raw strings.

### 1.3 Unix socket IPC is net-negative
**Attack.** `.sock` cleanup, `EADDRINUSE`, permission errors, reconnect bookkeeping — hundreds of lines for something SQLite already does in <0.1ms per query.

**Resolution.** `packages/ipc` is deleted from the plan.
- **Daemon supervisor fiber** ticks every 50ms, inside one short transaction:
  - `heartbeat()` — UPDATE `daemon_lock.heartbeat_at`
  - `detectNewIntents()` — for every registered abort controller, check if there are unapplied intents; trip abort if yes
  - `detectStuckNodes()` — watchdog for handlers that exceeded `maxMs + LEAK_GRACE_MS`. Skipped for nodes whose `HandlerSpec.maxMs` is `undefined` (llm opt-out via `max_ms=0`).
- **Web SSE streams** poll `events WHERE seq > ?` every 100ms per subscribed run. At 10 concurrent subscribers, ≈100 qps of indexed reads; <1ms each.
- **No `.sock` file.** Nothing to clean up on crash. Nothing to reconcile on restart.

### 1.4 Crash-recovery limbo
**Attack.** Daemon hard-crashes while runs were `running`. On restart, those rows still say `running`; the executor only claims `queued`; runs sit dead until watchdog fires a minute later.

**Resolution.** **Startup sweep** runs before the executor loop, in a single transaction:

```sql
-- (a) Requeue crash-interrupted runs. current_node is preserved so the
--     executor resumes on the in-flight node instead of re-emitting
--     fact.run_started and re-running the workflow from the start node.
--     Partial-side-effect safety lives in (b) below — rerun-from-start
--     was never the intended recovery semantics.
UPDATE run_state
   SET status = 'queued',
       node_started_at = NULL,
       dispatch_started_at = NULL,
       ready_at = :now,
       version = version + 1,
       updated_at = :now
 WHERE status = 'running'
 RETURNING run_id, version;

-- For each returned run_id, append fact.run_requeued_after_crash

-- (b) Quarantine orphans (see 1.1)
-- (c) paused, paused_human, and quarantined runs are NOT touched
```

Combined with the watchdog (1.10) and zombie detection (1.6), recovery is immediate rather than minute-delayed.

### 1.5 `MAX(seq)` write-path contention
**Attack.** `INSERT ... SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE run_id=?` adds a B-tree seek inside every write txn. Under load, the extra latency amplifies `SQLITE_BUSY` across both processes.

**Resolution.** Per-run counter on `run_state`. Every append bumps it atomically:

```sql
UPDATE run_state SET next_seq = next_seq + 1 WHERE run_id = ?1 RETURNING next_seq - 1 AS seq;
INSERT INTO events (run_id, seq, type, writer, payload, ts) VALUES (?1, ?seq, ?, ?, ?, ?);
```

No scan. Combined with `BEGIN IMMEDIATE`, concurrent appends serialize cleanly without index pressure. I10 captures this.

### 1.6 Zombie daemon after lock reclaim
Unchanged from Revision 1. Daemon lock has TTL; stalled process fails OCC on every commit; loop-internal re-check of `daemon_lock` forces it to exit on takeover.

### 1.7 Heartbeat outlives stuck executor
Consolidated into the supervisor fiber (1.3). Heartbeat, intent detection, and stuck-node detection share one 50ms tick. If the executor fiber wedges in a tight sync loop, the event loop is blocked — supervisor also stops, lock stales, another daemon reclaims. Belt and suspenders via handler-level `AbortSignal.timeout()` (§5).

### 1.8 LLM provider ignores `AbortSignal`
Unchanged. `Promise.race` with hard timeout bounds damage; leaked handlers emit `fact.handler_timeout_leaked` for accounting honesty.

### 1.9 Mid-flight abort replay
Covered by provider idempotency keys (1.1) and per-node iteration scoping (1.2). Handlers with `side_effect: "none" | "idempotent"` can replay freely; `external` handlers rely on the provider key.

### 1.10 LLM provider transport error mid-stream
**Attack.** The LLM provider returns 402 (insufficient balance), 429 (rate limit), 5xx, or the network drops mid-stream. pi-ai surfaces this as `AssistantMessageEvent { type: "error" }`; without intervention the llm handler converts it into `outcome.status = "fail"`, indistinguishable from a deliberate `abort` tool call. The run halts and all completed work in the transcript is abandoned even though it survives in the `messages` table.

**Resolution.**
1. **HTTP-status capture.** `PiLlmBackend` registers `StreamOptions.onResponse` to record the last `ProviderResponse.status` per LLM call. On stream `error`, the captured status (or `null` for pre-response network failures) is paired with the provider's `errorMessage` and bubbled out as a new outcome shape.
2. **Handler-result kind `pause_provider`.** The handler-bridge translates the provider-error outcome to `HandlerResult.kind = "pause_provider"` carrying `{ httpStatus, provider, errorMessage }`. The executor commits `fact.run_paused` with `reason: "payment_required"` for 402 (top-up off-ledger) or `reason: "provider_error"` otherwise, and transitions the run to `paused`.
3. **Generic resume intent.** Operator writes `intent.resume`. The daemon wakes the run back to `queued` and re-dispatches the same `(nodeId, iteration)` with the rehydrated transcript loaded as `priorMessages`. Worktree, branch, and message ordering all survive — same path as `paused_human` rehydration.
4. **Manual + auto classes.** 408 / 429 / 5xx / 529 / network errors emit `fact.run_paused{reason:"provider_retry"}` (with `attempt`, `resumeAt`) and project to `paused_auto` for timer-driven wake. 400 / 401 / 402 / 403 / 404 / 413 / 422 stay manual (`paused{reason:"provider_error"}`, or `paused{reason:"payment_required"}` for 402); auto-retry against a busted account would burn money.

### 1.11 Remaining concerns
- **sha256 oracle for blobs** — deferred to optional encryption later; single-user local tool has DB read = full read anyway.
- **SSE push ordering** — not an issue in polling model. Consumers read `seq > lastSeen`, always consistent.
- **Intent-flood DOS** — retry-storm ceiling (abort-loop detector emits `fact.run_paused{reason:"abort_loop"}` after K=5 consecutive aborts without progress; operator-resumable per Stage 3 of recoverable-budget-pause.md). HTTP rate-limit at web layer.
- **WAL bloat from large artifacts** — `blobs` holds metadata only; content lives on the filesystem so multi-MiB writes never frame into the WAL. Live SSE readers can't pin large blob bytes in the WAL as a result. See §2.
- **Schema drift across long pauses** — `schema_version` pinned per run; the daemon resumes any version inside the compatibility range `[MIN_COMPATIBLE_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION]`. Step-delta migrations live in `packages/store/src/migrations.ts` keyed by target version; existing DBs at `version < CURRENT` walk each delta in order. Halt only out-of-range pins with `fact.run_halted { reason: "schema_drift" }`. Current state: `MIN_COMPATIBLE_SCHEMA_VERSION = 1`, `CURRENT_SCHEMA_VERSION = 15`. See `packages/store/src/pragmas.ts` and `packages/store/src/migrations.ts`.
- **Replay determinism under LLM non-determinism** — inherent; external-call safety via idempotency keys; pure/idempotent handlers fine.

---

## 2. Schema

All tables are `STRICT`. The append-mostly per-run tables (`events`, `messages`, `blobs`, `artifacts`) additionally use `WITHOUT ROWID` for compact PK-clustered storage; the lifecycle and singleton tables (`schema_version`, `workflows`, `run_state`, `daemon_lock`, `daemon_events`) use the default rowid layout (`daemon_events` in particular relies on `INTEGER PRIMARY KEY AUTOINCREMENT`, which is incompatible with `WITHOUT ROWID`). Every table is narrow — the only "big" data (artifact content) lives on the filesystem under `blobsDir`, keyed by sha256. Per-run tables cascade on run deletion.

```sql
-- Pragmas applied on every connection open
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -65536;           -- 64MB per connection
PRAGMA mmap_size = 268435456;         -- 256MB mmap
PRAGMA wal_autocheckpoint = 1000;

-- Set at DB creation only:
-- PRAGMA page_size = 8192;

-- Every write transaction opens as BEGIN IMMEDIATE (grabs write lock up front)

CREATE TABLE schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
) STRICT;

CREATE TABLE workflows (
  sha TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dot_source TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE run_state (                          -- projection + queue + seq counter
  run_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,                       -- OCC token
  status TEXT NOT NULL CHECK (status IN (
    'queued','running','paused','paused_human','paused_auto',
    'completed','cancelled','halted','quarantined'
  )),
  current_node TEXT,
  workflow_sha TEXT NOT NULL REFERENCES workflows(sha),
  schema_version INTEGER NOT NULL,
  routing TEXT NOT NULL CHECK (length(routing) < 8192),
  metrics TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,            -- per-run counter; I10
  last_applied_seq INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL,                   -- original enqueue, immutable
  ready_at INTEGER NOT NULL,                      -- set on every transition INTO 'queued'
  node_started_at INTEGER,
  dispatch_started_at INTEGER,                    -- when the current dispatch began (activeMs accounting)
  updated_at INTEGER NOT NULL,
  title TEXT,                                     -- auto-titler output; NULL until generated
  cwd TEXT,                                       -- absolute project root the run was enqueued from; NULL for ephemeral
  workflow_name TEXT,                             -- resolved name when caller passed a bare name; NULL for path runs
  workflow_scope TEXT CHECK (workflow_scope IN ('global','local','path','ephemeral')),
  workflow_path TEXT,                             -- workflow file path at resolution time; diagnostic
  base_git_sha TEXT,                              -- HEAD sha of worktree at provision time; NULL when no provisioner
  branch TEXT,                                    -- preserved on dispose when working-copy delta exists; NULL otherwise
  schedule_id TEXT,                               -- schedule that fired this run; informational, not a FK cascade target
  total_cost_usd REAL GENERATED ALWAYS AS
    (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
  billed_tokens INTEGER GENERATED ALWAYS AS
    (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED,
  -- Worktree snapshot + inbox projection (docs/proposals/worktrees.md); added
  -- dormant in v15, populated by later steps. branch -> final_branch rename
  -- lands with the dispose rework.
  base_git_ref TEXT,                              -- symbolic-ref --short HEAD of user-cwd at provision; merge/commit target default
  final_git_sha TEXT,                             -- worktree HEAD at last snapshot boundary; NULL pre-terminal
  final_head_ref TEXT,                            -- worktree's HEAD branch at terminal; NULL when detached
  diff_base_sha TEXT,                             -- honest terminal diff base; == base_git_sha unless HEAD relocated
  change_stat TEXT,                               -- JSON {committed, uncommitted}; NULL pre-terminal / clean
  inbox_status TEXT,                              -- pending|acted|discarded; NULL = not an inbox candidate
  final_commit TEXT,                              -- projection: last commit_run sha
  merged_into TEXT                                -- projection: last merge_run target
) STRICT;

-- Partial index = queue in disguise; O(log N) claim
CREATE INDEX idx_run_state_queue
  ON run_state(priority DESC, ready_at ASC)
  WHERE status = 'queued';

CREATE INDEX idx_run_state_status   ON run_state(status);
CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
CREATE INDEX idx_run_state_updated  ON run_state(updated_at);
CREATE INDEX idx_run_state_cwd      ON run_state(cwd);
CREATE INDEX idx_runs_by_schedule
  ON run_state(schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX idx_run_state_inbox                 -- inbox list: pending, terminal-time desc
  ON run_state(updated_at DESC) WHERE inbox_status = 'pending';

CREATE TABLE events (
  run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,                             -- 'intent.*' | 'fact.*'
  writer TEXT NOT NULL CHECK (writer IN ('daemon','web')),
  payload TEXT NOT NULL CHECK (length(payload) < 4096),
  ts INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_events_type ON events(type, run_id, seq);
-- Cross-run, time-ordered scans for the global Home feed. Cursor is the
-- (ts, run_id, seq) tuple — per-run `seq` can't carry a global ordering
-- on its own.
CREATE INDEX idx_events_ts ON events(ts, run_id, seq);

CREATE TABLE messages (                           -- append-mostly; never rewritten
  run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  -- pi-agent-core `AgentMessage` JSON (round-trips losslessly). `role` is a
  -- generated column extracted from the JSON so UI filters and debug queries
  -- don't pay `json_extract` on hot paths.
  content TEXT NOT NULL CHECK (json_valid(content) AND length(content) < 1048576),
  role TEXT GENERATED ALWAYS AS (json_extract(content, '$.role')) STORED,
  node_id TEXT,
  iteration INTEGER NOT NULL DEFAULT 0,
  -- sha256 of the serialised content. Backs the opt-in replay dedup path
  -- (`appendMessage(runId, row, { dedup: true })`); default OFF because
  -- agent transcripts carry per-call timestamps that legitimately differ
  -- across attempts even when the semantic message is the same.
  content_hash TEXT,
  PRIMARY KEY (run_id, ordinal)
) STRICT, WITHOUT ROWID;

-- Metadata only: bytes live at `<blobsDir>/<first2>/<sha256>` on disk.
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE artifacts (                          -- per-(run,node,iteration) named refs
  run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha256),
  mime TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id, iteration, key)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_artifacts_blob ON artifacts(blob_sha);

CREATE TABLE daemon_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  http_url TEXT,                                  -- harness/serve listener URL; NULL for `swarm daemon --db <path>` only
  http_port INTEGER,
  harness_version TEXT
) STRICT;

-- Daemon-level audit log: process lifecycle, sweep activity, reaper
-- takeovers, GC, leak detection, worktree provisioning. Separate from
-- the per-run `events` table because some entries are global (no run
-- scope) and they must not interleave into the per-run `seq` space the
-- reducer projects. Same 4 KB payload cap as fact events.
CREATE TABLE daemon_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (length(payload) < 4096),
  ts INTEGER NOT NULL,
  run_id TEXT REFERENCES run_state(run_id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_daemon_events_ts   ON daemon_events(ts, seq);
CREATE INDEX idx_daemon_events_type ON daemon_events(type, ts);
CREATE INDEX idx_daemon_events_run  ON daemon_events(run_id, seq) WHERE run_id IS NOT NULL;

-- Recurring-run primitive (proposal: docs/proposals/scheduled-runs.md).
-- `(workflow_ref, cwd, interval_ms, optional input)` triple plus a
-- `next_fire_at` cursor. The daemon's `schedule-dispatcher` fiber
-- selects rows where `next_fire_at <= now AND paused_at IS NULL` once
-- per minute, fires runs by calling `enqueueRun` with `schedule_id`
-- set, then advances `next_fire_at = now + interval_ms` (anchored to
-- actual fire time). `workflow_ref` stores the workflow name or path
-- as a string — NOT a sha; resolution happens at fire time so schedules
-- survive workflow edits. If the file is missing or fails to validate,
-- the dispatcher records `fact.schedule_invalid_workflow` and
-- auto-pauses. `last_run_id` is informational (no FK), as is
-- `run_state.schedule_id` — schedule deletion is hard DELETE while runs
-- persist.
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  workflow_ref    TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  interval_ms     INTEGER NOT NULL,
  interval_text   TEXT NOT NULL,                  -- "30m" / "1h" / "6h" / "24h"; display only
  input           TEXT,                           -- positional input piped to the run via routing.input
  overlap_policy  TEXT NOT NULL DEFAULT 'skip'
                  CHECK (overlap_policy IN ('skip','queue','concurrent')),
  next_fire_at    INTEGER NOT NULL,               -- unix ms
  last_fire_at    INTEGER,
  last_run_id     TEXT,
  paused_at       INTEGER,                        -- NULL = active; non-NULL = explicitly paused
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_schedules_due
  ON schedules(next_fire_at) WHERE paused_at IS NULL;
CREATE INDEX idx_schedules_cwd ON schedules(cwd);

-- Built-in provider credentials. One row per provider id; `payload` is
-- the full AuthCredential JSON (api_key form or OAuthCredentials).
-- `kind` denormalises `payload.type` so post-mortems can SELECT row
-- shapes without JSON-parsing. No indexes — the PK on `provider` is
-- the only access pattern (lookup by id, full table scan for `list`,
-- both <20 rows in practice). The agent layer's
-- `SqliteAuthStorageBackend` rebuilds the in-memory AuthStorageData
-- blob from these rows on read and applies a returned `next` blob by
-- full-replace (upsert + delete-missing). See proposal:
-- `docs/proposals/provider-credentials-storage.md`.
CREATE TABLE provider_credentials (
  provider   TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('api_key','oauth')),
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Custom-provider definitions. One row per provider id; `config` is
-- the per-provider definition blob (baseUrl, headers, compat, models,
-- modelOverrides) — the `ProviderConfigSchema` shape from
-- `@swarm/agent` minus the `apiKey` field. Credentials always come
-- from `provider_credentials`. Per-row Ajv validation lives in the
-- agent layer (`ModelRegistry.loadCustomModels`) so one corrupt
-- provider can be skipped without poisoning sibling rows. No indexes
-- — PK on `provider` is the only access pattern (lookup by id, full
-- table scan for `list`, both <20 rows in practice). No SQL CHECK on
-- `api` / `provider` shape: pi-ai's `Api` and `Provider` types are
-- extensible. See proposal:
-- `docs/proposals/provider-config-storage.md`.
CREATE TABLE provider_config (
  provider   TEXT PRIMARY KEY,
  config     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
```

**Size targets:**
- `run_state` row: ~500 bytes; thousands of rows negligible.
- `events` row: ~300 bytes; partial indexes small.
- `messages` rows: ≤ 1 MiB per row (enforced; large values spill through `ctx.artifacts.put`).
- `blobs` row: ~100 bytes (metadata only). Content files up to 16 MiB apiece live under `blobsDir`.

---

## 3. Event taxonomy

### Intent events (writer: `web`, no OCC)
| Type | Payload fields | Semantics |
|---|---|---|
| `intent.run_enqueued` | `workflowSha`, `priority?` | Queue a new run |
| `intent.steering_requested` | `text: string` | Abort current node; inject steering before re-entry |
| `intent.pause_requested` | — | Abort current node; transition to `paused` |
| `intent.cancel_requested` | `reason?` | Abort current node; transition to `cancelled` |
| `intent.human_input` | `route: string`, `note?: string` | Wake a `paused_human` run; `route` is one of the node's declared `routes=` names chosen by the operator |
| `intent.resume` | `note?: string` | Generic wake for any `paused_*` run; re-dispatches the same `(nodeId, iteration)` |
| `intent.unquarantine` | `resolution: 'treat_as_done'\|'retry'\|'cancel'`, `note?: string` | Operator acknowledgement for a quarantined run |
| `intent.priority_adjusted` | `newPriority: number`, `note?: string` | Operator bump |
| `intent.budget_adjusted` | `scope: 'node'\|'run'`, `metric: 'cost'\|'tokens'`, `newLimit: number` (>0), `note?: string` | Operator raises a budget ceiling on a `paused{reason:'budget'}` run; folded into `routing.budget_override.<scope>.<metric>` so the next turn-boundary budget check uses the new ceiling. Web bundles a follow-up `intent.resume` ("Raise & Resume"); intents stay separate at the protocol level |
| `intent.max_retries_adjusted` | `nodeId: string`, `newLimit: number` (>0), `note?: string` | Operator raises a node's `max_retries` cap on a `paused{reason:'max_retries'}` run; folded into `routing.max_retries_override.<nodeId>`. Stage 3 of recoverable-budget-pause.md |
| `intent.goal_gate_adjusted` | `newLimit: number` (>0), `note?: string` | Operator raises the failing gate's retarget cap on a `paused{reason:'goal_gate'}` run; folded into `routing.max_goal_gate_retries_override` (takes precedence over the gate's `max_retries`) |
| `intent.max_loops_adjusted` | `newLimit: number` (>0), `note?: string` | Operator raises the per-run dispatch ceiling on a `paused{reason:'max_loops'}` run; folded into `routing.max_loops_override` |

### Fact events (writer: `daemon`, OCC-checked)
| Type | Payload fields | Semantics |
|---|---|---|
| `fact.run_started` | `workflowSha`, `schemaVersion`, `startNode`, `baseGitSha?`, `baseGitRef?` | Run enters `running`. `baseGitRef` is the source repo's branch at provision — the post-run merge/commit target default (docs/proposals/worktrees.md) |
| `fact.dispatch_started` | `nodeId`, `iteration`, `resumeOf: 'fresh'\|'crash'\|'paused'\|'paused_human'\|'paused_auto'\|'quarantined'` | Stamps `dispatchStartedAt` for activeMs accounting; lets analytics distinguish "ran straight through" from "had to be woken up" |
| `fact.node_started` | `nodeId`, `iteration` | Node dispatched |
| `fact.node_completed` | `nodeId`, `iteration`, `tokens`, `costUsd`, `inputCostUsd?`, `outputCostUsd?`, `cacheReadCostUsd?`, `cacheWriteCostUsd?`, `inputTokens?`, `outputTokens?`, `cacheReadTokens?`, `cacheWriteTokens?`, `modelName?`, `nextNode`, `outcomeStatus?: 'success'\|'fail'\|'retry'`, `route?: string` (present iff the source node declared `routes=` and the llm agent exited via the synthesised `route` tool — see docs/proposals/llm-routing.md) | Node succeeded. Cost / token splits are optional for back-compat; the run-level reducer defaults missing fields to 0. The four-bucket cost split (`inputCostUsd` / `outputCostUsd` / `cacheReadCostUsd` / `cacheWriteCostUsd`) sums to `costUsd` for llm handlers; tool / human handlers leave them unset. `outcomeStatus` lets the UI distinguish "completed OK" from "completed with outcome=fail" without walking edges |
| `fact.node_aborted` | `nodeId`, `iteration`, `cause`, `partialTokens`, `partialCostUsd`, `partialInputCostUsd?`, `partialOutputCostUsd?`, `partialCacheReadCostUsd?`, `partialCacheWriteCostUsd?`, `partialInputTokens?`, `partialOutputTokens?`, `partialCacheReadTokens?`, `partialCacheWriteTokens?` | Mid-flight abort. Partial cost / token splits cover work done before the abort; optional for back-compat with pre-split runs |
| `fact.intents_folded` | `intentSeq`, `folded` | Operator intents (steer / hitl / priority / pause) merged into routing/messages by the fold |
| `fact.side_effect_intent` | `nodeId`, `iteration`, `toolName`, `argsHash`, `attempt`, `idempotencyKey` | External tool about to run |
| `fact.side_effect_done` | `idempotencyKey`, `artifactKey`, `tokens?`, `costUsd?` | External tool completed |
| `fact.side_effect_failed` | `idempotencyKey`, `errorCode`, `retriable: bool` | External tool failed cleanly |
| `fact.tool_completed` | `toolName`, `argsHash`, `artifactKey`, `preview`, `summary?` | Non-external tool result |
| `fact.message_appended` | `ordinal`, `role`, `nodeId: string\|null`, `iteration` | Message metadata. `nodeId` is null for messages appended outside a node turn (e.g. seed messages) |
| `fact.run_paused_human` | `nodeId`, `text`, `routes: string[]`, `snapshot?` | Yielded for human input on a workflow `kind=human` node; `routes` is the closed enum of route names declared on the source node (one button per route in the web UI; button label comes from the matching outgoing edge's `label=` or `humanize(route)`). `snapshot` embeds the worktree diff for the operator's first paint (docs/proposals/worktrees.md); absent for bare-cwd runs. |
| `fact.run_paused` | `reason: 'operator'\|'provider_error'\|'payment_required'\|'budget'\|'provider_retry'\|'handler_retry'\|'timeout_retry'\|'max_retries'\|'goal_gate'\|'max_loops'\|'abort_loop'\|'provider_exhausted'`, plus reason-specific fields. Operator-resumable arms: `operator` (no extras), `provider_error` (`nodeId`, `httpStatus`, `provider`, `errorMessage`), `payment_required` (`nodeId`, `provider`, `errorMessage`), `budget` (`nodeId`, `scope`, `metric`, `limit`, `actual`), `max_retries` (`nodeId`, `currentLimit`, `attempts`), `goal_gate` (`gateNodeId`, `currentLimit`), `max_loops` (`currentLimit`, `dispatches`), `abort_loop` (`nodeId`, `consecutiveAborts`), `provider_exhausted` (`nodeId`, `attempts`, `cumulativeMs`). Auto-wake arms (status `paused_auto`): `provider_retry` (`nodeId`, `httpStatus`, `provider`, `errorMessage`, `attempt`, `resumeAt`), `handler_retry` (`nodeId`, `attempt`, `delayMs`, `resumeAt`, `maxRetries`), `timeout_retry` (`nodeId`, `attempt`, `delayMs`, `resumeAt`, `maxAttempts`, `attemptedMs`). | Unified pause fact. Status follows reason 1:1: reasons in `AUTO_WAKE_PAUSE_REASONS` (`provider_retry`, `handler_retry`, `timeout_retry`) project to `paused_auto` (wake-pending sweep auto-resumes at `resumeAt`); everything else → `paused` (operator must `intent.resume`, optionally preceded by a cap-adjustment intent: `intent.budget_adjusted`, `intent.max_retries_adjusted`, `intent.goal_gate_adjusted`, `intent.max_loops_adjusted`). `timeout_retry` re-categorises a watchdog `maxMs` overrun as system-initiated pause-retry — partial-spend metrics still accrue via a paired `fact.node_aborted{cause:"timeout"}` |
| `fact.provider_retry_attempted` | `nodeId`, `attempt`, `httpStatus: number\|null`, `delayMs` | One per attempt in an auto-retry chain — separate fact rather than mutated payload preserves I3 (fact immutability) |
| `fact.run_resumed` | `fromStatus: RunStatus`, `inputIntentSeq?` | Left a paused/quarantined state |
| `fact.run_completed` | `finalNode` | Terminal success |
| `fact.run_halted` | `reason: 'budget'\|'schema_drift'\|'error'\|'aborted_exit'\|'occ_exhausted'\|'timeout_exhausted'\|'route_not_picked'\|'route_call_not_isolated'\|'edge_no_match'`, `detail?`, `occContext?` (set when reason="occ_exhausted") | Terminal failure. After Stage 3 of recoverable-budget-pause.md the previously-recoverable-class reasons (`max_loops`, `abort_loop`, `goal_gate_unsatisfied`, `max_retries_exceeded`, `provider_exhausted`) moved to `fact.run_paused`. `timeout_exhausted` lands when the per-`(nodeId)` watchdog-retry counter saturates (default 3 attempts) — see `paused_auto{reason:"timeout_retry"}` for the recoverable side. The three `route_*` reasons (docs/proposals/llm-routing.md D3/D8) land when a routing node fails to commit a route via the synthesised `route` tool or chose a route the graph doesn't handle |
| `fact.run_cancelled` | `intentSeq` | Terminal cancel |
| `fact.snapshot_recorded` | `eventIdx`, `treeSha`, `commitSha`, `parentSnap`, `headSha`, `headRef`, `diffBaseSha`, `committed`, `uncommitted` | Terminal worktree snapshot (docs/proposals/worktrees.md). Once per worktree-backed run, after the terminal status fact. Reducer projects `change_stat` / `inbox_status` / `final_*`. Per-step + HITL snapshots are the `snapshot.captured` observability event, not facts. |
| `fact.run_quarantined` | `reason: 'orphan_side_effect'\|'other'`, `orphanedIntents?: seq[]` | Awaiting operator |
| `fact.run_requeued_after_crash` | `prevNode?`, `lastAliveAt?` | Startup sweep requeued. `lastAliveAt` is the dying daemon's last heartbeat — reducer credits `lastAliveAt − dispatchStartedAt` to `activeMs` |
| `fact.handler_timeout_leaked` | `nodeId`, `leakedAt` | Accounting truth |
| `fact.daemon_takeover` | `reclaimedFrom: pid`, `at: ts` | Lock reclaim |
| `fact.run_branched` | `branch`, `sha` | Operator post-run primitive (`intent.branch_run`, docs/proposals/worktrees.md): created `refs/heads/<branch>` at the run's heads-ref sha. Sets `run_state.branch`; inbox `pending → acted`. No longer dispose-emitted (step 6 removed branch-preservation). |
| `fact.run_committed` | `targetBranch`, `sha`, `message`, `parentSha` | Operator (`intent.commit_run`): committed the run's snapshot tree onto `targetBranch`. Sets `run_state.final_commit`; inbox `pending → acted`. |
| `fact.run_merged` | `targetBranch`, `mode: 'ff'\|'merge'\|'squash'`, `sha`, `parentShas: string[]` | Operator (`intent.merge_run`): merged the run's heads-ref into `targetBranch`. Sets `run_state.merged_into`; inbox `pending → acted`. |
| `fact.run_discarded` | `refs: string[]` | Operator (`intent.discard_run`): deleted the run's `refs/swarm/{snapshots,heads}/<id>`. Inbox `pending → discarded` (terminal-terminal). |

**Sub-agents have no dedicated facts and no `run_state` row.** A sub-agent (LLM-spawned via the `agent` tool) is a tool implementation that runs inline as a fresh llm call against the parent's event stream. Three **observability** event types bracket the slice: `subagent.start { subagent_id, parent_node_id, iteration, model, provider, name?, agent_def? }`, `subagent.end { subagent_id, status, summary_chars, total_tool_calls, costUsd, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, halt_reason? }`, and `subagent.resumed { subagent_id, reason: "already_completed" | "transcript_hydrated" }` (fires on respawn after a daemon crash; see [`docs/proposals/sub-agent-crash-resilience.md`](./proposals/sub-agent-crash-resilience.md)). `name` and `agent_def` are independent: `name` carries the free-form caller-supplied label from `agent({ name: <label>, … })`; `agent_def` carries the resolved profile name from `agent({ agent: <def-name>, … })` against a discovered definition (see [`docs/proposals/agent-definitions.md`](./proposals/agent-definitions.md)). Either, both, or neither can be present. UIs prefer `name` when present (the caller chose it for this spawn) and fall back to `agent_def`. Every event the sub-agent emits in between (`llm.start`, `llm.toolcall_*`, `cost.recorded`, `agent.turn_*`) carries `subagent_id` on its payload as a discriminator. The cost-rollup fields (`costUsd`, `totalTokens`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) sum every `cost.recorded` the sub-agent forwarded onto the parent's stream during its bracket — a per-spawn view UIs and analytics can render without scanning the slice. Required numbers, default 0 when no `cost.recorded` fired (e.g. spawn halted before any LLM call). Field shape mirrors `fact.node_aborted.partial*`. The fields are a per-spawn view of the same stream, not a duplicate accounting path: cost still rolls into the parent's `metrics` through the existing accumulation path — the reducer doesn't filter on `subagent_id`. The tool result (`{ subagent_id, status, total_tool_calls, halt_reason? }`) is the bidirectional handle the parent LLM gets back. Parallel `agent` toolcalls in one parent message run concurrently and demux by `subagent_id`. The `subagent_id` is picked at spawn time via two paths. **Content-addressed pending-resume (FIFO queue, default when `spec.args_hash` is set — the agent tool computes it from the spec's canonical args: prompt, system_prompt, allowed_tools, disallowed_tools, skills, max_iterations, agent_def, model, provider):** spawn-subagent queries prior `subagent.start` / `subagent.end` / `subagent.resumed` events for brackets in the same `(parentRunId, parentNodeId, parentIteration, args_hash)` scope whose latest terminal is `subagent.end{status:"cancelled"}` and that haven't been consumed by a `subagent.resumed`. The oldest such bracket's id is reused — same id ⇒ the hydration path below replays its transcript ⇒ the LLM's retry with byte-identical args automatically picks up where the cancelled bracket left off, without a `resume_subagent_id` parameter, without LLM cooperation. Six parallel siblings with same args each pop a distinct cancelled bracket because the eagerly-emitted `subagent.resumed` consumes its id before the next sibling's findPendingResumeCandidate runs (bun:sqlite writes are sync; the first sibling's resumed-write lands before the second's read). Stays scoped to `(parent_node_id, iteration)` so a goal-gate retarget into the same node doesn't accidentally bleed stale brackets into a fresh dispatch. **Fresh deterministic id (fallback):** `sha256(parentRunId, parentNodeId, parentIteration, tool_call_id)` truncated to 32 hex chars — so a sub-agent respawned after a daemon crash hashes to the same id and rehydrates its prior transcript under the existing `__subagent:<id>` namespace in the messages table. The respawn path emits `subagent.resumed` (no fresh `subagent.start` — the original is still in the event log) and either skips the LLM call (when the persisted transcript ended in `stopReason:"stop"` with no pending toolCalls) or hands `priorMessages` to the backend so the child picks up where it left off. On a resumed bracket, `subagent.end.costUsd` and the token fields are **cumulative** across every spawn of the same `subagent_id` — the daemon seeds the per-spawn rollup from prior `subagent.end` events for that id (via `IEventReader.getEventsByType`). **Consumers summing cost across `subagent.end` rows MUST dedupe by `subagent_id` and take the terminal (non-cancelled) bracket; naive summation across every bracket over-counts.** The parent's `total_cost_usd` projection is unaffected — it folds each `fact.node_completed.costUsd` once. Typed payload schemas: `SubagentStartData` / `SubagentEndData` / `SubagentResumedData` in `packages/core/src/types/events.ts`.

All payloads ≤ 4KB. Content references are `artifactKey`.

### Observability events (writer: `daemon`, no OCC)

Anything emitted via `ctx.emit` from a handler — `agent.message_start/end`, `llm.text_delta`, `llm.thinking_delta`, `llm.toolcall_delta`, `cost.recorded`, `tool.execution_start/end`, `intent.dropped`, `budget.warn` / `budget.stop`, etc. Best-effort streaming telemetry, not transactional bundle: no version bump, no decision logic reads them, consumers are SSE tails and projections. Events land in the same `seq` space as facts.

The executor flushes the in-handler buffer to the store on a soft 50ms timer or when 64 events accumulate, whichever first, so the conversation view streams mid-LLM-call. The handler's tail (`edge.selected`, post-handler budget warnings) is drained synchronously before the terminal `fact.node_*` so consumers see the trail in causal order.

`snapshot.captured` (payload: `SnapshotCapturedData` — `runId`, `eventIdx`, `nodeId`, `treeSha`, `commitSha`, `parentSnap`, `headSha`, optional `headRef` / `diffBaseSha` / `committed` / `uncommitted`) is the executor-emitted per-step + HITL worktree snapshot (docs/proposals/worktrees.md), feeding the Diff scrubber. Delta-suppressed (no event when the tree is unchanged on a step boundary). The terminal snapshot is the OCC-checked `fact.snapshot_recorded`, not this.

`llm.start.skills[]` carries one `SkillCatalogRecord` (see `packages/types/src/skills.ts`) per skill the model saw on this call. Each record includes `name`, `location`, `sha256`, `bytes`, `scope`, `source_dir`, optional `compatibility`, and — for `scope === "project"` — `project_cwd` so replay can correlate which project's skills were active for this run after per-run filtering at llm dispatch (see [`docs/proposals/skills-and-agents-ui.md`](./proposals/skills-and-agents-ui.md)).

### Daemon events (writer: `daemon`, separate `daemon_events` table)

Process-lifecycle and infrastructure events. Persisted in the dedicated `daemon_events` table — disjoint from the per-run `seq` space because many entries are global (no run scope) and they must not interleave into the per-run reducer's projection. Same 4 KB payload cap as fact events.

| Type | Payload fields | Semantics |
|---|---|---|
| `daemon.started` | `pid`, `hostname` | Daemon acquired the lock and started the executor |
| `daemon.stopped` | `pid`, `reason: 'clean'\|'leak_limit'\|'signal'\|'error'`, `detail?` | Daemon exiting; emitted before lock release |
| `daemon.reaper_took_over` | `priorPid`, `priorHostname`, `priorHeartbeatAt`, `staleForMs` | Lock TTL exceeded; this daemon force-acquired |
| `daemon.sweep_completed` | `requeued: number`, `quarantined: number`, `durationMs` | Startup sweep finished |
| `daemon.blob_gc_completed` | `deleted: number`, `durationMs` | Orphan-blob GC sweep finished |
| `daemon.leak_detected` | `runId`, `nodeId`, `count`, `ceiling` | A handler leaked past `maxMs + leakGrace`; per-process counter advanced. Only fires for nodes with a numeric `HandlerSpec.maxMs` — unbounded llm (`max_ms=0`) skips the watchdog. |
| `daemon.worktree_provisioned` | `runId`, `ok: boolean`, `errorDetail?` | Provisioner result; `ok: false` records why a run halted at provision time |
| `intent.schedule_create` | `scheduleId`, `workflowRef`, `cwd`, `intervalMs`, `intervalText`, `input?`, `overlapPolicy`, `fireOnCreate` | Operator created a schedule (writer: web/CLI). Audit only — the row in `schedules` is the canonical state |
| `intent.schedule_pause` | `scheduleId` | Operator paused a schedule |
| `intent.schedule_resume` | `scheduleId` | Operator resumed a schedule (no catch-up: `next_fire_at = now + interval_ms`) |
| `intent.schedule_delete` | `scheduleId` | Operator hard-deleted a schedule |
| `fact.schedule_fired` | `scheduleId`, `runId` | Dispatcher enqueued a run for the schedule (also writes `run_id` on the row) |
| `fact.schedule_skipped` | `scheduleId`, `reason: 'overlap'\|'paused'` | Dispatcher skipped a due fire because the prior run is non-terminal under `overlap=skip` |
| `fact.schedule_late` | `scheduleId`, `missedIntervals`, `lastTargetAt` | Emitted *before* the catch-up fire when ≥1 slot was missed; one fire per resume window per proposal §Catch-up policy |
| `fact.schedule_invalid_workflow` | `scheduleId`, `error` | Workflow ref failed to resolve / parse / validate; schedule auto-paused |

Schedule events ride `daemon_events` (not the per-run `events` table) because the dispatcher writes them outside any one run's lifecycle: `intent.schedule_create` arrives before any run exists, `fact.schedule_skipped` may not produce a run at all, and `fact.schedule_fired` carries the new run id on the row's `run_id` column for join-back. The `schedules` table itself is the canonical state; the events here are a queryable audit log.

`run_id` on the row is set for run-scoped daemon events (leak_detected, worktree_provisioned, fact.schedule_fired); global lifecycle / sweep / GC events leave it NULL.

---

## 4. Store interfaces

The store contract is segregated into four sub-interfaces along the
fault lines that actually matter (write vs read, run-state vs analytics
vs daemon coordination). `IEventStore` is preserved as a composite
type alias so existing callers don't break, but new code should depend
on the narrowest interface that fits its needs — analytics routes need
`IAnalyticsReader`, the supervisor needs `IDaemonCoordinator`, the
daemon executor needs the full set.

`SqliteStore` implements all four in a single class today. Splitting
them by surface lets a future implementation back the reader interface
with a Postgres replica or the analytics one with DuckDB without
disturbing the writer.

```typescript
// packages/store/src/types.ts — composite alias, preserved for back-compat.
export type IEventStore = IEventWriter & IEventReader & IAnalyticsReader & IDaemonCoordinator;
```

### 4.1 IEventWriter

Every method that mutates run-level state. Single-transaction surface:
shares the SQLite writer connection, runs under `BEGIN IMMEDIATE`.

```typescript
export interface IEventWriter {
  // Event log
  appendFact(runId: string, events: FactEvent[], expectedVersion: number, opts?: AppendFactOpts): FactAppendResult;
  appendIntent(runId: string, event: IntentEvent): IntentAppendResult;
  appendObservabilityEvents(runId: string, events: ObservabilityEvent[]): { seqs: number[] };

  // Run lifecycle (mutations)
  enqueueRun(params: EnqueueRunParams): void;
  claimNextRun(maxInFlight: number): { runId: string } | null;   // atomic; OCC-protected
  startupSweep(opts?: { priorHeartbeatAt?: number }): SweepResult;
  setRunTitle(runId: string, title: string): void;

  // Messages (write)
  appendMessage(
    runId: string,
    row: Omit<Message, "runId" | "ordinal">,
    opts?: { dedup?: boolean },
  ): { ordinal: number };

  // Artifacts (write)
  putArtifact(scope: ArtifactScope, content: Uint8Array, mime?: string, opts?: { replace?: boolean }): ArtifactRef;

  // Workflow catalog (write)
  saveWorkflow(sha: string, name: string, dotSource: string): void;

  // Maintenance
  vacuum(): void;
  gcBlobs(maxRows?: number): { deleted: number };
  close(): void;
}
```

### 4.2 IEventReader

Read-only run-level reads — state, events, messages, artifacts,
workflows, per-run aggregates. Includes the daemon's wake-pending
sweep helpers (`getWakeCandidates`, `getNextPendingIntent`,
`findOrphanSideEffects`) so the daemon never reaches for `db` directly.

```typescript
export interface IEventReader {
  // Run state + enumeration
  getState(runId: string): RunState | null;
  listRunIds(opts?: ListRunIdsOpts): string[];
  listRunSummaryRows(opts?: ListRunSummaryRowsOpts): RunSummaryRow[];
  runStateCounts(): { running: number; queued: number };

  // Event log
  getEvents(runId: string, opts?: GetEventsOpts): StoredEvent[];
  getEventsByType(runId: string, type: string): StoredEvent[];
  getSnapshotEvents(runId: string): StoredEvent[];  // snapshot.captured + fact.snapshot_recorded in seq order (scrubber feed)
  getLatestEvents(runId: string, limit: number): StoredEvent[];
  getGlobalEventsForward(opts: GetGlobalEventsForwardOpts): StoredEvent[];
  getGlobalEventsAtFloor(opts: GetGlobalEventsAtFloorOpts): StoredEvent[];
  getGlobalEventsLatest(opts: GetGlobalEventsLatestOpts): StoredEvent[];
  getUnappliedIntents(runId: string): StoredEvent[];
  getWakeCandidates(opts: { statuses: readonly RunStatus[]; autoResumeBefore?: number }): WakeCandidateRow[];
  getNextPendingIntent(runId: string, type: IntentType, sinceSeq: number): PendingIntentRow | null;
  findOrphanSideEffects(runId: string): OrphanSideEffectRow[];

  // Messages (read)
  getMessages(runId: string, opts?: GetMessagesOpts): Message[];
  getMessagesNarrow(runId: string, opts?: GetMessagesOpts): NarrowMessage[];
  listThreadsWithMessages(): Array<{ runId: string; threadId: string }>;

  // Per-run aggregates
  getStepAggregates(runId: string): StepAggregateRow[];
  getRunCostTotals(runId: string): RunCostTotalsRow;

  // Artifacts (read)
  getArtifact(scope: ArtifactScope): Uint8Array;
  getArtifactRef(scope: ArtifactScope): ArtifactRef | null;
  findDoneForIntent(runId: string, idempotencyKey: string): ArtifactRef | null;
  getNodeOutputs(runId: string): Map<string, { output: string; success: boolean; timestamp: number }>;

  // Workflow catalog (read) + emergent-paths project listing
  getWorkflow(sha: string): WorkflowRow | null;
  listCwds(): Array<{ cwd: string; lastUpdatedAt: number; runCount: number }>;
}
```

### 4.3 IAnalyticsReader

Dashboard aggregations — `enqueued_at`-anchored windows, bucketed time
series, distributions, drilldown. Distinct from `IEventReader` because
the queries are more expensive (window functions, `json_each` pivots,
multi-row aggregations) and warrant their own connection tuning when
we eventually split workloads — a fat `cache_size` and consistent-read
transactions are appropriate here in a way they aren't on the hot
event-log path.

```typescript
export interface IAnalyticsReader {
  getKpiTotals(window: AnalyticsWindow): KpiTotalsRow;
  getRunsByBucket(window: BucketedWindow): RunsByBucketRow[];
  getSpendByBucket(window: BucketedWindow): SpendByBucketRow[];
  getTokensByBucket(window: BucketedWindow): TokensByBucketRow[];
  getCacheByBucket(window: BucketedWindow): CacheByBucketRow[];
  getHaltDistribution(window: AnalyticsWindow): HaltDistributionRow[];
  getModelDistribution(window: AnalyticsWindow): ModelDistributionRow[];
  getTopWorkflows(window: AnalyticsWindow, limit: number): TopWorkflowRow[];
  getFirstRunAt(window: AnalyticsWindow): number | null;
  getWorkflowDirectory(opts: { cwd?: string }): WorkflowDirectoryRow[];
  getDrilldownPage(filters: DrilldownFilters, opts: { limit: number; cursor?: string | undefined }): DrilldownPage;
  getGlobalMetricsTotals(opts: { sinceMs: number }): GlobalMetricsTotalsRow;
  getGlobalModelBreakdown(opts: { sinceMs: number }): GlobalModelBreakdownRow[];
}
```

### 4.4 IDaemonCoordinator

The `daemon_events` and `daemon_lock` surface — orthogonal to the rest
because no transaction overlaps with run state; the tables are
independent. This is the cleanest interface to extract first if you
ever want a separate process holding the daemon lock.

```typescript
export interface IDaemonCoordinator {
  // daemon_events
  appendDaemonEvent(event: DaemonEvent, opts?: { runId?: string }): { seq: number; ts: number };
  getDaemonEvents(opts?: GetDaemonEventsOpts): DaemonEventRow[];

  // daemon_lock
  acquireDaemonLock(pid: number, hostname: string): DaemonLockResult;
  forceAcquireDaemonLock(pid: number, hostname: string): DaemonLockResult;
  heartbeatDaemonLock(pid: number): void;
  releaseDaemonLock(pid: number): void;
  currentDaemonLock(): DaemonLockRow | null;

  // schedules (proposal: docs/proposals/scheduled-runs.md)
  createSchedule(params: CreateScheduleParams, now: number): Schedule;
  getSchedule(id: string): Schedule | null;
  listSchedules(opts?: { cwd?: string }): Schedule[];
  getDueSchedules(now: number): Schedule[];
  pauseSchedule(id: string, now: number): void;
  resumeSchedule(id: string, now: number): void;
  deleteSchedule(id: string): void;
  recordScheduleFire(scheduleId: string, runId: string, now: number): void;
  recordScheduleSkipped(scheduleId: string, now: number): void;
  getScheduleRuns(scheduleId: string, limit: number): Array<{ runId: string; status: string; enqueuedAt: number }>;
}
```

Schedule methods are CRUD over the `schedules` table plus two
daemon-side advancers (`recordScheduleFire`, `recordScheduleSkipped`)
that the dispatcher fiber calls atomically inside its tick. They
bypass OCC because schedules don't ride the per-run reducer: a
schedule's only state transitions are paused/resumed/fired/deleted,
all single-row updates with no cross-table invariants. Audit rows live
on `daemon_events` (see §3).

### 4.5 Errors and shared types

```typescript
export type ArtifactScope = { runId: string; nodeId: string; iteration: number; key: string };
export type ArtifactRef = ArtifactScope & { sha256: string; sizeBytes: number; mime: string };

export class ConcurrencyError extends Error {}
export class ArtifactCollisionError extends Error {}
export class ArtifactTooLargeError extends Error {}
export class SchemaDriftError extends Error {}
export class QuarantineError extends Error {}
```

`SweepResult`, `EnqueueRunParams`, `GetEventsOpts`, `GetMessagesOpts`,
`GetDaemonEventsOpts`, `NarrowMessage`, `StepAggregateRow`,
`RunCostTotalsRow`, `Project`, the analytics row types, and the
global-feed cursor option types all live in
`packages/store/src/types.ts`. SQL strings are split per-table across
`event-queries.ts`, `run-state-queries.ts`, `message-queries.ts`,
`artifact-queries.ts`, `workflow-queries.ts`, `daemon-queries.ts`, and
`analytics-queries.ts` — each file owns its table's reads + writes.
The drift-lint asserts every method declared above appears verbatim in
the corresponding source interface.

**Implementation notes:**
- All methods synchronous; `bun:sqlite` is sync.
- Every write wraps in `db.transaction(() => ...)()` or the
  equivalent `BEGIN IMMEDIATE` / `COMMIT` pair. `BEGIN IMMEDIATE` grabs
  the write lock up front; busy_timeout handles contention.
- No in-process commit-listener API. Same-process daemons could subscribe but the only consumer that would benefit (the supervisor) lives in the same process as the writer for `appendFact` and a different process for `appendIntent` (web → daemon), so an in-process listener can't cross the boundary that matters. The 50ms supervisor poll covers both directions uniformly. SSE consumers poll `events WHERE seq > ?` directly.

---

## 5. Handler contract

Unchanged in substance from Revision 1; now with `iteration` visible, side-effect envelope carrying `idempotencyKey`, and `ctx.withScope` for sub-agent contexts spawned via the `agent` tool.

```typescript
export type SideEffect = "none" | "idempotent" | "external";

export type HandlerSpec = {
  kind: string;
  sideEffect: SideEffect;
  maxMs?: number;       // optional; llm may opt out via max-ms: 0
  handler: Handler;
};

export interface HandlerContext {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;                  // per-node retry counter (§3.6); 0 on first entry
  readonly signal: AbortSignal;                // AbortSignal.any([steer, timeout, shutdown])
  readonly routing: Readonly<Record<string, unknown>>;
  readonly llm: LlmClient;                     // pre-wired with signal, accounting
  readonly http: HttpClient;                   // pre-wired with signal, timeout
  readonly tools: ToolRegistry;                // narrowed by node.attrs.allowed_tools / denied_tools before the handler sees it
  readonly messages: {
    append(message: AgentMessage): { ordinal: number };   // pi-agent-core AgentMessage; round-trips losslessly
    recent(n: number): Message[];
    since(ordinal: number): Message[];
  };
  readonly artifacts: {
    put(key: string, content: string | Uint8Array, mime?: string, opts?: { replace?: boolean }): ArtifactRef;
    get(key: string): Uint8Array;
    ref(key: string): ArtifactRef | null;
    getFrom(scope: ArtifactScope): Uint8Array;
  };
  readonly externalCall: <T>(params: { toolName: string; args: unknown; attempt?: number }, fn: (idempotencyKey: string) => Promise<T>) => Promise<T>;
  readonly args: Readonly<{ inputs?: Record<string, string> }>;  // substitution args (${{ inputs.x }})
  readonly emit: (type: string, payload: Record<string, unknown>) => void;  // observability events (agent.* / llm.* / tool.* / cost.recorded / summary.*)
  readonly humanInput?: { route: string; note?: string } | string;
  readonly steering?: string;
  readonly env?: ExecutionEnvironment;                      // per-run worktree; falls back to process cwd when unset
  readonly budgetSnapshot?: BudgetSnapshotInput;            // cumulative cost / tokens vs configured ceilings
  readonly withScope: (override: ScopeOverrides) => HandlerContext; // sub-agent sub-contexts (re-narrowed tools, scoped emit/messages/artifacts)
  // No direct fetch, filesystem, DB, or process access.
}

export interface ScopeOverrides {
  nodeId: string;                                           // required — sub-context identity for emit stamping + side-effect keys
  iteration: number;                                        // required — per-context retry counter
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
  humanInput?: { route: string; note?: string } | string;
  steering?: string;
  budgetSnapshot?: BudgetSnapshotInput;
  // Run-level resources (store, llm, http, signal, routing, args,
  // env) are deliberately omitted — captured once at top-level
  // construction and reused across all withScope calls.
}

export type HandlerResult =
  | {
      kind: "transition";
      nextNode?: string;                                // omit to let edge selection decide
      outcomeStatus?: "success" | "fail" | "retry";
      route?: string;                                   // set by llm on routing nodes
      tokens: number;
      costUsd: number;
      inputCostUsd?: number;
      outputCostUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      modelName?: string;
    }
  | {
      kind: "yield_human";
      text: string;
      routes: string[];
    }
  | {
      kind: "halt";
      reason: "budget" | "max_loops" | "error" | "goal_gate_unsatisfied" | "max_retries_exceeded";
      detail?: string;
      // Stage 3 of recoverable-budget-pause.md converts the
      // operator-recoverable halts in this union to pauses. As of
      // docs/proposals/paused-max-retries.md the executor emits
      // `fact.run_paused{reason:"max_retries"}` directly via the
      // `retriesExhaustedPause` sentinel (no longer constructs
      // `kind:"halt", reason:"max_retries_exceeded"` from the retry
      // arm). `goal_gate_unsatisfied` → `fact.run_paused{reason:"goal_gate"}`
      // and `max_loops` → `fact.run_paused{reason:"max_loops"}` still
      // translate at result-to-facts time. `pauseContext` (optional,
      // omitted in this excerpt) carries `currentLimit` + `attempts`
      // so the resulting pause payload reads "exhausted N of M".
      // Genuinely-terminal HaltReasons (`schema_drift`, `aborted_exit`,
      // `occ_exhausted`, `timeout_exhausted`) are emitted by the executor
      // directly; `abort_loop` and `provider_exhausted` are also
      // executor-only and convert to `fact.run_paused` directly.
    }
  | {
      kind: "pause_provider";                            // recoverable provider transport failure
      httpStatus: number | null;                         // null on pre-response network failures
      provider: string;
      errorMessage: string;
      retryAfterMs?: number;                             // provider-supplied Retry-After (ms); honoured exactly when set, otherwise full-jitter exponential
    };
```

`externalCall` is the canonical helper for `side_effect: "external"` tools. It:
1. Canonicalises `params.args` via `canonicalStringify` (sorted keys, rejects non-JSON-serialisable values) and hashes the result → `argsHash`.
2. Computes `idempotencyKey = sha256(runId + nodeId + iteration + argsHash + attempt)`.
3. Emits `fact.side_effect_intent` via the executor (not the handler directly).
4. Invokes `fn(idempotencyKey)`; `fn` passes the key to the provider as an idempotency header.
5. On success: emits `fact.side_effect_done`, returns result.
6. On `AbortError`: does NOT emit `done`; executor will see orphan on replay if we crashed here.
7. On clean failure: emits `fact.side_effect_failed`.

Handlers never compute `argsHash` themselves. The framework owns canonicalisation so structurally-equal args across replay boundaries produce a stable key regardless of how the handler built them.

### Enforced at review
- `no-restricted-imports`: `fetch`, `undici`, `fs`, `child_process` banned inside `handlers/`.
- AST rule: no `await`/`JSON.stringify` inside `.transaction(() => ...)` bodies.
- Handler PRs must: declare `sideEffect`, set `maxMs` (or document why omission is correct for llm-style handlers that self-bound via cost/tokens), include replay property test for external tools.

---

## 6. Daemon loop (pseudocode)

```typescript
async function daemonMain() {
  const pid = process.pid;
  const lock = store.acquireDaemonLock(pid, os.hostname());
  if (!lock.acquired) {
    const current = store.currentDaemonLock()!;
    if (Date.now() - current.heartbeat_at > LOCK_TTL_MS) {
      store.forceAcquireDaemonLock(pid, os.hostname());
    } else {
      console.error(`Daemon already running: pid=${current.pid}`);
      process.exit(1);
    }
  }

  // CRITICAL: before anything else, heal any crash damage
  const sweep = store.startupSweep();
  log.info(`startup: requeued=${sweep.requeued.length} quarantined=${sweep.quarantined.length}`);

  const shutdown = new AbortController();
  process.on("SIGTERM", () => shutdown.abort());
  process.on("SIGINT", () => shutdown.abort());

  startSupervisor(shutdown.signal);      // 50ms tick: heartbeat + intents + watchdog
  await runExecutor(shutdown.signal);

  store.releaseDaemonLock(pid);
  store.close();
}

async function runExecutor(shutdownSignal: AbortSignal) {
  while (!shutdownSignal.aborted) {
    const job = store.claimNextRun(MAX_CONCURRENT_RUNS);
    if (!job) { await sleep(50); continue; }
    runOne(job.runId, shutdownSignal).catch(logAndQuarantine);
  }
}

async function runOne(runId: string, shutdownSignal: AbortSignal) {
  // Zombie detection
  const lock = store.currentDaemonLock();
  if (!lock || lock.pid !== process.pid) return;

  while (!shutdownSignal.aborted) {
    const state = store.getState(runId);
    if (!state || isTerminal(state.status) || state.status === "paused" || state.status === "paused_human" || state.status === "paused_auto" || state.status === "quarantined") return;

    if (state.schema_version !== CURRENT_SCHEMA_VERSION) {
      store.appendFact(runId, [haltFact("schema_drift")], state.version);
      return;
    }

    const unapplied = store.getUnappliedIntents(runId);
    const decision = foldIntents(unapplied, state);

    if (decision.kind === "cancel") {
      store.appendFact(runId, [cancelFact(unapplied)], state.version);
      return;
    }

    const steerAbort = new AbortController();
    const spec = handlerSpec(state.current_node);
    const sigs: AbortSignal[] = [steerAbort.signal, shutdownSignal];
    if (spec.maxMs !== undefined) sigs.push(AbortSignal.timeout(spec.maxMs));
    const nodeSignal = AbortSignal.any(sigs);
    registerAbort(runId, steerAbort);

    const ctx = buildHandlerContext(runId, state, nodeSignal, decision.steering, decision.humanInput);

    let result: HandlerResult;
    try {
      if (spec.maxMs !== undefined) {
        result = await Promise.race([
          dispatch(state.current_node, ctx),
          timeoutRejects(spec.maxMs + LEAK_GRACE_MS),
        ]);
      } else {
        // Unbounded llm — cost/token bounds and operator intents govern.
        result = await dispatch(state.current_node, ctx);
      }
    } catch (err) {
      result = mapErrorToResult(err, nodeSignal);
    } finally {
      unregisterAbort(runId);
    }

    const factEvents = mapResultToFacts(runId, state, result, unapplied);
    try {
      store.appendFact(runId, factEvents, state.version);
    } catch (err) {
      if (err instanceof ConcurrencyError) continue;
      throw err;
    }
  }
}
```

---

### Credential storage

Built-in pi-ai provider credentials (api_key + OAuth tokens) live in
the `provider_credentials` table on the global store
(`~/.swarm/swarm.db`). The store is the only credential coordination
surface: the harness daemon, `swarm serve`, and `swarm providers`
share one view of which providers are credentialed, and OAuth refresh
is last-writer-wins under SQLite WAL rather than file-locked. Keys
are stored verbatim — no `!cmd` / env-var resolution anywhere in the
credential path.

### Custom-provider config storage

Custom-provider definitions (Ollama, vLLM, LM Studio, corporate
proxies, plus any built-in-provider overrides) live in the
`provider_config` table on the same global store. One row per
provider id; the JSON `config` blob carries the `ProviderConfigSchema`
body (`baseUrl`, `headers`, `compat`, `models`, `modelOverrides`)
minus the `apiKey` field — credentials always go through
`provider_credentials`. `ModelRegistry.loadCustomModels` Ajv-validates
each row on read; one corrupt row is skipped (surfaced via
`registry.getError()`) without poisoning sibling providers. The
`!cmd` / env-var resolver that previously backed the `apiKey` field
and header values (`packages/agent/src/credentials/resolve-config-value.ts`)
is deleted entirely; secrets that previously rode through that shim
live in `provider_credentials` plus `authHeader: true` instead. See
proposal: `docs/proposals/provider-config-storage.md`.

## 7. Web server

```typescript
app.post("/runs", async (c) => {
  const body = await c.req.json() as {
    workflowSha: string;
    runId?: string;
    priority?: number;
    routing?: Record<string, unknown>;
    input?: string;          // free-form description → routing.input (auto-title seed; not substituted)
    inputs?: Record<string, string>;  // typed inputs → routing.inputs → ${{ inputs.x }}; validated against the inputs: block (400 invalid_inputs)
    cwd?: string;            // absolute project root at enqueue time; surfaced on run_state.cwd
    workflowName?: string;   // resolved name when the caller passed a bare name
    workflowScope?: "global" | "local" | "path" | "ephemeral";
    workflowPath?: string;   // filesystem path of the workflow file at resolution time
    title?: string;          // explicit run title; stored immediately and suppresses the auto-titler
  };

  // Preflight 1: at least one provider credential must be reachable.
  const provider = preflightProviders?.();
  if (provider && !provider.ok) {
    return c.json({ error: provider.detail, code: "provider_unavailable" }, 400);
  }
  // Preflight 2: backpressure on queued runs (running runs are bounded
  // separately by the daemon's maxConcurrentRuns).
  if (maxQueuedRuns != null && store.runStateCounts().queued >= maxQueuedRuns) {
    c.header("Retry-After", "30");
    return c.json({ error: "queue full", code: "queue_full" }, 429);
  }

  // Validate body.inputs against the workflow's inputs: block (400 on a
  // missing required input or out-of-range choice) before enqueue.
  const runId = body.runId ?? newRunId();
  const initialRouting = { ...(body.routing ?? {}) };
  if (typeof body.input === "string" && initialRouting.input === undefined) {
    initialRouting.input = body.input;
  }
  if (body.inputs != null && initialRouting.inputs === undefined) {
    initialRouting.inputs = body.inputs;
  }
  store.enqueueRun({ runId, workflowSha: body.workflowSha, priority: body.priority,
                     initialRouting, cwd: body.cwd,
                     workflowName: body.workflowName, workflowScope: body.workflowScope,
                     workflowPath: body.workflowPath });
  return c.json({ runId });
});

app.post("/runs/:id/steer",        async (c) => writeIntent(c, "intent.steering_requested"));
app.post("/runs/:id/pause",        async (c) => writeIntent(c, "intent.pause_requested"));
app.post("/runs/:id/cancel",       async (c) => writeIntent(c, "intent.cancel_requested"));
app.post("/runs/:id/human",        async (c) => writeIntent(c, "intent.human_input"));
app.post("/runs/:id/resume",       async (c) => writeIntent(c, "intent.resume"));
app.post("/runs/:id/unquarantine", async (c) => writeIntent(c, "intent.unquarantine"));
app.post("/runs/:id/priority",     async (c) => writeIntent(c, "intent.priority_adjusted"));
app.post("/runs/:id/budget",       async (c) => writeIntent(c, "intent.budget_adjusted"));  // {scope, metric, newLimit>0, note?}
app.post("/runs/:id/max_retries",  async (c) => writeIntent(c, "intent.max_retries_adjusted"));  // {nodeId, newLimit>0, note?}
app.post("/runs/:id/goal_gate",    async (c) => writeIntent(c, "intent.goal_gate_adjusted"));    // {newLimit>0, note?}
app.post("/runs/:id/max_loops",    async (c) => writeIntent(c, "intent.max_loops_adjusted"));    // {newLimit>0, note?}

// Schedules surface (proposal: docs/proposals/scheduled-runs.md).
// CRUD over the `schedules` table plus pause/resume verbs. Each
// mutation lands a matching `intent.schedule_*` audit row on
// `daemon_events`. Body of POST /schedules:
//   { workflow, cwd, every: "30m"|"1h"|"6h"|"24h",
//     input?, overlap?: "skip"|"queue"|"concurrent", fireOnCreate?: bool }
// `every` outside the four-value whitelist returns 400
// `code:"invalid_interval"`; bad overlap returns `code:"invalid_overlap"`.
app.post("/schedules",                async (c) => createSchedule(c));
app.get("/schedules",                 (c) => c.json(store.listSchedules({ cwd: c.req.query("cwd") })));
app.delete("/schedules/:id",          (c) => deleteSchedule(c));
app.post("/schedules/:id/pause",      (c) => pauseSchedule(c));
app.post("/schedules/:id/resume",     (c) => resumeSchedule(c));

// Skills + agents discovery surface (proposal: docs/proposals/skills-and-agents-ui.md).
// Read-only views over the live filesystem; each request re-walks
// `cwd ∪ store.listCwds()` (frontmatter-only, ms-scale). Identity in
// detail / tree / file URLs is `:locId = base64url(skill_dir)` for
// skills and `base64url(location)` for agents — names aren't unique
// across projects, so the absolute path is the canonical handle.
// `?project_cwd=<cwd>` on list endpoints filters to globals + that one
// project's project-scope records.
app.get("/skills",                    (c) => listSkills(c));
app.get("/skills/:locId",             (c) => skillDetail(c));     // metadata + frontmatter + SKILL.md body
app.get("/skills/:locId/tree",        (c) => skillTree(c));        // recursive walk under skill_dir
app.get("/skills/:locId/file",        (c) => skillFile(c));        // ?path=<rel>; sandboxed to skill_dir
app.get("/agents",                    (c) => listAgents(c));
app.get("/agents/:locId",             (c) => agentDetail(c));      // metadata + body (the prompt)

// Worktree snapshot read endpoints (docs/proposals/worktrees.md §Server endpoints,
// step 5). Pure git object-database queries — no checkouts, no worktree
// mutation. Snapshot commits are reachable via refs/swarm/snapshots/<runId>;
// eventIdx in the URL is the event seq, resolved to a commitSha by walking
// the run's snapshot events. All endpoints 404 on unknown run or eventIdx.
app.get("/runs/:id/snapshots",                    (c) => { /* ordered scrubber feed: Array<{eventIdx,nodeId,label,commitSha,treeSha,committed,uncommitted}> */ });
app.get("/runs/:id/snapshots/:eventIdx/tree",     (c) => { /* git ls-tree → {entries:[{path,mode,size,type}]} */ });
app.get("/runs/:id/snapshots/:eventIdx/file",     (c) => { /* git show <sha>:<path> → text/plain or application/octet-stream; ?path= required */ });
app.get("/runs/:id/snapshots/:eventIdx/diff",     (c) => { /* git diff → text/x-diff; ?against=base|previous|<eventIdx>; optional &path= */ });

// JSON-batch read of a run's events; pagination via ?since / ?limit.
app.get("/runs/:id/events", (c) => {
  const sinceSeq = Number(c.req.query("since") ?? 0);
  const limit = Math.min(Number(c.req.query("limit") ?? 1000), 5000);
  return c.json(store.getEvents(c.req.param("id"), { sinceSeq, limit }));
});

// Per-run conversation transcript: pi-agent AgentMessage rows, ordered
// by per-run `ordinal`. `nodeId` stamps which node appended each
// message. Used by the web conversation view and post-mortem tooling.
// Returns the narrow wire shape `{ ordinal, nodeId, content }` —
// `?nodeId=` filters to one thread, `?sinceOrdinal=` for resume-style
// pagination, `?limit=` caps the result set.
app.get("/runs/:id/messages", (c) => {
  const runId = c.req.param("id");
  if (store.getState(runId) == null) return c.json({ error: "not_found" }, 404);
  const opts: { nodeId?: string; sinceOrdinal?: number; limit?: number } = {};
  const nodeId = c.req.query("nodeId"); if (nodeId) opts.nodeId = nodeId;
  const since = Number(c.req.query("sinceOrdinal")); if (Number.isFinite(since)) opts.sinceOrdinal = since;
  const lim = Number(c.req.query("limit"));   if (Number.isFinite(lim) && lim > 0) opts.limit = lim;
  return c.json(store.getMessagesNarrow(runId, opts));
});

// Per-LLM-call snapshots merged with SQL-aggregated cost/token totals.
// Two-pass projection: eventsToSteps extracts static per-step fields
// from the event log; getStepAggregates runs a SQL window aggregation
// for cost/token totals; attachStepAggregates merges them; then
// fillOrphanDurations backfills durationMs for steps with no llm.done.
app.get("/runs/:id/steps", (c) => {
  const runId = c.req.param("id");
  const state = store.getState(runId);
  if (state == null) return c.json({ error: "not_found" }, 404);
  const events = store.getEvents(runId);
  const steps = attachStepAggregates(eventsToSteps(events), store.getStepAggregates(runId));
  const lastEventTs = events.at(-1)?.ts;
  return c.json(fillOrphanDurations(steps, { lastEventTs, runIsTerminal: isTerminalStatus(state.status) }));
});

// SSE stream of the same events; resumable via Last-Event-ID or ?sinceSeq.
app.get("/runs/:id/stream", (c) => streamSSE(c, async (stream) => {
  const runId = c.req.param("id");
  let sinceSeq = parseSeqCursorMax(c.req.query("sinceSeq"), c.req.header("Last-Event-ID"));
  while (!stream.aborted) {
    const events = store.getEvents(runId, { sinceSeq, limit: 500 });
    for (const e of events) {
      // No `event:` field on the wire — the type lives inside the JSON
      // payload, so the browser dispatches every frame via a single
      // `addEventListener("message", …)` and reads `.type` from there.
      // Avoids registering ~45 typed listeners per mount for zero gain.
      await stream.writeSSE({ id: String(e.seq), data: JSON.stringify(e) });
      sinceSeq = e.seq;
    }
    if (events.length === 0) await sleep(100);
  }
}));

```

No IPC. No daemon dependency for reads or intent writes. Polling is the whole story.

---

## 8. Queue fairness

**Rule.** Within a priority tier, FIFO on `ready_at`. `ready_at` is reset to `now()` on every transition INTO `queued` (initial enqueue, HITL wake, crash requeue, unquarantine-retry). Ties break by `run_id` (deterministic, seeded by ULID-like ordering).

```sql
ORDER BY priority DESC, ready_at ASC, run_id ASC
```

**Why this over alternatives:**

| Strategy | Behavior | Why rejected |
|---|---|---|
| Preserve original `enqueued_at` on resume | Long-paused runs jump to front on wake | Starves new submissions |
| Priority boost on HITL wake | Interactive runs preempt batch | Priority inversion; hogging |
| Round-robin per workflow | Fair across workflows | Complex; unclear within-workflow |
| **FIFO on `ready_at`** | Everyone queues fresh on transition | Simple; predictable; no starvation at single-machine scale |

**Scenario — N priority-10 runs wake from HITL simultaneously:**
SQLite serializes the N `intent.human_input` commits; each human-resume transaction sets `ready_at = now()` inside the same txn. Even at ms-level clustering, SQL commit order gives each a distinct `ready_at`; ties break by `run_id`. The claim index (`priority DESC, ready_at ASC, run_id ASC`) pops them deterministically in commit order. No thundering herd.

**Not starvation-free in theory:** a relentless priority-11 stream starves priority-10. That's priority's point. If workflow-level fairness becomes a need, add `workflow_max_concurrent` per workflow (cheap partial-index count). Not needed day 1.

**Observability:**
- Derive `wait_time_ms = now() - ready_at` at read time; expose in UI.
- `intent.priority_adjusted` is the operator escape hatch if something starves.

**Edge — operator cancel mid-resume:**
Human-wake (`intent.human_input`) and `intent.cancel_requested` can arrive in either order. Both are intents, both non-OCC, both processed by the daemon supervisor's fold. The fold prioritizes `cancel` deterministically: if both present, run becomes `cancelled` regardless of order. Documented in fold semantics.

---

## 9. Size bounds

| Name | Value | Enforced by |
|---|---|---|
| `MAX_EVENT_PAYLOAD_BYTES` | 4096 | `events.payload CHECK (length(...) < N)` + store pre-check (`s.length >= N`) |
| `MAX_ROUTING_BYTES` | 8192 | `run_state.routing CHECK (length(...) < N)` + store pre-check |
| `MAX_BLOB_BYTES` | 16 * 1024 * 1024 | Store module; throws `ArtifactTooLargeError` (gated on `Uint8Array.byteLength > N`) |
| `MAX_MESSAGE_CONTENT_BYTES` | 1024 * 1024 | `messages.content CHECK (length(...) < N)` + store pre-check throws `MessageTooLargeError` |
| `MAX_PREVIEW_CHARS` | 512 | Handler convention |

**Limit semantics:** for the four `<` CHECKs, the largest value that lands
successfully is `N - 1`; the constant is the *first rejected size*. Pre-flight
checks use the same `>=` shape, so JS code and SQL agree on rejection
threshold. `MAX_BLOB_BYTES` is the only inclusive cap (`> N` rejects).

**Unit caveat:** JS `string.length` is UTF-16 code units; SQLite `length()`
on TEXT is Unicode code-point count. They agree on BMP characters and diverge
by up to 2× on surrogate-pair-heavy content. The pre-flight check is the
binding constraint in practice — it runs first and is stricter for non-BMP
content. `MAX_BLOB_BYTES` is the only honest-bytes constant.
| `MAX_CONCURRENT_RUNS` | 8 (configurable) | `claimNextRun` |
| `LOCK_TTL_MS` | 30000 | Daemon lock reclaim |
| `HEARTBEAT_INTERVAL_MS` | 5000 | Supervisor fiber |
| `SUPERVISOR_TICK_MS` | 50 | Supervisor fiber |
| `SSE_POLL_MS` | 100 | Web SSE handler |
| `LEAK_GRACE_MS` | 10000 | Hard timeout grace |
| `ABORT_LOOP_CEILING` | 5 | Executor → `fact.run_paused{reason:"abort_loop"}` (operator-resumable per Stage 3) |
| `MAX_LOOPS` | 1000 (configurable via `ExecutorOpts.maxLoops`; per-run override via `intent.max_loops_adjusted`) | Executor → `fact.run_paused{reason:"max_loops"}` (operator-resumable per Stage 3) |

---

## 10. Property-test matrix

Harness: `fast-check` with seed-reproducible runs. Clock injected. SQLite in-memory or tmp-file.

| # | Invariant | Generator | Assertion |
|---|---|---|---|
| P1 | Seq monotonic & contiguous per run | N fibers × K writes | `events.seq = 1..NK` contiguous; `run_state.next_seq` matches |
| P2 | OCC correctness | K fibers racing `appendFact(v=N)` | Exactly one succeeds; K-1 `ConcurrencyError` |
| P3 | Intent never lost | Intents interleaved with aborts | All submitted intents in `getEvents` |
| P4 | Projection = fold | Random event sequences | `getState` ≡ `events.reduce(reducer)` |
| P5 | Crash recovery requeue | Kill at random SQL boundary | Startup sweep requeues all `running`; no half-applied txn |
| P6 | Orphan quarantine | Kill between `intent` and `done` | Startup → run `quarantined`; no re-run |
| P7 | Unquarantine retry | `intent.unquarantine:retry` | Run resumes; tool re-executes with same `idempotencyKey` |
| P8 | Mid-flight abort → replay | Abort at random await points | `fact.node_aborted` present; next turn converges; external tool count ≤ 1 per `idempotencyKey` |
| P9 | Daemon singleton | Start two daemons | Second exits non-zero; lock unchanged |
| P10 | Concurrency bound | Enqueue 100 runs, `MAX=4` | `COUNT(status='running') ≤ 4` at every snapshot |
| P11 | HITL durability | Pause → kill → restart → input | Progresses from exact stop point |
| P12 | Event payload bound | 5KB payload attempt | Throws; no insert |
| P13 | Routing bound | 10KB routing attempt | Throws; projection unchanged |
| P14 | Blob dedup | Identical content twice | Single `blobs` row; two `artifacts` |
| P15 | Artifact loop scoping | Same node, 3 iterations, same key | 3 distinct `artifacts` rows; no PK violation |
| P16 | Blob GC | Delete run; sweep | Orphan blobs removed; shared blobs retained |
| P17 | Schema drift refusal | Resume with mismatched version | `RUN_HALTED { reason: "schema_drift" }` |
| P18 | Zombie daemon commit | Force-acquire; original commits | Commit fails (OCC or lock check); original exits |
| P19 | SSE replay | Reconnect with `Last-Event-ID=N` | Receives `seq > N` in order |
| P20 | Abort loop ceiling | K>5 consecutive aborts, no progress | `fact.run_paused{reason:"abort_loop"}` (operator-resumable per Stage 3) |
| P21 | Queue fairness | N priority-10 HITL wakes | Claim order = commit order of `intent.human_input` |
| P22 | Cascade delete | Delete run_state row | events/messages/artifacts for that run all gone; blobs unchanged |
| P23 | STRICT enforcement | Insert string into integer column | Throws; no row inserted |
| P24 | Claim atomicity | K fibers racing `claimNextRun` | Each popped run claimed by exactly one fiber |
| P25 | Pre-commit recorder durability | `recordIntent` then no `recordDone` (simulated hard crash) | Intent fact in `events` before recorder returns; sweep quarantines without a matching done having ever existed |
| P26 | Artifact replay safety | Same-scope `putArtifact` calls with identical / differing content | Identical → no-op (existing ref); differing → `ArtifactCollisionError` unless `{ replace: true }`; only one row per scope |
| P27 | Intent fold truth table | Random batches of intents × all `RunStatus` values | Cancel always wins if present; pause coexists with steer/human as `shouldPauseAfterDispatch`; multi-instance human/priority last-wins; every intent ends up applied or in `dropped`; per-state preconditions enforced. See [`docs/intent-fold.md`](./intent-fold.md) |

---

## 11. Module layout

```
packages/
  store/
    src/
      schema.sql
      pragmas.ts
      migrations.ts
      store.ts                         ← IEventStore impl
      reducers.ts                      ← fact fold
      sweep.ts                         ← startup sweep (requeue + quarantine)
      types.ts
    test/                              ← property + unit
  core/
    src/
      parser/                          ← YAML parser
      handler/                         ← HandlerContext, HandlerSpec, Handler
        handlers/                      ← wait-human, tool, ...
        context.ts                     ← buildHandlerContext (per-call env)
        external-call.ts               ← idempotency key + intent/done envelope
      engine/
        edge-selection.ts              ← two-case algorithm: route-case | outcome-case (SPEC §3.6)
        retry-policy.ts                ← per-node retry counter (§3.6)
        thread.ts                      ← thread_id resolution
        substitution.ts                ← ${{ inputs.x }} only (SPEC §3.8)
      types/
        execution.ts                   ← ExecutionEnvironment interface
        events.ts                      ← fact + intent + observability
        summariser.ts                  ← SummariserBackend port
        ...
      executor/
        types.ts                       ← LlmBackend, LlmInput
  daemon/
    src/
      executor.ts                      ← executor fiber
      supervisor.ts                    ← heartbeat + intents + watchdog tick
      abort-registry.ts                ← runId → AbortController map
      dispatch.ts                      ← node-kind → handler
      auto-dispatcher.ts               ← shape → HandlerSpec fallback
      result-to-facts.ts               ← HandlerResult → FactEvent[]
      wake-pending.ts                  ← pending HITL + cancel + unquarantine + auto-resume sweeps
      auto-titler.ts                   ← run.title_generated summariser
      worktree-provisioner.ts          ← per-run WorktreeEnvironment map
      entrypoint.ts                    ← startDaemon
  agent/
    src/
      backend.ts                       ← PiLlmBackend (pi-agent-core)
      handler-bridge.ts                ← makeLlmHandler (LlmBackend → HandlerSpec)
      summariser.ts                    ← PiSummariserBackend
      thread.ts                        ← buildSummarySeed (summariser-backed)
      event-bridge.ts                  ← pi-agent AgentEvent → swarm EventType
      tool-adapter.ts                  ← swarm Tool → pi AgentTool
      message-store.ts                 ← in-process per-thread transcript cache
      system-prompt.ts                 ← buildSystemPrompt (context-files + skills + runEnv)
  server/
    src/
      index.ts                         ← createServer
      store/
        routes.ts                      ← intents (POST), SSE
        runs-routes.ts                 ← runs/messages/events/steps reads
        runs-adapter.ts                ← RunSummary / RunDetail projection
        steps.ts                       ← llm.start fold → Step[]
  workspace/
    src/
      local-env.ts                     ← LocalEnvironment (process cwd)
      worktree-env.ts                  ← WorktreeEnvironment (git worktree per run)
      tools.ts                         ← read / write / edit / bash
      skills/                          ← SKILL.md discovery + catalog
  web/                                 ← UI (React + Tanstack Router)
  cli/                                 ← bin/swarm.ts + commands/*.ts
```


---

## 12. Deferred decisions

- **Blob encryption** for secret-bearing outputs — single-user local; deferred.
- **Cross-machine deployment** — single-machine by design. `IEventStore` is synchronous (matches `bun:sqlite`); a Postgres backing would require async-ifying the interface and every callsite, so this is a future direction rather than a clean drop-in.
- **Retention policies** per workflow — manual `swarm prune` until demand.
- **Blob streaming** for >16MB — handler must chunk; revisit on real use case.
- **Auto-migration across breaking schema bumps** — refuse + manual for v1. Additive bumps are handled in-place by `applyAdditiveMigrations` (`packages/store/src/migrations.ts`) without touching the version row's compat range.
- **Workflow hot-reload for in-flight runs** — not planned; `workflow_sha` pinned.
- **Per-workflow concurrency caps** — add when needed; easy via partial-index counts.

### 12.1 Handler coverage

Five handler kinds dispatch end-to-end through `auto-dispatcher.ts`:
`start`, `exit`, `llm`, `human`, `tool`. The pure reducers
behind them (`retry-policy.ts`, `edge-selection.ts`,
`external-call.ts`) are property-tested.

Read-only enforcement on review/observer nodes is structural at three
layers: (a) `ctx.tools` is narrowed via `ToolRegistry.select` before
the `HandlerContext` is built; (b) the llm backend re-applies
`select(...)` on its workspace registry before handing tools to pi-ai;
(c) `ctx.env` is wrapped in a read-only proxy when no mutating tool
(`bash` / `write` / `edit`) is visible, so `env.writeFile` /
`env.exec` throw `ReadOnlyEnvError` even for handlers that bypass the
tool registry.

Known gaps in coverage live as proposals in [`proposals/`](./proposals/) — see [`proposals/README.md`](./proposals/README.md) for the index.

---

## 13. Risks ranked

1. **Handler discipline drift** — #1 long-term risk. Structural lint + review gate mandatory. A single handler ignoring `AbortSignal` breaks invariants.
2. **Provider without idempotency support** — any external tool that can't accept a dedup key cannot be made safe; operator review is the only line of defense. Tag loudly.
3. **SQLite write throughput ceiling** — unknown until measured. Counter-based seq (1.5) + BEGIN IMMEDIATE + STRICT + partial indexes should be comfortable below 1000 writes/sec. Measure in M6.
4. **LLM provider abort leakage** — real and uncontrollable; `Promise.race` bounds; `handler_timeout_leaked` records truth.
5. **Mid-flight external tool double-execution** — provider idempotency keys + quarantine close the window; relies on (2).
6. **Schema drift for long-paused runs** — refusing to resume is safe but operationally annoying; acceptable v1.

---

## 14. What this architecture buys

- **One coordination surface.** All races resolve in SQLite; nothing in the filesystem; no unix sockets.
- **Zero-cost pause snapshots.** Projection always current; pausing = emitting an event.
- **Deterministic property tests.** Seed-reproducible across the full coordination seam.
- **Web works daemon-down.** Reads + intent writes never block on daemon availability.
- **Content-addressed blobs.** Deduplication, loop-safe replay, clean GC.
- **Orphan side effects are caught, not masked.** Quarantine + idempotency keys = at-most-once jointly with provider.
- **Fair, predictable queueing.** `ready_at` FIFO; no hidden scheduler rules.
- **Auditable.** Every state transition is a durable event; `events` table is system memory.
