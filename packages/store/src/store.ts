import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  selectNodeOutputRefs,
  upsertArtifact,
} from "./artifact-queries.ts";
import { BlobFS } from "./blob-fs.ts";
import {
  deleteDaemonLock,
  insertDaemonEvent,
  insertDaemonLock,
  selectDaemonEvents,
  selectDaemonEventsByRun,
  selectDaemonLock,
  updateDaemonLockHeartbeat,
  updateDaemonLockHttp,
  upsertDaemonLock,
} from "./daemon-queries.ts";
import {
  type DescendantEventRow,
  insertEventDaemon,
  insertEventRunEnqueued,
  insertEventWeb,
  type OrphanSideEffectRow,
  type PendingIntentRow,
  selectEvents,
  selectEventsByType,
  selectEventsWithDescendants,
  selectFactSideEffectDone,
  selectFactSideEffectIntent,
  selectGlobalEventsAtFloor,
  selectGlobalEventsForward,
  selectGlobalEventsLatest,
  selectNextPendingIntent,
  selectOrphanSideEffects,
  selectUnappliedIntents,
} from "./event-queries.ts";
import {
  insertMessage,
  type NarrowMessageWithOriginRow,
  selectActiveThreads,
  selectMaxMessageOrdinal,
  selectMessageByDedup,
  selectMessages,
  selectMessagesNarrow,
  selectMessagesNarrowWithDescendants,
} from "./message-queries.ts";
import { Metrics, type MetricsSnapshot } from "./metrics.ts";
import { migrate } from "./migrations.ts";
import { applyCreationPragmas, applyPragmas, CURRENT_SCHEMA_VERSION } from "./pragmas.ts";
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
  applyMetricsDelta,
  bumpRunSeq,
  type CwdSummaryRow,
  claimQueuedRun,
  countQueuedRuns,
  countRunningRuns,
  type GlobalMetricsTotalsRow,
  type GlobalModelBreakdownRow,
  insertRunState,
  type ListRunIdsOpts,
  type ListRunSummaryRowsOpts,
  type MetricsDeltaRow,
  type ParentCostSnapshot,
  // queryRunCostTotals renamed at import for symmetry with the other
  // `query*` imports below; original symbol used by tests directly.
  getRunCostTotals as queryRunCostTotals,
  getStepAggregates as queryStepAggregates,
  type RunCostTotalsRow,
  type RunStateRow,
  type RunSummaryRow,
  type StepAggregateRow,
  type ActiveDescendantNodeRow,
  type ChildStatusDigestRow,
  selectActiveChildren,
  selectActiveDescendantNodes,
  selectChildStatusDigest,
  selectCwds,
  selectGlobalMetricsTotals,
  selectGlobalModelBreakdown,
  selectNextQueuedRun,
  selectParentCostSnapshot,
  selectRunIds,
  selectRunStateRow,
  selectRunSummaryRows,
  selectWakeCandidates,
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
  type ArtifactRef,
  type ArtifactScope,
  ArtifactTooLargeError,
  type ClaimEligibility,
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
  type MergedStoredEvent,
  type Message,
  MessageTooLargeError,
  type MetricsDelta,
  type NarrowMessage,
  type ObservabilityEvent,
  PayloadTooLargeError,
  type ProviderConfigRow,
  type ProviderCredentialRow,
  type RunMetrics,
  type RunState,
  type Schedule,
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
    cwd: row.cwd,
    workflowName: row.workflow_name,
    workflowScope: row.workflow_scope,
    workflowPath: row.workflow_path,
    scheduleId: row.schedule_id,
    parentRunId: row.parent_run_id,
    parentNodeId: row.parent_node_id,
    parallelIndex: row.parallel_index,
    subgraphRootNodeId: row.subgraph_root_node_id,
    subgraphTerminalNodeId: row.subgraph_terminal_node_id,
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

  addMetricsDelta(runId: string, delta: MetricsDelta): void {
    const row: MetricsDeltaRow = {
      billedTokens: delta.billedTokens ?? 0,
      totalCostUsd: delta.totalCostUsd ?? 0,
      totalInputCostUsd: delta.totalInputCostUsd ?? 0,
      totalOutputCostUsd: delta.totalOutputCostUsd ?? 0,
      totalCacheReadCostUsd: delta.totalCacheReadCostUsd ?? 0,
      totalCacheWriteCostUsd: delta.totalCacheWriteCostUsd ?? 0,
      totalInputTokens: delta.totalInputTokens ?? 0,
      totalOutputTokens: delta.totalOutputTokens ?? 0,
      totalCacheReadTokens: delta.totalCacheReadTokens ?? 0,
      totalCacheWriteTokens: delta.totalCacheWriteTokens ?? 0,
      activeMs: delta.activeMs ?? 0,
    };
    const now = this.now();
    const startAt = performance.now();
    this.writeTxn(() => {
      applyMetricsDelta(this.db, runId, row, now);
    });
    this.metrics.recordWrite(performance.now() - startAt, "metrics_delta");
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

    this.writeTxn(() => {
      if (!workflowExists(this.db, params.workflowSha)) {
        throw new Error(`unknown workflow sha ${params.workflowSha}`);
      }

      insertRunState(this.db, {
        runId: params.runId,
        workflowSha: params.workflowSha,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        routing,
        metrics,
        priority: params.priority ?? 0,
        enqueuedAt: now,
        readyAt: now,
        updatedAt: now,
        cwd: params.cwd ?? null,
        workflowName: params.workflowName ?? null,
        workflowScope: params.workflowScope ?? null,
        workflowPath: params.workflowPath ?? null,
        scheduleId: params.scheduleId ?? null,
        parentRunId: params.parentRunId ?? null,
        parentNodeId: params.parentNodeId ?? null,
        parallelIndex: params.parallelIndex ?? null,
        subgraphRootNodeId: params.subgraphRootNodeId ?? null,
        subgraphTerminalNodeId: params.subgraphTerminalNodeId ?? null,
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

  claimNextRun(maxInFlight: number, opts?: { eligibility?: ClaimEligibility }): { runId: string } | null {
    const now = this.now();
    let claimed: string | null = null;
    // P0.4: `eligibility.parentStatusIn` will gate sub-runs on parent
    // status once P1.1 adds the `parent_run_id` column. Until then, the
    // schema has no sub-runs, so every queued row is a top-level run and
    // the filter is structurally a no-op. The parameter is accepted for
    // signature stability — caller code wired in P0 keeps working when
    // the SQL gains the join in P1.1.
    const _eligibility = opts?.eligibility;

    this.writeTxn(() => {
      if (countRunningRuns(this.db) >= maxInFlight) return;

      const row = selectNextQueuedRun(this.db);
      if (row == null) return;

      claimed = claimQueuedRun(this.db, { runId: row.run_id, expectedVersion: row.version, now });
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

  /**
   * Merged event stream covering this run AND every descendant sub-run,
   * in (ts, runId, seq) order. Sub-run events are returned with
   * `parentNodeIdForBranch` / `parallelIndexForBranch` / `branchNodeId`
   * stamped on each row so the parent's UI can render them as inline
   * branches without re-querying. D2 of `docs/proposals/parallel.md`.
   *
   * Cost: one recursive CTE join per call; bounded by the descendant
   * count (typically O(fanout-width)). Use for the run-detail page's
   * unified view; per-run drill-downs should keep using `getEvents`.
   */
  getEventsFeedWithDescendants(runId: string, opts: { sinceTs?: number; limit?: number } = {}): MergedStoredEvent[] {
    const rows: DescendantEventRow[] = selectEventsWithDescendants(this.db, runId, opts);
    return rows.map((r) => {
      const base = rowToStoredEvent(r);
      const ev: MergedStoredEvent = { ...base, originRunId: r.originRunId };
      if (r.parentNodeIdForBranch != null) ev.parentNodeIdForBranch = r.parentNodeIdForBranch;
      if (r.parallelIndexForBranch != null) ev.parallelIndexForBranch = r.parallelIndexForBranch;
      if (r.branchNodeId != null) ev.branchNodeId = r.branchNodeId;
      // Backward-compat shim: rewrite sub-run branch-root
      // fact.node_started / fact.node_completed payloads to look like
      // the legacy inline-branch shape (`parentNodeId` + `parallelIndex`
      // on the payload). Existing client code (branch-meta,
      // RunConversation, CostInspector) keys off those fields and
      // works unchanged. Only the branch root's events get this
      // treatment; internal multi-node subgraph events flow through
      // without parentNodeId, which keeps branch-meta from
      // mis-classifying them as additional branches.
      if (
        r.branchNodeId != null &&
        r.parentNodeIdForBranch != null &&
        (ev.type === "fact.node_started" || ev.type === "fact.node_completed")
      ) {
        const p = ev.payload as Record<string, unknown> | null;
        if (p != null && p["nodeId"] === r.branchNodeId) {
          ev.payload = {
            ...p,
            parentNodeId: r.parentNodeIdForBranch,
            ...(r.parallelIndexForBranch != null ? { parallelIndex: r.parallelIndexForBranch } : {}),
          };
        }
      }
      return ev;
    });
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
      // appends are invisible to the client until the next codergen
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
    }));
  }

  getMessagesNarrowWithDescendants(
    runId: string,
    opts: { sinceOrdinal?: number; limit?: number } = {},
  ): Array<NarrowMessage & { originRunId: string }> {
    const queryOpts: Parameters<typeof selectMessagesNarrowWithDescendants>[2] = {
      sinceOrdinal: opts.sinceOrdinal ?? 0,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    };
    return selectMessagesNarrowWithDescendants(this.db, runId, queryOpts).map((r: NarrowMessageWithOriginRow) => ({
      ordinal: r.ordinal,
      content: JSON.parse(r.content),
      nodeId: r.node_id,
      originRunId: r.originRunId,
    }));
  }

  // ─────────────── Aggregations ───────────────

  getStepAggregates(runId: string): StepAggregateRow[] {
    return queryStepAggregates(this.db, runId);
  }

  getRunCostTotals(runId: string): RunCostTotalsRow {
    return queryRunCostTotals(this.db, runId);
  }

  getParentCostSnapshot(parentRunId: string): ParentCostSnapshot {
    return selectParentCostSnapshot(this.db, parentRunId);
  }

  activeChildRuns(parentRunId: string): string[] {
    return selectActiveChildren(this.db, parentRunId);
  }

  activeDescendantNodes(parentRunId: string): ActiveDescendantNodeRow[] {
    return selectActiveDescendantNodes(this.db, parentRunId);
  }

  childStatusDigest(parentRunId: string): ChildStatusDigestRow | null {
    return selectChildStatusDigest(this.db, parentRunId);
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

  getNodeOutputs(runId: string): Map<string, { output: string; success: boolean; timestamp: number }> {
    const out = new Map<string, { output: string; success: boolean; timestamp: number }>();
    const decoder = new TextDecoder();
    // Cross-run substitution (P5 of docs/proposals/parallel.md):
    //
    //   1. Walk the parent chain UP and prepend their outputs. A
    //      sub-run prompt like "review using $scope.output" needs to
    //      see the parent's scope output. Parent's outputs are frozen
    //      at fanout time — they don't change after sub-runs dispatch.
    //
    //   2. Add this run's own outputs.
    //
    //   3. Walk the direct children DOWN, adding their outputs. A
    //      parent's downstream node (e.g. `synthesize`) reads
    //      `$lens_correctness.output` — the artifact lives under the
    //      child sub-run's namespace, not the parent's. Without this
    //      hop the substitution silently resolves to the empty string
    //      and cascades down the graph as aborted_exit.
    //
    // Order: parent first → self → children. `Map.set` later-wins, so
    // a child's overwrite of the parent's nodeId is intentional (the
    // child's output is the more recent thing — though parallel
    // branches by construction don't re-emit a parent's nodeId).
    const accumulateRefs = (sourceRunId: string): void => {
      const refs = selectNodeOutputRefs(this.db, sourceRunId);
      for (const ref of refs) {
        const colon = ref.outputRefKey.indexOf(":");
        if (colon < 0) continue;
        const refNodeId = ref.outputRefKey.slice(0, colon);
        const key = ref.outputRefKey.slice(colon + 1);
        let bytes: Uint8Array;
        try {
          bytes = this.getArtifact({ runId: sourceRunId, nodeId: refNodeId, iteration: ref.iteration, key });
        } catch {
          continue;
        }
        out.set(ref.nodeId, {
          output: decoder.decode(bytes),
          success: ref.outcomeStatus !== "fail",
          timestamp: ref.seq,
        });
      }
    };

    // (1) Parent chain (up). Bound to defend against pathological
    // cycles (impossible per schema FK but cheap belt-and-suspenders).
    const ancestry: string[] = [];
    let cursor: string | null = runId;
    let depth = 0;
    while (cursor != null && depth < 32) {
      const row = selectRunStateRow(this.db, cursor);
      if (row == null || row.parent_run_id == null) break;
      ancestry.push(row.parent_run_id);
      cursor = row.parent_run_id;
      depth++;
    }
    for (let i = ancestry.length - 1; i >= 0; i--) accumulateRefs(ancestry[i]!);

    // (2) Self.
    accumulateRefs(runId);

    // (3) Direct children. The children query is a single indexed
    // scan; we only walk one level deep to avoid an exponential blow
    // on hypothetical nested fan-outs (not currently supported).
    const childIds = selectRunIds(this.db, { parentRunId: runId });
    for (const childId of childIds) accumulateRefs(childId);

    return out;
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
        current: {
          pid,
          hostname,
          startedAt: now,
          heartbeatAt: now,
          httpUrl: null,
          httpPort: null,
          harnessVersion: null,
        },
      };
    });
    return result!;
  }

  forceAcquireDaemonLock(pid: number, hostname: string): DaemonLockResult {
    const now = this.now();
    let current!: DaemonLockRow;
    this.writeTxn(() => {
      upsertDaemonLock(this.db, pid, hostname, now);
      current = {
        pid,
        hostname,
        startedAt: now,
        heartbeatAt: now,
        httpUrl: null,
        httpPort: null,
        harnessVersion: null,
      };
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
      httpUrl: row.http_url,
      httpPort: row.http_port,
      harnessVersion: row.harness_version,
    };
  }

  /** Publish the harness HTTP discovery info onto the lock row. The
   *  harness is the supervisor, so it owns the URL columns
   *  regardless of which pid currently holds the daemon role. */
  setDaemonLockHttp(args: { url: string | null; port: number | null; version: string | null }): void {
    this.writeTxn(() => {
      updateDaemonLockHttp(this.db, args.url, args.port, args.version);
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
    this.writeTxn(() => {
      insertSchedule(this.db, {
        id: params.id,
        workflowRef: params.workflowRef,
        cwd: params.cwd,
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

  saveWorkflow(sha: string, name: string, dotSource: string): void {
    const now = this.now();
    this.writeTxn(() => {
      insertWorkflowIfAbsent(this.db, sha, name, dotSource, now);
    });
  }

  getWorkflow(sha: string): WorkflowRow | null {
    const row = selectWorkflow(this.db, sha);
    if (row == null) return null;
    return {
      sha: row.sha,
      name: row.name,
      dotSource: row.dot_source,
      createdAt: row.created_at,
    };
  }

  // ─────────────── Cwd listing ───────────────

  listCwds(): CwdSummaryRow[] {
    return selectCwds(this.db);
  }

  // ─────────────── Maintenance ───────────────

  vacuum(): void {
    this.db.exec("VACUUM");
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
      branch: state.branch,
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
    if (typeof src["fidelity"] === "string") out["fidelity"] = src["fidelity"];
  }
  return out;
}
