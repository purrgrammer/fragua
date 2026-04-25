// Store → RunSummary / RunDetail adapter.
//
// The authoritative data lives in @swarm/store (run_state + events); this
// module projects a RunState + its event tail into the shapes the
// `/runs` REST endpoints hand to the web UI.

import type { Database } from "bun:sqlite";
import type { IEventStore, RunState, RunStatus, StoredEvent } from "@swarm/store";
import type { NodeState, RunDetail, RunSummary, SelectedEdge } from "../schemas.ts";

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
      return "running";
    case "queued":
      return "queued";
    case "paused_hitl":
      return "paused";
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

  // Pre-split runs have 0 for every split field — in that case fall back
  // to treating `totalTokens` as input so old runs still show a token
  // count somewhere instead of rendering "0 / 0 / 0 / 0". We detect this
  // as "none of the four split fields ever incremented" — a post-split
  // run that genuinely had zero output tokens (tool-only turn, maybe) is
  // indistinguishable at this layer, but that's fine: it's still 0.
  const m = state.metrics;
  const hasSplit =
    m.totalInputTokens > 0 || m.totalOutputTokens > 0 || m.totalCacheReadTokens > 0 || m.totalCacheWriteTokens > 0;
  const summary: RunSummary = {
    runId: state.runId,
    startedAt,
    status: mapStatus(state.status),
    eventCount: events.length,
    costUsd: m.totalCostUsd,
    inputTokens: hasSplit ? m.totalInputTokens : m.totalTokens,
    outputTokens: m.totalOutputTokens,
    cacheReadTokens: m.totalCacheReadTokens,
    cacheWriteTokens: m.totalCacheWriteTokens,
  };
  if (state.workflowSha) summary.workflow = state.workflowSha;
  if (workflowName !== undefined) summary.workflowName = workflowName;
  if (durationMs !== undefined) summary.durationMs = durationMs;
  const title = state.title && state.title.length > 0 ? state.title : pickTitle(events);
  if (title !== undefined) summary.title = title;
  const input = pickInput(state.routing);
  if (input !== undefined) summary.input = input;
  return summary;
}

/** Pick the most recent auto-generated title from the event stream.
 * `run.title_generated` events are emitted by the async summariser
 * after a run starts; we take the last one so re-triggered titles
 * supersede stale ones. */
function pickTitle(events: StoredEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type !== "run.title_generated") continue;
    const payload = ev.payload as { title?: unknown };
    if (typeof payload.title === "string" && payload.title.length > 0) return payload.title;
  }
  return undefined;
}

function pickInput(routing: Record<string, unknown>): string | undefined {
  const v = routing["input"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
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
    selectedEdges: deriveSelectedEdges(events),
  };
  if (workflowSource !== undefined) detail.workflowSource = workflowSource;
  return detail;
}

/**
 * Walk the event log and emit one NodeState per nodeId seen. State is
 * derived from the latest transition fact on that node:
 *   - node_started + node_completed(outcomeStatus≠fail) → completed
 *   - node_started + node_completed(outcomeStatus=fail) → failed
 *   - node_started only                                 → running
 *   - node_aborted                                      → failed
 *   - (nothing)                                         → pending (not
 *     emitted; graph layer renders pending for nodes absent from the list,
 *     which the UI then fades to mark "never executed").
 *
 * Terminal-halt patch: if the run ended via `fact.run_halted`,
 * `fact.run_cancelled`, or `fact.run_quarantined` and a node is still
 * marked `running` (no node_completed / node_aborted of its own), we
 * downgrade it to `failed` so the UI doesn't show a stale "in progress"
 * spinner on a halted run.
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
      case "fact.node_completed": {
        const outcome = (ev.payload as { outcomeStatus?: string }).outcomeStatus;
        bump(nodeId, outcome === "fail" ? "failed" : "completed", ev.seq);
        break;
      }
      case "fact.node_aborted":
        bump(nodeId, "failed", ev.seq);
        break;
      default:
        break;
    }
  }

  // Terminal-halt patch: find the first run-terminal event (there should
  // be exactly one) and use its seq as the lastEventSeq for any node
  // that never received its own completion/abort.
  let haltSeq: number | undefined;
  for (const ev of events) {
    if (ev.type === "fact.run_halted" || ev.type === "fact.run_cancelled" || ev.type === "fact.run_quarantined") {
      haltSeq = ev.seq;
      break;
    }
  }
  if (haltSeq !== undefined) {
    for (const [nodeId, v] of byNode) {
      if (v.state === "running") {
        byNode.set(nodeId, { state: "failed", lastEventSeq: haltSeq });
      }
    }
  }

  return Array.from(byNode.entries()).map(([nodeId, v]) => ({
    nodeId,
    state: v.state,
    lastEventSeq: v.lastEventSeq,
  }));
}

/** Project `edge.selected` events into the `(from, to)` pairs the executor
 *  traversed. Order preserved. Duplicates kept — a back-edge re-entered N
 *  times emits N entries, which lets the UI reason about iteration if it
 *  cares. */
function deriveSelectedEdges(events: StoredEvent[]): SelectedEdge[] {
  const out: SelectedEdge[] = [];
  for (const ev of events) {
    if (ev.type !== "edge.selected") continue;
    const p = ev.payload as { from?: unknown; to?: unknown };
    if (typeof p.from === "string" && typeof p.to === "string") {
      out.push({ from: p.from, to: p.to });
    }
  }
  return out;
}

function nodeIdOf(event: StoredEvent): string | null {
  if (!event.type.startsWith("fact.")) return null;
  const p = event.payload as { nodeId?: unknown };
  return typeof p.nodeId === "string" ? p.nodeId : null;
}

export { deriveNodeStates, deriveSelectedEdges };

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
