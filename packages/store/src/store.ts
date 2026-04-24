import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BlobFS } from "./blob-fs.ts";
import { Metrics, type MetricsSnapshot } from "./metrics.ts";
import { migrate } from "./migrations.ts";
import { applyCreationPragmas, applyPragmas, CURRENT_SCHEMA_VERSION } from "./pragmas.ts";
import { applyFact, emptyMetrics } from "./reducers.ts";
import { sha256Hex } from "./sha256.ts";
import { startupSweep } from "./sweep.ts";
import {
  type AppendFactOpts,
  type ArtifactRef,
  type ArtifactScope,
  ArtifactTooLargeError,
  ConcurrencyError,
  type DaemonLockResult,
  type DaemonLockRow,
  type EnqueueRunParams,
  type EventWriter,
  type FactAppendResult,
  type FactEvent,
  type GetEventsOpts,
  type GetMessagesOpts,
  type IEventStore,
  type IntentAppendResult,
  type IntentEvent,
  MAX_BLOB_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_ROUTING_BYTES,
  type Message,
  MessageTooLargeError,
  type ObservabilityEvent,
  PayloadTooLargeError,
  type RunMetrics,
  type RunState,
  type RunStatus,
  type StoredEvent,
  type SweepResult,
  type WorkflowRow,
} from "./types.ts";

interface RunStateRow {
  run_id: string;
  version: number;
  status: RunStatus;
  current_node: string | null;
  workflow_sha: string;
  schema_version: number;
  routing: string;
  metrics: string;
  next_seq: number;
  last_applied_seq: number;
  priority: number;
  enqueued_at: number;
  ready_at: number;
  node_started_at: number | null;
  updated_at: number;
  title: string | null;
}

type CommitListener = (runId: string, seq: number) => void;

export interface SqliteStoreOpts {
  path?: string;
  /** Directory for content-addressed blob files. Defaults to
   * `<dirname(path)>/blobs` for file-backed DBs; for `:memory:` a fresh
   * tmpdir is created and torn down on `close()`. */
  blobsDir?: string;
  now?: () => number;
}

export class SqliteStore implements IEventStore {
  private readonly db: Database;
  private readonly blobs: BlobFS;
  private readonly blobsDirOwned: boolean;
  private readonly blobsDir: string;
  private readonly now: () => number;
  private readonly listeners = new Set<CommitListener>();
  private readonly metrics = new Metrics();

  metricsSnapshot(): MetricsSnapshot {
    return this.metrics.snapshot();
  }

  constructor(opts: SqliteStoreOpts = {}) {
    const path = opts.path ?? ":memory:";
    const fresh = path === ":memory:" || !existsSync(path);
    this.db = new Database(path);
    if (fresh) applyCreationPragmas(this.db);
    applyPragmas(this.db);
    migrate(this.db);
    this.now = opts.now ?? (() => Date.now());

    if (opts.blobsDir != null) {
      this.blobsDir = opts.blobsDir;
      this.blobsDirOwned = false;
    } else if (path === ":memory:") {
      this.blobsDir = mkdtempSync(join(tmpdir(), "swarm-blobs-"));
      this.blobsDirOwned = true;
    } else {
      this.blobsDir = join(dirname(path), "blobs");
      this.blobsDirOwned = false;
    }
    this.blobs = new BlobFS(this.blobsDir);
  }

  // ─────────────── Writes ───────────────

  appendFact(runId: string, events: FactEvent[], expectedVersion: number, opts: AppendFactOpts = {}): FactAppendResult {
    if (events.length === 0) {
      throw new Error("appendFact requires at least one event");
    }
    const ts = this.now();
    const seqs: number[] = [];
    let newVersion = 0;
    const startAt = performance.now();

    try {
      this.writeTxn(() => {
        const row = this.selectRunRow(runId);
        if (row == null) throw new Error(`unknown run ${runId}`);
        if (row.version !== expectedVersion) {
          throw new ConcurrencyError(expectedVersion, row.version);
        }

        let state = this.rowToState(row);

        for (const event of events) {
          const payload = this.validatePayload(event.payload);
          const seq = this.bumpSeq(runId);
          seqs.push(seq);
          this.db
            .query("INSERT INTO events (run_id, seq, type, writer, payload, ts) VALUES (?, ?, ?, 'daemon', ?, ?)")
            .run(runId, seq, event.type, payload, ts);
          state = applyFact(state, event, ts);
        }

        if (opts.routingPatch != null) {
          state = {
            ...state,
            routing: { ...state.routing, ...opts.routingPatch },
          };
        }

        state = {
          ...state,
          version: state.version + 1,
          lastAppliedSeq: opts.advanceAppliedTo != null ? opts.advanceAppliedTo : state.lastAppliedSeq,
        };

        this.writeProjection(state);
        newVersion = state.version;
      });
      this.metrics.recordWrite(performance.now() - startAt, "fact");
    } catch (err) {
      if (err instanceof ConcurrencyError) this.metrics.recordOccConflict();
      throw err;
    }

    const lastSeq = seqs[seqs.length - 1]!;
    this.emitCommit(runId, lastSeq);
    return { committed: true, newVersion, seqs };
  }

  appendIntent(runId: string, event: IntentEvent): IntentAppendResult {
    const payload = this.validatePayload(event.payload);
    const ts = this.now();
    let seq = 0;
    const startAt = performance.now();

    this.writeTxn(() => {
      const row = this.selectRunRow(runId);
      if (row == null) throw new Error(`unknown run ${runId}`);
      seq = this.bumpSeq(runId);
      this.db
        .query("INSERT INTO events (run_id, seq, type, writer, payload, ts) VALUES (?, ?, ?, 'web', ?, ?)")
        .run(runId, seq, event.type, payload, ts);
    });
    this.metrics.recordWrite(performance.now() - startAt, "intent");

    this.emitCommit(runId, seq);
    return { seq, ts };
  }

  appendObservabilityEvents(runId: string, events: ObservabilityEvent[]): { seqs: number[] } {
    if (events.length === 0) return { seqs: [] };
    const ts = this.now();
    const seqs: number[] = [];
    const startAt = performance.now();

    const truncated: { type: string; bytes: number }[] = [];
    this.writeTxn(() => {
      const row = this.selectRunRow(runId);
      if (row == null) throw new Error(`unknown run ${runId}`);
      for (const event of events) {
        if (typeof event.type !== "string" || event.type.length === 0) {
          throw new Error("observability event.type must be a non-empty string");
        }
        // One oversized event must not tank the rest of the batch. Swap
        // the payload for a truncation marker that keeps routing info
        // (nodeId, iteration) so UI step-grouping still works. Full
        // content for llm turns is already in the `messages` table.
        let payload: string;
        try {
          payload = this.validatePayload(event.payload);
        } catch (err) {
          if (!(err instanceof PayloadTooLargeError)) throw err;
          truncated.push({ type: event.type, bytes: err.sizeBytes });
          payload = this.validatePayload(truncationMarker(event.payload, err.sizeBytes));
        }
        const seq = this.bumpSeq(runId);
        seqs.push(seq);
        this.db
          .query("INSERT INTO events (run_id, seq, type, writer, payload, ts) VALUES (?, ?, ?, 'daemon', ?, ?)")
          .run(runId, seq, event.type, payload, ts);
      }
    });
    if (truncated.length > 0) {
      for (const t of truncated) {
        // eslint-disable-next-line no-console
        console.warn(
          `[store] truncated oversized observability event for run ${runId}: type=${t.type} bytes=${t.bytes} cap=${MAX_EVENT_PAYLOAD_BYTES}`,
        );
      }
    }
    this.metrics.recordWrite(performance.now() - startAt, "fact");

    if (seqs.length > 0) this.emitCommit(runId, seqs[seqs.length - 1]!);
    return { seqs };
  }

  // ─────────────── Run lifecycle ───────────────

  enqueueRun(params: EnqueueRunParams): void {
    const now = this.now();
    const routing = JSON.stringify(params.initialRouting ?? {});
    if (routing.length >= MAX_ROUTING_BYTES) {
      throw new PayloadTooLargeError(routing.length, MAX_ROUTING_BYTES);
    }
    const metrics = JSON.stringify(emptyMetrics());

    this.writeTxn(() => {
      const workflow = this.db
        .query<{ sha: string }, [string]>("SELECT sha FROM workflows WHERE sha = ?")
        .get(params.workflowSha);
      if (workflow == null) {
        throw new Error(`unknown workflow sha ${params.workflowSha}`);
      }

      this.db
        .query(
          `INSERT INTO run_state (
             run_id, version, status, current_node, workflow_sha, schema_version,
             routing, metrics, next_seq, last_applied_seq, priority,
             enqueued_at, ready_at, node_started_at, updated_at
           ) VALUES (?, 1, 'queued', NULL, ?, ?, ?, ?, 1, 0, ?, ?, ?, NULL, ?)`,
        )
        .run(
          params.runId,
          params.workflowSha,
          CURRENT_SCHEMA_VERSION,
          routing,
          metrics,
          params.priority ?? 0,
          now,
          now,
          now,
        );

      const seq = this.bumpSeq(params.runId);
      this.db
        .query(
          "INSERT INTO events (run_id, seq, type, writer, payload, ts) VALUES (?, ?, 'intent.run_enqueued', 'web', ?, ?)",
        )
        .run(
          params.runId,
          seq,
          JSON.stringify({
            workflowSha: params.workflowSha,
            priority: params.priority ?? 0,
          }),
          now,
        );
    });

    this.emitCommit(params.runId, 1);
  }

  claimNextRun(maxInFlight: number): { runId: string } | null {
    const now = this.now();
    let claimed: string | null = null;

    this.writeTxn(() => {
      const running = this.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_state WHERE status = 'running'")
        .get();
      if ((running?.n ?? 0) >= maxInFlight) return;

      const row = this.db
        .query<{ run_id: string; version: number }, []>(
          `SELECT run_id, version FROM run_state
            WHERE status = 'queued'
            ORDER BY priority DESC, ready_at ASC, run_id ASC
            LIMIT 1`,
        )
        .get();
      if (row == null) return;

      const res = this.db
        .query<{ run_id: string }, [number, number, string, number]>(
          `UPDATE run_state
              SET status = 'running',
                  node_started_at = ?,
                  version = version + 1,
                  updated_at = ?
            WHERE run_id = ? AND version = ? AND status = 'queued'
          RETURNING run_id`,
        )
        .get(now, now, row.run_id, row.version);

      if (res != null) claimed = res.run_id;
    });

    return claimed != null ? { runId: claimed } : null;
  }

  startupSweep(): SweepResult {
    return startupSweep(this.db, this.now);
  }

  setRunTitle(runId: string, title: string): void {
    const clipped = title.length > 200 ? title.slice(0, 200) : title;
    const now = this.now();
    this.writeTxn(() => {
      this.db.query("UPDATE run_state SET title = ?, updated_at = ? WHERE run_id = ?").run(clipped, now, runId);
    });
  }

  // ─────────────── State reads ───────────────

  getState(runId: string): RunState | null {
    const row = this.selectRunRow(runId);
    return row == null ? null : this.rowToState(row);
  }

  getEvents(runId: string, opts: GetEventsOpts = {}): StoredEvent[] {
    const since = opts.sinceSeq ?? 0;
    const limit = opts.limit ?? 1000;
    const rows = this.db
      .query<
        {
          run_id: string;
          seq: number;
          type: string;
          writer: EventWriter;
          payload: string;
          ts: number;
        },
        [string, number, number]
      >(
        `SELECT run_id, seq, type, writer, payload, ts
           FROM events
          WHERE run_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(runId, since, limit);
    return rows.map((r) => ({
      runId: r.run_id,
      seq: r.seq,
      type: r.type as StoredEvent["type"],
      writer: r.writer,
      payload: JSON.parse(r.payload),
      ts: r.ts,
    }));
  }

  getUnappliedIntents(runId: string): StoredEvent[] {
    const state = this.selectRunRow(runId);
    if (state == null) return [];
    const rows = this.db
      .query<
        {
          run_id: string;
          seq: number;
          type: string;
          writer: EventWriter;
          payload: string;
          ts: number;
        },
        [string, number]
      >(
        `SELECT run_id, seq, type, writer, payload, ts
           FROM events
          WHERE run_id = ? AND seq > ? AND writer = 'web'
          ORDER BY seq ASC`,
      )
      .all(runId, state.last_applied_seq);
    return rows.map((r) => ({
      runId: r.run_id,
      seq: r.seq,
      type: r.type as StoredEvent["type"],
      writer: r.writer,
      payload: JSON.parse(r.payload),
      ts: r.ts,
    }));
  }

  // ─────────────── Messages ───────────────

  appendMessage(runId: string, row: Omit<Message, "runId" | "ordinal">): { ordinal: number } {
    // Pre-check before entering the transaction so the caller sees a typed
    // error rather than a CHECK constraint failure from SQLite. The schema
    // CHECK is defence-in-depth for any path that bypasses this method.
    const serialized = JSON.stringify(row.content);
    if (serialized.length >= MAX_MESSAGE_CONTENT_BYTES) {
      throw new MessageTooLargeError(serialized.length, MAX_MESSAGE_CONTENT_BYTES);
    }
    let ordinal = 0;
    this.writeTxn(() => {
      const max = this.db
        .query<{ m: number | null }, [string]>("SELECT MAX(ordinal) AS m FROM messages WHERE run_id = ?")
        .get(runId);
      ordinal = (max?.m ?? 0) + 1;
      this.db
        .query(
          `INSERT INTO messages (run_id, ordinal, content, node_id, iteration)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runId, ordinal, serialized, row.nodeId, row.iteration ?? 0);
    });
    return { ordinal };
  }

  listThreadsWithMessages(): Array<{ runId: string; threadId: string }> {
    type Row = { run_id: string; thread_id: string };
    const fromMessages = this.db
      .query<Row, []>(
        `SELECT DISTINCT m.run_id AS run_id, m.node_id AS thread_id
           FROM messages m
           JOIN run_state r ON r.run_id = m.run_id
          WHERE m.node_id IS NOT NULL
            AND r.status IN ('queued','running','paused_hitl')`,
      )
      .all();
    const fromEvents = this.db
      .query<Row, []>(
        `SELECT DISTINCT e.run_id AS run_id,
                         CAST(json_extract(e.payload, '$.thread_id') AS TEXT) AS thread_id
           FROM events e
           JOIN run_state r ON r.run_id = e.run_id
          WHERE e.type = 'llm.start'
            AND json_extract(e.payload, '$.thread_id') IS NOT NULL
            AND r.status IN ('queued','running','paused_hitl')`,
      )
      .all();
    const seen = new Set<string>();
    const out: Array<{ runId: string; threadId: string }> = [];
    for (const row of [...fromMessages, ...fromEvents]) {
      if (row.thread_id == null || row.thread_id === "") continue;
      const key = `${row.run_id}\x00${row.thread_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ runId: row.run_id, threadId: row.thread_id });
    }
    return out;
  }

  getMessages(runId: string, opts: GetMessagesOpts = {}): Message[] {
    const since = opts.sinceOrdinal ?? 0;
    const limit = opts.limit ?? 1000;
    type Row = {
      run_id: string;
      ordinal: number;
      content: string;
      node_id: string | null;
      iteration: number;
    };
    if (opts.nodeId != null) {
      return this.db
        .query<Row, [string, number, string, number]>(
          `SELECT run_id, ordinal, content, node_id, iteration
             FROM messages
            WHERE run_id = ? AND ordinal > ? AND node_id = ?
            ORDER BY ordinal ASC
            LIMIT ?`,
        )
        .all(runId, since, opts.nodeId, limit)
        .map(this.rowToMessage);
    }
    return this.db
      .query<Row, [string, number, number]>(
        `SELECT run_id, ordinal, content, node_id, iteration
           FROM messages
          WHERE run_id = ? AND ordinal > ?
          ORDER BY ordinal ASC
          LIMIT ?`,
      )
      .all(runId, since, limit)
      .map(this.rowToMessage);
  }

  // ─────────────── Artifacts ───────────────

  putArtifact(scope: ArtifactScope, content: Uint8Array, mime?: string): ArtifactRef {
    if (content.byteLength > MAX_BLOB_BYTES) {
      throw new ArtifactTooLargeError(content.byteLength, MAX_BLOB_BYTES);
    }
    const sha = sha256Hex(content);
    const now = this.now();
    const bytes = content.byteLength;

    // File-then-row: write the content-addressed file before the DB row
    // points at it. A crash between rename and INSERT leaves an orphan
    // file; the `blobs` row never references missing content.
    this.blobs.put(sha, content);

    this.writeTxn(() => {
      this.db
        .query(
          `INSERT OR IGNORE INTO blobs (sha256, size_bytes, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(sha, bytes, now);
      this.db
        .query(
          `INSERT INTO artifacts
             (run_id, node_id, iteration, key, blob_sha, mime, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, node_id, iteration, key) DO UPDATE SET
             blob_sha = excluded.blob_sha,
             mime     = excluded.mime,
             created_at = excluded.created_at`,
        )
        .run(scope.runId, scope.nodeId, scope.iteration, scope.key, sha, mime ?? null, now);
    });

    return {
      ...scope,
      sha256: sha,
      sizeBytes: bytes,
      mime: mime ?? null,
    };
  }

  getArtifact(scope: ArtifactScope): Uint8Array {
    const ref = this.getArtifactRef(scope);
    if (ref == null) {
      throw new Error(`artifact not found: ${scope.runId}/${scope.nodeId}#${scope.iteration}:${scope.key}`);
    }
    if (!this.blobs.has(ref.sha256)) {
      throw new Error(`blob file missing for sha ${ref.sha256}`);
    }
    return this.blobs.get(ref.sha256);
  }

  getArtifactRef(scope: ArtifactScope): ArtifactRef | null {
    const row = this.db
      .query<
        {
          blob_sha: string;
          mime: string | null;
          size_bytes: number;
        },
        [string, string, number, string]
      >(
        `SELECT a.blob_sha, a.mime, b.size_bytes
           FROM artifacts a
           JOIN blobs b ON b.sha256 = a.blob_sha
          WHERE a.run_id = ? AND a.node_id = ? AND a.iteration = ? AND a.key = ?`,
      )
      .get(scope.runId, scope.nodeId, scope.iteration, scope.key);
    if (row == null) return null;
    return {
      ...scope,
      sha256: row.blob_sha,
      sizeBytes: row.size_bytes,
      mime: row.mime,
    };
  }

  findDoneForIntent(runId: string, idempotencyKey: string): ArtifactRef | null {
    const done = this.db
      .query<{ seq: number; payload: string }, [string, string]>(
        `SELECT seq, payload FROM events
          WHERE run_id = ? AND type = 'fact.side_effect_done'
            AND json_extract(payload, '$.idempotencyKey') = ?
          LIMIT 1`,
      )
      .get(runId, idempotencyKey);
    if (done == null) return null;
    const parsed = JSON.parse(done.payload) as {
      idempotencyKey: string;
      artifactKey: string;
    };

    const intent = this.db
      .query<{ payload: string }, [string, string]>(
        `SELECT payload FROM events
          WHERE run_id = ? AND type = 'fact.side_effect_intent'
            AND json_extract(payload, '$.idempotencyKey') = ?
          LIMIT 1`,
      )
      .get(runId, idempotencyKey);
    if (intent == null) return null;
    const intentPayload = JSON.parse(intent.payload) as {
      nodeId: string;
      iteration: number;
    };
    return this.getArtifactRef({
      runId,
      nodeId: intentPayload.nodeId,
      iteration: intentPayload.iteration,
      key: parsed.artifactKey,
    });
  }

  // ─────────────── Daemon lock ───────────────

  acquireDaemonLock(pid: number, hostname: string): DaemonLockResult {
    const now = this.now();
    let result: DaemonLockResult | null = null;

    this.writeTxn(() => {
      const existing = this.currentDaemonLock();
      if (existing != null) {
        result = { acquired: false, current: existing };
        return;
      }
      this.db
        .query(
          `INSERT INTO daemon_lock (id, pid, hostname, started_at, heartbeat_at)
           VALUES (1, ?, ?, ?, ?)`,
        )
        .run(pid, hostname, now, now);
      result = {
        acquired: true,
        current: { pid, hostname, startedAt: now, heartbeatAt: now },
      };
    });
    return result!;
  }

  forceAcquireDaemonLock(pid: number, hostname: string): DaemonLockResult {
    const now = this.now();
    let current!: DaemonLockRow;
    this.writeTxn(() => {
      this.db
        .query(
          `INSERT INTO daemon_lock (id, pid, hostname, started_at, heartbeat_at)
             VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             pid = excluded.pid,
             hostname = excluded.hostname,
             started_at = excluded.started_at,
             heartbeat_at = excluded.heartbeat_at`,
        )
        .run(pid, hostname, now, now);
      current = { pid, hostname, startedAt: now, heartbeatAt: now };
    });
    return { acquired: true, current };
  }

  heartbeatDaemonLock(pid: number): void {
    const now = this.now();
    this.writeTxn(() => {
      this.db.query("UPDATE daemon_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?").run(now, pid);
    });
  }

  releaseDaemonLock(pid: number): void {
    this.writeTxn(() => {
      this.db.query("DELETE FROM daemon_lock WHERE id = 1 AND pid = ?").run(pid);
    });
  }

  runStateCounts(): { running: number; queued: number } {
    const running = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_state WHERE status = 'running'")
      .get();
    const queued = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_state WHERE status = 'queued'")
      .get();
    return { running: running?.n ?? 0, queued: queued?.n ?? 0 };
  }

  currentDaemonLock(): DaemonLockRow | null {
    const row = this.db
      .query<
        {
          pid: number;
          hostname: string;
          started_at: number;
          heartbeat_at: number;
        },
        []
      >("SELECT pid, hostname, started_at, heartbeat_at FROM daemon_lock WHERE id = 1")
      .get();
    if (row == null) return null;
    return {
      pid: row.pid,
      hostname: row.hostname,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
    };
  }

  // ─────────────── Workflows ───────────────

  saveWorkflow(sha: string, name: string, dotSource: string): void {
    const now = this.now();
    this.writeTxn(() => {
      this.db
        .query(
          `INSERT INTO workflows (sha, name, dot_source, created_at)
             VALUES (?, ?, ?, ?)
           ON CONFLICT(sha) DO NOTHING`,
        )
        .run(sha, name, dotSource, now);
    });
  }

  getWorkflow(sha: string): WorkflowRow | null {
    const row = this.db
      .query<
        {
          sha: string;
          name: string;
          dot_source: string;
          created_at: number;
        },
        [string]
      >("SELECT sha, name, dot_source, created_at FROM workflows WHERE sha = ?")
      .get(sha);
    if (row == null) return null;
    return {
      sha: row.sha,
      name: row.name,
      dotSource: row.dot_source,
      createdAt: row.created_at,
    };
  }

  // ─────────────── Subscriptions ───────────────

  onCommit(listener: CommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ─────────────── Maintenance ───────────────

  vacuum(): void {
    this.db.exec("VACUUM");
  }

  gcBlobs(maxRows?: number): { deleted: number } {
    const limit = maxRows ?? 1000;
    // Pass 1: drop `blobs` rows with no artifact referent. RETURNING feeds
    // the file-delete pass so row-without-file is impossible mid-sweep.
    const orphans = this.db
      .query<{ sha256: string }, [number]>(
        `WITH orphans AS (
           SELECT b.sha256
             FROM blobs b
             LEFT JOIN artifacts a ON a.blob_sha = b.sha256
            WHERE a.blob_sha IS NULL
            LIMIT ?
         )
         DELETE FROM blobs
          WHERE sha256 IN (SELECT sha256 FROM orphans)
        RETURNING sha256`,
      )
      .all(limit);
    for (const row of orphans) this.blobs.delete(row.sha256);

    // Pass 2: remove blob files with no matching row. Catches files left
    // behind when a row was deleted directly (cascade) or when a crash
    // between put() and INSERT orphaned the file. Bounded by the same
    // per-sweep limit to keep tail latency predictable.
    let extraDeleted = 0;
    const budget = limit - orphans.length;
    if (budget > 0) {
      const shas = this.blobs.listAllShas();
      for (const sha of shas) {
        if (extraDeleted >= budget) break;
        const row = this.db
          .query<{ sha256: string }, [string]>("SELECT sha256 FROM blobs WHERE sha256 = ?")
          .get(sha);
        if (row == null) {
          this.blobs.delete(sha);
          extraDeleted++;
        }
      }
    }

    return { deleted: orphans.length + extraDeleted };
  }

  close(): void {
    this.listeners.clear();
    this.db.close();
    if (this.blobsDirOwned) this.blobs.destroy();
  }

  // ─────────────── Internals ───────────────

  private writeTxn(fn: () => void): void {
    // BEGIN IMMEDIATE grabs the write lock up front; busy_timeout handles contention.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors; propagate original.
      }
      throw err;
    }
  }

  private selectRunRow(runId: string): RunStateRow | null {
    return (
      this.db
        .query<RunStateRow, [string]>(
          `SELECT run_id, version, status, current_node, workflow_sha,
                  schema_version, routing, metrics, next_seq, last_applied_seq,
                  priority, enqueued_at, ready_at, node_started_at, updated_at,
                  title
             FROM run_state
            WHERE run_id = ?`,
        )
        .get(runId) ?? null
    );
  }

  private rowToState(row: RunStateRow): RunState {
    const parsedMetrics = JSON.parse(row.metrics) as Partial<RunMetrics>;
    // Pre-split rows (before the input/output/cache split landed) are
    // missing the four new totals. Default to 0 so older runs render as
    // "we didn't track this" (all zeros) instead of NaN-ing downstream.
    const metrics: RunMetrics = {
      totalTokens: parsedMetrics.totalTokens ?? 0,
      totalCostUsd: parsedMetrics.totalCostUsd ?? 0,
      totalInputTokens: parsedMetrics.totalInputTokens ?? 0,
      totalOutputTokens: parsedMetrics.totalOutputTokens ?? 0,
      totalCacheReadTokens: parsedMetrics.totalCacheReadTokens ?? 0,
      totalCacheWriteTokens: parsedMetrics.totalCacheWriteTokens ?? 0,
      loopCounts: parsedMetrics.loopCounts ?? {},
      models: parsedMetrics.models ?? {},
    };
    const routing = JSON.parse(row.routing) as Record<string, unknown>;
    return {
      runId: row.run_id,
      version: row.version,
      status: row.status,
      currentNode: row.current_node,
      workflowSha: row.workflow_sha,
      schemaVersion: row.schema_version,
      routing,
      metrics,
      nextSeq: row.next_seq,
      lastAppliedSeq: row.last_applied_seq,
      priority: row.priority,
      enqueuedAt: row.enqueued_at,
      readyAt: row.ready_at,
      nodeStartedAt: row.node_started_at,
      updatedAt: row.updated_at,
      title: row.title,
    };
  }

  private rowToMessage = (r: {
    run_id: string;
    ordinal: number;
    content: string;
    node_id: string | null;
    iteration: number;
  }): Message => ({
    runId: r.run_id,
    ordinal: r.ordinal,
    content: JSON.parse(r.content),
    nodeId: r.node_id,
    iteration: r.iteration,
  });

  private bumpSeq(runId: string): number {
    const row = this.db
      .query<{ seq: number }, [string]>(
        `UPDATE run_state
            SET next_seq = next_seq + 1
          WHERE run_id = ?
         RETURNING next_seq - 1 AS seq`,
      )
      .get(runId);
    if (row == null) throw new Error(`run_state missing for ${runId}`);
    return row.seq;
  }

  private writeProjection(state: RunState): void {
    const routing = JSON.stringify(state.routing);
    if (routing.length >= MAX_ROUTING_BYTES) {
      throw new PayloadTooLargeError(routing.length, MAX_ROUTING_BYTES);
    }
    const metrics = JSON.stringify(state.metrics);
    this.db
      .query(
        `UPDATE run_state SET
           version          = ?,
           status           = ?,
           current_node     = ?,
           routing          = ?,
           metrics          = ?,
           last_applied_seq = ?,
           priority         = ?,
           ready_at         = ?,
           node_started_at  = ?,
           updated_at       = ?
         WHERE run_id = ?`,
      )
      .run(
        state.version,
        state.status,
        state.currentNode,
        routing,
        metrics,
        state.lastAppliedSeq,
        state.priority,
        state.readyAt,
        state.nodeStartedAt,
        state.updatedAt,
        state.runId,
      );
  }

  private validatePayload(payload: unknown): string {
    const s = JSON.stringify(payload ?? {});
    if (s.length >= MAX_EVENT_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError(s.length, MAX_EVENT_PAYLOAD_BYTES);
    }
    return s;
  }

  private emitCommit(runId: string, seq: number): void {
    if (this.listeners.size === 0) return;
    queueMicrotask(() => {
      for (const l of this.listeners) {
        try {
          l(runId, seq);
        } catch {
          // Listeners must not throw into the store.
        }
      }
    });
  }
}

/** Replacement payload for an oversized observability event. Preserves
 * the routing fields UIs need to group steps (nodeId, iteration) and
 * stamps an explicit truncation marker so consumers don't silently read
 * fabricated data. Full LLM content is reconstructable from the
 * `messages` table, which is uncapped. */
function truncationMarker(original: unknown, originalBytes: number): Record<string, unknown> {
  const out: Record<string, unknown> = { _truncated: true, _original_bytes: originalBytes };
  if (original != null && typeof original === "object") {
    const src = original as Record<string, unknown>;
    if (typeof src["nodeId"] === "string") out["nodeId"] = src["nodeId"];
    if (typeof src["iteration"] === "number") out["iteration"] = src["iteration"];
    if (typeof src["content_index"] === "number") out["content_index"] = src["content_index"];
  }
  return out;
}
