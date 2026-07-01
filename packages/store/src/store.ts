import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INPUTS_KEY, validateRoutingPatch } from "@fragua/core";
import type { ChangeStat, InboxStatus, RunEnqueuedPayload } from "@fragua/types";
import { NODE_LIFECYCLE_FACT_TYPES, VALID_WRITERS } from "@fragua/types";
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
import {
  asObject,
  assertBundleManifest,
  assertSha256,
  BUNDLE_VERSION,
  type BundleManifest,
  blobPath,
  canonicalJson,
  decodeJsonl,
  encodeJsonl,
  MANIFEST_ENTRY,
  readTar,
  runArtifactsPath,
  runEventsPath,
  runMessagesPath,
  runResultPath,
  SCRUBBER_VERSION,
  type TarEntry,
  workflowIrPath,
  workflowSourcePath,
  writeTar,
} from "./bundle.ts";
import {
  deleteDaemonLock,
  deleteServerEndpoint,
  insertDaemonEvent,
  insertDaemonLock,
  selectDaemonEvents,
  selectDaemonEventsByRun,
  selectDaemonLock,
  selectLatestDaemonLifecycleEvent,
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
  selectEventsTail,
  selectFactSideEffectDone,
  selectFactSideEffectIntent,
  selectGlobalEventsAtFloor,
  selectGlobalEventsForward,
  selectGlobalEventsLatest,
  selectLatestEvents,
  selectLatestLifecycleByNode,
  selectNextPendingIntent,
  selectOrphanSideEffects,
  selectSnapshotEvents,
  selectUnappliedIntents,
} from "./event-queries.ts";
import {
  deleteMcpOAuth as queryDeleteMcpOAuth,
  upsertMcpOAuth as queryUpsertMcpOAuth,
  selectAllMcpOAuth,
  selectMcpOAuth,
} from "./mcp-oauth-queries.ts";
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
  getAllOutputStructs,
  getLatestOutput,
  getLatestOutputBatch,
  getOutputsForRun,
  insertOutput,
} from "./outputs-queries.ts";
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
import { applyFact, deriveRunState, emptyMetrics } from "./reducers.ts";
import {
  collectRoutingBlobShas,
  isBlobRef,
  materializeStructJson,
  maybeSpillStruct,
  spillRoutingInputs,
} from "./routing-blobs.ts";
import { assertSafeRunId } from "./run-id.ts";
import {
  bumpRunSeq,
  type CwdSummaryRow,
  claimQueuedRun,
  countDispatchableRunningRuns,
  countQueuedRuns,
  countRunningRuns,
  type FleetSummary,
  type FleetSummaryOpts,
  type GcSnapshotRunRow,
  type GlobalMetricsTotalsRow,
  type GlobalModelBreakdownRow,
  insertRunState,
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
  selectAllRoutings,
  selectCwds,
  selectFleetSummary,
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
  selectLatestScheduleError,
  selectSchedule,
  selectScheduleRuns,
  selectSchedulesByCwd,
  updateScheduleAfterFire,
  updateSchedulePaused,
  updateScheduleResumed,
  updateScheduleSkip,
} from "./schedule-queries.ts";
import { buildExportRegistry, isTextMime, scrubEventPayload, scrubJsonStrings } from "./scrub/export-registry.ts";
import { type ScrubOptions, scrubText } from "./scrub/scrub.ts";
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
  type GetEventsTailOpts,
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
  RunNotFoundError,
  type RunState,
  type Schedule,
  type ServerEndpointRow,
  type StoredEvent,
  type SweepResult,
  utf8ByteLength,
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
  pass: number;
}): Message {
  return {
    runId: r.run_id,
    ordinal: r.ordinal,
    content: JSON.parse(r.content),
    nodeId: r.node_id,
    iteration: r.iteration,
    pass: r.pass,
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
    imported: row.imported === 1,
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
    title: row.title,
    overlapPolicy: row.overlap_policy,
    nextFireAt: row.next_fire_at,
    lastFireAt: row.last_fire_at,
    lastRunId: row.last_run_id,
    pausedAt: row.paused_at,
    lastError: null,
    createdAt: row.created_at,
  };
}

/**
 * Walk an exported event payload and rewrite every `$fragua_blob` sha in the
 * genesis routing to the export sha from `reCasMap`. Called after
 * `scrubEventPayload` so free-text string values are already scrubbed; only
 * the ref object's sha field needs to change. Returns the original when there
 * is nothing to rewrite (no allocation on the hot path for non-genesis events).
 */
function rewriteRoutingRefs(
  payload: unknown,
  reCasMap: Map<string, { exportSha: string; exportBytes: Uint8Array }>,
): unknown {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const src = payload as Record<string, unknown>;
  const routing = src["routing"];
  if (routing == null || typeof routing !== "object" || Array.isArray(routing)) return payload;
  const newRouting = deepRewriteRefs(routing, reCasMap);
  if (newRouting === routing) return payload;
  return { ...src, routing: newRouting };
}

function deepRewriteRefs(v: unknown, reCasMap: Map<string, { exportSha: string; exportBytes: Uint8Array }>): unknown {
  if (isBlobRef(v)) {
    const origSha = v["$fragua_blob"];
    const mapped = reCasMap.get(origSha);
    if (mapped == null || mapped.exportSha === origSha) return v;
    return { ...v, $fragua_blob: mapped.exportSha };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((item) => {
      const r = deepRewriteRefs(item, reCasMap);
      if (r !== item) changed = true;
      return r;
    });
    return changed ? out : v;
  }
  if (v !== null && typeof v === "object") {
    const src = v as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(src)) {
      const r = deepRewriteRefs(val, reCasMap);
      if (r !== val) changed = true;
      out[k] = r;
    }
    return changed ? out : v;
  }
  return v;
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

/** Options for {@link SqliteStore.exportRunBundle}. */
export interface ExportBundleOptions {
  fraguaVersion: string;
  /** `"source"` (default): markers are `[REDACTED:source]`. `"generic"`:
   * markers are `[REDACTED]` with no source label (CI bundles). */
  labelMode?: "source" | "generic";
  /** Extra literal needles merged into the registry before compilation.
   * Used by the CI profile to inject captured env secrets. */
  extraLiterals?: Array<{ value: string; source: string }>;
  /** The run's terminal result envelope (`fragua ci`'s
   * `{ runId, status, outputs, usage }`). When supplied it is scrubbed as JSON
   * and shipped as `runs/<id>/result.json` so an imported run carries the same
   * object the `--json` stream emitted. Omitted for a non-terminal run. */
  runResult?: unknown;
}

/** Return value of {@link SqliteStore.exportRunBundle}. */
export interface ExportBundleResult {
  bytes: Uint8Array;
  /** `true` when a live secret value (provider-credential or `env:*` literal)
   * was found VERBATIM in an UN-SCRUBBED binary artifact blob. Text surfaces
   * are always scrubbed, so a literal hit there is non-fatal by design. Binary
   * blobs ship as-is (§13 residual) and are scanned — a hit means the secret
   * reached an egress surface the scrubber does NOT redact. Pattern-only
   * matches never set this flag. */
  liveLiteralHit: boolean;
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
    // Gate the routing patch against the known key vocabulary BEFORE the write
    // transaction opens (I1): an unknown key family or wrong-typed value must be
    // rejected here, never spread into the projection where a later typed read
    // would silently degrade to a conservative default and a wrong dispatch.
    if (opts.routingPatch != null) validateRoutingPatch(opts.routingPatch);
    const ts = this.now();
    const seqs: number[] = [];
    let newVersion = 0;
    let committedState: RunState | undefined;
    const startAt = performance.now();

    // Pre-serialise outputs payloads OUTSIDE the transaction (invariant I1:
    // no JSON.stringify inside db.transaction). We extract them from the
    // node_completed events before entering the txn so insertOutput receives a
    // plain string inside the closure. An oversized struct spills to the blob
    // CAS here (blob written before the txn, same crash-safety as routing
    // spill): the event payload + the index then hold a tiny `{$fragua_blob}`
    // ref, so neither needs raising past the 4 KiB cap, and a large struct is
    // no longer a node failure.
    const outputsInserts: Array<{ nodeId: string; iteration: number; structJson: string }> = [];
    const outputsSpilledBlobs: Array<{ sha: string; bytes: number }> = [];
    for (const event of events) {
      if (event.type === "fact.node_completed") {
        const p = event.payload as { nodeId: string; iteration: number; outputs?: Record<string, unknown> };
        if (p.outputs !== undefined) {
          const structJson = JSON.stringify(p.outputs);
          const ref = maybeSpillStruct(structJson, (sha, bytes) => this.blobs.put(sha, bytes));
          if (ref !== null) {
            // Replace the inline struct in the event payload with the ref so the
            // event stays under the 4 KiB cap; the index stores the same ref.
            p.outputs = { ...ref };
            outputsInserts.push({ nodeId: p.nodeId, iteration: p.iteration, structJson: JSON.stringify(ref) });
            outputsSpilledBlobs.push({ sha: ref.$fragua_blob, bytes: ref.bytes });
          } else {
            outputsInserts.push({ nodeId: p.nodeId, iteration: p.iteration, structJson });
          }
        }
      }
    }

    try {
      // Fold + serialize OUTSIDE the write lock (invariant I1: no JSON.stringify
      // inside a txn body). We read the row optimistically, fold the events, and
      // serialize the resulting projection here; the txn below re-checks the
      // version under the lock and writeProjection's expectedVersion guard rejects
      // a stale write, so the speculative fold stays OCC-correct.
      const row = selectRunStateRow(this.db, runId);
      if (row == null) throw new Error(`unknown run ${runId}`);
      if (row.version !== expectedVersion) {
        throw new ConcurrencyError(expectedVersion, row.version);
      }

      let state = rowToRunState(row);
      for (const event of events) {
        state = applyFact(state, event, ts);
      }
      if (opts.routingPatch != null) {
        state = { ...state, routing: { ...state.routing, ...opts.routingPatch } };
      }
      state = {
        ...state,
        version: state.version + 1,
        lastAppliedSeq: opts.advanceAppliedTo != null ? opts.advanceAppliedTo : state.lastAppliedSeq,
      };

      // Pre-serialize the projection + event payloads, and run the MAX_ROUTING_BYTES
      // guard here so an oversized routing payload fails closed before the lock.
      const routingJson = JSON.stringify(state.routing);
      const routingBytes = utf8ByteLength(routingJson);
      if (routingBytes >= MAX_ROUTING_BYTES) {
        throw new PayloadTooLargeError(routingBytes, MAX_ROUTING_BYTES);
      }
      const projection = {
        routingJson,
        metricsJson: JSON.stringify(state.metrics),
        changeStatJson: state.changeStat != null ? JSON.stringify(state.changeStat) : null,
      };
      const eventPayloads = events.map((event) => this.validatePayload(event.payload));
      committedState = state;
      newVersion = state.version;

      this.writeTxn(() => {
        // Re-check the version under the lock: the fold above ran on a snapshot
        // read taken before the txn, so another writer may have advanced the row.
        const current = selectRunStateRow(this.db, runId);
        if (current == null) throw new Error(`unknown run ${runId}`);
        if (current.version !== expectedVersion) {
          throw new ConcurrencyError(expectedVersion, current.version);
        }

        for (let i = 0; i < events.length; i++) {
          const seq = bumpRunSeq(this.db, runId);
          seqs.push(seq);
          insertEventDaemon(this.db, runId, seq, events[i]!.type, eventPayloads[i]!, ts);
        }

        // Durability barrier for spilled-output blobs: the BlobFS.put() ran
        // before this txn; the row insert makes them reachable + GC-protected.
        for (const { sha, bytes } of outputsSpilledBlobs) {
          insertBlobIfAbsent(this.db, sha, bytes, ts);
        }

        // Write outputs index rows in the same transaction (ground rule #5).
        for (const o of outputsInserts) {
          insertOutput(this.db, runId, o.nodeId, o.iteration, o.structJson);
        }

        this.writeProjection(state, expectedVersion, projection);
      });
      this.metrics.recordWrite(performance.now() - startAt, "fact");
    } catch (err) {
      if (err instanceof ConcurrencyError) this.metrics.recordOccConflict();
      throw err;
    }

    return { committed: true, newVersion, seqs, ...(committedState !== undefined ? { state: committedState } : {}) };
  }

  appendIntent(runId: string, event: IntentEvent): IntentAppendResult {
    const payload = this.validatePayload(event.payload);
    const ts = this.now();
    let seq = 0;
    const startAt = performance.now();

    this.writeTxn(() => {
      const row = selectRunStateRow(this.db, runId);
      if (row == null) throw new RunNotFoundError(runId);
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

  latestDaemonLifecycleEvent(): DaemonEventRow | null {
    const r = selectLatestDaemonLifecycleEvent(this.db);
    if (r == null) return null;
    return {
      seq: r.seq,
      type: r.type,
      payload: JSON.parse(r.payload),
      ts: r.ts,
      runId: r.run_id,
    };
  }

  // ─────────────── Run lifecycle ───────────────

  enqueueRun(params: EnqueueRunParams): void {
    const now = this.now();

    // Spill oversized routing.inputs string values to the blob CAS before
    // the size checks. Blobs are written before the transaction so
    // crash-between-put-and-row leaves an orphan file (GC sweeps it), which
    // is safer than the inverse. The rows are inserted inside writeTxn below.
    let effectiveRouting = params.initialRouting ?? {};
    let spilledBlobs: Array<{ key: string; sha: string; bytes: number }> = [];
    if (effectiveRouting[INPUTS_KEY] != null) {
      const result = spillRoutingInputs(effectiveRouting, (sha, bytes) => {
        this.blobs.put(sha, bytes);
      });
      effectiveRouting = result.routing;
      spilledBlobs = result.spilled;
    }

    const routing = JSON.stringify(effectiveRouting);
    const routingBytes = utf8ByteLength(routing);
    if (routingBytes >= MAX_ROUTING_BYTES) {
      throw new PayloadTooLargeError(routingBytes, MAX_ROUTING_BYTES);
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

    // The genesis event carries the whole enqueue identity so `run_state` is
    // derivable by replaying the log (no `cwd` — its absence keeps an imported
    // run inert). Bounded by the 4 KiB event cap, tighter than routing's 8 KiB.
    // Use effectiveRouting (post-spill) so blob refs appear in the genesis event.
    const genesisPayload = JSON.stringify({
      workflowSha: params.workflowSha,
      priority: params.priority ?? 0,
      projectId,
      projectName,
      routing: effectiveRouting,
      contractVersion: EVENT_CONTRACT_VERSION,
      ...(params.workflowName != null ? { workflowName: params.workflowName } : {}),
      ...(params.workflowScope != null ? { workflowScope: params.workflowScope } : {}),
      ...(params.workflowPath != null ? { workflowPath: params.workflowPath } : {}),
      ...(params.scheduleId != null ? { scheduleId: params.scheduleId } : {}),
    } satisfies RunEnqueuedPayload);
    const genesisBytes = utf8ByteLength(genesisPayload);
    if (genesisBytes >= MAX_EVENT_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError(genesisBytes, MAX_EVENT_PAYLOAD_BYTES);
    }

    this.writeTxn(() => {
      if (!workflowExists(this.db, params.workflowSha)) {
        throw new Error(`unknown workflow sha ${params.workflowSha}`);
      }
      // Insert blob rows for any values spilled to the CAS. The BlobFS.put()
      // calls happened before this transaction; the row insert is the
      // durability barrier that makes them reachable to reads and GC-protected.
      for (const { sha, bytes } of spilledBlobs) {
        insertBlobIfAbsent(this.db, sha, bytes, now);
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
      insertEventRunEnqueued(this.db, params.runId, seq, genesisPayload, now);
    });
  }

  listRunIds(opts: ListRunIdsOpts = {}): string[] {
    return selectRunIds(this.db, opts);
  }

  listRunSummaryRows(opts: ListRunSummaryRowsOpts = {}): RunSummaryRow[] {
    return selectRunSummaryRows(this.db, opts);
  }

  fleetSummary(opts: FleetSummaryOpts = {}): FleetSummary {
    return selectFleetSummary(this.db, opts);
  }

  claimNextRun(maxInFlight: number): { runId: string } | null {
    const now = this.now();
    let claimed: string | null = null;

    this.writeTxn(() => {
      // Capacity counts only runs the daemon could be executing here — imported
      // runs (inert by marker) never claim, so they must not burn a slot.
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

  getEventsTail(runId: string, opts: GetEventsTailOpts = {}): StoredEvent[] {
    return selectEventsTail(this.db, runId, opts).map(rowToStoredEvent);
  }

  getLatestLifecycleByNode(runId: string): Array<{ nodeId: string; type: string }> {
    return selectLatestLifecycleByNode(this.db, runId, NODE_LIFECYCLE_FACT_TYPES);
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
    row: Omit<Message, "runId" | "ordinal" | "pass"> & { pass?: number },
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
        const existing = selectMessageByDedup(
          this.db,
          runId,
          row.nodeId as string,
          iteration,
          row.pass ?? 0,
          contentHash,
        );
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
        pass: row.pass ?? 0,
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
      pass: r.pass,
    }));
  }

  // ─────────────── Outputs index ───────────────

  getOutputsForRun(runId: string): Array<{ nodeId: string; iteration: number; struct: string }> {
    const out: Array<{ nodeId: string; iteration: number; struct: string }> = [];
    for (const r of getOutputsForRun(this.db, runId)) {
      try {
        out.push({ ...r, struct: materializeStructJson(r.struct, (sha) => this.blobs.get(sha)) });
      } catch {
        // A spilled output whose blob is missing/corrupt: drop the row rather
        // than throw. A downstream `${{ outputs.X.f }}` read then fails closed
        // (a clean node failure) instead of crashing the dispatch, and the UI
        // simply omits the unreadable output.
      }
    }
    return out;
  }

  getLatestOutput(runId: string, nodeId: string): string | null {
    const struct = getLatestOutput(this.db, runId, nodeId);
    if (struct === null) return null;
    try {
      return materializeStructJson(struct, (sha) => this.blobs.get(sha));
    } catch {
      // Missing/corrupt spilled blob — surface as "no output" so the caller
      // fails closed rather than throwing.
      return null;
    }
  }

  getLatestOutputBatch(runId: string, nodeIds: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const { nodeId, struct } of getLatestOutputBatch(this.db, runId, nodeIds)) {
      try {
        out.set(
          nodeId,
          materializeStructJson(struct, (sha) => this.blobs.get(sha)),
        );
      } catch {
        // Missing/corrupt spilled blob — omit the node so the caller treats it
        // as "no output" (fails closed), matching `getLatestOutput`.
      }
    }
    return out;
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

  readBlob(sha: string): Uint8Array | null {
    if (!this.blobs.has(sha)) return null;
    return this.blobs.get(sha);
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

  // ─────────────── MCP OAuth ───────────────

  getMcpOAuth(url: string): string | undefined {
    const row = selectMcpOAuth(this.db, url);
    return row == null ? undefined : row.payload;
  }

  listMcpOAuth(): { url: string; payload: string }[] {
    return selectAllMcpOAuth(this.db).map((row) => ({ url: row.url, payload: row.payload }));
  }

  upsertMcpOAuth(url: string, payload: string): void {
    // Caller passes a pre-stringified opaque `payload` per invariant I1 —
    // JSON.stringify must not run inside the write txn.
    const now = this.now();
    this.writeTxn(() => {
      queryUpsertMcpOAuth(this.db, { url, payload, now });
    });
  }

  deleteMcpOAuth(url: string): void {
    this.writeTxn(() => {
      queryDeleteMcpOAuth(this.db, url);
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
    const title = params.title ?? null;
    const projectId = params.projectId ?? params.cwd;
    this.writeTxn(() => {
      insertSchedule(this.db, {
        id: params.id,
        workflowRef: params.workflowRef,
        cwd: params.cwd,
        projectId,
        intervalMs: params.intervalMs,
        intervalText: params.intervalText,
        title,
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
      title,
      overlapPolicy,
      nextFireAt,
      lastFireAt: null,
      lastRunId: null,
      pausedAt: null,
      lastError: null,
      createdAt: now,
    };
  }

  getSchedule(id: string): Schedule | null {
    const row = selectSchedule(this.db, id);
    return row == null ? null : this.scheduleFromRow(row);
  }

  listSchedules(opts?: { cwd?: string }): Schedule[] {
    const rows = opts?.cwd != null ? selectSchedulesByCwd(this.db, opts.cwd) : selectAllSchedules(this.db);
    return rows.map((r) => this.scheduleFromRow(r));
  }

  /** Public schedule shape + the auto-pause cause. The cause join runs only
   * for paused rows (the dispatcher excludes paused schedules from the due
   * scan, so the hot path never pays it). */
  private scheduleFromRow(row: ScheduleRow): Schedule {
    const schedule = rowToSchedule(row);
    if (row.paused_at == null) return schedule;
    const err = selectLatestScheduleError(this.db, row.id);
    return err == null ? schedule : { ...schedule, lastError: err.error };
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
   * other table — the secret-bearing (`provider_credentials`, `provider_config`,
   * `mcp_oauth`)
   * and instance-scoped (`daemon_lock`, `server_endpoint`, `daemon_events`,
   * `schedules`) ones — then VACUUM + checkpoint so the dropped bytes are truly
   * gone (no freelist or WAL residue). `fragua ci` calls this before leaving a
   * `--db` artifact, so the pruned store carries no credential TABLE.
   *
   * NOT a scrub: the retained `events`/`messages` keep the RAW transcript +
   * observability deltas, which can hold secret values verbatim. The pruned
   * `--db` store is a raw inspection record, NOT secret-free — the scrubbed,
   * safe-to-publish artifact is `exportRunBundle` (the `.fragua` bundle).
   *
   * An ALLOWLIST, not a denylist: a table is dropped unless it's explicitly
   * part of the portable record, so a future table can't silently ride along.
   * Keep this in sync with schema.sql. */
  retainPortableTables(): void {
    // `imported_runs` rides along: it's the authoritative inert marker, and
    // `getState` reads it to derive `imported`. Dropping it would both break that
    // read and strip the inert flag from any imported run in a portable copy.
    const portable = new Set([
      "schema_version",
      "workflows",
      "run_state",
      "events",
      "messages",
      "artifacts",
      "blobs",
      "imported_runs",
    ]);
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

  /** Export `runId` as a portable `.fragua` bundle (bundles.md): a
   * manifest-first tar carrying a DENYLIST-FILTERED EVENT LOG, transcript,
   * artifact rows, the content-addressed workflow, and the referenced blob
   * bytes. There is NO `run_state` — it is re-derived on import by replaying
   * the log.
   *
   * Event filtering (denylist): streaming-delta and scaffolding events that are
   * losslessly reconstructable from the `messages` transcript are dropped.
   * Everything else is retained so read-plane projections (step aggregates,
   * edge overlays, title) work on imported runs. Dropped types:
   *   llm.text_delta, llm.text_end, llm.thinking_delta, llm.thinking_end,
   *   llm.toolcall_delta, llm.toolcall_end,
   *   agent.start, agent.end, agent.message_start, agent.message_end,
   *   agent.message_update, agent.turn_start, agent.turn_end,
   *   tool.execution_start, tool.execution_update, tool.execution_end,
   *   tool.output_chunk, summary.started, summary.text_delta,
   *   snapshot.captured (snapshot refs not in bundle; imported cwd=null).
   * Retained: llm.start (slimmed — prompt stripped, identity fields kept),
   *   llm.done, llm.error, edge.selected, run.title_generated, cost.recorded,
   *   budget.warn, budget.stop, steering.*, control.*, fact.*, intent.*.
   *
   * `llm.start` is exported as a slimmed payload (prompt stripped; see
   * `slimLlmStartForExport`) so it anchors getStepAggregates cost windows
   * and eventsToSteps LLM-step detection without leaking prompt text.
   *
   * Stored events are never mutated — filtering and slimming are export-only.
   * Message content and event payload free-text fields are scrubbed at export
   * time (literal credentials + cwd path + known-format patterns). To build the
   * literal needle set this reads `provider_credentials` payloads into the
   * registry in memory for the duration of the call — cleartext secrets never
   * enter the bundle, but the egress path does touch them. Text-ish
   * artifact blobs (mime `text/*` or `application/json|x-yaml|xml|javascript`)
   * are decoded, scrubbed, and re-CASed — the new sha replaces the original in
   * the artifacts JSONL, blob tar entry, and manifest blobs[] consistently.
   * Binary blobs ship as-is under their original sha; a secret in a binary
   * artifact is a known residual (see docs/proposals/secret-scrubbing.md §13).
   *
   * `fraguaVersion` is stamped for the import-time compatibility check.
   * Single-run today (the `fragua ci --export` producer); the format is
   * multi-run by construction. Rows are canonically ordered (events by seq,
   * messages by ordinal, artifacts/blobs by sha) for re-export determinism. */
  exportRunBundle(runId: string, opts: ExportBundleOptions): ExportBundleResult {
    const run = this.getState(runId);
    if (run == null) throw new Error(`exportRunBundle: run not found: ${runId}`);
    const wf = this.getWorkflow(run.workflowSha);
    if (wf == null) throw new Error(`exportRunBundle: workflow ${run.workflowSha} missing for run ${runId}`);

    const allEvents = [...this.getEvents(runId)].sort((a, b) => a.seq - b.seq);
    const events = allEvents.filter((e) => !EXPORT_DENYLIST.has(e.type));
    const messages = [...this.getMessages(runId)].sort((a, b) => a.ordinal - b.ordinal);

    const { registry, literalValues } = buildExportRegistry({
      providerCredentials: this.listProviderCredentials(),
      cwd: run.cwd,
      ...(opts.extraLiterals !== undefined ? { extraLiterals: opts.extraLiterals } : {}),
    });
    const artifacts = this.listArtifacts(runId).sort(
      (a, b) => a.nodeId.localeCompare(b.nodeId) || a.iteration - b.iteration || a.key.localeCompare(b.key),
    );

    // Text surfaces are always scrubbed; the live-literal gate fires only on
    // binary artifacts (the §13 residual — shipped as-is). The scrub pass itself
    // never needs a callback: hits in text mean the secret was REDACTED = safe.
    let liveLiteralHit = false;
    const scrubOpts: ScrubOptions = {
      labels: opts.labelMode ?? "source",
    };

    // Re-CAS map: original blobSha → exported sha (may differ for text blobs).
    // Built before assembling the tar so artifact rows and blob entries are
    // consistent in all three places (artifacts JSONL, blob tar entry, manifest).
    // Routing blobs are seeded FIRST so they share the map with artifact blobs
    // and deduplicate consistently (a routing blob and an artifact blob with the
    // same content produce one tar entry, one manifest row, one mapping entry).
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const reCasMap = new Map<string, { exportSha: string; exportBytes: Uint8Array }>();

    // Seed routing blobs: spilled routing.inputs values are always text.
    // Scrub via scrubText (single string, not nested JSON) and re-CAS.
    // ASSUMPTION: only `intent.run_enqueued` carries routing blob refs.
    // Routing is set once at enqueue and never mutated by any subsequent intent;
    // if a future intent ever mutates routing.inputs this loop must enumerate
    // every such event, not just the genesis.
    const genesisEvent = events.find((e) => e.type === "intent.run_enqueued");
    if (genesisEvent != null) {
      const gp = genesisEvent.payload as Record<string, unknown>;
      const routingForBlobs = gp["routing"] as Record<string, unknown> | undefined;
      if (routingForBlobs != null) {
        for (const origSha of collectRoutingBlobShas(routingForBlobs)) {
          if (reCasMap.has(origSha)) continue;
          const origBytes = this.blobs.get(origSha);
          const text = dec.decode(origBytes);
          const scrubbed = scrubText(text, registry, scrubOpts);
          const exportBytes = scrubbed !== text ? enc.encode(scrubbed) : origBytes;
          const exportSha = scrubbed !== text ? sha256Hex(exportBytes) : origSha;
          reCasMap.set(origSha, { exportSha, exportBytes });
        }
      }
    }

    for (const artifact of artifacts) {
      const origSha = artifact.blobSha;
      if (reCasMap.has(origSha)) continue;
      const origBytes = this.blobs.get(origSha);
      if (isTextMime(artifact.mime)) {
        const text = dec.decode(origBytes);
        let scrubbed: string;
        const mimeBase = (artifact.mime ?? "").split(";")[0]!.trim();
        if (mimeBase === "application/json") {
          try {
            const parsed: unknown = JSON.parse(text);
            const scrubbedObj = scrubJsonStrings(parsed, registry, scrubOpts);
            scrubbed = JSON.stringify(scrubbedObj);
          } catch {
            scrubbed = scrubJsonStrings(text, registry, scrubOpts) as string;
          }
        } else {
          scrubbed = scrubJsonStrings(text, registry, scrubOpts) as string;
        }
        const exportBytes = scrubbed !== text ? enc.encode(scrubbed) : origBytes;
        const exportSha = scrubbed !== text ? sha256Hex(exportBytes) : origSha;
        reCasMap.set(origSha, { exportSha, exportBytes });
      } else {
        // Binary blobs ship as-is — scanned below for verbatim live-literal hits
        // (the §13 residual gate). A hit sets liveLiteralHit; the blob is still
        // exported unchanged (we scan-and-alarm, not redact-in-place).
        reCasMap.set(origSha, { exportSha: origSha, exportBytes: origBytes });
      }
    }

    // Spilled structured-output blobs: a `fact.node_completed` whose `outputs`
    // is a `$fragua_blob` ref points at a CAS blob holding the struct JSON.
    // Collect, scrub as JSON, and re-CAS (same treatment as a text artifact) so
    // the blob ships in the bundle; the event ref is rewritten to the export
    // sha at serialisation below.
    for (const e of events) {
      if (e.type !== "fact.node_completed") continue;
      const out = (e.payload as { outputs?: unknown }).outputs;
      if (!isBlobRef(out)) continue;
      const origSha = out.$fragua_blob;
      if (reCasMap.has(origSha)) continue;
      const origBytes = this.blobs.get(origSha);
      const text = dec.decode(origBytes);
      let scrubbed: string;
      try {
        scrubbed = JSON.stringify(scrubJsonStrings(JSON.parse(text), registry, scrubOpts));
      } catch {
        scrubbed = scrubJsonStrings(text, registry, scrubOpts) as string;
      }
      const exportBytes = scrubbed !== text ? enc.encode(scrubbed) : origBytes;
      const exportSha = scrubbed !== text ? sha256Hex(exportBytes) : origSha;
      reCasMap.set(origSha, { exportSha, exportBytes });
    }

    // Binary-artifact residual gate: scan every binary blob for verbatim
    // live-literal values. Text blobs are always scrubbed, so only binary ones
    // can contain a live secret. A single hit flips liveLiteralHit=true — the
    // blob is still exported unchanged (scan-and-alarm, not redact-in-place).
    if (literalValues.length > 0) {
      for (const artifact of artifacts) {
        if (isTextMime(artifact.mime)) continue;
        const entry = reCasMap.get(artifact.blobSha);
        if (entry == null) continue;
        const buf = Buffer.isBuffer(entry.exportBytes)
          ? entry.exportBytes
          : Buffer.from(entry.exportBytes.buffer, entry.exportBytes.byteOffset, entry.exportBytes.byteLength);
        for (const literal of literalValues) {
          if (buf.includes(literal)) {
            liveLiteralHit = true;
            break;
          }
        }
        if (liveLiteralHit) break;
      }
    }

    // Collect unique export shas (deduped CAS — two artifacts that scrub to the
    // same bytes share one blob entry). Build a sha → entry map in one pass to
    // avoid the O(n²) .find() per sha.
    const exportShaMap = new Map<string, { exportSha: string; exportBytes: Uint8Array }>();
    for (const entry of reCasMap.values()) {
      if (!exportShaMap.has(entry.exportSha)) exportShaMap.set(entry.exportSha, entry);
    }
    const exportShas = [...exportShaMap.keys()].sort();
    const blobEntries: TarEntry[] = [];
    const blobManifest: { sha256: string; size: number }[] = [];
    for (const exportSha of exportShas) {
      const entry = exportShaMap.get(exportSha)!;
      blobEntries.push({ name: blobPath(exportSha), data: entry.exportBytes });
      blobManifest.push({ sha256: exportSha, size: entry.exportBytes.length });
    }

    const manifest: BundleManifest = {
      bundleVersion: BUNDLE_VERSION,
      scrubberVersion: SCRUBBER_VERSION,
      fraguaVersion: opts.fraguaVersion,
      contractVersion: EVENT_CONTRACT_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      irVersion: wf.irVersion,
      runs: [{ runId, workflowSha: run.workflowSha, events: events.length, messages: messages.length }],
      workflows: [{ sha: wf.sha, name: wf.name, irVersion: wf.irVersion }],
      blobs: blobManifest,
    };

    const bytes = writeTar([
      { name: MANIFEST_ENTRY, data: new TextEncoder().encode(canonicalJson(manifest)) },
      {
        name: runEventsPath(runId),
        data: encodeJsonl(
          events.map((e) => {
            // Slim llm.start before scrub so prompt is stripped first, then
            // the retained identity fields still go through the registry.
            const exportPayloadPre = e.type === "llm.start" ? slimLlmStartForExport(e.payload) : e.payload;
            const scrubbedPayload = scrubEventPayload(e.type, exportPayloadPre, registry, scrubOpts);
            // Rewrite $fragua_blob shas in the genesis routing so the exported
            // ref points at the scrubbed blob's new sha. scrubEventPayload leaves
            // ref objects (non-string values) untouched — only the sha needs
            // updating to match what we put in the tar and manifest.
            const exportPayload =
              e.type === "intent.run_enqueued"
                ? rewriteRoutingRefs(scrubbedPayload, reCasMap)
                : e.type === "fact.node_completed"
                  ? (deepRewriteRefs(scrubbedPayload, reCasMap) as typeof scrubbedPayload)
                  : scrubbedPayload;
            return { seq: e.seq, type: e.type, writer: e.writer, payload: exportPayload, ts: e.ts };
          }),
        ),
      },
      {
        name: runMessagesPath(runId),
        data: encodeJsonl(
          messages.map((m) => ({
            ordinal: m.ordinal,
            content: scrubJsonStrings(m.content, registry, scrubOpts),
            nodeId: m.nodeId,
            iteration: m.iteration,
            pass: m.pass,
          })),
        ),
      },
      {
        name: runArtifactsPath(runId),
        data: encodeJsonl(
          artifacts.map((a) => ({
            ...a,
            blobSha: reCasMap.get(a.blobSha)?.exportSha ?? a.blobSha,
          })),
        ),
      },
      ...(opts.runResult !== undefined
        ? [
            {
              name: runResultPath(runId),
              data: enc.encode(JSON.stringify(scrubJsonStrings(opts.runResult, registry, scrubOpts))),
            },
          ]
        : []),
      { name: workflowSourcePath(wf.sha), data: new TextEncoder().encode(wf.source) },
      { name: workflowIrPath(wf.sha), data: new TextEncoder().encode(wf.ir) },
      ...blobEntries,
    ]);
    return { bytes, liveLiteralHit };
  }

  /** Merge a `.fragua` bundle into this store so its runs are inspectable here
   * (`fragua runs status|events|messages`). `run_state` is DERIVED by replaying
   * each run's event log (`deriveRunState`) — the bundle carries no projection.
   * An imported run is inert by construction: its derived `cwd` is `null`, so
   * the daemon can never claim or provision it (no marker needed).
   *
   * Fail-closed on what blocks a safe read: an unknown `bundleVersion` or any
   * blob absent / failing its sha256. The event-contract version is reported
   * (`resumeCompatible`), not gated — a too-new/too-old run still imports for
   * inspection. Idempotent: a run already present is a no-op. */
  importRunBundle(bytes: Uint8Array): {
    runs: { runId: string; imported: boolean }[];
    resumeCompatible: boolean;
  } {
    const entries = readTar(bytes);
    const byName = new Map(entries.map((e) => [e.name, e.data] as const));
    const manifestEntry = byName.get(MANIFEST_ENTRY);
    if (manifestEntry == null) throw new Error("importRunBundle: manifest.json missing from bundle");
    let manifest: BundleManifest;
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestEntry)) as BundleManifest;
    } catch {
      throw new Error("importRunBundle: manifest.json is not valid JSON");
    }
    assertBundleManifest(manifest);
    if (manifest.bundleVersion !== BUNDLE_VERSION) {
      throw new Error(
        `importRunBundle: unsupported bundleVersion ${manifest.bundleVersion} (this build reads ${BUNDLE_VERSION})`,
      );
    }
    const resumeCompatible =
      manifest.contractVersion >= MIN_COMPATIBLE_CONTRACT_VERSION && manifest.contractVersion <= EVENT_CONTRACT_VERSION;

    // Verify every manifest blob is present and hashes to its claimed sha BEFORE
    // any write — a tampered or truncated bundle fails closed.
    const blobs: { sha256: string; size: number; data: Uint8Array }[] = [];
    for (const b of manifest.blobs) {
      const data = byName.get(blobPath(b.sha256));
      if (data == null)
        throw new Error(`importRunBundle: blob ${b.sha256} is in the manifest but absent from the bundle`);
      const actual = sha256Hex(data);
      if (actual !== b.sha256) {
        throw new Error(`importRunBundle: blob ${b.sha256} failed its integrity check (bytes hash to ${actual})`);
      }
      blobs.push({ sha256: b.sha256, size: data.length, data });
    }

    // Workflows: read the source + IR bytes each manifest entry declares. The
    // `name` length is rejected (not clamped) in assertBundleManifest — same
    // reject discipline as the sha gates, no silent mutation at the boundary.
    const workflows = manifest.workflows.map((w) => {
      const source = byName.get(workflowSourcePath(w.sha));
      const ir = byName.get(workflowIrPath(w.sha));
      if (source == null || ir == null) {
        throw new Error(`importRunBundle: workflow ${w.sha} is in the manifest but its source/ir entry is absent`);
      }
      return { ...w, source: new TextDecoder().decode(source), ir: new TextDecoder().decode(ir) };
    });

    // The format is multi-run by construction; a duplicate id would import the
    // first run then fail the second on a PK conflict (opaque SQLite error).
    const seenIds = new Set<string>();
    for (const r of manifest.runs) {
      if (seenIds.has(r.runId)) throw new Error(`importRunBundle: duplicate runId ${r.runId} in manifest`);
      seenIds.add(r.runId);
    }

    // Decode + derive every run OUTSIDE the write txn (I1: no JSON / alloc work
    // inside). Each run's `run_state` is reconstructed from its event log.
    const runsToImport = manifest.runs.map((r) => {
      assertSafeRunId(r.runId);
      const evData = byName.get(runEventsPath(r.runId));
      if (evData == null) throw new Error(`importRunBundle: run ${r.runId} has no events.jsonl`);
      const events = decodeJsonl(evData) as {
        seq: number;
        type: string;
        writer: EventWriter;
        payload: unknown;
        ts: number;
      }[];
      const msgData = byName.get(runMessagesPath(r.runId));
      const messages = (msgData == null ? [] : decodeJsonl(msgData)) as {
        ordinal: number;
        content: unknown;
        nodeId: string | null;
        iteration: number;
        /** Absent in bundles exported before schema v4 — import defaults to 0. */
        pass?: number;
      }[];
      const artData = byName.get(runArtifactsPath(r.runId));
      const artifacts = (artData == null ? [] : decodeJsonl(artData)) as ArtifactListRow[];

      // Untrusted event rows: reject a non-object row (a `null` line decodes to
      // null and would TypeError on `.writer`), gate the provenance `writer` to
      // the known set (the column has no CHECK, by design — but the import trust
      // boundary does), and require a string `type`/numeric `seq` so a malformed
      // row can't reach the events table.
      for (const ev of events) {
        if (ev == null || typeof ev !== "object") {
          throw new Error(`importRunBundle: run ${r.runId} carries a non-object event row`);
        }
        // Primitive-shape gate FIRST — so a non-string writer (e.g. `{}`) is
        // rejected as a malformed row, not mislabeled "invalid writer" by the
        // membership test below (which only ever sees strings after this).
        if (typeof ev.type !== "string" || typeof ev.seq !== "number" || typeof ev.writer !== "string") {
          throw new Error(`importRunBundle: run ${r.runId} carries a malformed event (type/seq/writer)`);
        }
        if (!VALID_WRITERS.has(ev.writer)) {
          throw new Error(
            `importRunBundle: run ${r.runId} event seq ${ev.seq} has invalid writer ${JSON.stringify(ev.writer)}`,
          );
        }
      }
      // Scope note: we shape-gate the row envelope (writer/type/seq) and the
      // GENESIS payload (below), but NOT every other event's `payload` — the
      // reducer is intentionally tolerant, an imported run is inert (never
      // executes here), and event payloads are INSERT OR IGNORE'd verbatim for
      // inspection. Gating every fact/intent payload shape would duplicate the
      // event-contract surface; it's deliberately out of scope.
      //
      // Same gate for transcript rows — `ordinal`/`iteration` numeric, `nodeId`
      // string-or-null — so a tampered messages.jsonl fails clearly here, not as
      // an opaque SQLITE_CONSTRAINT in the txn.
      for (const m of messages) {
        if (m == null || typeof m !== "object") {
          throw new Error(`importRunBundle: run ${r.runId} carries a non-object message row`);
        }
        if (typeof m.ordinal !== "number" || typeof m.iteration !== "number") {
          throw new Error(`importRunBundle: run ${r.runId} message has non-numeric ordinal/iteration`);
        }
        if (m.nodeId !== null && typeof m.nodeId !== "string") {
          throw new Error(`importRunBundle: run ${r.runId} message has a non-string nodeId`);
        }
      }
      // Defense-in-depth: shape-gate the genesis identity fields BEFORE
      // deriveRunState consumes them, same discipline as the manifest shas. A
      // bare `!= null` sweep would admit a wrong-typed value (workflowSha:
      // 12345) or an array (`typeof [] === "object"`) and let it reach
      // insertRunState / FK lookups — type each field at the boundary (asObject
      // rejects arrays) and surface a clear error, not an opaque SQLITE_CONSTRAINT
      // in the txn. (deriveRunState re-finds genesis; this gate runs first so its
      // clearer errors win.)
      const genesis = events.find((e) => e.type === "intent.run_enqueued");
      if (genesis == null)
        throw new Error(`importRunBundle: run ${r.runId} has no genesis (intent.run_enqueued) event`);
      const gp = asObject(genesis.payload, `run ${r.runId} genesis payload`);
      assertSha256(gp["workflowSha"], `run ${r.runId} genesis workflowSha`);
      for (const f of ["projectId", "projectName"] as const) {
        if (typeof gp[f] !== "string") throw new Error(`importRunBundle: run ${r.runId} genesis ${f} is not a string`);
      }
      if (typeof gp["contractVersion"] !== "number") {
        throw new Error(`importRunBundle: run ${r.runId} genesis contractVersion is not a number`);
      }
      asObject(gp["routing"], `run ${r.runId} genesis routing`);

      const derived = deriveRunState(r.runId, events);
      // Rebuild the outputs index from node_completed facts, mirroring the live
      // append path so import and live agree (I1: JSON.stringify stays out of the
      // txn). An already-spilled output rides the payload as a `{$fragua_blob}`
      // ref (its blob ships in the bundle) → index the ref verbatim. An inline
      // struct is indexed as-is, or spilled to a blob here when it would breach
      // the `outputs.struct` CHECK (<4096) — never silently dropped (the prior
      // `length < 4096` guard skipped such a row, leaving the index incomplete).
      const outputsRows: Array<{ nodeId: string; iteration: number; structJson: string }> = [];
      const outputsSpilledBlobs: Array<{ sha: string; bytes: number }> = [];
      for (const ev of events) {
        if (ev.type !== "fact.node_completed") continue;
        const p = ev.payload as { nodeId?: unknown; iteration?: unknown; outputs?: unknown };
        if (p.outputs === undefined || typeof p.nodeId !== "string" || typeof p.iteration !== "number") continue;
        if (isBlobRef(p.outputs)) {
          outputsRows.push({ nodeId: p.nodeId, iteration: p.iteration, structJson: JSON.stringify(p.outputs) });
          continue;
        }
        const structJson = JSON.stringify(p.outputs);
        const ref = maybeSpillStruct(structJson, (sha, bytes) => this.blobs.put(sha, bytes));
        if (ref !== null) {
          outputsRows.push({ nodeId: p.nodeId, iteration: p.iteration, structJson: JSON.stringify(ref) });
          outputsSpilledBlobs.push({ sha: ref.$fragua_blob, bytes: ref.bytes });
        } else {
          outputsRows.push({ nodeId: p.nodeId, iteration: p.iteration, structJson });
        }
      }
      return {
        derived,
        outputsRows,
        outputsSpilledBlobs,
        routingJson: JSON.stringify(derived.routing),
        metricsJson: JSON.stringify(derived.metrics),
        changeStatJson: derived.changeStat != null ? JSON.stringify(derived.changeStat) : null,
        eventRows: events.map((ev) => ({
          seq: ev.seq,
          type: ev.type,
          writer: ev.writer,
          payload: JSON.stringify(ev.payload),
          ts: ev.ts,
        })),
        messageRows: messages.map((m) => {
          const content = JSON.stringify(m.content);
          return {
            ordinal: m.ordinal,
            content,
            nodeId: m.nodeId,
            iteration: m.iteration,
            pass: m.pass,
            contentHash: sha256Hex(content),
          };
        }),
        artifacts,
        already: this.getState(r.runId) != null,
      };
    });

    const now = this.now();
    const result: { runId: string; imported: boolean }[] = [];

    // Blob files before the txn (fs I/O); reap any orphan if the txn throws.
    try {
      for (const b of blobs) this.blobs.put(b.sha256, b.data);

      this.writeTxn(() => {
        for (const w of workflows) insertWorkflowIfAbsent(this.db, w.sha, w.name, w.source, w.ir, w.irVersion, now);
        for (const b of blobs) insertBlobIfAbsent(this.db, b.sha256, b.size, now);

        for (const r of runsToImport) {
          const d = r.derived;
          if (!r.already) {
            insertRunState(this.db, {
              runId: d.runId,
              workflowSha: d.workflowSha,
              contractVersion: d.contractVersion,
              routing: r.routingJson,
              metrics: r.metricsJson,
              priority: d.priority,
              enqueuedAt: d.enqueuedAt,
              readyAt: d.readyAt,
              updatedAt: d.updatedAt,
              cwd: null, // a local binding — absent from the log; keeps the run inert
              projectId: d.projectId,
              projectName: d.projectName,
              workflowName: d.workflowName,
              workflowScope: d.workflowScope,
              workflowPath: d.workflowPath,
              scheduleId: d.scheduleId,
            });
            writeRunStateProjection(this.db, {
              runId: d.runId,
              version: d.version,
              // The row was inserted just above at version 1.
              expectedVersion: 1,
              status: d.status,
              currentNode: d.currentNode,
              routingJson: r.routingJson,
              metricsJson: r.metricsJson,
              lastAppliedSeq: d.lastAppliedSeq,
              priority: d.priority,
              readyAt: d.readyAt,
              nodeStartedAt: d.nodeStartedAt,
              dispatchStartedAt: d.dispatchStartedAt,
              updatedAt: d.updatedAt,
              baseGitSha: d.baseGitSha,
              baseGitRef: d.baseGitRef,
              finalGitSha: d.finalGitSha,
              finalHeadRef: d.finalHeadRef,
              diffBaseSha: d.diffBaseSha,
              changeStatJson: r.changeStatJson,
              inboxStatus: d.inboxStatus,
              acceptedSha: d.acceptedSha,
            });
            setRunStateNextSeq(this.db, d.runId, d.nextSeq);
            // Authoritative inert marker: holds the run out of dispatch /
            // concurrency / sweep regardless of its derived status (a
            // non-terminal source run derives to queued/running but must never
            // execute here). Only on first import; re-import is a no-op.
            markRunImported(this.db, d.runId, now);
          }
          for (const ev of r.eventRows) {
            insertEventOrIgnore(this.db, d.runId, ev.seq, ev.type, ev.writer, ev.payload, ev.ts);
          }
          for (const m of r.messageRows) {
            insertMessageOrIgnore(this.db, {
              runId: d.runId,
              ordinal: m.ordinal,
              content: m.content,
              nodeId: m.nodeId,
              iteration: m.iteration,
              pass: m.pass ?? 0,
              contentHash: m.contentHash,
            });
          }
          // Durability barrier for any output struct spilled during import:
          // the blob was written to the FS in the map above; make it reachable
          // + GC-protected before the index row that references it lands.
          for (const b of r.outputsSpilledBlobs) {
            insertBlobIfAbsent(this.db, b.sha, b.bytes, now);
          }
          // Rebuild the outputs index from node_completed facts.
          for (const o of r.outputsRows) {
            insertOutput(this.db, d.runId, o.nodeId, o.iteration, o.structJson);
          }
          for (const a of r.artifacts) {
            upsertArtifact(this.db, {
              runId: d.runId,
              nodeId: a.nodeId,
              iteration: a.iteration,
              key: a.key,
              blobSha: a.blobSha,
              mime: a.mime,
              now: a.createdAt,
            });
          }
          result.push({ runId: d.runId, imported: !r.already });
        }
      });
    } catch (err) {
      for (const b of blobs) {
        if (!blobRowExists(this.db, b.sha256)) this.blobs.delete(b.sha256);
      }
      // Reap any output struct spilled during the map whose index row didn't
      // land (txn rolled back) — same orphan-blob discipline as the bundle blobs.
      for (const r of runsToImport) {
        for (const b of r.outputsSpilledBlobs) {
          if (!blobRowExists(this.db, b.sha)) this.blobs.delete(b.sha);
        }
      }
      throw err;
    }

    return { runs: result, resumeCompatible };
  }

  gcBlobs(maxRows?: number): { deleted: number } {
    const limit = maxRows ?? 1000;

    // Collect routing-referenced blob shas as GC roots so spilled input blobs
    // are never collected while the run is still live. This is the single place
    // that decides blob reachability; routing roots extend artifact reachability.
    const routingStrings = selectAllRoutings(this.db);
    const routingRootShas = new Set<string>();
    for (const routingJson of routingStrings) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(routingJson);
      } catch {
        continue;
      }
      for (const sha of collectRoutingBlobShas(parsed)) {
        routingRootShas.add(sha);
      }
    }
    // Spilled structured-output blobs are GC roots too: each outputs-index row
    // may itself be a `{$fragua_blob}` ref. Without this they'd be collected as
    // orphans and a later `${{ outputs.X.f }}` read would fail to rehydrate.
    for (const structJson of getAllOutputStructs(this.db)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(structJson);
      } catch {
        continue;
      }
      if (isBlobRef(parsed)) routingRootShas.add(parsed.$fragua_blob);
    }
    const protectedShasJson = JSON.stringify([...routingRootShas]);

    // Pass 1: drop `blobs` rows with no artifact referent AND not a routing
    // root. RETURNING feeds the file-delete pass so row-without-file is
    // impossible mid-sweep.
    const orphanShas = deleteOrphanBlobs(this.db, limit, protectedShasJson);
    for (const sha of orphanShas) this.blobs.delete(sha);

    // Pass 2: remove blob files with no matching row. Catches files left
    // behind when a row was deleted directly (cascade) or when a crash
    // between put() and INSERT orphaned the file. Bounded by the same
    // per-sweep limit to keep tail latency predictable. Routing-root files
    // (even those without a row, e.g., mid-write crash) are preserved.
    let extraDeleted = 0;
    const budget = limit - orphanShas.length;
    if (budget > 0) {
      const shas = this.blobs.listAllShas();
      for (const sha of shas) {
        if (extraDeleted >= budget) break;
        if (routingRootShas.has(sha)) continue;
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

  /**
   * Apply the in-memory projection to `run_state`. Runs under the write lock
   * (it is only ever called from inside a `writeTxn`), so it MUST NOT serialize
   * (invariant I1): the caller pre-serializes `routing`/`metrics`/`changeStat`
   * and runs the MAX_ROUTING_BYTES guard before opening the transaction.
   */
  private writeProjection(
    state: RunState,
    expectedVersion: number,
    serialized: { routingJson: string; metricsJson: string; changeStatJson: string | null },
  ): void {
    const applied = writeRunStateProjection(this.db, {
      runId: state.runId,
      version: state.version,
      expectedVersion,
      status: state.status,
      currentNode: state.currentNode,
      routingJson: serialized.routingJson,
      metricsJson: serialized.metricsJson,
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
      changeStatJson: serialized.changeStatJson,
      inboxStatus: state.inboxStatus,
      acceptedSha: state.acceptedSha,
    });
    if (!applied) {
      const row = selectRunStateRow(this.db, state.runId);
      throw new ConcurrencyError(expectedVersion, row?.version ?? -1);
    }
  }

  private validatePayload(payload: unknown): string {
    const s = JSON.stringify(payload ?? {});
    const bytes = utf8ByteLength(s);
    if (bytes >= MAX_EVENT_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError(bytes, MAX_EVENT_PAYLOAD_BYTES);
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

/** Event types dropped from bundle exports — streaming deltas and scaffolding
 * that are losslessly reconstructable from the `messages` transcript.
 * Everything NOT in this set is retained so read-plane projections work on
 * imported runs. See docs/proposals/secret-scrubbing.md §4 for the rationale.
 *
 * Tier-3 decision: retain llm.error, budget.warn, budget.stop, steering.*,
 * control.*, and legacy run.* lifecycle echoes (small structural payloads
 * useful for forensics, already covered by scrubEventPayload for free-text
 * fields). Drop snapshot.captured (snapshot refs aren’t in the bundle and
 * imported cwd=null means no diff target anyway). */
const EXPORT_DENYLIST = new Set<string>([
  "llm.text_delta",
  "llm.text_end",
  "llm.thinking_delta",
  "llm.thinking_end",
  "llm.toolcall_delta",
  "llm.toolcall_end",
  "agent.start",
  "agent.end",
  "agent.message_start",
  "agent.message_end",
  "agent.message_update",
  "agent.turn_start",
  "agent.turn_end",
  "tool.execution_start",
  "tool.execution_update",
  "tool.execution_end",
  "tool.output_chunk",
  "summary.started",
  "summary.text_delta",
  "snapshot.captured",
]);

/** Slim an `llm.start` payload for bundle export: keep identity and manifest
 * fields that back read-plane projections (getStepAggregates, eventsToSteps),
 * strip the free-text `prompt` which is already in the `messages` transcript
 * and is a secret-leak surface.
 *
 * Mirrors the identity-field set of `truncationMarker` and extends it with
 * the small manifests carried by llm.start. `system_prompt` on llm.start is
 * already a `{ sha256, bytes }` digest (not full text) and passes through. */
function slimLlmStartForExport(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return out;
  const src = payload as Record<string, unknown>;
  if (typeof src["nodeId"] === "string") out["nodeId"] = src["nodeId"];
  if (typeof src["provider"] === "string") out["provider"] = src["provider"];
  if (typeof src["model"] === "string") out["model"] = src["model"];
  if (typeof src["thread_id"] === "string") out["thread_id"] = src["thread_id"];
  if (typeof src["summary"] === "string") out["summary"] = src["summary"];
  if (typeof src["iteration"] === "number") {
    out["iteration"] = src["iteration"];
  } else if (src["iteration"] != null && typeof src["iteration"] === "object") {
    const it = src["iteration"] as Record<string, unknown>;
    if (typeof it["n"] === "number" && typeof it["max"] === "number") {
      out["iteration"] = { n: it["n"], max: it["max"] };
    }
  }
  if (src["context_files"] !== undefined) out["context_files"] = src["context_files"];
  if (src["skills"] !== undefined) out["skills"] = src["skills"];
  if (src["budget"] !== undefined) out["budget"] = src["budget"];
  if (src["system_prompt"] !== undefined) out["system_prompt"] = src["system_prompt"];
  return out;
}
