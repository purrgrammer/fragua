# swarm — Architecture

> **Authoritative.** The design the codebase implements. Companion to [`SPEC.md`](./SPEC.md) (goals) and [`handler-contract.md`](./handler-contract.md) (writing handlers).
>
> SQLite-backed event store with projection-in-transaction, intent/fact split, hard-abort semantics, content-addressed blob storage. No filesystem coordination surface.

---

## 0. Context and decisions

### What we're committing to
- **Single coordination surface: one SQLite database.** All state, events, queue, locks, artifacts. Two processes (daemon, web server) both read and write. WAL mode handles multi-process access.
- **Event sourcing with projection-in-transaction.** Events are the immutable log of truth. A materialized projection (`run_state`) is updated inside the same transaction as the event append. Reads of current state are one row; event fold is only used for migration/debug.
- **Intent/fact split.** Web writes intents (always-appendable, no OCC). Daemon writes facts (OCC-checked against `run_state.version`). 90% of retry pressure disappears.
- **Hard abort for all interrupts.** Pause, cancel, and steer all trip a single `AbortSignal`. Handlers unwind, emit `fact.node_aborted` with partial metrics, executor re-enters (or halts) based on new state.
- **Durable HITL via unwind-and-rehydrate.** `wait.human` nodes return `yield_hitl`, the executor emits `fact.run_paused_hitl`, the process is free. Human input (intent event) wakes the daemon; it rehydrates from the projection and resumes at the next node.
- **Content-addressed blobs with sha256.** Tool outputs never inline in event payloads. Handlers write raw content to content-addressed `blobs`; events carry a ref + bounded preview.
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
| **I8** | Raw tool output addressed by sha256 in `blobs`; artifacts are named refs scoped by `(run, node, iteration, key)` | Store API; handlers cannot emit raw content as fact payload |
| **I9** | LLM-visible preview (`messages`) is distinct from system-recorded raw (`artifacts`) | Handler API exposes `messages.append()` and `artifacts.put()` separately |
| **I10** | Seq assignment is O(1) via per-run counter on `run_state.next_seq`; never scanned | Store module; `UPDATE run_state SET next_seq = next_seq + 1 RETURNING ...` inside append txn |

---

## 1. Adversarial review — findings and resolutions

### 1.1 Orphan `SIDE_EFFECT_INTENT` after crash
**Attack.** Daemon crashes after `fact.side_effect_intent` is committed but before `fact.side_effect_done`. The external API call actually happened (credit charged, PR merged). On replay, absence of `DONE` is not proof of non-execution — blindly re-running doubles the effect.

**Resolution.**
1. **Provider-level idempotency keys.** External tool envelope carries `idempotencyKey = sha256(runId + nodeId + iteration + argsHash + attempt)`. Handler passes this as `Idempotency-Key` header (or provider-equivalent). Provider dedupes server-side; jointly we achieve at-most-once.
2. **Startup quarantine.** On daemon start, scan for `fact.side_effect_intent` events without a matching `fact.side_effect_done`/`fact.side_effect_failed` (joined by `idempotencyKey`). Any run with such an orphan enters `quarantined` status. Run does not resume until a human writes `intent.unquarantine { resolution: "treat_as_done" | "retry" | "cancel", note }`.
3. **Retry uses the same key.** If operator chooses `retry`, the handler re-executes with the same `idempotencyKey`. If the provider already processed the prior attempt, it returns the cached response. Safe under operator error.
4. **Tools without provider dedup** get a warning label at registration; operator is the only safety net. Documented as handler-author responsibility.

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
-- (c) paused_hitl and quarantined runs are NOT touched
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

### 1.10 Remaining concerns
- **sha256 oracle for blobs** — deferred to optional encryption later; single-user local tool has DB read = full read anyway.
- **SSE push ordering** — not an issue in polling model. Consumers read `seq > lastSeen`, always consistent.
- **Intent-flood DOS** — retry-storm ceiling (abort-loop detector emits `RUN_HALTED { reason: "abort_loop" }` after K=5 consecutive aborts without progress). HTTP rate-limit at web layer.
- **Large BLOB page-split cascade** — `blobs` is **rowid** table; overflow pages handle big values efficiently. See §2.
- **Schema drift across long pauses** — `schema_version` pinned per run; daemon refuses to resume mismatches, emits `fact.run_halted { reason: "schema_drift" }`.
- **Replay determinism under LLM non-determinism** — inherent; external-call safety via idempotency keys; pure/idempotent handlers fine.

---

## 2. Schema

All tables `STRICT`. All per-run tables cascade on run deletion. `WITHOUT ROWID` only on narrow rows; **`blobs` is a rowid table** to benefit from overflow pages for large BLOBs.

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
    'queued','running','paused_hitl','completed','cancelled','halted','quarantined'
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
  updated_at INTEGER NOT NULL
) STRICT;

-- Partial index = queue in disguise; O(log N) claim
CREATE INDEX idx_run_state_queue
  ON run_state(priority DESC, ready_at ASC)
  WHERE status = 'queued';

CREATE INDEX idx_run_state_status ON run_state(status);

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

CREATE TABLE messages (                           -- append-mostly; never rewritten
  run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  node_id TEXT,
  iteration INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, ordinal)
) STRICT, WITHOUT ROWID;

CREATE TABLE blobs (                              -- content-addressed; ROWID table for BLOB overflow
  sha256 TEXT NOT NULL UNIQUE,
  content BLOB NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_blobs_sha ON blobs(sha256);

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
  heartbeat_at INTEGER NOT NULL
) STRICT;
```

**Size targets:**
- `run_state` row: ~500 bytes; thousands of rows negligible.
- `events` row: ~300 bytes; partial indexes small.
- `messages` rows: variable, bounded by LLM message size.
- `blobs`: up to 16MB per row; overflow pages handle efficiently on rowid table.

---

## 3. Event taxonomy

### Intent events (writer: `web`, no OCC)
| Type | Payload fields | Semantics |
|---|---|---|
| `intent.run_enqueued` | `workflowSha`, `priority?` | Queue a new run |
| `intent.steering_requested` | `payload: string` | Abort current node; inject steering before re-entry |
| `intent.pause_requested` | — | Abort current node; transition to `paused` |
| `intent.cancel_requested` | `reason?` | Abort current node; transition to `cancelled` |
| `intent.hitl_input` | `payload: unknown` | Wake a `paused_hitl` run |
| `intent.unquarantine` | `resolution: 'treat_as_done'\|'retry'\|'cancel'`, `note: string` | Operator acknowledgement for a quarantined run |
| `intent.priority_adjusted` | `newPriority: number`, `note: string` | Operator bump |

### Fact events (writer: `daemon`, OCC-checked)
| Type | Payload fields | Semantics |
|---|---|---|
| `fact.run_started` | `workflowSha`, `schemaVersion`, `startNode` | Run enters `running` |
| `fact.node_started` | `nodeId`, `iteration` | Node dispatched |
| `fact.node_completed` | `nodeId`, `iteration`, `outputRef?`, `tokens`, `costUsd`, `nextNode` | Node succeeded |
| `fact.node_aborted` | `nodeId`, `iteration`, `cause`, `partialTokens`, `partialCostUsd` | Mid-flight abort |
| `fact.steering_applied` | `intentSeq`, `folded` | Steer merged into routing/messages |
| `fact.side_effect_intent` | `nodeId`, `iteration`, `toolName`, `argsHash`, `attempt`, `idempotencyKey` | External tool about to run |
| `fact.side_effect_done` | `idempotencyKey`, `artifactKey`, `tokens?`, `costUsd?` | External tool completed |
| `fact.side_effect_failed` | `idempotencyKey`, `errorCode`, `retriable: bool` | External tool failed cleanly |
| `fact.tool_completed` | `toolName`, `argsHash`, `artifactKey`, `preview`, `summary?` | Non-external tool result |
| `fact.message_appended` | `ordinal`, `role`, `nodeId`, `iteration` | Message metadata |
| `fact.run_paused_hitl` | `nodeId`, `prompt` | Yielded for human input |
| `fact.run_resumed` | `fromStatus`, `inputIntentSeq?` | Left a paused/quarantined state |
| `fact.run_completed` | `finalNode` | Terminal success |
| `fact.run_halted` | `reason: 'budget'\|'max_loops'\|'abort_loop'\|'schema_drift'\|'error'\|'aborted_exit'`, `detail?` | Terminal failure |
| `fact.run_cancelled` | `intentSeq` | Terminal cancel |
| `fact.run_quarantined` | `reason: 'orphan_side_effect'\|...`, `orphanedIntents?: seq[]` | Awaiting operator |
| `fact.run_requeued_after_crash` | `prevNode?` | Startup sweep requeued |
| `fact.handler_timeout_leaked` | `nodeId`, `leakedAt` | Accounting truth |
| `fact.daemon_takeover` | `reclaimedFrom: pid`, `at: ts` | Lock reclaim |

All payloads ≤ 4KB. Content references are `artifactKey`.

---

## 4. IEventStore interface

```typescript
// packages/store/src/types.ts

export interface IEventStore {
  // Writes
  appendFact(runId: string, events: FactEvent[], expectedVersion: number): FactAppendResult;
  appendIntent(runId: string, event: IntentEvent): IntentAppendResult;

  // Run lifecycle
  enqueueRun(params: { runId: string; workflowSha: string; priority?: number }): void;
  claimNextRun(maxInFlight: number): { runId: string } | null;   // atomic; respects concurrency
  startupSweep(): { requeued: string[]; quarantined: string[] };

  // State reads
  getState(runId: string): RunState | null;
  getEvents(runId: string, sinceSeq?: number, limit?: number): StoredEvent[];
  getUnappliedIntents(runId: string): StoredEvent[];

  // Messages
  appendMessage(runId: string, row: Omit<Message,'ordinal'>): { ordinal: number };
  getMessages(runId: string, opts?: { sinceOrdinal?: number; limit?: number; nodeId?: string }): Message[];

  // Artifacts
  putArtifact(scope: ArtifactScope, content: Uint8Array, mime?: string): ArtifactRef;
  getArtifact(scope: ArtifactScope): Uint8Array;
  getArtifactRef(scope: ArtifactScope): ArtifactRef | null;
  findDoneForIntent(runId: string, idempotencyKey: string): ArtifactRef | null;   // replay short-circuit

  // Daemon lock
  acquireDaemonLock(pid: number, hostname: string): DaemonLockResult;
  heartbeatDaemonLock(pid: number): void;
  releaseDaemonLock(pid: number): void;
  currentDaemonLock(): DaemonLockRow | null;

  // Workflows
  saveWorkflow(sha: string, name: string, dotSource: string): void;
  getWorkflow(sha: string): WorkflowRow | null;

  // Subscriptions (in-process post-commit callback; no IPC)
  onCommit(listener: (runId: string, seq: number) => void): () => void;

  // Maintenance
  vacuum(): void;
  gcBlobs(maxRows?: number): { deleted: number };
  close(): void;
}

export type ArtifactScope = { runId: string; nodeId: string; iteration: number; key: string };
export type ArtifactRef = ArtifactScope & { sha256: string; sizeBytes: number; mime: string };

export class ConcurrencyError extends Error {}
export class ArtifactTooLargeError extends Error {}
export class SchemaDriftError extends Error {}
export class QuarantineError extends Error {}
```

**Implementation notes:**
- All methods synchronous; `bun:sqlite` is sync.
- Every write wraps in `WriteQueue.enqueue(() => db.transaction(() => ...)())`. `BEGIN IMMEDIATE` for all txns.
- `onCommit` listeners fire after commit, inside `queueMicrotask`. Used by daemon supervisor for optional early-wake (belt-and-suspenders alongside 50ms polling).

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

export type HandlerContext = Readonly<{
  runId: string;
  nodeId: string;
  iteration: number;                     // per-node retry counter (§3.6); 0 on first entry
  signal: AbortSignal;                   // AbortSignal.any([steer, timeout, shutdown])
  routing: Readonly<Record<string, unknown>>;
  llm: LlmClient;                        // pre-wired with signal, accounting
  http: HttpClient;                      // pre-wired with signal, timeout
  tools: ToolRegistry;                   // side_effect tagged; external tools auto-envelope
  messages: {
    append(role: MessageRole, content: string): { ordinal: number };
    recent(n: number): Message[];
    since(ordinal: number): Message[];
  };
  artifacts: {
    put(key: string, content: string | Uint8Array, mime?: string): ArtifactRef;
    get(key: string): Uint8Array;
    ref(key: string): ArtifactRef | null;
    getFrom(scope: ArtifactScope): Uint8Array;
  };
  externalCall: <T>(fn: (key: string) => Promise<T>, argsHash: string, attempt?: number) => Promise<T>;
  // No direct fetch, filesystem, DB, or process access.
}>;

export type HandlerResult =
  | { kind: "transition"; nextNode: string; outputRef?: ArtifactRef; routingDelta?: Record<string, unknown>; tokens: number; costUsd: number }
  | { kind: "yield_hitl"; prompt: string; routingDelta?: Record<string, unknown> }
  | { kind: "halt"; reason: "budget" | "max_loops" | "error"; detail?: string };
```

`externalCall` is the canonical helper for `side_effect: "external"` tools. It:
1. Computes `idempotencyKey = sha256(runId + nodeId + iteration + argsHash + attempt)`.
2. Emits `fact.side_effect_intent` via the executor (not the handler directly).
3. Invokes `fn(idempotencyKey)`; `fn` passes the key to the provider as an idempotency header.
4. On success: emits `fact.side_effect_done`, returns result.
5. On `AbortError`: does NOT emit `done`; executor will see orphan on replay if we crashed here.
6. On clean failure: emits `fact.side_effect_failed`.

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
    if (!state || isTerminal(state.status) || state.status === "paused_hitl" || state.status === "quarantined") return;

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
  const { workflowSha, priority } = await c.req.json();
  const runId = newRunId();
  store.enqueueRun({ runId, workflowSha, priority });
  return c.json({ runId });
});

app.post("/runs/:id/steer",    async (c) => writeIntent(c, "intent.steering_requested"));
app.post("/runs/:id/pause",    async (c) => writeIntent(c, "intent.pause_requested"));
app.post("/runs/:id/cancel",   async (c) => writeIntent(c, "intent.cancel_requested"));
app.post("/runs/:id/hitl",     async (c) => writeIntent(c, "intent.hitl_input"));
app.post("/runs/:id/unquarantine", async (c) => writeIntent(c, "intent.unquarantine"));

app.get("/runs/:id/events", (c) => streamSSE(c, async (stream) => {
  const runId = c.req.param("id");
  let lastSeq = Number(c.req.header("Last-Event-ID") ?? 0);
  while (!stream.aborted) {
    const events = store.getEvents(runId, lastSeq, 500);
    for (const e of events) {
      await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
      lastSeq = e.seq;
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
| `MAX_EVENT_PAYLOAD_BYTES` | 4096 | `events.payload CHECK` |
| `MAX_ROUTING_BYTES` | 8192 | `run_state.routing CHECK` |
| `MAX_BLOB_BYTES` | 16 * 1024 * 1024 | Store module; throws `ArtifactTooLargeError` |
| `MAX_PREVIEW_CHARS` | 512 | Handler convention |
| `MAX_CONCURRENT_RUNS` | 8 (configurable) | `claimNextRun` |
| `LOCK_TTL_MS` | 30000 | Daemon lock reclaim |
| `HEARTBEAT_INTERVAL_MS` | 5000 | Supervisor fiber |
| `SUPERVISOR_TICK_MS` | 50 | Supervisor fiber |
| `SSE_POLL_MS` | 100 | Web SSE handler |
| `LEAK_GRACE_MS` | 5000 | Hard timeout grace |
| `ABORT_LOOP_CEILING` | 5 | Reducer → `RUN_HALTED` |

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
        fidelity.ts                    ← mode resolution + degradeOnResume
        substitution.ts                ← $ARGUMENTS / $RUN_ID / $WORKTREE_PATH / $LOG_DIR / $nodeId.output
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
      wake-hitl.ts                     ← pending HITL scan
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
- **Cross-machine deployment** — single-machine by design; swap SQLite → Postgres behind `IEventStore` if ever needed.
- **Retention policies** per workflow — manual `swarm prune` until demand.
- **Blob streaming** for >16MB — handler must chunk; revisit on real use case.
- **Auto-migration of schema drift** — refuse + manual for v1.
- **Workflow hot-reload for in-flight runs** — not planned; `workflow_sha` pinned.
- **Per-workflow concurrency caps** — add when needed; easy via partial-index counts.

### 13.1 Declared-but-not-yet-wired

Features whose types, events, or surfaces exist but whose runtime
enforcement isn't built. A reader of the code will see attrs / event
names that don't do anything yet. Listed here so they're discoverable
and tracked.

- **Budget ledger.** `graph.attrs.budget_usd`, `graph.attrs.budget_tokens`, `graph.attrs.budget_policy`, `node.attrs.max_cost_usd`, `node.attrs.max_tokens` all parse and serialise. `BudgetSnapshot` event payload is declared. `budget.warn` / `budget.stop` event types are declared. No code reads cumulative spend and fires the events; no handler honours the ceiling. Runs exceed their declared budget silently.
- *(retired)* ~~Worktree provisioning.~~ Wired. `WorktreeProvisioner` (`@swarm/daemon`) maintains a per-runId `Map<runId, ExecutionEnvironment>`; the executor calls `ensure(runId)` before the first dispatch and `dispose(runId)` once the run reaches a terminal status (completed / cancelled / halted). `paused_hitl` + `quarantined` runs keep their worktree so a resume picks up exactly where it left off — including across daemon restarts, since `WorktreeEnvironment.init()` detects an existing registered worktree (via `git worktree list --porcelain`) and reuses it without re-running bootstrap. `$WORKTREE_PATH` / `$LOG_DIR` substitution args now resolve to real paths. Non-git cwds fall back to a shared `LocalEnvironmentProvisioner` (tests + demo paths).
- *(retired)* ~~Checkpoint / resume.~~ Wired through the `messages` table. `PiCodergenBackend` calls `CodergenInput.persistMessage` at each `message_end` to land plaintext content in `messages.content` (TEXT, unbounded — §I7 cap stays intact because message content never rides the event envelope). Handler-bridge loads the prior transcript from the store into `CodergenInput.priorMessages` as synthesised `AgentMessage`s before every `backend.run()`. Resume detection is purely derived: `(prior non-empty) ∧ ¬(this process wrote this thread)` ⇒ apply `degradeOnResume` per SPEC §3.6 (fidelity=full → summary:high). The degrade makes plaintext sufficient — tool_use blocks don't need to survive a daemon restart. A separate `GET /runs/:id/messages` endpoint serves the transcript to the frontend directly.
- *(retired)* ~~Auto-title summariser (emit side).~~ Wired. `AutoTitler` (@swarm/daemon) fires once per run right after `fact.run_started`, emits `summary.*` + `cost.recorded` + `run.title_generated` under the synthetic `__summary.title` node id, and projects the result onto `run_state.title` via `setRunTitle`. The daemon `drain()`s pending title calls on shutdown so in-flight summariser streams cancel via the shared `shutdownSignal`. `auto_title: "off"` disables even when a summariser is configured; failures (missing keys, network errors) leave `title = null` and the UI falls back to `routing.input`.
- **Handler coverage.** All 8 canonical kinds from attractor §2.8 are now wired end-to-end through `auto-dispatcher.ts`: `start`, `exit`, `conditional`, `codergen`, `wait.human`, `tool`, `parallel`, and `parallel.fan_in`. The pure reducers behind them — `fan-in.ts`, `retry-policy.ts`, `edge-selection.ts`, `external-call.ts` — are all property-tested. Parallel is v1 "deliberation-only" (regime C): branches deep-clone routing but share the run's worktree and must stay read-only. HITL inside a parallel branch is coerced to `fail`; multi-worktree parallel and LLM-evaluated fan_in (attractor §4.9's `prompt`-set branch) are deferred.
- **Per-node provider preflight.** `POST /runs` checks that the daemon has *some* provider API key set, but not that the specific provider pinned on each `node.attrs.provider` is reachable. A workflow that hardcodes an unconfigured provider fails at dispatch (visible via `fact.run_halted`), not at enqueue.

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
