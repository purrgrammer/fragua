// Store → RunSummary / RunDetail adapter.
//
// The authoritative data lives in @swarm/store (run_state + events); this
// module projects a RunState + its event tail into the shapes the
// `/runs` REST endpoints hand to the web UI.

import type { Database } from "bun:sqlite";
import type { IEventStore, RunState, RunStatus, StoredEvent } from "@swarm/store";
import type { NodeState, RunDetail, RunSummary } from "../schemas.ts";

export type UiStatus = RunSummary["status"];

export function mapStatus(status: RunStatus): UiStatus {
  switch (status) {
    case "completed":
      return "success";
    case "cancelled":
      return "canceled";
    case "halted":
      return "fail";
    case "running":
    case "queued":
    case "paused_hitl":
      return "running";
    case "quarantined":
      return "fail";
  }
}

/** Build a RunSummary from a run's projection + its event tail. */
export function runStateToSummary(
  state: RunState,
  events: StoredEvent[],
  workflowName: string | undefined,
): RunSummary {
  const first = events[0];
  const last = events[events.length - 1];
  const startedAt = first != null ? new Date(first.ts).toISOString() : new Date(state.enqueuedAt).toISOString();
  const durationMs = first != null && last != null && last.ts >= first.ts ? last.ts - first.ts : undefined;

  const summary: RunSummary = {
    runId: state.runId,
    startedAt,
    status: mapStatus(state.status),
    eventCount: events.length,
    costUsd: state.metrics.totalCostUsd,
    inputTokens: state.metrics.totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  if (state.workflowSha) summary.workflow = state.workflowSha;
  if (workflowName !== undefined) summary.workflowName = workflowName;
  if (durationMs !== undefined) summary.durationMs = durationMs;
  return summary;
}

/** Build a RunDetail from a run's projection + its full event log. */
export function runStateToDetail(
  state: RunState,
  events: StoredEvent[],
  workflowName: string | undefined,
  workflowSource: string | undefined,
): RunDetail {
  const summary = runStateToSummary(state, events, workflowName);
  const detail: RunDetail = {
    ...summary,
    lastEventSeq: state.lastAppliedSeq,
    nodes: deriveNodeStates(events),
  };
  if (workflowSource !== undefined) detail.workflowSource = workflowSource;
  return detail;
}

/**
 * Walk the event log and emit one NodeState per nodeId seen. State is
 * derived from the latest transition fact on that node:
 *   - node_started + node_completed → completed
 *   - node_started only              → running
 *   - node_aborted                   → failed
 *   - (nothing)                      → pending (not emitted; graph layer
 *     will show pending for nodes absent from the list)
 */
function deriveNodeStates(events: StoredEvent[]): NodeState[] {
  const byNode = new Map<string, { state: NodeState["state"]; lastEventSeq: number }>();
  const bump = (nodeId: string, state: NodeState["state"], seq: number) => {
    byNode.set(nodeId, { state, lastEventSeq: seq });
  };

  for (const ev of events) {
    const nodeId = nodeIdOf(ev);
    if (nodeId == null) continue;
    switch (ev.type) {
      case "fact.node_started":
        bump(nodeId, "running", ev.seq);
        break;
      case "fact.node_completed":
        bump(nodeId, "completed", ev.seq);
        break;
      case "fact.node_aborted":
        bump(nodeId, "failed", ev.seq);
        break;
      default:
        break;
    }
  }

  return Array.from(byNode.entries()).map(([nodeId, v]) => ({
    nodeId,
    state: v.state,
    lastEventSeq: v.lastEventSeq,
  }));
}

function nodeIdOf(event: StoredEvent): string | null {
  if (!event.type.startsWith("fact.")) return null;
  const p = event.payload as { nodeId?: unknown };
  return typeof p.nodeId === "string" ? p.nodeId : null;
}

/**
 * Enumerate every run in the store. Uses a raw SQL escape hatch — we
 * don't want to add a list method to IEventStore just for this
 * adapter, since the real web UI path will eventually paginate.
 */
export function listRuns(store: IEventStore): string[] {
  const db = (store as unknown as { db?: Database }).db;
  if (db == null) return [];
  return db
    .query<{ run_id: string }, []>("SELECT run_id FROM run_state ORDER BY updated_at DESC")
    .all()
    .map((r) => r.run_id);
}
