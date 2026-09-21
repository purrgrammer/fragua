// Shared test fixtures for RunSummary / RunDetail rows.
//
// `STATUS_TO_RUN_STATUS` is a test-only reverse approximation of the
// server projection's `runStatus → status` collapse (the projection maps
// raw runStatus down to the coarse UI status; here we invert it to pick a
// plausible default runStatus from a status). `summaryRow` / `makeRunDetail`
// build a minimal row and default runStatus through the map, so a new
// required field is added in one place instead of scattered across suites.

import type { RunDetail, RunSummary } from "../../src/lib/api.ts";

export const STATUS_TO_RUN_STATUS: Record<RunSummary["status"], RunSummary["runStatus"]> = {
  queued: "queued",
  running: "running",
  paused: "paused",
  success: "completed",
  fail: "halted",
  canceled: "cancelled",
  // No status collapses to `running` from the server; `unknown` has no
  // faithful inverse, so callers depending on it should pass runStatus
  // explicitly rather than trust this arbitrary default.
  //
  // `fail` and `paused` are likewise ambiguous: the coarse `fail` collapses
  // both `halted` and `quarantined` (defaulted to `halted` here), and
  // `paused` collapses `paused` / `paused_human` / `paused_auto` (defaulted
  // to `paused`). A test exercising quarantined or a pause sub-state must
  // pass `runStatus` explicitly rather than trust these defaults.
  unknown: "running",
};

export function summaryRow(overrides: Partial<RunSummary> = {}): RunSummary {
  const {
    runId,
    startedAt,
    status,
    runStatus,
    eventCount,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...rest
  } = overrides;
  const resolvedStatus = status ?? "success";
  return {
    runId: runId ?? "r",
    startedAt: startedAt ?? "2024-01-01T00:00:00Z",
    status: resolvedStatus,
    runStatus: runStatus ?? STATUS_TO_RUN_STATUS[resolvedStatus],
    eventCount: eventCount ?? 1,
    costUsd: costUsd ?? 0,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    ...rest,
  };
}

/** "Needs attention" row — an operator-paused run for Inbox / sidebar tests. */
export const blockedRun = (id: string): RunSummary => summaryRow({ runId: id, status: "paused", eventCount: 2 });

/** "Ready to land" row — a terminal worktree run awaiting an operator primitive. */
export const pendingRun = (id: string): RunSummary =>
  summaryRow({
    runId: id,
    status: "success",
    eventCount: 1,
    inboxStatus: "pending",
    changeStat: {
      committed: { filesChanged: 1, insertions: 2, deletions: 0 },
      uncommitted: null,
    },
  });

export function makeRunDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  const {
    runId,
    startedAt,
    status,
    runStatus,
    lastEventSeq,
    nodes,
    selectedEdges,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...rest
  } = overrides;
  const resolvedStatus = status ?? "running";
  return {
    runId: runId ?? "r1",
    startedAt: startedAt ?? "2024-01-01T00:00:00Z",
    status: resolvedStatus,
    runStatus: runStatus ?? STATUS_TO_RUN_STATUS[resolvedStatus],
    lastEventSeq: lastEventSeq ?? 1,
    nodes: nodes ?? [],
    selectedEdges: selectedEdges ?? [],
    costUsd: costUsd ?? 0,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    ...rest,
  };
}
