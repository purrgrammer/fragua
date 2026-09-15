// Shared test fixtures for RunSummary rows.
//
// `STATUS_TO_RUN_STATUS` is the coarse `status → runStatus` collapse the
// server projection performs; it lived duplicated across the suite until
// this shared source. `summaryRow` builds a minimal RunSummary and defaults
// runStatus through the map, so a new required field is added in one place.

import type { RunSummary } from "../../src/lib/api.ts";

export const STATUS_TO_RUN_STATUS: Record<RunSummary["status"], RunSummary["runStatus"]> = {
  queued: "queued",
  running: "running",
  paused: "paused",
  success: "completed",
  fail: "halted",
  canceled: "cancelled",
  unknown: "running",
};

export function summaryRow(overrides: Partial<RunSummary> = {}): RunSummary {
  const status = overrides.status ?? "success";
  return {
    runId: overrides.runId ?? "r",
    startedAt: overrides.startedAt ?? "2024-01-01T00:00:00Z",
    status,
    runStatus: overrides.runStatus ?? STATUS_TO_RUN_STATUS[status],
    eventCount: overrides.eventCount ?? 1,
    costUsd: overrides.costUsd ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
    ...(overrides.workflow !== undefined ? { workflow: overrides.workflow } : {}),
    ...(overrides.workflowName !== undefined ? { workflowName: overrides.workflowName } : {}),
    ...(overrides.inboxStatus !== undefined ? { inboxStatus: overrides.inboxStatus } : {}),
    ...(overrides.changeStat !== undefined ? { changeStat: overrides.changeStat } : {}),
    ...(overrides.baseGitRef !== undefined ? { baseGitRef: overrides.baseGitRef } : {}),
  };
}
