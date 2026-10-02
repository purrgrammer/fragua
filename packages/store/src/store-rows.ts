import type { ChangeStat, InboxStatus } from "@fragua/types";
import type { ProviderConfigDbRow } from "./provider-config-queries.ts";
import type { ProviderCredentialDbRow } from "./provider-credentials-queries.ts";
import type { RunStateRow } from "./run-state-queries.ts";
import type { ScheduleRow } from "./schedule-queries.ts";
import type {
  EventWriter,
  Message,
  ProviderConfigRow,
  ProviderCredentialRow,
  RunMetrics,
  RunState,
  Schedule,
  StoredEvent,
} from "./types.ts";

/** EventRow → StoredEvent. Shared across getEvents / getGlobalEvents*
 * so the projection (column rename, payload parse, writer cast) lives
 * in one place. */
export function rowToStoredEvent(r: {
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

export function rowToMessage(r: {
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

export function rowToRunState(row: RunStateRow): RunState {
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

export function rowToProviderCredential(row: ProviderCredentialDbRow): ProviderCredentialRow {
  return {
    provider: row.provider,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToProviderConfig(row: ProviderConfigDbRow): ProviderConfigRow {
  return {
    provider: row.provider,
    config: JSON.parse(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToSchedule(row: ScheduleRow): Schedule {
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
