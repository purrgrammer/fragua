# swarm — Architecture

> **Authoritative.** The design the codebase implements. Companion to [`SPEC.md`](./SPEC.md) (goals) and [`handler-contract.md`](./handler-contract.md) (writing handlers).
>
> SQLite-backed event store with projection-in-transaction, intent/fact split, hard-abort semantics, content-addressed blob storage. No filesystem coordination surface.

---

## 0. Context and decisions

### What we're committing to
- **Single coordination surface: one SQLite database.** All state, events, queue, locks, and artifact metadata. Two processes (daemon, web server) both read and write. WAL mode handles multi-process access. Artifact *content* lives on the filesystem under `blobsDir`, keyed by sha256 — keeping raw bytes out of the WAL.
- **Event sourcing with projection-in-transaction.** Events are the immutable log of truth. A materialized projection (`run_state`) is updated inside the same transaction as the event append. Reads of current state are one row; event fold is only used for migration/debug.
- **Intent/fact split.** Web writes intents (always-appendable, no OCC). Daemon writes facts (OCC-checked against `run_state.version`). 90% of retry pressure disappears.
- **Hard abort for all interrupts.** Pause, cancel, and steer all trip a single `AbortSignal`. Handlers unwind, emit `fact.node_aborted` with partial metrics, executor re-enters (or halts) based on new state.
- **Durable HITL via unwind-and-rehydrate.** `wait.human` nodes return `yield_hitl`, the executor emits `fact.run_paused_hitl`, the process is free. Human input (intent event) wakes the daemon; it rehydrates from the projection and resumes at the next node.
- **Content-addressed blobs on disk.** Tool outputs never inline in event payloads or the WAL. Handlers write raw content to `<blobsDir>/<first2>/<sha256>`; a metadata row in `blobs` points at it. Events carry a ref + bounded preview. File-then-row commit ordering: a crash can leave orphan files (GC sweeps), never dangling rows.
- **Orphan-side-effect quarantine.** External tools use provider idempotency keys; on crash-replay, orphaned `SIDE_EFFECT_INTENT` without matching `DONE` quarantines the run for operator review. No blind retry.
- **No IPC.** Daemon↔web coordination is SQLite polling (50ms daemon supervisor, 100ms SSE). No unix socket. No stale `.sock` cleanup. No `EADDRINUSE`.
- **Singleton daemon via `daemon_lock` row with heartbeat.** Zombie detection on reclaim + startup sweep of mid-flight runs.
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
  - `detectStuckNodes()` — watchdog for handlers that exceeded `maxMs + LEAK_GRACE_MS`
- **Web SSE streams** poll `events WHERE seq > ?` every 100ms per subscribed run. At 10 concurrent subscribers, ≈100 qps of indexed reads; <1ms each.
- **No `.sock` file.** Nothing to clean up on crash. Nothing to reconcile on restart.

### 1.4 Crash-recovery limbo
**Attack.** Daemon hard-crashes while runs were `running`. On restart, those rows still say `running`; the executor only claims `queued`; runs sit dead until watchdog fires a minute later.

**Resolution.** **Startup sweep** runs before the executor loop, in a single transaction:

```sql
-- (a) Requeue crash-interrupted runs
UPDATE run_state
   SET status = 'queued',
       current_node = NULL,
       node_started_at = NULL,
       ready_at = :now,
       version = version + 1,
       updated_at = :now
 WHERE status = 'running'
 RETURNING run_id, version;

-- For each returned run_id, append fact.run_requeued_after_crash

-- (b) Quarantine orphans (see 1.1)
-- (c) paused, paused_hitl, and quarantined runs are NOT touched
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
**Attack.** The LLM provider returns 402 (insufficient balance), 429 (rate limit), 5xx, or the network drops mid-stream. pi-ai surfaces this as `AssistantMessageEvent { type: "error" }`; without intervention the codergen handler converts it into `outcome.status = "fail"`, indistinguishable from a deliberate `<abort>`. The run halts and all completed work in the transcript is abandoned even though it survives in the `messages` table.

**Resolution.**
1. **HTTP-status capture.** `PiCodergenBackend` registers `StreamOptions.onResponse` to record the last `ProviderResponse.status` per LLM call. On stream `error`, the captured status (or `null` for pre-response network failures) is paired with the provider's `errorMessage` and bubbled out as a new outcome shape.
2. **Handler-result kind `pause_provider`.** The handler-bridge translates the provider-error outcome to `HandlerResult.kind = "pause_provider"` carrying `{ httpStatus, provider, errorMessage }`. The executor commits `fact.run_paused` with `reason: "payment_required"` for 402 (top-up off-ledger) or `reason: "provider_error"` otherwise, and transitions the run to `paused`.
3. **Generic resume intent.** Operator writes `intent.resume`. The daemon wakes the run back to `queued` and re-dispatches the same `(nodeId, iteration)` with the rehydrated transcript loaded as `priorMessages`. Worktree, branch, and message ordering all survive — same path as `paused_hitl` rehydration.
4. **Manual + auto classes.** 408 / 429 / 5xx / 529 / network errors carry `policy: "auto-retry"` on the same fact and project to `paused_provider_retry` for timer-driven wake. 400 / 401 / 402 / 403 / 404 / 413 / 422 stay manual (`paused`); auto-retry against a busted account would burn money.

### 1.11 Remaining concerns
- **sha256 oracle for blobs** — deferred to optional encryption later; single-user local tool has DB read = full read anyway.
- **SSE push ordering** — not an issue in polling model. Consumers read `seq > lastSeen`, always consistent.
- **Intent-flood DOS** — retry-storm ceiling (abort-loop detector emits `RUN_HALTED { reason: "abort_loop" }` after K=5 consecutive aborts without progress). HTTP rate-limit at web layer.
- **WAL bloat from large artifacts** — `blobs` holds metadata only; content lives on the filesystem so multi-MiB writes never frame into the WAL. Live SSE readers can't pin large blob bytes in the WAL as a result. See §2.
- **Schema drift across long pauses** — `schema_version` pinned per run; the daemon resumes any version inside the compatibility range `[MIN_COMPATIBLE_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION]`. Step-delta migrations live in `packages/store/src/migrations.ts` keyed by target version; existing DBs at `version < CURRENT` walk each delta in order. Halt only out-of-range pins with `fact.run_halted { reason: "schema_drift" }`. Current state: `MIN_COMPATIBLE_SCHEMA_VERSION = 1`, `CURRENT_SCHEMA_VERSION = 2` (v2 collapses `paused_provider_error` into the unified `paused` status carrying a reason-discriminated `fact.run_paused`). See `packages/store/src/pragmas.ts` and `packages/store/src/migrations.ts`.
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
    'queued','running','paused','paused_hitl','paused_provider_retry','paused_retry',
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
  workflow_path TEXT,                             -- .dot file path at resolution time; diagnostic
  base_git_sha TEXT,                              -- HEAD sha of worktree at provision time; NULL when no provisioner
  branch TEXT,                                    -- preserved on dispose when working-copy delta exists; NULL otherwise
  total_cost_usd REAL GENERATED ALWAYS AS
    (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
  billed_tokens INTEGER GENERATED ALWAYS AS
    (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
) STRICT;

-- Partial index = queue in disguise; O(log N) claim
CREATE INDEX idx_run_state_queue
  ON run_state(priority DESC, ready_at ASC)
  WHERE status = 'queued';

CREATE INDEX idx_run_state_status   ON run_state(status);
CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
CREATE INDEX idx_run_state_updated  ON run_state(updated_at);
CREATE INDEX idx_run_state_cwd      ON run_state(cwd);

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
| `intent.hitl_input` | `selected: string`, `note?: string` | Wake a `paused_hitl` run; `selected` is the accelerator key chosen by the operator |
| `intent.resume` | `note?: string` | Generic wake for any `paused_*` run; re-dispatches the same `(nodeId, iteration)` |
| `intent.unquarantine` | `resolution: 'treat_as_done'\|'retry'\|'cancel'`, `note?: string` | Operator acknowledgement for a quarantined run |
| `intent.priority_adjusted` | `newPriority: number`, `note?: string` | Operator bump |
| `intent.budget_adjusted` | `scope: 'node'\|'run'`, `metric: 'cost'\|'tokens'`, `newLimit: number` (>0), `note?: string` | Operator raises a budget ceiling on a `paused{reason:'budget'}` run; folded into `routing.budget_override.<scope>.<metric>` so the next turn-boundary budget check uses the new ceiling. Web bundles a follow-up `intent.resume` ("Raise & Resume"); intents stay separate at the protocol level |

### Fact events (writer: `daemon`, OCC-checked)
| Type | Payload fields | Semantics |
|---|---|---|
| `fact.run_started` | `workflowSha`, `schemaVersion`, `startNode`, `baseGitSha?` | Run enters `running` |
| `fact.dispatch_started` | `nodeId`, `iteration`, `resumeOf: 'fresh'\|'crash'\|'paused'\|'paused_hitl'\|'paused_provider_retry'\|'paused_retry'\|'quarantined'` | Stamps `dispatchStartedAt` for activeMs accounting; lets analytics distinguish "ran straight through" from "had to be woken up" |
| `fact.node_started` | `nodeId`, `iteration` | Node dispatched |
| `fact.node_completed` | `nodeId`, `iteration`, `outputRef?`, `tokens`, `costUsd`, `inputCostUsd?`, `outputCostUsd?`, `inputTokens?`, `outputTokens?`, `cacheReadTokens?`, `cacheWriteTokens?`, `modelName?`, `nextNode`, `outcomeStatus?: 'success'\|'partial_success'\|'fail'\|'retry'\|'skipped'` | Node succeeded. Cost / token splits are optional for back-compat; the run-level reducer defaults missing fields to 0. `outcomeStatus` lets the UI distinguish "completed OK" from "completed with outcome=fail" without walking edges |
| `fact.node_aborted` | `nodeId`, `iteration`, `cause`, `partialTokens`, `partialCostUsd`, `partialInputCostUsd?`, `partialOutputCostUsd?`, `partialInputTokens?`, `partialOutputTokens?`, `partialCacheReadTokens?`, `partialCacheWriteTokens?` | Mid-flight abort. Partial cost / token splits cover work done before the abort; optional for back-compat with pre-split runs |
| `fact.intents_folded` | `intentSeq`, `folded` | Operator intents (steer / hitl / priority / pause) merged into routing/messages by the fold |
| `fact.side_effect_intent` | `nodeId`, `iteration`, `toolName`, `argsHash`, `attempt`, `idempotencyKey` | External tool about to run |
| `fact.side_effect_done` | `idempotencyKey`, `artifactKey`, `tokens?`, `costUsd?` | External tool completed |
| `fact.side_effect_failed` | `idempotencyKey`, `errorCode`, `retriable: bool` | External tool failed cleanly |
| `fact.tool_completed` | `toolName`, `argsHash`, `artifactKey`, `preview`, `summary?` | Non-external tool result |
| `fact.message_appended` | `ordinal`, `role`, `nodeId: string\|null`, `iteration` | Message metadata. `nodeId` is null for messages appended outside a node turn (e.g. seed messages) |
| `fact.run_paused_hitl` | `nodeId`, `label`, `options: [{key,label,to}]` | Yielded for human input on a workflow `wait.human` node; `options` mirrors the outgoing edge set with parsed accelerator keys |
| `fact.run_paused` | `reason: 'operator'\|'provider_error'\|'payment_required'\|'budget'`, `nodeId`, plus reason-specific fields. `provider_error`: `httpStatus`, `provider`, `errorMessage`, `policy?`, `attempt?`, `resumeAt?`. `payment_required`: `provider`, `errorMessage`. `budget`: `scope`, `metric`, `limit`, `actual`. | Unified operator-resumable pause. `reason="provider_error"` with `policy="auto-retry"` projects status to `paused_provider_retry` (wake-pending sweep auto-resumes at `resumeAt`); everything else → `paused` (operator must `intent.resume`, or `intent.budget_adjusted` + `intent.resume` for budget reason) |
| `fact.provider_retry_attempted` | `nodeId`, `attempt`, `httpStatus: number\|null`, `delayMs` | One per attempt in an auto-retry chain — separate fact rather than mutated payload preserves I3 (fact immutability) |
| `fact.run_paused_retry` | `nodeId`, `attempt`, `delayMs`, `resumeAt`, `maxRetries` | Handler returned `outcomeStatus="retry"`; concurrency slot released for the backoff window. Wake-pending sweeper re-queues at `resumeAt` |
| `fact.run_resumed` | `fromStatus: RunStatus`, `inputIntentSeq?` | Left a paused/quarantined state |
| `fact.run_completed` | `finalNode` | Terminal success |
| `fact.run_halted` | `reason: 'budget'\|'max_loops'\|'abort_loop'\|'schema_drift'\|'error'\|'aborted_exit'\|'goal_gate_unsatisfied'\|'max_retries_exceeded'\|'occ_exhausted'\|'provider_exhausted'`, `detail?`, `occContext?` (set when reason="occ_exhausted") | Terminal failure |
| `fact.run_cancelled` | `intentSeq` | Terminal cancel |
| `fact.run_quarantined` | `reason: 'orphan_side_effect'\|'other'`, `orphanedIntents?: seq[]` | Awaiting operator |
| `fact.run_requeued_after_crash` | `prevNode?`, `lastAliveAt?` | Startup sweep requeued. `lastAliveAt` is the dying daemon's last heartbeat — reducer credits `lastAliveAt − dispatchStartedAt` to `activeMs` |
| `fact.handler_timeout_leaked` | `nodeId`, `leakedAt` | Accounting truth |
| `fact.daemon_takeover` | `reclaimedFrom: pid`, `at: ts` | Lock reclaim |
| `fact.run_branched` | `branch` | Post-terminal metadata: dispose() preserved a branch (working tree had a non-empty `git status --porcelain`). Lands AFTER the terminal status fact. <br/> > Status: in-progress — provisioner + branch-on-dispose + post-terminal fact landed; branch GC, paused-run drift, and per-branch isolation in parallel are tracked in [`docs/proposals/worktree-design.md`](./proposals/worktree-design.md) |

All payloads ≤ 4KB. Content references are `artifactKey`.

### Observability events (writer: `daemon`, no OCC)

Anything emitted via `ctx.emitObservability` from a handler — `agent.message_start/end`, `llm.text_delta`, `llm.thinking_delta`, `llm.toolcall_delta`, `cost.recorded`, `tool.execution_start/end`, `intent.dropped`, `budget.warn` / `budget.stop`, etc. Best-effort streaming telemetry, not transactional bundle: no version bump, no decision logic reads them, consumers are SSE tails and projections. Events land in the same `seq` space as facts.

The executor flushes the in-handler buffer to the store on a soft 50ms timer or when 64 events accumulate, whichever first, so the conversation view streams mid-LLM-call. The handler's tail (`edge.selected`, post-handler budget warnings) is drained synchronously before the terminal `fact.node_*` so consumers see the trail in causal order.

### Daemon events (writer: `daemon`, separate `daemon_events` table)

Process-lifecycle and infrastructure events. Persisted in the dedicated `daemon_events` table — disjoint from the per-run `seq` space because many entries are global (no run scope) and they must not interleave into the per-run reducer's projection. Same 4 KB payload cap as fact events.

| Type | Payload fields | Semantics |
|---|---|---|
| `daemon.started` | `pid`, `hostname` | Daemon acquired the lock and started the executor |
| `daemon.stopped` | `pid`, `reason: 'clean'\|'leak_limit'\|'signal'\|'error'`, `detail?` | Daemon exiting; emitted before lock release |
| `daemon.reaper_took_over` | `priorPid`, `priorHostname`, `priorHeartbeatAt`, `staleForMs` | Lock TTL exceeded; this daemon force-acquired |
| `daemon.sweep_completed` | `requeued: number`, `quarantined: number`, `durationMs` | Startup sweep finished |
| `daemon.blob_gc_completed` | `deleted: number`, `durationMs` | Orphan-blob GC sweep finished |
| `daemon.leak_detected` | `runId`, `nodeId`, `count`, `ceiling` | A handler leaked past `maxMs + leakGrace`; per-process counter advanced |
| `daemon.worktree_provisioned` | `runId`, `ok: boolean`, `errorDetail?` | Provisioner result; `ok: false` records why a run halted at provision time |

`run_id` on the row is set for run-scoped daemon events (leak_detected, worktree_provisioned); global lifecycle / sweep / GC events leave it NULL.

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
  runStateCounts(): { running: number; queued: number };

  // Event log
  getEvents(runId: string, opts?: GetEventsOpts): StoredEvent[];
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
}
```

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

Unchanged in substance from Revision 1; now with `iteration` visible and side-effect envelope carrying `idempotencyKey`.

```typescript
export type SideEffect = "none" | "idempotent" | "external";

export type HandlerSpec = {
  kind: string;
  sideEffect: SideEffect;
  maxMs: number;
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
  readonly args: Readonly<Record<string, string>>;          // substitution args ($ARGUMENTS, ...)
  readonly nodeOutputs: ReadonlyMap<string, NodeOutput>;    // prior nodes' captured outputs, dereferenced once per dispatch
  readonly emit: (type: string, payload: Record<string, unknown>) => void;  // observability events (agent.* / llm.* / tool.* / cost.recorded / summary.*)
  readonly hitlInput?: { selected: string; note?: string } | string;
  readonly steering?: string;
  readonly env?: ExecutionEnvironment;                      // per-run worktree; falls back to process cwd when unset
  readonly budgetSnapshot?: BudgetSnapshotInput;            // cumulative cost / tokens vs configured ceilings
  // No direct fetch, filesystem, DB, or process access.
}

export type HandlerResult =
  | {
      kind: "transition";
      nextNode?: string;                                // omit to route via the 5-rule edge selector
      outcomeStatus?: "success" | "partial_success" | "fail" | "retry" | "skipped";
      preferredLabel?: string;
      suggestedNextIds?: string[];
      outputRef?: ArtifactRef;
      routingDelta?: Record<string, unknown>;
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
      kind: "yield_hitl";
      label: string;
      options: Array<{ key: string; label: string; to: string }>;
      routingDelta?: Record<string, unknown>;
    }
  | {
      kind: "halt";
      reason: "budget" | "max_loops" | "error" | "goal_gate_unsatisfied" | "max_retries_exceeded";
      detail?: string;
      // `abort_loop`, `schema_drift`, `aborted_exit`, `occ_exhausted` are also valid
      // `fact.run_halted` reasons but the executor emits those itself — not
      // constructible by handlers.
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
- Handler PRs must: declare `sideEffect`, set `maxMs`, include replay property test for external tools.

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
    if (!state || isTerminal(state.status) || state.status === "paused" || state.status === "paused_hitl" || state.status === "paused_provider_retry" || state.status === "paused_retry" || state.status === "quarantined") return;

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
    const nodeSignal = AbortSignal.any([
      steerAbort.signal,
      AbortSignal.timeout(handlerSpec(state.current_node).maxMs),
      shutdownSignal,
    ]);
    registerAbort(runId, steerAbort);

    const ctx = buildHandlerContext(runId, state, nodeSignal, decision.routingDelta, decision.steering, decision.hitlInput);

    let result: HandlerResult;
    try {
      result = await Promise.race([
        dispatch(state.current_node, ctx),
        timeoutRejects(handlerSpec(state.current_node).maxMs + LEAK_GRACE_MS),
      ]);
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

## 7. Web server

```typescript
app.post("/runs", async (c) => {
  const body = await c.req.json() as {
    workflowSha: string;
    runId?: string;
    priority?: number;
    routing?: Record<string, unknown>;
    input?: string;          // positional input → routing.input → $ARGUMENTS
    cwd?: string;            // absolute project root at enqueue time; surfaced on run_state.cwd
    workflowName?: string;   // resolved name when the caller passed a bare name
    workflowScope?: "global" | "local" | "path" | "ephemeral";
    workflowPath?: string;   // filesystem path of the .dot file at resolution time
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

  const runId = body.runId ?? newRunId();
  const initialRouting = { ...(body.routing ?? {}) };
  if (typeof body.input === "string" && initialRouting.input === undefined) {
    initialRouting.input = body.input;
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
app.post("/runs/:id/hitl",         async (c) => writeIntent(c, "intent.hitl_input"));
app.post("/runs/:id/resume",       async (c) => writeIntent(c, "intent.resume"));
app.post("/runs/:id/unquarantine", async (c) => writeIntent(c, "intent.unquarantine"));
app.post("/runs/:id/priority",     async (c) => writeIntent(c, "intent.priority_adjusted"));
app.post("/runs/:id/budget",       async (c) => writeIntent(c, "intent.budget_adjusted"));  // {scope, metric, newLimit>0, note?}

// JSON-batch read of a run's events; pagination via ?since / ?limit.
app.get("/runs/:id/events", (c) => {
  const sinceSeq = Number(c.req.query("since") ?? 0);
  const limit = Math.min(Number(c.req.query("limit") ?? 1000), 5000);
  return c.json(store.getEvents(c.req.param("id"), { sinceSeq, limit }));
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
SQLite serializes the N `intent.hitl_input` commits; each HITL-resume transaction sets `ready_at = now()` inside the same txn. Even at ms-level clustering, SQL commit order gives each a distinct `ready_at`; ties break by `run_id`. The claim index (`priority DESC, ready_at ASC, run_id ASC`) pops them deterministically in commit order. No thundering herd.

**Not starvation-free in theory:** a relentless priority-11 stream starves priority-10. That's priority's point. If workflow-level fairness becomes a need, add `workflow_max_concurrent` per workflow (cheap partial-index count). Not needed day 1.

**Observability:**
- Derive `wait_time_ms = now() - ready_at` at read time; expose in UI.
- `intent.priority_adjusted` is the operator escape hatch if something starves.

**Edge — operator cancel mid-resume:**
HITL-wake (`intent.hitl_input`) and `intent.cancel_requested` can arrive in either order. Both are intents, both non-OCC, both processed by the daemon supervisor's fold. The fold prioritizes `cancel` deterministically: if both present, run becomes `cancelled` regardless of order. Documented in fold semantics.

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
| `ABORT_LOOP_CEILING` | 5 | Reducer → `RUN_HALTED` |
| `MAX_LOOPS` | 1000 (configurable via `ExecutorOpts.maxLoops`) | Executor → `fact.run_halted { reason: "max_loops" }` |

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
| P20 | Abort loop ceiling | K>5 consecutive aborts, no progress | `RUN_HALTED { reason: "abort_loop" }` |
| P21 | Queue fairness | N priority-10 HITL wakes | Claim order = commit order of `intent.hitl_input` |
| P22 | Cascade delete | Delete run_state row | events/messages/artifacts for that run all gone; blobs unchanged |
| P23 | STRICT enforcement | Insert string into integer column | Throws; no row inserted |
| P24 | Claim atomicity | K fibers racing `claimNextRun` | Each popped run claimed by exactly one fiber |
| P25 | Pre-commit recorder durability | `recordIntent` then no `recordDone` (simulated hard crash) | Intent fact in `events` before recorder returns; sweep quarantines without a matching done having ever existed |
| P26 | Artifact replay safety | Same-scope `putArtifact` calls with identical / differing content | Identical → no-op (existing ref); differing → `ArtifactCollisionError` unless `{ replace: true }`; only one row per scope |
| P27 | Intent fold truth table | Random batches of intents × all `RunStatus` values | Cancel always wins if present; pause coexists with steer/hitl as `shouldPauseAfterDispatch`; multi-instance hitl/priority last-wins; every intent ends up applied or in `dropped`; per-state preconditions enforced. See [`docs/intent-fold.md`](./intent-fold.md) |

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
      parser/                          ← DOT parser
      handler/                         ← HandlerContext, HandlerSpec, Handler
        handlers/                      ← wait-human, tool, parallel, fan-in, ...
        context.ts                     ← buildHandlerContext (per-call env)
        external-call.ts               ← idempotency key + intent/done envelope
      engine/
        edge-selection.ts              ← 5-rule priority (attractor §3.3)
        fan-in.ts                      ← heuristic ranking reducer (§4.9)
        retry-policy.ts                ← per-node retry counter (§3.6)
        fidelity.ts                    ← fidelity + thread_id resolution
        substitution.ts                ← $ARGUMENTS / ${context.*} / $nodeId.output[.path]
      types/
        execution.ts                   ← ExecutionEnvironment interface
        events.ts                      ← fact + intent + observability
        summariser.ts                  ← SummariserBackend port
        ...
      executor/
        types.ts                       ← CodergenBackend, CodergenInput
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
      backend.ts                       ← PiCodergenBackend (pi-agent-core)
      handler-bridge.ts                ← makeCodergenHandler (CodergenBackend → HandlerSpec)
      summariser.ts                    ← PiSummariserBackend
      fidelity.ts                      ← buildFidelitySeed (summariser-backed)
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

## 13. Deferred decisions

- **Blob encryption** for secret-bearing outputs — single-user local; deferred.
- **Cross-machine deployment** — single-machine by design. `IEventStore` is synchronous (matches `bun:sqlite`); a Postgres backing would require async-ifying the interface and every callsite, so this is a future direction rather than a clean drop-in.
- **Retention policies** per workflow — manual `swarm prune` until demand.
- **Blob streaming** for >16MB — handler must chunk; revisit on real use case.
- **Auto-migration across breaking schema bumps** — refuse + manual for v1. Additive bumps are handled in-place by `applyAdditiveMigrations` (`packages/store/src/migrations.ts`) without touching the version row's compat range.
- **Workflow hot-reload for in-flight runs** — not planned; `workflow_sha` pinned.
- **Per-workflow concurrency caps** — add when needed; easy via partial-index counts.

### 13.1 Handler coverage

All 8 canonical handler kinds from attractor §2.8 dispatch end-to-end
through `auto-dispatcher.ts`: `start`, `exit`, `conditional`,
`codergen`, `wait.human`, `tool`, `parallel`, `parallel.fan_in`. The
pure reducers behind them (`fan-in.ts`, `retry-policy.ts`,
`edge-selection.ts`, `external-call.ts`) are property-tested.

Read-only enforcement on review/observer branches is structural at
three layers: (a) `ctx.tools` is narrowed via `ToolRegistry.select`
before the `HandlerContext` is built; (b) the codergen backend
re-applies `select(...)` on its workspace registry before handing
tools to pi-ai; (c) `ctx.env` is wrapped in a read-only proxy when no
mutating tool (`bash` / `write` / `edit`) is visible, so
`env.writeFile` / `env.exec` throw `ReadOnlyEnvError` even for
handlers that bypass the tool registry. HITL inside a parallel branch
is coerced to `fail`.

Known gaps in coverage live in [`PENDING.md`](./PENDING.md).

---

## 14. Risks ranked

1. **Handler discipline drift** — #1 long-term risk. Structural lint + review gate mandatory. A single handler ignoring `AbortSignal` breaks invariants.
2. **Provider without idempotency support** — any external tool that can't accept a dedup key cannot be made safe; operator review is the only line of defense. Tag loudly.
3. **SQLite write throughput ceiling** — unknown until measured. Counter-based seq (1.5) + BEGIN IMMEDIATE + STRICT + partial indexes should be comfortable below 1000 writes/sec. Measure in M6.
4. **LLM provider abort leakage** — real and uncontrollable; `Promise.race` bounds; `handler_timeout_leaked` records truth.
5. **Mid-flight external tool double-execution** — provider idempotency keys + quarantine close the window; relies on (2).
6. **Schema drift for long-paused runs** — refusing to resume is safe but operationally annoying; acceptable v1.

---

## 15. What this architecture buys

- **One coordination surface.** All races resolve in SQLite; nothing in the filesystem; no unix sockets.
- **Zero-cost pause snapshots.** Projection always current; pausing = emitting an event.
- **Deterministic property tests.** Seed-reproducible across the full coordination seam.
- **Web works daemon-down.** Reads + intent writes never block on daemon availability.
- **Content-addressed blobs.** Deduplication, loop-safe replay, clean GC.
- **Orphan side effects are caught, not masked.** Quarantine + idempotency keys = at-most-once jointly with provider.
- **Fair, predictable queueing.** `ready_at` FIFO; no hidden scheduler rules.
- **Auditable.** Every state transition is a durable event; `events` table is system memory.
