import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BlobFS } from "./blob-fs.ts";
import { Metrics, type MetricsSnapshot } from "./metrics.ts";
import { migrate } from "./migrations.ts";
import { applyCreationPragmas, applyPragmas, CURRENT_SCHEMA_VERSION } from "./pragmas.ts";
import {
  getRunCostTotals as queryRunCostTotals,
  getStepAggregates as queryStepAggregates,
  selectEvents,
  selectGlobalEventsAtFloor,
  selectGlobalEventsForward,
  selectGlobalEventsLatest,
  selectMessages,
  selectMessagesNarrow,
  selectNodeOutputRefs,
  selectProjectById,
  selectProjects,
  UPSERT_PROJECT_SQL,
} from "./queries.ts";
import { applyFact, emptyMetrics } from "./reducers.ts";
import { sha256Hex } from "./sha256.ts";
import { startupSweep } from "./sweep.ts";
import {
  type AppendFactOpts,
  ArtifactCollisionError,
  type ArtifactRef,
  type ArtifactScope,
  ArtifactTooLargeError,
  ConcurrencyError,
  type DaemonEvent,
  type DaemonEventRow,
  type DaemonLockResult,
  type DaemonLockRow,
  type EnqueueRunParams,
  type EventWriter,
  type FactAppendResult,
  type FactEvent,
  type GetDaemonEventsOpts,
  type GetEventsOpts,
  type GetGlobalEventsAtFloorOpts,
  type GetGlobalEventsForwardOpts,
  type GetGlobalEventsLatestOpts,
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
  type NarrowMessage,
  type ObservabilityEvent,
  PayloadTooLargeError,
  type Project,
  type RunCostTotalsRow,
  type RunMetrics,
  type RunState,
  type RunStatus,
  type StepAggregateRow,
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
  dispatch_started_at: number | null;
  updated_at: number;
  title: string | null;
  base_git_sha: string | null;
  branch: string | null;
}

export interface SqliteStoreOpts {
  path?: string;
  /** Directory for content-addressed blob files. Defaults to
   * `<dirname(path)>/blobs` for file-backed DBs; for `:memory:` a fresh
   * tmpdir is created and torn down on `close()`. */
  blobsDir?: string;
  now?: () => number;
}

/** EventRow → StoredEvent. Shared across getEvents / getGlobalEvents*
 * so the projection (column rename, payload parse, writer cast) lives
 * in one place. */
function rowToStoredEvent(r: {
  run_id: string;
  seq: number;
  type: string;
  writer: string;
  payload: string;
  ts: number;
}): StoredEvent {
  return {
    runId: r.run_id,
    seq: r.seq,
    type: r.type as StoredEvent["type"],
    writer: r.writer as EventWriter,
    payload: JSON.parse(r.payload),
    ts: r.ts,
  };
}

export class SqliteStore implements IEventStore {
  private readonly db: Database;
  private readonly blobs: BlobFS;
  private readonly blobsDirOwned: boolean;
  private readonly blobsDir: string;
  private readonly now: () => number;
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

    return { seqs };
  }

  // ─────────────── Daemon events ───────────────

  appendDaemonEvent(event: DaemonEvent, opts?: { runId?: string }): { seq: number; ts: number } {
    const payload = this.validatePayload(event.payload);
    const ts = this.now();
    const runId = opts?.runId ?? null;
    let seq = 0;

    this.writeTxn(() => {
      const row = this.db
        .query<{ seq: number }, [string, string, number, string | null]>(
          `INSERT INTO daemon_events (type, payload, ts, run_id)
                VALUES (?, ?, ?, ?)
              RETURNING seq`,
        )
        .get(event.type, payload, ts, runId);
      if (row == null) throw new Error("daemon_events insert returned no row");
      seq = row.seq;
    });

    return { seq, ts };
  }

  getDaemonEvents(opts: GetDaemonEventsOpts = {}): DaemonEventRow[] {
    const sinceSeq = opts.sinceSeq ?? 0;
    const limit = opts.limit ?? -1;
    type Row = { seq: number; type: string; payload: string; ts: number; run_id: string | null };
    const rows: Row[] =
      opts.runId != null
        ? this.db
            .query<Row, [string, number, number]>(
              `SELECT seq, type, payload, ts, run_id
                 FROM daemon_events
                WHERE run_id = ? AND seq > ?
                ORDER BY seq ASC
                LIMIT ?`,
            )
            .all(opts.runId, sinceSeq, limit)
        : this.db
            .query<Row, [number, number]>(
              `SELECT seq, type, payload, ts, run_id
                 FROM daemon_events
                WHERE seq > ?
                ORDER BY seq ASC
                LIMIT ?`,
            )
            .all(sinceSeq, limit);
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      payload: JSON.parse(r.payload),
      ts: r.ts,
      runId: r.run_id,
    }));
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
             enqueued_at, ready_at, node_started_at, dispatch_started_at, updated_at,
             project_id
           ) VALUES (?, 1, 'queued', NULL, ?, ?, ?, ?, 1, 0, ?, ?, ?, NULL, NULL, ?, ?)`,
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
          params.projectId ?? null,
        );

      // Refresh the projects display cache. Same txn as the run insert
      // so a successful enqueue always carries a labelable row; a failed
      // enqueue rolls the projects update back together with the run.
      if (params.projectId != null && params.projectName != null) {
        this.db.query(UPSERT_PROJECT_SQL).run(params.projectId, params.projectName, params.projectRoot ?? null, now);
      }

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

  startupSweep(opts?: { priorHeartbeatAt?: number }): SweepResult {
    return startupSweep(this.db, this.now, opts);
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
    // No default limit — when the caller doesn't specify one, return the
    // full event log. `selectEvents` translates `limit: undefined` into
    // SQLite's unbounded `LIMIT -1`. Callers that need a cap (the SSE
    // batch loop, the runs-list summariser) pass `limit` explicitly.
    const queryOpts: Parameters<typeof selectEvents>[2] = {
      sinceSeq: opts.sinceSeq ?? 0,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    };
    return selectEvents(this.db, runId, queryOpts).map(rowToStoredEvent);
  }

  getGlobalEventsForward(opts: GetGlobalEventsForwardOpts): StoredEvent[] {
    return selectGlobalEventsForward(this.db, opts).map(rowToStoredEvent);
  }

  getGlobalEventsAtFloor(opts: GetGlobalEventsAtFloorOpts): StoredEvent[] {
    return selectGlobalEventsAtFloor(this.db, opts).map(rowToStoredEvent);
  }

  getGlobalEventsLatest(opts: GetGlobalEventsLatestOpts): StoredEvent[] {
    return selectGlobalEventsLatest(this.db, opts).map(rowToStoredEvent);
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

  appendMessage(
    runId: string,
    row: Omit<Message, "runId" | "ordinal">,
    opts?: { dedup?: boolean },
  ): { ordinal: number } {
    // Pre-check before entering the transaction so the caller sees a typed
    // error rather than a CHECK constraint failure from SQLite. The schema
    // CHECK is defence-in-depth for any path that bypasses this method.
    const serialized = JSON.stringify(row.content);
    if (serialized.length >= MAX_MESSAGE_CONTENT_BYTES) {
      throw new MessageTooLargeError(serialized.length, MAX_MESSAGE_CONTENT_BYTES);
    }
    const contentHash = sha256Hex(serialized);
    const iteration = row.iteration ?? 0;
    const dedup = opts?.dedup === true && row.nodeId !== null;
    let ordinal = 0;
    this.writeTxn(() => {
      // Opt-in dedup. When the caller asserts the message is replay-safe
      // (deterministic content given the same scope), passing `dedup: true`
      // causes a re-dispatch at the same `(run, node, iteration)` with
      // byte-identical content to return the existing ordinal instead of
      // minting a duplicate row.
      //
      // Default OFF because agent transcripts carry per-call timestamps
      // (and other mutable accounting fields) that legitimately differ
      // across attempts even when the semantic message is the same;
      // hashing the raw JSON would falsely refuse those dedups *or*
      // falsely allow them depending on timing. Handler-level
      // idempotency is the correct contract for those messages.
      if (dedup) {
        const existing = this.db
          .query<{ ordinal: number }, [string, string, number, string]>(
            `SELECT ordinal FROM messages
              WHERE run_id = ? AND node_id = ? AND iteration = ? AND content_hash = ?
              LIMIT 1`,
          )
          .get(runId, row.nodeId as string, iteration, contentHash);
        if (existing != null) {
          ordinal = existing.ordinal;
          return;
        }
      }
      const max = this.db
        .query<{ m: number | null }, [string]>("SELECT MAX(ordinal) AS m FROM messages WHERE run_id = ?")
        .get(runId);
      ordinal = (max?.m ?? 0) + 1;
      this.db
        .query(
          `INSERT INTO messages (run_id, ordinal, content, node_id, iteration, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, ordinal, serialized, row.nodeId, iteration, contentHash);
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
            AND r.status IN ('queued','running','paused_hitl','paused_provider_error')`,
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
            AND r.status IN ('queued','running','paused_hitl','paused_provider_error')`,
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
    // No default limit — the transcript view shows the full list, and
    // `selectMessages` translates `limit: undefined` into SQLite's
    // unbounded `LIMIT -1`. Callers that need a cap pass `limit`.
    const queryOpts: Parameters<typeof selectMessages>[2] = {
      sinceOrdinal: opts.sinceOrdinal ?? 0,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.nodeId != null ? { nodeId: opts.nodeId } : {}),
    };
    return selectMessages(this.db, runId, queryOpts).map(this.rowToMessage);
  }

  getMessagesNarrow(runId: string, opts: GetMessagesOpts = {}): NarrowMessage[] {
    const queryOpts: Parameters<typeof selectMessagesNarrow>[2] = {
      sinceOrdinal: opts.sinceOrdinal ?? 0,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.nodeId != null ? { nodeId: opts.nodeId } : {}),
    };
    return selectMessagesNarrow(this.db, runId, queryOpts).map((r) => ({
      ordinal: r.ordinal,
      content: JSON.parse(r.content),
      nodeId: r.node_id,
    }));
  }

  // ─────────────── Aggregations ───────────────

  getStepAggregates(runId: string): StepAggregateRow[] {
    return queryStepAggregates(this.db, runId);
  }

  getRunCostTotals(runId: string): RunCostTotalsRow {
    return queryRunCostTotals(this.db, runId);
  }

  // ─────────────── Artifacts ───────────────

  putArtifact(scope: ArtifactScope, content: Uint8Array, mime?: string, opts?: { replace?: boolean }): ArtifactRef {
    if (content.byteLength > MAX_BLOB_BYTES) {
      throw new ArtifactTooLargeError(content.byteLength, MAX_BLOB_BYTES);
    }
    const sha = sha256Hex(content);
    const now = this.now();
    const bytes = content.byteLength;
    const replace = opts?.replace ?? false;

    // Replay-safe by default. If an artifact already exists at this scope:
    //  - same content → no-op, return the existing ref (replay produces
    //    the same logical state).
    //  - different content + !replace → ArtifactCollisionError. The handler
    //    is asking to overwrite something durable; force the call site to
    //    declare intent.
    //  - different content + replace → overwrite (the legacy behaviour,
    //    now opt-in).
    // See `docs/handler-contract.md` "replay semantics."
    const existing = this.getArtifactRef(scope);
    if (existing != null) {
      if (existing.sha256 === sha) {
        return existing;
      }
      if (!replace) {
        throw new ArtifactCollisionError(scope, existing.sha256, sha);
      }
    }

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

  getNodeOutputs(runId: string): Map<string, { output: string; success: boolean; timestamp: number }> {
    const refs = selectNodeOutputRefs(this.db, runId);
    const out = new Map<string, { output: string; success: boolean; timestamp: number }>();
    const decoder = new TextDecoder();
    // Refs come back ordered by seq ASC, so a later iteration of the same
    // node naturally overwrites the earlier one. The artifact key on the
    // event is the canonical "<nodeId>:<key>" string the daemon writes;
    // the artifact itself was put under the node's own scope, so we
    // recover (nodeId, iteration, key) from the payload directly.
    for (const ref of refs) {
      // outputRefKey shape: "<refNodeId>:<key>"; the refNodeId may differ
      // from the node that emitted the fact when handlers eventually
      // surface child-node refs (e.g. parallel branches). Until that
      // lands, both strings agree.
      const colon = ref.outputRefKey.indexOf(":");
      if (colon < 0) continue;
      const refNodeId = ref.outputRefKey.slice(0, colon);
      const key = ref.outputRefKey.slice(colon + 1);
      let bytes: Uint8Array;
      try {
        bytes = this.getArtifact({ runId, nodeId: refNodeId, iteration: ref.iteration, key });
      } catch {
        // Artifact missing on disk (orphan after an out-of-band gc-blobs
        // run, say). Skip rather than throw — the substituted prompt
        // will treat the value as empty, same as a node that never
        // produced output.
        continue;
      }
      const text = decoder.decode(bytes);
      out.set(ref.nodeId, {
        output: text,
        success: ref.outcomeStatus !== "fail",
        timestamp: ref.seq,
      });
    }
    return out;
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

  // ─────────────── Projects ───────────────

  listProjects(): Project[] {
    return selectProjects(this.db);
  }

  getProject(id: string): Project | null {
    return selectProjectById(this.db, id);
  }

  upsertProject(args: { id: string; name: string; rootPath?: string | null }): void {
    const now = this.now();
    this.writeTxn(() => {
      this.db.query(UPSERT_PROJECT_SQL).run(args.id, args.name, args.rootPath ?? null, now);
    });
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
        const row = this.db.query<{ sha256: string }, [string]>("SELECT sha256 FROM blobs WHERE sha256 = ?").get(sha);
        if (row == null) {
          this.blobs.delete(sha);
          extraDeleted++;
        }
      }
    }

    return { deleted: orphans.length + extraDeleted };
  }

  close(): void {
    this.db.close();
    if (this.blobsDirOwned) this.blobs.destroy();
  }

  // ─────────────── Internals ───────────────

  private writeTxn(fn: () => void): void {
    // BEGIN IMMEDIATE grabs the write lock up front; busy_timeout handles
    // contention. Time the lock acquisition separately from the txn body
    // so an operator watching metrics can see contention (high p99
    // lockWait, low p99 write) before tail latency is visible end-to-end.
    const lockStart = performance.now();
    this.db.exec("BEGIN IMMEDIATE");
    this.metrics.recordLockWait(performance.now() - lockStart);
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
                  priority, enqueued_at, ready_at, node_started_at,
                  dispatch_started_at, updated_at, title, base_git_sha, branch
             FROM run_state
            WHERE run_id = ?`,
        )
        .get(runId) ?? null
    );
  }

  private rowToState(row: RunStateRow): RunState {
    const parsedMetrics = JSON.parse(row.metrics) as Partial<RunMetrics>;
    const metrics: RunMetrics = {
      billedTokens: parsedMetrics.billedTokens ?? 0,
      totalCostUsd: parsedMetrics.totalCostUsd ?? 0,
      totalInputCostUsd: parsedMetrics.totalInputCostUsd ?? 0,
      totalOutputCostUsd: parsedMetrics.totalOutputCostUsd ?? 0,
      totalInputTokens: parsedMetrics.totalInputTokens ?? 0,
      totalOutputTokens: parsedMetrics.totalOutputTokens ?? 0,
      totalCacheReadTokens: parsedMetrics.totalCacheReadTokens ?? 0,
      totalCacheWriteTokens: parsedMetrics.totalCacheWriteTokens ?? 0,
      loopCounts: parsedMetrics.loopCounts ?? {},
      models: parsedMetrics.models ?? {},
      nodeCosts: parsedMetrics.nodeCosts ?? {},
      activeMs: parsedMetrics.activeMs ?? 0,
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
      dispatchStartedAt: row.dispatch_started_at,
      updatedAt: row.updated_at,
      title: row.title,
      baseGitSha: row.base_git_sha,
      branch: row.branch,
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
           version             = ?,
           status              = ?,
           current_node        = ?,
           routing             = ?,
           metrics             = ?,
           last_applied_seq    = ?,
           priority            = ?,
           ready_at            = ?,
           node_started_at     = ?,
           dispatch_started_at = ?,
           updated_at          = ?,
           base_git_sha        = ?,
           branch              = ?
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
        state.dispatchStartedAt,
        state.updatedAt,
        state.baseGitSha,
        state.branch,
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
}

/** Replacement payload for an oversized observability event. Preserves
 * the small, high-value metadata fields UIs / aggregators rely on (node
 * routing, model identity, iteration loop position, thread context) and
 * stamps an explicit truncation marker so consumers don't silently read
 * fabricated data. The bulky parts (prompt, system_prompt, messages,
 * skills, context_files) are reconstructable from the `messages` table
 * + the workflow source and are deliberately dropped here.
 *
 * Anything added here must stay *short*: the whole truncated payload
 * still has to fit in MAX_EVENT_PAYLOAD_BYTES, which is the reason we
 * truncate in the first place. Strings + numbers + the small
 * `iteration` object only — no nested arrays. */
function truncationMarker(original: unknown, originalBytes: number): Record<string, unknown> {
  const out: Record<string, unknown> = { _truncated: true, _original_bytes: originalBytes };
  if (original != null && typeof original === "object") {
    const src = original as Record<string, unknown>;
    if (typeof src["nodeId"] === "string") out["nodeId"] = src["nodeId"];
    // `iteration` is overloaded across event types: a plain number on
    // observability events stamped by the executor, a `{ n, max }`
    // object on llm.start when the caller is a loop. Keep both shapes.
    if (typeof src["iteration"] === "number") {
      out["iteration"] = src["iteration"];
    } else if (src["iteration"] != null && typeof src["iteration"] === "object") {
      const it = src["iteration"] as Record<string, unknown>;
      if (typeof it["n"] === "number" && typeof it["max"] === "number") {
        out["iteration"] = { n: it["n"], max: it["max"] };
      }
    }
    if (typeof src["content_index"] === "number") out["content_index"] = src["content_index"];
    // llm.start-specific identity fields — without these the step UI
    // can't render the model name, look up the context window, or join
    // back to the right thread when the prompt + system_prompt push
    // the payload over the cap. All four are short strings.
    if (typeof src["provider"] === "string") out["provider"] = src["provider"];
    if (typeof src["model"] === "string") out["model"] = src["model"];
    if (typeof src["thread_id"] === "string") out["thread_id"] = src["thread_id"];
    if (typeof src["fidelity"] === "string") out["fidelity"] = src["fidelity"];
  }
  return out;
}
