// Store → RunSummary / RunDetail adapter.
//
// The authoritative data lives in @swarm/store (run_state + events); this
// module projects a RunState + its event tail into the shapes the
// `/runs` REST endpoints hand to the web UI.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IEventStore, ListRunIdsOpts, RunState, RunStatus, StoredEvent } from "@swarm/store";
import type { HitlOption, NodeState, RunDetail, RunSummary, SelectedEdge } from "../schemas.ts";

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
    case "paused":
    case "paused_hitl":
    case "paused_auto":
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

  const m = state.metrics;
  const summary: RunSummary = {
    runId: state.runId,
    startedAt,
    status: mapStatus(state.status),
    runStatus: state.status,
    eventCount: events.length,
    costUsd: m.totalCostUsd,
    inputTokens: m.totalInputTokens,
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
  if (state.cwd != null) summary.cwd = state.cwd;
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
    // Tail-of-events seq, NOT `state.lastAppliedSeq` — the latter is the
    // intent-fold cursor (advanced only via `advanceAppliedTo` when an
    // intent is folded into the projection) and stays at 1 for runs whose
    // only intent was the initial enqueue. The web client uses this value
    // both as the SSE resume watermark and as the dedup filter for
    // overlay edges in `mergeDetail`; it must match the seq of the
    // latest event reflected in `nodes` / `selectedEdges`, otherwise SSE
    // re-delivers events the snapshot already covers and the run-detail
    // Graph view shows `· ×N` on edges that fired exactly once.
    lastEventSeq: events.at(-1)?.seq ?? 0,
    nodes: deriveNodeStates(events),
    selectedEdges: deriveSelectedEdges(events),
  };
  if (workflowSource !== undefined) detail.workflowSource = workflowSource;

  if (state.cwd != null) {
    const candidate = join(state.cwd, ".swarm", "worktrees", state.runId);
    if (existsSync(candidate)) detail.worktreePath = candidate;
  }

  if (state.status === "paused_hitl") {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type === "fact.run_paused_hitl") {
        const p = ev.payload as { nodeId?: unknown; label?: unknown; options?: unknown };
        if (typeof p.nodeId === "string") detail.hitlNodeId = p.nodeId;
        if (typeof p.label === "string") detail.hitlLabel = p.label;
        if (Array.isArray(p.options)) detail.hitlOptions = p.options as HitlOption[];
        break;
      }
    }
  }

  return detail;
}

/**
 * Walk the event log and emit one NodeState per `(nodeId, iteration)` seen.
 * State is derived from the latest transition fact on that pair:
 *   - node_started + node_completed(outcomeStatus≠fail) → completed
 *   - node_started + node_completed(outcomeStatus=fail) → failed
 *   - node_started only                                 → running
 *   - node_aborted                                      → failed
 *   - (nothing)                                         → pending (not
 *     emitted; graph layer renders pending for nodes absent from the list,
 *     which the UI then fades to mark "never executed").
 *
 * Loops (backward edges, goal-gate retargets) bump `iteration` on
 * `fact.node_started`; each iteration appears as its own entry. The web
 * UI groups by `nodeId` and renders the latest iteration's state; non-loop
 * runs see iteration=0 only and behave identically to pre-loop output.
 *
 * Terminal-halt patch: if the run ended via `fact.run_halted`,
 * `fact.run_cancelled`, or `fact.run_quarantined` and any entry is still
 * marked `running`, we downgrade to `failed` so the UI doesn't show a
 * stale "in progress" spinner on a halted run.
 */
function deriveNodeStates(events: StoredEvent[]): NodeState[] {
  const byKey = new Map<
    string,
    { nodeId: string; iteration: number; state: NodeState["state"]; lastEventSeq: number }
  >();
  const keyOf = (nodeId: string, iteration: number) => `${nodeId}#${iteration}`;
  const bump = (nodeId: string, iteration: number, state: NodeState["state"], seq: number) => {
    byKey.set(keyOf(nodeId, iteration), { nodeId, iteration, state, lastEventSeq: seq });
  };

  for (const ev of events) {
    const nodeId = nodeIdOf(ev);
    if (nodeId == null) continue;
    const iteration = iterationOf(ev) ?? 0;
    switch (ev.type) {
      case "fact.node_started":
        bump(nodeId, iteration, "running", ev.seq);
        break;
      // `dispatch_started` fires on every dispatch including resume after
      // an operator-pause abort. Without this case the prior `node_aborted`
      // wins as the last-counted event and the node stays "failed" until
      // `node_completed` finally fires — long minutes for a chatty agent.
      case "fact.dispatch_started":
        bump(nodeId, iteration, "running", ev.seq);
        break;
      case "fact.node_completed": {
        const outcome = (ev.payload as { outcomeStatus?: string }).outcomeStatus;
        bump(nodeId, iteration, outcome === "fail" ? "failed" : "completed", ev.seq);
        break;
      }
      case "fact.node_aborted":
        bump(nodeId, iteration, "failed", ev.seq);
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
    for (const [k, v] of byKey) {
      if (v.state === "running") {
        byKey.set(k, { ...v, state: "failed", lastEventSeq: haltSeq });
      }
    }
  }

  // Stable order: by `(nodeId, iteration)`. The UI groups by nodeId so
  // adjacent iterations land together, which makes "latest" lookups cheap.
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
    return a.iteration - b.iteration;
  });
}

/** Project `edge.selected` events into the `(from, to, iteration)` triples
 *  the executor traversed. Order preserved. Multiple entries for the same
 *  `(from, to)` are emitted when a back-edge or goal-gate retarget
 *  re-traverses across iterations; `iteration` distinguishes them.
 *
 *  Reconciliation: when an `edge.selected` is followed by a
 *  `goal_gate.retarget` for the same source node, the engine overrode
 *  the originally-picked edge with the gate's retry_target — the
 *  recorded edge was never actually traversed. The newer daemon
 *  suppresses the misleading emission at source; historical runs still
 *  carry it, so we rewrite it here to point at the actual retarget
 *  destination. We rewrite (vs. drop) because consumers count one
 *  selectedEdge per gate visit to derive retarget firings; dropping
 *  would silently undercount and dim the synthetic retarget edge. */
function deriveSelectedEdges(events: StoredEvent[]): SelectedEdge[] {
  const out: SelectedEdge[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined || ev.type !== "edge.selected") continue;
    const p = ev.payload as { from?: unknown; to?: unknown; iteration?: unknown };
    if (typeof p.from !== "string" || typeof p.to !== "string") continue;
    const iteration = typeof p.iteration === "number" && Number.isFinite(p.iteration) ? p.iteration : 0;
    const retargetTo = goalGateRetargetTarget(events, i, p.from);
    out.push({ from: p.from, to: retargetTo ?? p.to, iteration });
  }
  return out;
}

/** When the next event after `edgeSelectedIdx` is a `goal_gate.retarget`
 *  for `fromNode`, return the retarget target; otherwise `undefined`.
 *  The engine emits these back-to-back when a retarget overrides a
 *  freshly-picked edge. Searches forward until the source's
 *  `fact.node_completed` (which closes the window). */
function goalGateRetargetTarget(events: StoredEvent[], edgeSelectedIdx: number, fromNode: string): string | undefined {
  for (let j = edgeSelectedIdx + 1; j < events.length; j++) {
    const ev = events[j];
    if (ev === undefined) continue;
    if (ev.type === "goal_gate.retarget") {
      const p = ev.payload as { failedGate?: unknown; target?: unknown };
      if (p.failedGate === fromNode && typeof p.target === "string") return p.target;
    }
    if (ev.type === "fact.node_completed") {
      const nodeId = (ev.payload as { nodeId?: unknown }).nodeId;
      if (nodeId === fromNode) return undefined;
    }
  }
  return undefined;
}

function nodeIdOf(event: StoredEvent): string | null {
  if (!event.type.startsWith("fact.")) return null;
  const p = event.payload as { nodeId?: unknown };
  return typeof p.nodeId === "string" ? p.nodeId : null;
}

function iterationOf(event: StoredEvent): number | null {
  const p = event.payload as { iteration?: unknown };
  return typeof p.iteration === "number" && Number.isFinite(p.iteration) ? p.iteration : null;
}

export { deriveNodeStates, deriveSelectedEdges };

export type ListRunsOpts = ListRunIdsOpts;

/** Wire to `IEventStore.listRunIds` — kept for callers that already
 *  imported `listRuns`. SQL pushdown lives in the store. */
export function listRuns(store: IEventStore, opts: ListRunsOpts = {}): string[] {
  return store.listRunIds(opts);
}
