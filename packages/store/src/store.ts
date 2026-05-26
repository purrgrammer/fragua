import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangeStat, InboxStatus } from "@fragua/types";
import {
  type AnalyticsWindow,
  type BucketedWindow,
  type CacheByBucketRow,
  type DrilldownFilters,
  type DrilldownPage,
  type HaltDistributionRow,
  type KpiTotalsRow,
  type ModelDistributionRow,
  getCacheByBucket as queryCacheByBucket,
  getDrilldownPage as queryDrilldownPage,
  getFirstRunAt as queryFirstRunAt,
  getHaltDistribution as queryHaltDistribution,
  getKpiTotals as queryKpiTotals,
  getModelDistribution as queryModelDistribution,
  getRunsByBucket as queryRunsByBucket,
  getSpendByBucket as querySpendByBucket,
  getTokensByBucket as queryTokensByBucket,
  getTopWorkflows as queryTopWorkflows,
  getWorkflowDirectory as queryWorkflowDirectory,
  type RunsByBucketRow,
  type SpendByBucketRow,
  type TokensByBucketRow,
  type TopWorkflowRow,
  type WorkflowDirectoryRow,
} from "./analytics-queries.ts";
import {
  blobRowExists,
  deleteOrphanBlobs,
  insertBlobIfAbsent,
  selectArtifactRef as querySelectArtifactRef,
  selectArtifactsForRun,
  upsertArtifact,
} from "./artifact-queries.ts";
import { BlobFS } from "./blob-fs.ts";
import { BUNDLE_VERSION, type BundleManifest, canonicalJson, readTar, type TarEntry, writeTar } from "./bundle.ts";
import {
  deleteDaemonLock,
  deleteServerEndpoint,
  insertDaemonEvent,
  insertDaemonLock,
  selectDaemonEvents,
  selectDaemonEventsByRun,
  selectDaemonLock,
  selectServerEndpoint,
  updateDaemonLockHeartbeat,
  upsertDaemonLock,
  upsertServerEndpoint,
} from "./daemon-queries.ts";
import {
  insertEventDaemon,
  insertEventOrIgnore,
  insertEventRunEnqueued,
  insertEventWeb,
  type OrphanSideEffectRow,
  type PendingIntentRow,
  selectEvents,
  selectEventsByType,
  selectFactSideEffectDone,
  selectFactSideEffectIntent,
  selectGlobalEventsAtFloor,
  selectGlobalEventsForward,
  selectGlobalEventsLatest,
  selectLatestEvents,
  selectNextPendingIntent,
  selectOrphanSideEffects,
  selectSnapshotEvents,
  selectUnappliedIntents,
} from "./event-queries.ts";
import {
  insertMessage,
  insertMessageOrIgnore,
  selectActiveThreads,
  selectMaxMessageOrdinal,
  selectMessageByDedup,
  selectMessages,
  selectMessagesNarrow,
} from "./message-queries.ts";
import { Metrics, type MetricsSnapshot } from "./metrics.ts";
import { migrate, verifySchema } from "./migrations.ts";
import {
  applyCreationPragmas,
  applyPragmas,
  CURRENT_SCHEMA_VERSION,
  EVENT_CONTRACT_VERSION,
  MIN_COMPATIBLE_CONTRACT_VERSION,
} from "./pragmas.ts";
import {
  type ProviderConfigDbRow,
  deleteProviderConfig as queryDeleteProviderConfig,
  upsertProviderConfig as queryUpsertProviderConfig,
  selectAllProviderConfigs,
  selectProviderConfig,
  selectProviderConfigRevision,
} from "./provider-config-queries.ts";
import {
  type ProviderCredentialDbRow,
  deleteProviderCredential as queryDeleteProviderCredential,
  upsertProviderCredential as queryUpsertProviderCredential,
  selectAllProviderCredentials,
  selectProviderCredential,
} from "./provider-credentials-queries.ts";
import { applyFact, emptyMetrics } from "./reducers.ts";
import {
  bumpRunSeq,
  type CwdSummaryRow,
  claimQueuedRun,
  countDispatchableRunningRuns,
  countQueuedRuns,
  countRunningRuns,
  type GcSnapshotRunRow,
  type GlobalMetricsTotalsRow,
  type GlobalModelBreakdownRow,
  insertRunState,
  isRunImported,
  type ListRunIdsOpts,
  type ListRunSummaryRowsOpts,
  markRunImported,
  type ProjectSummaryRow,
  // queryRunCostTotals renamed at import for symmetry with the other
  // `query*` imports below; original symbol used by tests directly.
  getRunCostTotals as queryRunCostTotals,
  getStepAggregates as queryStepAggregates,
  type RunCostTotalsRow,
  type RunStateRow,
  type RunSummaryRow,
  type StepAggregateRow,
  selectCwds,
  selectGcEligibleSnapshotRuns,
  selectGlobalMetricsTotals,
  selectGlobalModelBreakdown,
  selectInboxActionCandidates,
  selectNextQueuedRun,
  selectProjects,
  selectRunIds,
  selectRunStateRow,
  selectRunSummaryRows,
  selectWakeCandidates,
  setRunStateCwd,
  setRunStateNextSeq,
  updateRunStateTitle,
  type WakeCandidateRow,
  writeRunStateProjection,
} from "./run-state-queries.ts";
import {
  deleteScheduleRow,
  insertSchedule,
  type ScheduleRow,
  selectAllSchedules,
  selectDueSchedules,
  selectSchedule,
  selectScheduleRuns,
  selectSchedulesByCwd,
  updateScheduleAfterFire,
  updateSchedulePaused,
  updateScheduleResumed,
  updateScheduleSkip,
} from "./schedule-queries.ts";
import { sha256Hex } from "./sha256.ts";
import { startupSweep } from "./sweep.ts";
import {
  type AppendFactOpts,
  ArtifactCollisionError,
  type ArtifactListRow,
  type ArtifactRef,
  type ArtifactScope,
  ArtifactTooLargeError,
  ConcurrencyError,
  type CreateScheduleParams,
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
  type IntentType,
  MAX_BLOB_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_ROUTING_BYTES,
  type Message,
  MessageTooLargeError,
  type NarrowMessage,
  type ObservabilityEvent,
  PayloadTooLargeError,
  type ProviderConfigRow,
  type ProviderCredentialRow,
  type RunMetrics,
  type RunState,
  type Schedule,
  type ServerEndpointRow,
  type StoredEvent,
  type SweepResult,
  type WorkflowRow,
} from "./types.ts";
import { insertWorkflowIfAbsent, selectWorkflow, workflowExists } from "./workflow-queries.ts";

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

function rowToMessage(r: {
  run_id: string;
  ordinal: number;
  content: string;
  node_id: string | null;
  iteration: number;
}): Message {
  return {
    runId: r.run_id,
    ordinal: r.ordinal,
    content: JSON.parse(r.content),
    nodeId: r.node_id,
    iteration: r.iteration,
  };
}

function rowToRunState(row: RunStateRow): RunState {
  const parsedMetrics = JSON.parse(row.metrics) as Partial<RunMetrics>;
  const metrics: RunMetrics = {
    billedTokens: parsedMetrics.billedTokens ?? 0,
    totalCostUsd: parsedMetrics.totalCostUsd ?? 0,
    totalInputCostUsd: parsedMetrics.totalInputCostUsd ?? 0,
    totalOutputCostUsd: parsedMetrics.totalOutputCostUsd ?? 0,
    totalCacheReadCostUsd: parsedMetrics.totalCacheReadCostUsd ?? 0,
    totalCacheWriteCostUsd: parsedMetrics.totalCacheWriteCostUsd ?? 0,
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
    contractVersion: row.contract_version,
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
    baseGitRef: row.base_git_ref,
    finalGitSha: row.final_git_sha,
    finalHeadRef: row.final_head_ref,
    diffBaseSha: row.diff_base_sha,
    changeStat: row.change_stat != null ? (JSON.parse(row.change_stat) as ChangeStat) : null,
    inboxStatus: row.inbox_status as InboxStatus | null,
    acceptedSha: row.accepted_sha,
    cwd: row.cwd,
    projectId: row.project_id,
    projectName: row.project_name,
    workflowName: row.workflow_name,
    workflowScope: row.workflow_scope,
    workflowPath: row.workflow_path,
    scheduleId: row.schedule_id,
  };
}

function rowToProviderCredential(row: ProviderCredentialDbRow): ProviderCredentialRow {
  return {
    provider: row.provider,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProviderConfig(row: ProviderConfigDbRow): ProviderConfigRow {
  return {
    provider: row.provider,
    config: JSON.parse(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    workflowRef: row.workflow_ref,
    cwd: row.cwd,
    projectId: row.project_id,
    intervalMs: row.interval_ms,
    intervalText: row.interval_text,
    input: row.input,
    overlapPolicy: row.overlap_policy,
    nextFireAt: row.next_fire_at,
    lastFireAt: row.last_fire_at,
    lastRunId: row.last_run_id,
    pausedAt: row.paused_at,
    createdAt: row.created_at,
  };
}

export interface SqliteStoreOpts {
  path?: string;
  /** Directory for content-addressed blob files. Defaults to
   * `<dirname(path)>/blobs` for file-backed DBs; for `:memory:` a fresh
   * tmpdir is created and torn down on `close()`. */
  blobsDir?: string;
  now?: () => number;
  /** When false, open in read-the-version-and-refuse-to-bump mode: validate
   * `schema_version` against the binary and refuse to create or migrate. A
   * store-client (no daemon up) uses this so a stray open can't mutate schema.
   * Default true — the fact-writer owners (harness/daemon) auto-migrate. */
  migrate?: boolean;
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
    const shouldMigrate = opts.migrate ?? true;
    if (!shouldMigrate && fresh) {
      throw new Error(`no fragua store at ${path} — start the harness to create it`);
    }
    this.db = new Database(path);
    if (fresh) applyCreationPragmas(this.db);
    applyPragmas(this.db);
    if (shouldMigrate) migrate(this.db);
    else verifySchema(this.db);
    this.now = opts.now ?? (() => Date.now());

    if (opts.blobsDir != null) {
      this.blobsDir = opts.blobsDir;
      this.blobsDirOwned = false;
    } else if (path === ":memory:") {
      this.blobsDir = mkdtempSync(join(tmpdir(), "fragua-blobs-"));
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
        const row = selectRunStateRow(this.db, runId);
        if (row == null) throw new Error(`unknown run ${runId}`);
        if (row.version !== expectedVersion) {
          throw new ConcurrencyError(expectedVersion, row.version);
        }

        let state = rowToRunState(row);

        for (const event of events) {
          const payload = this.validatePayload(event.payload);
          const seq = bumpRunSeq(this.db, runId);
          seqs.push(seq);
          insertEventDaemon(this.db, runId, seq, event.type, payload, ts);
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
      const row = selectRunStateRow(this.db, runId);
      if (row == null) throw new Error(`unknown run ${runId}`);
      seq = bumpRunSeq(this.db, runId);
      insertEventWeb(this.db, runId, seq, event.type, payload, ts);
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
      const row = selectRunStateRow(this.db, runId);
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
        const seq = bumpRunSeq(this.db, runId);
        seqs.push(seq);
        insertEventDaemon(this.db, runId, seq, event.type, payload, ts);
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
      seq = insertDaemonEvent(this.db, event.type, payload, ts, runId);
    });
    return { seq, ts };
  }

  getDaemonEvents(opts: GetDaemonEventsOpts = {}): DaemonEventRow[] {
    const sinceSeq = opts.sinceSeq ?? 0;
    const limit = opts.limit ?? -1;
    const rows =
      opts.runId != null
        ? selectDaemonEventsByRun(this.db, opts.runId, sinceSeq, limit)
        : selectDaemonEvents(this.db, sinceSeq, limit);
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

    // project_id / project_name are NOT NULL identity columns. Production
    // callers (CLI run, server enqueue, schedule dispatcher) resolve a real
    // committed id + label at the boundary and pass them explicitly. When a
    // caller omits them (headless/test enqueues), fall back to the cwd as a
    // stable per-store identity and its basename as the label — never NULL.
    const cwd = params.cwd ?? null;
    const projectId = params.projectId ?? cwd ?? "local";
    const projectName =
      params.projectName ?? (cwd != null ? (cwd.split("/").filter(Boolean).at(-1) ?? "local") : "local");

    this.writeTxn(() => {
      if (!workflowExists(this.db, params.workflowSha)) {
        throw new Error(`unknown workflow sha ${params.workflowSha}`);
      }

      insertRunState(this.db, {
        runId: params.runId,
        workflowSha: params.workflowSha,
        contractVersion: EVENT_CONTRACT_VERSION,
        routing,
        metrics,
        priority: params.priority ?? 0,
        enqueuedAt: now,
        readyAt: now,
        updatedAt: now,
        cwd,
        projectId,
        projectName,
        workflowName: params.workflowName ?? null,
        workflowScope: params.workflowScope ?? null,
        workflowPath: params.workflowPath ?? null,
        scheduleId: params.scheduleId ?? null,
      });

      const seq = bumpRunSeq(this.db, params.runId);
      insertEventRunEnqueued(
        this.db,
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

  listRunIds(opts: ListRunIdsOpts = {}): string[] {
    return selectRunIds(this.db, opts);
  }

  listRunSummaryRows(opts: ListRunSummaryRowsOpts = {}): RunSummaryRow[] {
    return selectRunSummaryRows(this.db, opts);
  }

  claimNextRun(maxInFlight: number): { runId: string } | null {
    const now = this.now();
    let claimed: string | null = null;

    this.writeTxn(() => {
      // Capacity counts only runs the daemon could be executing here — imported
      // runs awaiting adoption never claim, so they must not burn a slot (§4.1).
      if (countDispatchableRunningRuns(this.db) >= maxInFlight) return;

      const row = selectNextQueuedRun(this.db);
      if (row == null) return;

      claimed = claimQueuedRun(this.db, { runId: row.run_id, expectedVersion: row.version, now });
    });

    return claimed != null ? { runId: claimed } : null;
  }

  startupSweep(opts?: { priorHeartbeatAt?: number }): SweepResult {
    return startupSweep(this.db, this.now, opts);
  }

  /** Rebind a run's cwd (a local binding) — used by `runs import --rehydrate`
   *  after reconstructing the run's worktree locally (db-import §3.2). */
  setRunCwd(runId: string, cwd: string): void {
    this.writeTxn(() => setRunStateCwd(this.db, runId, cwd));
  }

  /** True when the run is imported and not yet adopted — inert (db-import §4.1).
   *  Surfaced so the read-plane can badge imported runs without the marker
   *  riding on the portable `run_state` row. */
  isRunImported(runId: string): boolean {
    return isRunImported(this.db, runId);
  }

  setRunTitle(runId: string, title: string): void {
    const clipped = title.length > 200 ? title.slice(0, 200) : title;
    const now = this.now();
    this.writeTxn(() => {
      updateRunStateTitle(this.db, runId, clipped, now);
    });
  }

  // ─────────────── State reads ───────────────

  getState(runId: string): RunState | null {
    const row = selectRunStateRow(this.db, runId);
    return row == null ? null : rowToRunState(row);
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

  getEventsByType(runId: string, type: string): StoredEvent[] {
    return selectEventsByType(this.db, runId, type).map(rowToStoredEvent);
  }

  getSnapshotEvents(runId: string): StoredEvent[] {
    return selectSnapshotEvents(this.db, runId).map(rowToStoredEvent);
  }

  getLatestEvents(runId: string, limit: number): StoredEvent[] {
    return selectLatestEvents(this.db, runId, limit).map(rowToStoredEvent);
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
    const state = selectRunStateRow(this.db, runId);
    if (state == null) return [];
    return selectUnappliedIntents(this.db, runId, state.last_applied_seq).map(rowToStoredEvent);
  }

  getWakeCandidates(opts: { statuses: readonly RunState["status"][]; autoResumeBefore?: number }): WakeCandidateRow[] {
    return selectWakeCandidates(this.db, opts);
  }

  getInboxActionCandidates(): WakeCandidateRow[] {
    return selectInboxActionCandidates(this.db);
  }

  getGcEligibleSnapshotRuns(opts: { cwd: string; cutoff: number }): GcSnapshotRunRow[] {
    return selectGcEligibleSnapshotRuns(this.db, opts);
  }

  getNextPendingIntent(runId: string, type: IntentType, sinceSeq: number): PendingIntentRow | null {
    return selectNextPendingIntent(this.db, runId, type, sinceSeq);
  }

  findOrphanSideEffects(runId: string): OrphanSideEffectRow[] {
    return selectOrphanSideEffects(this.db, runId);
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
    const ts = this.now();
    const role = row.content.role;
    const nodeId = row.nodeId;
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
        const existing = selectMessageByDedup(this.db, runId, row.nodeId as string, iteration, contentHash);
        if (existing != null) {
          ordinal = existing.ordinal;
          return;
        }
      }
      ordinal = selectMaxMessageOrdinal(this.db, runId) + 1;
      insertMessage(this.db, {
        runId,
        ordinal,
        content: serialized,
        nodeId: row.nodeId,
        iteration,
        contentHash,
      });
      // Signal the per-run SSE stream that a new message row landed, so
      // clients can refetch the messages tail. Without this, tool-handler
      // appends are invisible to the client until the next llm
      // emits `agent.message_end`. Dedup hits don't insert a row, so
      // they don't emit either — the client's last refetch already
      // covers the existing ordinal.
      const eventPayload = this.validatePayload({ ordinal, role, nodeId, iteration });
      const seq = bumpRunSeq(this.db, runId);
      insertEventDaemon(this.db, runId, seq, "fact.message_appended", eventPayload, ts);
    });
    return { ordinal };
  }

  listThreadsWithMessages(): Array<{ runId: string; threadId: string }> {
    return selectActiveThreads(this.db);
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
    return selectMessages(this.db, runId, queryOpts).map(rowToMessage);
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
      iteration: r.iteration,
    }));
  }

  // ─────────────── Aggregations ───────────────

  getStepAggregates(runId: string): StepAggregateRow[] {
    return queryStepAggregates(this.db, runId);
  }

  getRunCostTotals(runId: string): RunCostTotalsRow {
    return queryRunCostTotals(this.db, runId);
  }

  getKpiTotals(window: AnalyticsWindow): KpiTotalsRow {
    return queryKpiTotals(this.db, window);
  }

  getRunsByBucket(window: BucketedWindow): RunsByBucketRow[] {
    return queryRunsByBucket(this.db, window);
  }

  getSpendByBucket(window: BucketedWindow): SpendByBucketRow[] {
    return querySpendByBucket(this.db, window);
  }

  getTokensByBucket(window: BucketedWindow): TokensByBucketRow[] {
    return queryTokensByBucket(this.db, window);
  }

  getCacheByBucket(window: BucketedWindow): CacheByBucketRow[] {
    return queryCacheByBucket(this.db, window);
  }

  getHaltDistribution(window: AnalyticsWindow): HaltDistributionRow[] {
    return queryHaltDistribution(this.db, window);
  }

  getModelDistribution(window: AnalyticsWindow): ModelDistributionRow[] {
    return queryModelDistribution(this.db, window);
  }

  getTopWorkflows(window: AnalyticsWindow, limit: number): TopWorkflowRow[] {
    return queryTopWorkflows(this.db, window, limit);
  }

  getFirstRunAt(window: AnalyticsWindow): number | null {
    return queryFirstRunAt(this.db, window);
  }

  getWorkflowDirectory(opts: { cwd?: string }): WorkflowDirectoryRow[] {
    return queryWorkflowDirectory(this.db, opts);
  }

  getDrilldownPage(filters: DrilldownFilters, opts: { limit: number; cursor?: string | undefined }): DrilldownPage {
    return queryDrilldownPage(this.db, filters, opts);
  }

  getGlobalMetricsTotals(opts: { sinceMs: number }): GlobalMetricsTotalsRow {
    return selectGlobalMetricsTotals(this.db, opts.sinceMs);
  }

  getGlobalModelBreakdown(opts: { sinceMs: number }): GlobalModelBreakdownRow[] {
    return selectGlobalModelBreakdown(this.db, opts.sinceMs);
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
      insertBlobIfAbsent(this.db, sha, bytes, now);
      upsertArtifact(this.db, {
        runId: scope.runId,
        nodeId: scope.nodeId,
        iteration: scope.iteration,
        key: scope.key,
        blobSha: sha,
        mime: mime ?? null,
        now,
      });
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
    const row = querySelectArtifactRef(this.db, scope);
    if (row == null) return null;
    return {
      ...scope,
      sha256: row.blob_sha,
      sizeBytes: row.size_bytes,
      mime: row.mime,
    };
  }

  listArtifacts(runId: string): ArtifactListRow[] {
    return selectArtifactsForRun(this.db, runId);
  }

  findDoneForIntent(runId: string, idempotencyKey: string): ArtifactRef | null {
    const done = selectFactSideEffectDone(this.db, runId, idempotencyKey);
    if (done == null) return null;
    const parsed = JSON.parse(done.payload) as {
      idempotencyKey: string;
      artifactKey: string;
    };

    const intent = selectFactSideEffectIntent(this.db, runId, idempotencyKey);
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
      insertDaemonLock(this.db, pid, hostname, now);
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
      upsertDaemonLock(this.db, pid, hostname, now);
      current = { pid, hostname, startedAt: now, heartbeatAt: now };
    });
    return { acquired: true, current };
  }

  heartbeatDaemonLock(pid: number): void {
    const now = this.now();
    this.writeTxn(() => {
      updateDaemonLockHeartbeat(this.db, pid, now);
    });
  }

  releaseDaemonLock(pid: number): void {
    this.writeTxn(() => {
      deleteDaemonLock(this.db, pid);
    });
  }

  runStateCounts(): { running: number; queued: number } {
    return { running: countRunningRuns(this.db), queued: countQueuedRuns(this.db) };
  }

  currentDaemonLock(): DaemonLockRow | null {
    const row = selectDaemonLock(this.db);
    if (row == null) return null;
    return {
      pid: row.pid,
      hostname: row.hostname,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
    };
  }

  currentServerEndpoint(): ServerEndpointRow | null {
    const row = selectServerEndpoint(this.db);
    if (row == null) return null;
    return {
      url: row.url,
      port: row.port,
      pid: row.pid,
      startedAt: row.started_at,
      harnessVersion: row.harness_version,
    };
  }

  /** Publish where the HTTP server is reachable, after the listener binds.
   *  Written by the harness's in-process server or a standalone `fragua serve`. */
  setServerEndpoint(args: { url: string; port: number; pid: number; version: string | null }): void {
    this.writeTxn(() => {
      upsertServerEndpoint(this.db, args.url, args.port, args.pid, this.now(), args.version);
    });
  }

  /** Clear the endpoint on clean shutdown. pid-scoped — a server that already
   *  rebound under a new pid isn't erased by a late closer. */
  clearServerEndpoint(pid: number): void {
    this.writeTxn(() => {
      deleteServerEndpoint(this.db, pid);
    });
  }

  // ─────────────── Provider credentials ───────────────

  getProviderCredential(provider: string): ProviderCredentialRow | null {
    const row = selectProviderCredential(this.db, provider);
    return row == null ? null : rowToProviderCredential(row);
  }

  listProviderCredentials(): ProviderCredentialRow[] {
    return selectAllProviderCredentials(this.db).map(rowToProviderCredential);
  }

  upsertProviderCredential(args: { provider: string; kind: "api_key" | "oauth"; payload: string }): void {
    // Caller passes pre-stringified `payload` per invariant I1 —
    // JSON.stringify must not run inside the write txn.
    const now = this.now();
    this.writeTxn(() => {
      queryUpsertProviderCredential(this.db, {
        provider: args.provider,
        kind: args.kind,
        payload: args.payload,
        now,
      });
    });
  }

  deleteProviderCredential(provider: string): void {
    this.writeTxn(() => {
      queryDeleteProviderCredential(this.db, provider);
    });
  }

  // ─────────────── Provider config ───────────────

  getProviderConfig(provider: string): ProviderConfigRow | null {
    const row = selectProviderConfig(this.db, provider);
    return row == null ? null : rowToProviderConfig(row);
  }

  listProviderConfigs(): ProviderConfigRow[] {
    return selectAllProviderConfigs(this.db).map(rowToProviderConfig);
  }

  upsertProviderConfig(args: { provider: string; config: string }): void {
    // Caller passes pre-stringified `config` per invariant I1 —
    // JSON.stringify must not run inside the write txn.
    const now = this.now();
    this.writeTxn(() => {
      queryUpsertProviderConfig(this.db, {
        provider: args.provider,
        config: args.config,
        now,
      });
    });
  }

  deleteProviderConfig(provider: string): void {
    this.writeTxn(() => {
      queryDeleteProviderConfig(this.db, provider);
    });
  }

  getProviderConfigRevision(): { maxUpdatedAt: number; rowCount: number } {
    const row = selectProviderConfigRevision(this.db);
    return { maxUpdatedAt: row.max_updated_at, rowCount: row.row_count };
  }

  // ─────────────── Schedules ───────────────

  createSchedule(params: CreateScheduleParams, now: number): Schedule {
    const fireOnCreate = params.fireOnCreate ?? true;
    const overlapPolicy = params.overlapPolicy ?? "skip";
    const nextFireAt = fireOnCreate ? now : now + params.intervalMs;
    const input = params.input ?? null;
    const projectId = params.projectId ?? params.cwd;
    this.writeTxn(() => {
      insertSchedule(this.db, {
        id: params.id,
        workflowRef: params.workflowRef,
        cwd: params.cwd,
        projectId,
        intervalMs: params.intervalMs,
        intervalText: params.intervalText,
        input,
        overlapPolicy,
        nextFireAt,
        createdAt: now,
      });
    });
    return {
      id: params.id,
      workflowRef: params.workflowRef,
      cwd: params.cwd,
      projectId,
      intervalMs: params.intervalMs,
      intervalText: params.intervalText,
      input,
      overlapPolicy,
      nextFireAt,
      lastFireAt: null,
      lastRunId: null,
      pausedAt: null,
      createdAt: now,
    };
  }

  getSchedule(id: string): Schedule | null {
    const row = selectSchedule(this.db, id);
    return row == null ? null : rowToSchedule(row);
  }

  listSchedules(opts?: { cwd?: string }): Schedule[] {
    const rows = opts?.cwd != null ? selectSchedulesByCwd(this.db, opts.cwd) : selectAllSchedules(this.db);
    return rows.map(rowToSchedule);
  }

  getDueSchedules(now: number): Schedule[] {
    return selectDueSchedules(this.db, now).map(rowToSchedule);
  }

  pauseSchedule(id: string, now: number): void {
    this.writeTxn(() => {
      updateSchedulePaused(this.db, id, now);
    });
  }

  resumeSchedule(id: string, now: number): void {
    this.writeTxn(() => {
      updateScheduleResumed(this.db, id, now);
    });
  }

  deleteSchedule(id: string): void {
    this.writeTxn(() => {
      deleteScheduleRow(this.db, id);
    });
  }

  recordScheduleFire(scheduleId: string, runId: string, now: number): void {
    this.writeTxn(() => {
      updateScheduleAfterFire(this.db, { id: scheduleId, runId, now });
    });
  }

  recordScheduleSkipped(scheduleId: string, now: number): void {
    this.writeTxn(() => {
      updateScheduleSkip(this.db, scheduleId, now);
    });
  }

  getScheduleRuns(scheduleId: string, limit: number): Array<{ runId: string; status: string; enqueuedAt: number }> {
    return selectScheduleRuns(this.db, scheduleId, limit).map((r) => ({
      runId: r.run_id,
      status: r.status,
      enqueuedAt: r.enqueued_at,
    }));
  }

  // ─────────────── Workflows ───────────────

  saveWorkflow(sha: string, name: string, source: string, ir: string, irVersion: number): void {
    const now = this.now();
    this.writeTxn(() => {
      insertWorkflowIfAbsent(this.db, sha, name, source, ir, irVersion, now);
    });
  }

  getWorkflow(sha: string): WorkflowRow | null {
    const row = selectWorkflow(this.db, sha);
    if (row == null) return null;
    return {
      sha: row.sha,
      name: row.name,
      source: row.source,
      ir: row.ir,
      irVersion: row.ir_version,
      createdAt: row.created_at,
    };
  }

  // ─────────────── Cwd listing ───────────────

  listCwds(): CwdSummaryRow[] {
    return selectCwds(this.db);
  }

  listProjects(): ProjectSummaryRow[] {
    return selectProjects(this.db);
  }

  // ─────────────── Maintenance ───────────────

  vacuum(): void {
    this.db.exec("VACUUM");
  }

  /** Prune the store to the portable, replayable run record, dropping every
   * other table — the secret-bearing (`provider_credentials`, `provider_config`)
   * and instance-scoped (`daemon_lock`, `server_endpoint`, `daemon_events`,
   * `schedules`) ones — then VACUUM + checkpoint so the dropped bytes are truly
   * gone (no freelist or WAL residue). `fragua ci` calls this before leaving a
   * `--db` artifact, so an exported store can never carry a credential.
   *
   * An ALLOWLIST, not a denylist: a table is dropped unless it's explicitly
   * part of the portable record, so a future table can't silently ride along.
   * Keep this in sync with schema.sql. */
  retainPortableTables(): void {
    const portable = new Set(["schema_version", "workflows", "run_state", "events", "messages", "artifacts", "blobs"]);
    const tables = this.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    this.db.exec("PRAGMA foreign_keys = OFF");
    for (const t of tables) {
      if (!portable.has(t)) this.db.exec(`DROP TABLE IF EXISTS "${t}"`);
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("VACUUM");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  /** Export `runId` as a portable `.fragua` bundle (db-import.md): a
   * manifest-first tar carrying only the portable subset — run_state, events,
   * messages, artifacts, the content-addressed workflow, and the referenced
   * blob bytes. Secret + machine-local tables are never read, so the artifact
   * is credential-free by construction (no scrub). `fraguaVersion` is stamped
   * for the import-time compatibility check (the store doesn't know the CLI
   * version).
   *
   * Blob coverage is the run's artifacts; message/event spill blobs are a
   * follow-up — import validates FK closure, so a gap is a clear error, never
   * silent corruption. `gitBundle` (optional) carries the run's tree state — a
   * `git bundle` the CLI builds from the run's refs — in a dedicated `git-bundle`
   * tar entry for `runs import --rehydrate` (db-import §3.2); the store can't
   * shell git, so the caller produces the bytes. */
  exportRunBundle(runId: string, opts: { fraguaVersion: string; gitBundle?: Uint8Array }): Uint8Array {
    const run = this.getState(runId);
    if (run == null) throw new Error(`exportRunBundle: run not found: ${runId}`);
    const wf = this.getWorkflow(run.workflowSha);
    if (wf == null) throw new Error(`exportRunBundle: workflow ${run.workflowSha} missing for run ${runId}`);

    // Canonical row order (by artifact scope) so the manifest is
    // store-independent — listArtifacts orders by created_at, not a total order.
    const artifacts = this.listArtifacts(runId).sort(
      (a, b) => a.nodeId.localeCompare(b.nodeId) || a.iteration - b.iteration || a.key.localeCompare(b.key),
    );
    const shas = [...new Set(artifacts.map((a) => a.blobSha))].sort();
    const blobEntries: TarEntry[] = [];
    const blobManifest: { sha256: string; size: number }[] = [];
    for (const sha of shas) {
      const bytes = this.blobs.get(sha);
      blobEntries.push({ name: `blobs/${sha}`, data: bytes });
      blobManifest.push({ sha256: sha, size: bytes.length });
    }

    const gitBundle =
      opts.gitBundle != null ? { sha256: sha256Hex(opts.gitBundle), size: opts.gitBundle.length } : undefined;

    const manifest: BundleManifest = {
      bundleVersion: BUNDLE_VERSION,
      fraguaVersion: opts.fraguaVersion,
      contractVersion: EVENT_CONTRACT_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      irVersion: wf.irVersion,
      run,
      workflow: { sha: wf.sha, name: wf.name, source: wf.source, ir: wf.ir, irVersion: wf.irVersion },
      events: this.getEvents(runId),
      messages: this.getMessages(runId),
      artifacts,
      blobs: blobManifest,
      ...(gitBundle != null ? { gitBundle } : {}),
    };
    const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
    const extra: TarEntry[] = opts.gitBundle != null ? [{ name: "git-bundle", data: opts.gitBundle }] : [];
    return writeTar([{ name: "manifest.json", data: manifestBytes }, ...blobEntries, ...extra]);
  }

  /** Merge a `.fragua` bundle (from {@link exportRunBundle}, possibly produced
   * on another machine) into this store so the run is inspectable here
   * (`fragua runs status|events|messages`). Fail-closed on what blocks a safe
   * read: an unknown `bundleVersion` (manifest shape this build can't parse) or
   * a blob whose bytes don't hash to its manifest sha — nothing is written. The
   * event-contract version does NOT gate import: a too-new/too-old run still
   * imports so it can be inspected, and `resumeCompatible` reports whether the
   * daemon's resume gate would accept it — an incompatible run parks on resume,
   * never on inspect (db-import §5). Idempotent: re-importing is a no-op
   * (events/messages INSERT-OR-IGNORE, artifacts upsert, run_state inserted
   * once). Per §4 the import rebinds `cwd → null` and resets local operator state
   * (`inboxStatus → null`, `acceptedSha → null`). The **status travels verbatim**
   * (an imported `paused_human` shows `paused_human`); inertness is a separate
   * concern — a row in `imported_runs` (§4.1) holds the run out of dispatch,
   * concurrency, and the inbox until it is explicitly adopted, rather than lying
   * about its status. Tree-state rehydrate + adopt/resume are later increments.
   *
   * Returns `imported: false` when the run was already present, and
   * `resumeCompatible: false` when the run's contract is outside this build's
   * supported range. */
  importRunBundle(bytes: Uint8Array): {
    runId: string;
    imported: boolean;
    resumeCompatible: boolean;
  } {
    const entries = readTar(bytes);
    const manifestEntry = entries.find((e) => e.name === "manifest.json");
    if (manifestEntry == null) throw new Error("importRunBundle: manifest.json missing from bundle");
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as BundleManifest;

    if (manifest.bundleVersion !== BUNDLE_VERSION) {
      throw new Error(
        `importRunBundle: unsupported bundleVersion ${manifest.bundleVersion} (this build reads ${BUNDLE_VERSION})`,
      );
    }
    // The event-contract version does NOT gate import — a too-new/too-old run
    // still imports so it can be inspected; only the daemon's resume gate parks
    // it (engine_incompatible), and only on resume (db-import §5).
    const resumeCompatible =
      manifest.contractVersion >= MIN_COMPATIBLE_CONTRACT_VERSION && manifest.contractVersion <= EVENT_CONTRACT_VERSION;

    // Verify every manifest blob is present and hashes to its claimed sha
    // BEFORE any write — a tampered or truncated bundle fails closed.
    const blobByName = new Map<string, Uint8Array>();
    for (const e of entries) {
      if (e.name.startsWith("blobs/")) blobByName.set(e.name.slice("blobs/".length), e.data);
    }
    const blobs: { sha256: string; size: number; data: Uint8Array }[] = [];
    for (const b of manifest.blobs) {
      const data = blobByName.get(b.sha256);
      if (data == null) {
        throw new Error(`importRunBundle: blob ${b.sha256} is in the manifest but absent from the bundle`);
      }
      const actual = sha256Hex(data);
      if (actual !== b.sha256) {
        throw new Error(`importRunBundle: blob ${b.sha256} failed its integrity check (bytes hash to ${actual})`);
      }
      blobs.push({ sha256: b.sha256, size: b.size, data });
    }

    // Tree state (the git-bundle) rides a dedicated `git-bundle` entry, not the
    // content-addressed `blobs/` set (it's run-level, not an artifact). Validate
    // its integrity here; the CLI reads the same entry for `--rehydrate` (the
    // store can't shell git, so it doesn't persist or unbundle it).
    if (manifest.gitBundle != null) {
      const gb = entries.find((e) => e.name === "git-bundle");
      if (gb == null) {
        throw new Error("importRunBundle: manifest declares a gitBundle but the git-bundle entry is absent");
      }
      const actual = sha256Hex(gb.data);
      if (actual !== manifest.gitBundle.sha256) {
        throw new Error(`importRunBundle: git-bundle failed its integrity check (bytes hash to ${actual})`);
      }
    }

    const run = manifest.run;
    const wf = manifest.workflow;
    const already = this.getState(run.runId) != null;
    const now = this.now();

    // db-import §4: the status travels VERBATIM (show the original state). The
    // local daemon must still never claim/resume an imported run into execution,
    // but that's enforced by the `imported_runs` marker (§4.1) — written below —
    // not by mutating the status. So a `paused_human` import shows paused_human,
    // a `running` import shows running, etc.

    // Pre-serialize outside the write lock — I1 bans JSON.stringify (and any
    // allocation-heavy work) inside writeTxn.
    const routingJson = JSON.stringify(run.routing);
    const metricsJson = JSON.stringify(run.metrics);
    const changeStatJson = run.changeStat != null ? JSON.stringify(run.changeStat) : null;
    const eventRows = manifest.events.map((ev) => ({
      runId: ev.runId,
      seq: ev.seq,
      type: ev.type,
      writer: ev.writer,
      payload: JSON.stringify(ev.payload),
      ts: ev.ts,
    }));
    const messageRows = manifest.messages.map((m) => {
      const content = JSON.stringify(m.content);
      return {
        runId: m.runId,
        ordinal: m.ordinal,
        content,
        nodeId: m.nodeId,
        iteration: m.iteration,
        contentHash: sha256Hex(content),
      };
    });

    // Blob files before the txn (fs I/O): the `blobs` row must never point at
    // a missing file — same file-then-row ordering as putArtifact.
    for (const b of blobs) this.blobs.put(b.sha256, b.data);

    this.writeTxn(() => {
      // FK order: workflow → blobs → run_state → events/messages/artifacts.
      insertWorkflowIfAbsent(this.db, wf.sha, wf.name, wf.source, wf.ir, wf.irVersion, now);
      for (const b of blobs) insertBlobIfAbsent(this.db, b.sha256, b.size, now);

      if (!already) {
        insertRunState(this.db, {
          runId: run.runId,
          workflowSha: run.workflowSha,
          contractVersion: run.contractVersion,
          routing: routingJson,
          metrics: metricsJson,
          priority: run.priority,
          enqueuedAt: run.enqueuedAt,
          readyAt: run.readyAt,
          updatedAt: run.updatedAt,
          cwd: null, // rebind on this machine — db-import §4
          projectId: run.projectId,
          projectName: run.projectName,
          workflowName: run.workflowName,
          workflowScope: run.workflowScope,
          workflowPath: run.workflowPath,
          scheduleId: run.scheduleId,
        });
        writeRunStateProjection(this.db, {
          runId: run.runId,
          version: run.version,
          status: run.status, // verbatim — db-import §4 (inertness via imported_runs)
          currentNode: run.currentNode,
          routingJson,
          metricsJson,
          lastAppliedSeq: run.lastAppliedSeq,
          priority: run.priority,
          readyAt: run.readyAt,
          nodeStartedAt: run.nodeStartedAt,
          dispatchStartedAt: run.dispatchStartedAt,
          updatedAt: run.updatedAt,
          baseGitSha: run.baseGitSha,
          baseGitRef: run.baseGitRef,
          finalGitSha: run.finalGitSha,
          finalHeadRef: run.finalHeadRef,
          diffBaseSha: run.diffBaseSha,
          changeStatJson,
          inboxStatus: null, // not local work to triage — db-import §4 (out of the inbox)
          acceptedSha: null,
        });
        setRunStateNextSeq(this.db, run.runId, run.nextSeq); // projection write omits next_seq
        // Local import marker (§4.1): holds the run inert (no dispatch / no
        // concurrency slot / no inbox) until adopted, while its status stays
        // verbatim. Pure INSERT — safe in this write txn.
        markRunImported(this.db, run.runId, now);
        // Title rides its own writer — the auto-titler sets it out-of-band, so
        // the create + projection helpers omit the column. Carry the source
        // title here; pass the source updatedAt so this doesn't clobber
        // updated_at to import time.
        if (run.title != null) updateRunStateTitle(this.db, run.runId, run.title, run.updatedAt);
      }

      for (const ev of eventRows) {
        insertEventOrIgnore(this.db, ev.runId, ev.seq, ev.type, ev.writer, ev.payload, ev.ts);
      }
      for (const m of messageRows) insertMessageOrIgnore(this.db, m);
      for (const a of manifest.artifacts) {
        upsertArtifact(this.db, {
          runId: run.runId,
          nodeId: a.nodeId,
          iteration: a.iteration,
          key: a.key,
          blobSha: a.blobSha,
          mime: a.mime,
          now: a.createdAt,
        });
      }
    });

    return { runId: run.runId, imported: !already, resumeCompatible };
  }

  gcBlobs(maxRows?: number): { deleted: number } {
    const limit = maxRows ?? 1000;
    // Pass 1: drop `blobs` rows with no artifact referent. RETURNING feeds
    // the file-delete pass so row-without-file is impossible mid-sweep.
    const orphanShas = deleteOrphanBlobs(this.db, limit);
    for (const sha of orphanShas) this.blobs.delete(sha);

    // Pass 2: remove blob files with no matching row. Catches files left
    // behind when a row was deleted directly (cascade) or when a crash
    // between put() and INSERT orphaned the file. Bounded by the same
    // per-sweep limit to keep tail latency predictable.
    let extraDeleted = 0;
    const budget = limit - orphanShas.length;
    if (budget > 0) {
      const shas = this.blobs.listAllShas();
      for (const sha of shas) {
        if (extraDeleted >= budget) break;
        if (!blobRowExists(this.db, sha)) {
          this.blobs.delete(sha);
          extraDeleted++;
        }
      }
    }

    return { deleted: orphanShas.length + extraDeleted };
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

  private writeProjection(state: RunState): void {
    const routing = JSON.stringify(state.routing);
    if (routing.length >= MAX_ROUTING_BYTES) {
      throw new PayloadTooLargeError(routing.length, MAX_ROUTING_BYTES);
    }
    const metrics = JSON.stringify(state.metrics);
    const changeStatJson = state.changeStat != null ? JSON.stringify(state.changeStat) : null;
    writeRunStateProjection(this.db, {
      runId: state.runId,
      version: state.version,
      status: state.status,
      currentNode: state.currentNode,
      routingJson: routing,
      metricsJson: metrics,
      lastAppliedSeq: state.lastAppliedSeq,
      priority: state.priority,
      readyAt: state.readyAt,
      nodeStartedAt: state.nodeStartedAt,
      dispatchStartedAt: state.dispatchStartedAt,
      updatedAt: state.updatedAt,
      baseGitSha: state.baseGitSha,
      baseGitRef: state.baseGitRef,
      finalGitSha: state.finalGitSha,
      finalHeadRef: state.finalHeadRef,
      diffBaseSha: state.diffBaseSha,
      changeStatJson,
      inboxStatus: state.inboxStatus,
      acceptedSha: state.acceptedSha,
    });
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
    if (typeof src["summary"] === "string") out["summary"] = src["summary"];
  }
  return out;
}
