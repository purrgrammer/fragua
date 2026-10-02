import { NODE_LIFECYCLE_FACT_TYPES } from "@fragua/types";
import { selectArtifactRef as querySelectArtifactRef, selectArtifactsForRun } from "./artifact-queries.ts";
import {
  type OrphanSideEffectRow,
  type PendingIntentRow,
  selectEventCount,
  selectEvents,
  selectEventsByType,
  selectEventsTail,
  selectFactSideEffectDone,
  selectFactSideEffectIntent,
  selectGlobalEventsAtFloor,
  selectGlobalEventsForward,
  selectGlobalEventsLatest,
  selectLatestEvents,
  selectLatestHumanPause,
  selectLatestLifecycleByNode,
  selectNextPendingIntent,
  selectOrphanSideEffects,
  selectSnapshotEvents,
  selectUnappliedIntents,
} from "./event-queries.ts";
import { selectActiveThreads, selectMessages, selectMessagesNarrow } from "./message-queries.ts";
import {
  type CwdSummaryRow,
  countQueuedRuns,
  countRunningRuns,
  type FleetSummary,
  type FleetSummaryOpts,
  type GcSnapshotRunRow,
  type ListRunIdsOpts,
  type ListRunSummaryRowsOpts,
  type ProjectSummaryRow,
  getRunCostTotals as queryRunCostTotals,
  getStepAggregates as queryStepAggregates,
  type RunCostTotalsRow,
  type RunSummaryRow,
  type StepAggregateRow,
  selectCwds,
  selectFleetSummary,
  selectGcEligibleSnapshotRuns,
  selectInboxActionCandidates,
  selectProjects,
  selectRunIds,
  selectRunStateRow,
  selectRunSummaryRows,
  selectWakeCandidates,
  type WakeCandidateRow,
} from "./run-state-queries.ts";
import type { StoreCtx } from "./store-ctx.ts";
import { rowToMessage, rowToRunState, rowToStoredEvent } from "./store-rows.ts";
import type {
  ArtifactListRow,
  ArtifactRef,
  ArtifactScope,
  EventCountOpts,
  GetEventsOpts,
  GetEventsTailOpts,
  GetGlobalEventsAtFloorOpts,
  GetGlobalEventsForwardOpts,
  GetGlobalEventsLatestOpts,
  GetMessagesOpts,
  IntentType,
  Message,
  NarrowMessage,
  RunState,
  StoredEvent,
  WorkflowRow,
} from "./types.ts";
import { selectWorkflow } from "./workflow-queries.ts";

export function getState(ctx: StoreCtx, runId: string): RunState | null {
  const row = selectRunStateRow(ctx.db, runId);
  return row == null ? null : rowToRunState(row);
}

export function listRunIds(ctx: StoreCtx, opts: ListRunIdsOpts = {}): string[] {
  return selectRunIds(ctx.db, opts);
}

export function listRunSummaryRows(ctx: StoreCtx, opts: ListRunSummaryRowsOpts = {}): RunSummaryRow[] {
  return selectRunSummaryRows(ctx.db, opts);
}

export function fleetSummary(ctx: StoreCtx, opts: FleetSummaryOpts = {}): FleetSummary {
  return selectFleetSummary(ctx.db, opts);
}

export function runStateCounts(ctx: StoreCtx): { running: number; queued: number } {
  return { running: countRunningRuns(ctx.db), queued: countQueuedRuns(ctx.db) };
}

export function getEvents(ctx: StoreCtx, runId: string, opts: GetEventsOpts = {}): StoredEvent[] {
  // No default limit — when the caller doesn't specify one, return the
  // full event log. `selectEvents` translates `limit: undefined` into
  // SQLite's unbounded `LIMIT -1`. Callers that need a cap (the SSE
  // batch loop, the runs-list summariser) pass `limit` explicitly.
  const queryOpts: Parameters<typeof selectEvents>[2] = {
    sinceSeq: opts.sinceSeq ?? 0,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  };
  return selectEvents(ctx.db, runId, queryOpts).map(rowToStoredEvent);
}

export function getEventsByType(ctx: StoreCtx, runId: string, type: string): StoredEvent[] {
  return selectEventsByType(ctx.db, runId, type).map(rowToStoredEvent);
}

export function getSnapshotEvents(ctx: StoreCtx, runId: string): StoredEvent[] {
  return selectSnapshotEvents(ctx.db, runId).map(rowToStoredEvent);
}

export function getLatestEvents(ctx: StoreCtx, runId: string, limit: number): StoredEvent[] {
  return selectLatestEvents(ctx.db, runId, limit).map(rowToStoredEvent);
}

export function getLatestHumanPause(ctx: StoreCtx, runId: string): StoredEvent | null {
  const row = selectLatestHumanPause(ctx.db, runId);
  return row == null ? null : rowToStoredEvent(row);
}

export function getEventsTail(ctx: StoreCtx, runId: string, opts: GetEventsTailOpts = {}): StoredEvent[] {
  return selectEventsTail(ctx.db, runId, opts).map(rowToStoredEvent);
}

export function getEventCount(ctx: StoreCtx, runId: string, opts: EventCountOpts = {}): number {
  return selectEventCount(ctx.db, runId, opts);
}

export function getLatestLifecycleByNode(ctx: StoreCtx, runId: string): Array<{ nodeId: string; type: string }> {
  return selectLatestLifecycleByNode(ctx.db, runId, NODE_LIFECYCLE_FACT_TYPES);
}

export function getGlobalEventsForward(ctx: StoreCtx, opts: GetGlobalEventsForwardOpts): StoredEvent[] {
  return selectGlobalEventsForward(ctx.db, opts).map(rowToStoredEvent);
}

export function getGlobalEventsAtFloor(ctx: StoreCtx, opts: GetGlobalEventsAtFloorOpts): StoredEvent[] {
  return selectGlobalEventsAtFloor(ctx.db, opts).map(rowToStoredEvent);
}

export function getGlobalEventsLatest(ctx: StoreCtx, opts: GetGlobalEventsLatestOpts): StoredEvent[] {
  return selectGlobalEventsLatest(ctx.db, opts).map(rowToStoredEvent);
}

export function getUnappliedIntents(ctx: StoreCtx, runId: string): StoredEvent[] {
  const state = selectRunStateRow(ctx.db, runId);
  if (state == null) return [];
  return selectUnappliedIntents(ctx.db, runId, state.last_applied_seq).map(rowToStoredEvent);
}

export function getWakeCandidates(
  ctx: StoreCtx,
  opts: { statuses: readonly RunState["status"][]; autoResumeBefore?: number },
): WakeCandidateRow[] {
  return selectWakeCandidates(ctx.db, opts);
}

export function getInboxActionCandidates(ctx: StoreCtx): WakeCandidateRow[] {
  return selectInboxActionCandidates(ctx.db);
}

export function getGcEligibleSnapshotRuns(ctx: StoreCtx, opts: { cwd: string; cutoff: number }): GcSnapshotRunRow[] {
  return selectGcEligibleSnapshotRuns(ctx.db, opts);
}

export function getNextPendingIntent(
  ctx: StoreCtx,
  runId: string,
  type: IntentType,
  sinceSeq: number,
): PendingIntentRow | null {
  return selectNextPendingIntent(ctx.db, runId, type, sinceSeq);
}

export function findOrphanSideEffects(ctx: StoreCtx, runId: string): OrphanSideEffectRow[] {
  return selectOrphanSideEffects(ctx.db, runId);
}

export function listThreadsWithMessages(ctx: StoreCtx): Array<{ runId: string; threadId: string }> {
  return selectActiveThreads(ctx.db);
}

export function getMessages(ctx: StoreCtx, runId: string, opts: GetMessagesOpts = {}): Message[] {
  // No default limit — the transcript view shows the full list, and
  // `selectMessages` translates `limit: undefined` into SQLite's
  // unbounded `LIMIT -1`. Callers that need a cap pass `limit`.
  const queryOpts: Parameters<typeof selectMessages>[2] = {
    sinceOrdinal: opts.sinceOrdinal ?? 0,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.nodeId != null ? { nodeId: opts.nodeId } : {}),
  };
  return selectMessages(ctx.db, runId, queryOpts).map(rowToMessage);
}

export function getMessagesNarrow(ctx: StoreCtx, runId: string, opts: GetMessagesOpts = {}): NarrowMessage[] {
  const queryOpts: Parameters<typeof selectMessagesNarrow>[2] = {
    sinceOrdinal: opts.sinceOrdinal ?? 0,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.nodeId != null ? { nodeId: opts.nodeId } : {}),
  };
  return selectMessagesNarrow(ctx.db, runId, queryOpts).map((r) => ({
    ordinal: r.ordinal,
    content: JSON.parse(r.content),
    nodeId: r.node_id,
    iteration: r.iteration,
    pass: r.pass,
  }));
}

export function getStepAggregates(ctx: StoreCtx, runId: string): StepAggregateRow[] {
  return queryStepAggregates(ctx.db, runId);
}

export function getRunCostTotals(ctx: StoreCtx, runId: string): RunCostTotalsRow {
  return queryRunCostTotals(ctx.db, runId);
}

export function readBlob(ctx: StoreCtx, sha: string): Uint8Array | null {
  if (!ctx.blobs.has(sha)) return null;
  return ctx.blobs.get(sha);
}

export function getArtifact(ctx: StoreCtx, scope: ArtifactScope): Uint8Array {
  const ref = getArtifactRef(ctx, scope);
  if (ref == null) {
    throw new Error(`artifact not found: ${scope.runId}/${scope.nodeId}#${scope.iteration}:${scope.key}`);
  }
  if (!ctx.blobs.has(ref.sha256)) {
    throw new Error(`blob file missing for sha ${ref.sha256}`);
  }
  return ctx.blobs.get(ref.sha256);
}

export function getArtifactRef(ctx: StoreCtx, scope: ArtifactScope): ArtifactRef | null {
  const row = querySelectArtifactRef(ctx.db, scope);
  if (row == null) return null;
  return {
    ...scope,
    sha256: row.blob_sha,
    sizeBytes: row.size_bytes,
    mime: row.mime,
  };
}

export function listArtifacts(ctx: StoreCtx, runId: string): ArtifactListRow[] {
  return selectArtifactsForRun(ctx.db, runId);
}

export function findDoneForIntent(ctx: StoreCtx, runId: string, idempotencyKey: string): ArtifactRef | null {
  const done = selectFactSideEffectDone(ctx.db, runId, idempotencyKey);
  if (done == null) return null;
  const parsed = JSON.parse(done.payload) as {
    idempotencyKey: string;
    artifactKey: string;
  };

  const intent = selectFactSideEffectIntent(ctx.db, runId, idempotencyKey);
  if (intent == null) return null;
  const intentPayload = JSON.parse(intent.payload) as {
    nodeId: string;
    iteration: number;
  };
  return getArtifactRef(ctx, {
    runId,
    nodeId: intentPayload.nodeId,
    iteration: intentPayload.iteration,
    key: parsed.artifactKey,
  });
}

export function getWorkflow(ctx: StoreCtx, sha: string): WorkflowRow | null {
  const row = selectWorkflow(ctx.db, sha);
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

export function listCwds(ctx: StoreCtx): CwdSummaryRow[] {
  return selectCwds(ctx.db);
}

export function listProjects(ctx: StoreCtx): ProjectSummaryRow[] {
  return selectProjects(ctx.db);
}
