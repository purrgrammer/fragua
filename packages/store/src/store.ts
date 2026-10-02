import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AnalyticsWindow,
  BucketedWindow,
  CacheByBucketRow,
  DrilldownFilters,
  DrilldownPage,
  HaltDistributionRow,
  KpiTotalsRow,
  ModelDistributionRow,
  RunsByBucketRow,
  SpendByBucketRow,
  TokensByBucketRow,
  TopWorkflowRow,
  WorkflowDirectoryRow,
} from "./analytics-queries.ts";
import { BlobFS } from "./blob-fs.ts";
import type { OrphanSideEffectRow, PendingIntentRow } from "./event-queries.ts";
import type { JudgeAnswerRow } from "./message-queries.ts";
import { Metrics, type MetricsSnapshot } from "./metrics.ts";
import { migrate, verifySchema } from "./migrations.ts";
import { applyCreationPragmas, applyPragmas } from "./pragmas.ts";
import type {
  CwdSummaryRow,
  FleetSummary,
  FleetSummaryOpts,
  GcSnapshotRunRow,
  GlobalMetricsTotalsRow,
  GlobalModelBreakdownRow,
  ListRunIdsOpts,
  ListRunSummaryRowsOpts,
  ProjectSummaryRow,
  RunCostTotalsRow,
  RunSummaryRow,
  StepAggregateRow,
  WakeCandidateRow,
} from "./run-state-queries.ts";
import * as analytics from "./store-analytics.ts";
import * as bundleExport from "./store-bundle-export.ts";
import * as bundleImport from "./store-bundle-import.ts";
import * as config from "./store-config.ts";
import * as coordinator from "./store-coordinator.ts";
import * as credentials from "./store-credentials.ts";
import type { StoreCtx } from "./store-ctx.ts";
import * as mcpOAuth from "./store-mcp-oauth.ts";
import * as metricsReader from "./store-metrics.ts";
import * as outputs from "./store-outputs.ts";
import * as reader from "./store-reader.ts";
import * as schedules from "./store-schedules.ts";
import * as writer from "./store-writer.ts";
import {
  type AppendFactOpts,
  type ArtifactListRow,
  type ArtifactRef,
  type ArtifactScope,
  type CreateScheduleParams,
  type DaemonEvent,
  type DaemonEventRow,
  type DaemonLockResult,
  type DaemonLockRow,
  type EnqueueRunParams,
  type EventCountOpts,
  type ExportBundleOptions,
  type ExportBundleResult,
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
  type ImportBundleResult,
  type IntentAppendResult,
  type IntentEvent,
  type IntentType,
  MAX_EVENT_PAYLOAD_BYTES,
  type Message,
  type NarrowMessage,
  type ObservabilityEvent,
  PayloadTooLargeError,
  type ProviderConfigRow,
  type ProviderCredentialRow,
  type RunState,
  type Schedule,
  type ServerEndpointRow,
  type StoredEvent,
  type SweepResult,
  utf8ByteLength,
  type WorkflowRow,
} from "./types.ts";

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

/**
 * The SQLite-backed `IEventStore`. This class is a thin façade: it owns the
 * database handle, the blob CAS, the write-lock transaction, and the payload
 * guard, and delegates each sub-interface's method bodies to a sibling module
 * (`store-writer.ts`, `store-reader.ts`, …) through the shared {@link StoreCtx}.
 * See `docs/ARCHITECTURE.md` §4.
 */
export class SqliteStore implements IEventStore {
  private readonly db: Database;
  private readonly blobs: BlobFS;
  private readonly blobsDirOwned: boolean;
  private readonly blobsDir: string;
  private readonly now: () => number;
  private readonly metrics = new Metrics();
  private readonly ctx: StoreCtx;

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

    this.ctx = {
      db: this.db,
      blobs: this.blobs,
      now: this.now,
      metrics: this.metrics,
      writeTxn: (fn) => this.writeTxn(fn),
      validatePayload: (payload) => this.validatePayload(payload),
      store: this,
    };
  }

  // ─────────────── Writes ───────────────

  appendFact(runId: string, events: FactEvent[], expectedVersion: number, opts: AppendFactOpts = {}): FactAppendResult {
    return writer.appendFact(this.ctx, runId, events, expectedVersion, opts);
  }

  appendIntent(runId: string, event: IntentEvent): IntentAppendResult {
    return writer.appendIntent(this.ctx, runId, event);
  }

  appendObservabilityEvents(runId: string, events: ObservabilityEvent[]): { seqs: number[] } {
    return writer.appendObservabilityEvents(this.ctx, runId, events);
  }

  enqueueRun(params: EnqueueRunParams): void {
    writer.enqueueRun(this.ctx, params);
  }

  claimNextRun(maxInFlight: number): { runId: string } | null {
    return writer.claimNextRun(this.ctx, maxInFlight);
  }

  startupSweep(opts?: { priorHeartbeatAt?: number }): SweepResult {
    return writer.startupSweep(this.ctx, opts);
  }

  setRunTitle(runId: string, title: string): void {
    writer.setRunTitle(this.ctx, runId, title);
  }

  appendMessage(
    runId: string,
    row: Omit<Message, "runId" | "ordinal" | "pass"> & { pass?: number },
    opts?: { dedup?: boolean },
  ): { ordinal: number } {
    return writer.appendMessage(this.ctx, runId, row, opts);
  }

  putArtifact(scope: ArtifactScope, content: Uint8Array, mime?: string, opts?: { replace?: boolean }): ArtifactRef {
    return writer.putArtifact(this.ctx, scope, content, mime, opts);
  }

  saveWorkflow(sha: string, name: string, source: string, ir: string, irVersion: number): void {
    writer.saveWorkflow(this.ctx, sha, name, source, ir, irVersion);
  }

  vacuum(): void {
    writer.vacuum(this.ctx);
  }

  gcBlobs(maxRows?: number): { deleted: number } {
    return writer.gcBlobs(this.ctx, maxRows);
  }

  close(): void {
    this.db.close();
    if (this.blobsDirOwned) this.blobs.destroy();
  }

  // ─────────────── State + event reads ───────────────

  getState(runId: string): RunState | null {
    return reader.getState(this.ctx, runId);
  }

  listRunIds(opts: ListRunIdsOpts = {}): string[] {
    return reader.listRunIds(this.ctx, opts);
  }

  listRunSummaryRows(opts: ListRunSummaryRowsOpts = {}): RunSummaryRow[] {
    return reader.listRunSummaryRows(this.ctx, opts);
  }

  fleetSummary(opts: FleetSummaryOpts = {}): FleetSummary {
    return reader.fleetSummary(this.ctx, opts);
  }

  runStateCounts(): { running: number; queued: number } {
    return reader.runStateCounts(this.ctx);
  }

  getEvents(runId: string, opts: GetEventsOpts = {}): StoredEvent[] {
    return reader.getEvents(this.ctx, runId, opts);
  }

  getEventsByType(runId: string, type: string): StoredEvent[] {
    return reader.getEventsByType(this.ctx, runId, type);
  }

  getSnapshotEvents(runId: string): StoredEvent[] {
    return reader.getSnapshotEvents(this.ctx, runId);
  }

  getLatestEvents(runId: string, limit: number): StoredEvent[] {
    return reader.getLatestEvents(this.ctx, runId, limit);
  }

  getLatestHumanPause(runId: string): StoredEvent | null {
    return reader.getLatestHumanPause(this.ctx, runId);
  }

  getEventsTail(runId: string, opts: GetEventsTailOpts = {}): StoredEvent[] {
    return reader.getEventsTail(this.ctx, runId, opts);
  }

  getEventCount(runId: string, opts: EventCountOpts = {}): number {
    return reader.getEventCount(this.ctx, runId, opts);
  }

  getLatestLifecycleByNode(runId: string): Array<{ nodeId: string; type: string }> {
    return reader.getLatestLifecycleByNode(this.ctx, runId);
  }

  getGlobalEventsForward(opts: GetGlobalEventsForwardOpts): StoredEvent[] {
    return reader.getGlobalEventsForward(this.ctx, opts);
  }

  getGlobalEventsAtFloor(opts: GetGlobalEventsAtFloorOpts): StoredEvent[] {
    return reader.getGlobalEventsAtFloor(this.ctx, opts);
  }

  getGlobalEventsLatest(opts: GetGlobalEventsLatestOpts): StoredEvent[] {
    return reader.getGlobalEventsLatest(this.ctx, opts);
  }

  getUnappliedIntents(runId: string): StoredEvent[] {
    return reader.getUnappliedIntents(this.ctx, runId);
  }

  getWakeCandidates(opts: { statuses: readonly RunState["status"][]; autoResumeBefore?: number }): WakeCandidateRow[] {
    return reader.getWakeCandidates(this.ctx, opts);
  }

  getInboxActionCandidates(): WakeCandidateRow[] {
    return reader.getInboxActionCandidates(this.ctx);
  }

  getGcEligibleSnapshotRuns(opts: { cwd: string; cutoff: number }): GcSnapshotRunRow[] {
    return reader.getGcEligibleSnapshotRuns(this.ctx, opts);
  }

  getNextPendingIntent(runId: string, type: IntentType, sinceSeq: number): PendingIntentRow | null {
    return reader.getNextPendingIntent(this.ctx, runId, type, sinceSeq);
  }

  findOrphanSideEffects(runId: string): OrphanSideEffectRow[] {
    return reader.findOrphanSideEffects(this.ctx, runId);
  }

  // ─────────────── Messages ───────────────

  getMessages(runId: string, opts: GetMessagesOpts = {}): Message[] {
    return reader.getMessages(this.ctx, runId, opts);
  }

  getMessagesNarrow(runId: string, opts: GetMessagesOpts = {}): NarrowMessage[] {
    return reader.getMessagesNarrow(this.ctx, runId, opts);
  }

  listThreadsWithMessages(): Array<{ runId: string; threadId: string }> {
    return reader.listThreadsWithMessages(this.ctx);
  }

  // ─────────────── Aggregates + outputs ───────────────

  getStepAggregates(runId: string): StepAggregateRow[] {
    return reader.getStepAggregates(this.ctx, runId);
  }

  getRunCostTotals(runId: string): RunCostTotalsRow {
    return reader.getRunCostTotals(this.ctx, runId);
  }

  getOutputsForRun(runId: string): Array<{ nodeId: string; iteration: number; struct: string }> {
    return outputs.getOutputsForRun(this.ctx, runId);
  }

  getLatestOutput(runId: string, nodeId: string): string | null {
    return outputs.getLatestOutput(this.ctx, runId, nodeId);
  }

  getLatestOutputBatch(runId: string, nodeIds: readonly string[]): Map<string, string> {
    return outputs.getLatestOutputBatch(this.ctx, runId, nodeIds);
  }

  // ─────────────── Blobs + artifacts ───────────────

  readBlob(sha: string): Uint8Array | null {
    return reader.readBlob(this.ctx, sha);
  }

  getArtifact(scope: ArtifactScope): Uint8Array {
    return reader.getArtifact(this.ctx, scope);
  }

  getArtifactRef(scope: ArtifactScope): ArtifactRef | null {
    return reader.getArtifactRef(this.ctx, scope);
  }

  listArtifacts(runId: string): ArtifactListRow[] {
    return reader.listArtifacts(this.ctx, runId);
  }

  findDoneForIntent(runId: string, idempotencyKey: string): ArtifactRef | null {
    return reader.findDoneForIntent(this.ctx, runId, idempotencyKey);
  }

  // ─────────────── Workflow catalog + projects ───────────────

  getWorkflow(sha: string): WorkflowRow | null {
    return reader.getWorkflow(this.ctx, sha);
  }

  listCwds(): CwdSummaryRow[] {
    return reader.listCwds(this.ctx);
  }

  listProjects(): ProjectSummaryRow[] {
    return reader.listProjects(this.ctx);
  }

  // ─────────────── Analytics ───────────────

  getKpiTotals(window: AnalyticsWindow): KpiTotalsRow {
    return analytics.getKpiTotals(this.ctx, window);
  }

  getRunsByBucket(window: BucketedWindow): RunsByBucketRow[] {
    return analytics.getRunsByBucket(this.ctx, window);
  }

  getSpendByBucket(window: BucketedWindow): SpendByBucketRow[] {
    return analytics.getSpendByBucket(this.ctx, window);
  }

  getTokensByBucket(window: BucketedWindow): TokensByBucketRow[] {
    return analytics.getTokensByBucket(this.ctx, window);
  }

  getCacheByBucket(window: BucketedWindow): CacheByBucketRow[] {
    return analytics.getCacheByBucket(this.ctx, window);
  }

  getHaltDistribution(window: AnalyticsWindow): HaltDistributionRow[] {
    return analytics.getHaltDistribution(this.ctx, window);
  }

  getModelDistribution(window: AnalyticsWindow): ModelDistributionRow[] {
    return analytics.getModelDistribution(this.ctx, window);
  }

  getTopWorkflows(window: AnalyticsWindow, limit: number): TopWorkflowRow[] {
    return analytics.getTopWorkflows(this.ctx, window, limit);
  }

  getFirstRunAt(window: AnalyticsWindow): number | null {
    return analytics.getFirstRunAt(this.ctx, window);
  }

  getWorkflowDirectory(opts: { cwd?: string }): WorkflowDirectoryRow[] {
    return analytics.getWorkflowDirectory(this.ctx, opts);
  }

  getDrilldownPage(filters: DrilldownFilters, opts: { limit: number; cursor?: string | undefined }): DrilldownPage {
    return analytics.getDrilldownPage(this.ctx, filters, opts);
  }

  getGlobalMetricsTotals(opts: { sinceMs: number }): GlobalMetricsTotalsRow {
    return analytics.getGlobalMetricsTotals(this.ctx, opts);
  }

  getGlobalModelBreakdown(opts: { sinceMs: number }): GlobalModelBreakdownRow[] {
    return analytics.getGlobalModelBreakdown(this.ctx, opts);
  }

  // ─────────────── Daemon events + lock + endpoint ───────────────

  appendDaemonEvent(event: DaemonEvent, opts?: { runId?: string }): { seq: number; ts: number } {
    return coordinator.appendDaemonEvent(this.ctx, event, opts);
  }

  getDaemonEvents(opts: GetDaemonEventsOpts = {}): DaemonEventRow[] {
    return coordinator.getDaemonEvents(this.ctx, opts);
  }

  latestDaemonLifecycleEvent(): DaemonEventRow | null {
    return coordinator.latestDaemonLifecycleEvent(this.ctx);
  }

  acquireDaemonLock(pid: number, hostname: string): DaemonLockResult {
    return coordinator.acquireDaemonLock(this.ctx, pid, hostname);
  }

  forceAcquireDaemonLock(pid: number, hostname: string): DaemonLockResult {
    return coordinator.forceAcquireDaemonLock(this.ctx, pid, hostname);
  }

  heartbeatDaemonLock(pid: number): void {
    coordinator.heartbeatDaemonLock(this.ctx, pid);
  }

  releaseDaemonLock(pid: number): void {
    coordinator.releaseDaemonLock(this.ctx, pid);
  }

  forceDeleteDaemonLock(): void {
    coordinator.forceDeleteDaemonLock(this.ctx);
  }

  evictDaemonLockIfStale(opts: {
    ttlMs: number;
    now?: () => number;
    isHolderAlive?: (lock: DaemonLockRow) => boolean;
  }): { evicted: boolean; swept?: SweepResult; stalePid?: number; priorHeartbeatAt?: number } {
    return coordinator.evictDaemonLockIfStale(this.ctx, opts);
  }

  currentDaemonLock(): DaemonLockRow | null {
    return coordinator.currentDaemonLock(this.ctx);
  }

  currentServerEndpoint(): ServerEndpointRow | null {
    return coordinator.currentServerEndpoint(this.ctx);
  }

  setServerEndpoint(args: { url: string; port: number; pid: number; version: string | null }): void {
    coordinator.setServerEndpoint(this.ctx, args);
  }

  clearServerEndpoint(pid: number): void {
    coordinator.clearServerEndpoint(this.ctx, pid);
  }

  // ─────────────── Schedules ───────────────

  createSchedule(params: CreateScheduleParams, now: number): Schedule {
    return schedules.createSchedule(this.ctx, params, now);
  }

  createScheduleAudited(params: CreateScheduleParams, event: DaemonEvent, now: number): Schedule {
    return schedules.createScheduleAudited(this.ctx, params, event, now);
  }

  getSchedule(id: string): Schedule | null {
    return schedules.getSchedule(this.ctx, id);
  }

  listSchedules(opts?: { cwd?: string }): Schedule[] {
    return schedules.listSchedules(this.ctx, opts);
  }

  getDueSchedules(now: number): Schedule[] {
    return schedules.getDueSchedules(this.ctx, now);
  }

  pauseSchedule(id: string, now: number): void {
    schedules.pauseSchedule(this.ctx, id, now);
  }

  pauseScheduleAudited(id: string, event: DaemonEvent, now: number): void {
    schedules.pauseScheduleAudited(this.ctx, id, event, now);
  }

  resumeSchedule(id: string, now: number): void {
    schedules.resumeSchedule(this.ctx, id, now);
  }

  resumeScheduleAudited(id: string, event: DaemonEvent, now: number): void {
    schedules.resumeScheduleAudited(this.ctx, id, event, now);
  }

  deleteSchedule(id: string): void {
    schedules.deleteSchedule(this.ctx, id);
  }

  deleteScheduleAudited(id: string, event: DaemonEvent, now: number): void {
    schedules.deleteScheduleAudited(this.ctx, id, event, now);
  }

  recordScheduleFire(scheduleId: string, runId: string, now: number): void {
    schedules.recordScheduleFire(this.ctx, scheduleId, runId, now);
  }

  recordScheduleSkipped(scheduleId: string, now: number): void {
    schedules.recordScheduleSkipped(this.ctx, scheduleId, now);
  }

  getScheduleRuns(scheduleId: string, limit: number): Array<{ runId: string; status: string; enqueuedAt: number }> {
    return schedules.getScheduleRuns(this.ctx, scheduleId, limit);
  }

  // ─────────────── Provider credentials ───────────────

  getProviderCredential(provider: string): ProviderCredentialRow | null {
    return credentials.getProviderCredential(this.ctx, provider);
  }

  listProviderCredentials(): ProviderCredentialRow[] {
    return credentials.listProviderCredentials(this.ctx);
  }

  upsertProviderCredential(args: { provider: string; kind: "api_key" | "oauth"; payload: string }): void {
    credentials.upsertProviderCredential(this.ctx, args);
  }

  deleteProviderCredential(provider: string): void {
    credentials.deleteProviderCredential(this.ctx, provider);
  }

  // ─────────────── Provider config ───────────────

  getProviderConfig(provider: string): ProviderConfigRow | null {
    return config.getProviderConfig(this.ctx, provider);
  }

  listProviderConfigs(): ProviderConfigRow[] {
    return config.listProviderConfigs(this.ctx);
  }

  upsertProviderConfig(args: { provider: string; config: string }): void {
    config.upsertProviderConfig(this.ctx, args);
  }

  deleteProviderConfig(provider: string): void {
    config.deleteProviderConfig(this.ctx, provider);
  }

  getProviderConfigRevision(): { maxUpdatedAt: number; rowCount: number } {
    return config.getProviderConfigRevision(this.ctx);
  }

  // ─────────────── MCP OAuth ───────────────

  getMcpOAuth(url: string): string | undefined {
    return mcpOAuth.getMcpOAuth(this.ctx, url);
  }

  listMcpOAuth(): { url: string; payload: string }[] {
    return mcpOAuth.listMcpOAuth(this.ctx);
  }

  upsertMcpOAuth(url: string, payload: string): void {
    mcpOAuth.upsertMcpOAuth(this.ctx, url, payload);
  }

  deleteMcpOAuth(url: string): void {
    mcpOAuth.deleteMcpOAuth(this.ctx, url);
  }

  // ─────────────── Bundles ───────────────

  exportRunBundle(runId: string, opts: ExportBundleOptions): ExportBundleResult {
    return bundleExport.exportRunBundle(this.ctx, runId, opts);
  }

  importRunBundle(bytes: Uint8Array): ImportBundleResult {
    return bundleImport.importRunBundle(this.ctx, bytes);
  }

  retainPortableTables(): void {
    bundleExport.retainPortableTables(this.ctx);
  }

  // ─────────────── Metrics + judge ───────────────

  metricsSnapshot(): MetricsSnapshot {
    return metricsReader.metricsSnapshot(this.ctx);
  }

  getJudgeMessages(workflowName?: string): JudgeAnswerRow[] {
    return metricsReader.getJudgeMessages(this.ctx, workflowName);
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

  /** Thin wrapper over {@link writer.writeProjection} kept on the façade so the
   * structural-guard regression test can reach the projection write path
   * directly. Production callers go through `appendFact` in `store-writer.ts`. */
  private writeProjection(
    state: RunState,
    expectedVersion: number,
    serialized: { routingJson: string; metricsJson: string; changeStatJson: string | null },
  ): void {
    writer.writeProjection(this.ctx, state, expectedVersion, serialized);
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
