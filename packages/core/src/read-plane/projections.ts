// Store → RunSummary / RunDetail adapter.
//
// The authoritative data lives in @fragua/store (run_state + events); this
// module projects a RunState + its event tail into the shapes the
// `/runs` read endpoints hand to read clients.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IEventReader, ListRunIdsOpts, RunState, RunStatus, RunSummaryRow, StoredEvent } from "@fragua/store";
import { HALT_REASONS, type HaltReason } from "@fragua/types";
import { fanoutBranchClosures } from "../engine/fanout.ts";
import { parseWorkflow } from "../parser/yaml.ts";
import type { Graph } from "../types/graph.ts";
import type { NodeState, RunDetail, RunFanoutTopology, RunSummary, SelectedEdge } from "./schemas.ts";

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
    case "paused_human":
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
  const ownTitle = state.title && state.title.length > 0 ? state.title : undefined;
  const title = ownTitle ?? pickTitle(events);
  if (title !== undefined) summary.title = title;
  if (state.cwd != null) summary.cwd = state.cwd;
  summary.projectId = state.projectId;
  summary.projectName = state.projectName;
  if (state.imported === true) summary.imported = true;
  return summary;
}

/** Build a RunSummary from the SQL-backed list projection. This mirrors
 * `runStateToSummary` without requiring the route to fetch and parse the
 * full event log for every row. */
export function runSummaryRowToSummary(row: RunSummaryRow): RunSummary {
  const startedAtMs = row.firstEventTs ?? row.enqueuedAt;
  const durationMs =
    row.firstEventTs != null && row.lastEventTs != null && row.lastEventTs >= row.firstEventTs
      ? row.lastEventTs - row.firstEventTs
      : undefined;
  const summary: RunSummary = {
    runId: row.runId,
    startedAt: new Date(startedAtMs).toISOString(),
    status: mapStatus(row.status),
    runStatus: row.status,
    eventCount: row.eventCount,
    costUsd: row.totalCostUsd,
    inputTokens: row.totalInputTokens,
    outputTokens: row.totalOutputTokens,
    cacheReadTokens: row.totalCacheReadTokens,
    cacheWriteTokens: row.totalCacheWriteTokens,
  };
  if (row.workflowSha) summary.workflow = row.workflowSha;
  if (row.workflowName != null) summary.workflowName = row.workflowName;
  if (durationMs !== undefined) summary.durationMs = durationMs;

  const ownTitle = row.title != null && row.title.length > 0 ? row.title : undefined;
  const eventTitle = row.eventTitle != null && row.eventTitle.length > 0 ? row.eventTitle : undefined;
  const title = ownTitle ?? eventTitle;
  if (title !== undefined) summary.title = title;

  if (row.cwd != null) summary.cwd = row.cwd;
  summary.projectId = row.projectId;
  summary.projectName = row.projectName;

  if (row.inboxStatus === "pending" || row.inboxStatus === "acted" || row.inboxStatus === "discarded") {
    summary.inboxStatus = row.inboxStatus;
  }
  if (row.changeStat != null) {
    try {
      const parsed = JSON.parse(row.changeStat) as RunSummary["changeStat"];
      if (parsed != null) summary.changeStat = parsed;
    } catch {
      // malformed JSON — omit rather than fail the list
    }
  }
  if (row.baseGitRef != null && row.baseGitRef.length > 0) summary.baseGitRef = row.baseGitRef;
  if (row.baseGitSha != null && row.baseGitSha.length > 0) summary.baseGitSha = row.baseGitSha;
  if (row.imported === 1) summary.imported = true;
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
  if (workflowSource !== undefined) {
    detail.workflowSource = workflowSource;
    const fanout = fanoutTopologyFor(state.workflowSha, workflowSource);
    if (fanout !== undefined) detail.fanout = fanout;
  }

  detail.projectId = state.projectId;
  detail.projectName = state.projectName;
  if (state.cwd != null) {
    const candidate = join(state.cwd, ".fragua", "worktrees", state.runId);
    if (existsSync(candidate)) detail.worktreePath = candidate;
  }

  if (state.baseGitRef != null && state.baseGitRef.length > 0) detail.baseGitRef = state.baseGitRef;
  if (state.baseGitSha != null && state.baseGitSha.length > 0) detail.baseGitSha = state.baseGitSha;
  // Authoritative inert marker is `imported_runs` (carried on `state.imported`),
  // NOT `cwd == null` — a legitimately-enqueued run can have a null cwd and must
  // keep its operate controls.
  if (state.imported === true) detail.imported = true;

  if (state.status === "halted") {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type === "fact.run_halted") {
        const p = ev.payload as { reason?: unknown; detail?: unknown } | null | undefined;
        if (typeof p?.reason === "string" && (HALT_REASONS as readonly string[]).includes(p.reason)) {
          detail.haltReason = p.reason as HaltReason;
        }
        if (typeof p?.detail === "string") detail.haltDetail = p.detail;
        break;
      }
    }
  }

  if (state.status === "paused_human") {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type === "fact.run_paused_human") {
        const p = ev.payload as { nodeId?: unknown; text?: unknown; routes?: unknown; routeLabels?: unknown };
        if (typeof p.nodeId === "string") detail.hitlNodeId = p.nodeId;
        if (typeof p.text === "string") detail.hitlLabel = p.text;
        // Transitional projection: the new payload shape carries
        // `routes: string[]`; the web still consumes the legacy
        // `hitlOptions` shape with `{key,label,to}`. Synthesise each
        // route as `key=label=route`, `to=""` (target is irrelevant
        // to the operator-facing button; the engine's edge-selection
        // Step-0 fires the matching `route=` edge on resume). The
        // web `humanizeRouteName` reformats `output_only` -> "Output
        // Only" for the button label.
        if (Array.isArray(p.routes)) {
          detail.hitlOptions = (p.routes as unknown[]).filter((r): r is string => typeof r === "string");
        }
        // Sparse per-route button-text overrides (D6 `label=`). Keep only
        // string→string entries so a malformed payload can't poison the
        // projection; the web falls back to `humanizeRouteName` for any
        // route absent from the map.
        if (p.routeLabels != null && typeof p.routeLabels === "object" && !Array.isArray(p.routeLabels)) {
          const labels: Record<string, string> = {};
          for (const [route, label] of Object.entries(p.routeLabels as Record<string, unknown>)) {
            if (typeof label === "string") labels[route] = label;
          }
          if (Object.keys(labels).length > 0) detail.hitlOptionLabels = labels;
        }
        break;
      }
    }
  }

  // HITL decision history: pair each `intent.human_input` with the gate
  // it answered (the most recent preceding `fact.run_paused_human`). Built
  // for every run, not just paused ones, so a resumed/terminal run still
  // shows what the operator chose. Latest write per node wins, so a loop
  // that revisits the same human gate keeps only its final answer.
  const decisions = collectHitlDecisions(events);
  if (decisions !== undefined) detail.hitlDecisions = decisions;

  const requeues = collectCrashRequeues(events);
  if (requeues.length > 0) detail.crashRequeues = requeues;

  return detail;
}

/** One entry per `fact.run_requeued_after_crash`, in log order. Null-payload-
 * safe: a corrupted store row must not throw the projection. */
function collectCrashRequeues(events: StoredEvent[]): NonNullable<RunDetail["crashRequeues"]> {
  const out: NonNullable<RunDetail["crashRequeues"]> = [];
  for (const ev of events) {
    if (ev.type !== "fact.run_requeued_after_crash") continue;
    const p = ev.payload as { prevNode?: unknown; lastAliveAt?: unknown } | null | undefined;
    const entry: NonNullable<RunDetail["crashRequeues"]>[number] = { at: ev.ts };
    if (typeof p?.prevNode === "string") entry.prevNode = p.prevNode;
    if (typeof p?.lastAliveAt === "number" && Number.isFinite(p.lastAliveAt)) entry.lastAliveAt = p.lastAliveAt;
    out.push(entry);
  }
  return out;
}

// Workflow source is sha-pinned at enqueue and immutable, but runStateToDetail
// runs on every detail fetch of a live run — without the memo each SSE-driven
// refetch re-parses the same YAML and re-walks the closures. `null` caches a
// parse failure so a corrupt source isn't re-parsed per push either. Bounded:
// a long-lived daemon serving many distinct shas (schedules, iterative dev)
// would otherwise accumulate parsed graphs forever; on overflow the oldest
// entry is evicted (Map iteration order = insertion order), and a re-derive
// after eviction is just one YAML parse.
const FANOUT_TOPOLOGY_CACHE_MAX = 256;
const fanoutTopologyCache = new Map<string, RunFanoutTopology | null>();

function fanoutTopologyFor(workflowSha: string, workflowSource: string): RunFanoutTopology | undefined {
  const hit = fanoutTopologyCache.get(workflowSha);
  if (hit !== undefined) return hit ?? undefined;
  const derived = deriveFanoutTopology(workflowSource) ?? null;
  if (fanoutTopologyCache.size >= FANOUT_TOPOLOGY_CACHE_MAX) {
    const oldest = fanoutTopologyCache.keys().next().value;
    if (oldest !== undefined) fanoutTopologyCache.delete(oldest);
  }
  fanoutTopologyCache.set(workflowSha, derived);
  return derived ?? undefined;
}

/** Fan-out topology for the run detail, from the stored source via the
 * shared closure walk. Served for EVERY parseable workflow — `nodeTypes`
 * feeds type glyphs and tool-row affordances on non-parallel runs too; the
 * branch maps are simply empty then. `undefined` only when the source
 * doesn't parse (defensive: the save-path mint validates, so a stored
 * source parses). */
function deriveFanoutTopology(workflowSource: string): RunFanoutTopology | undefined {
  let graph: Graph;
  try {
    graph = parseWorkflow(workflowSource);
  } catch {
    return undefined;
  }
  const parentOf: Record<string, string> = {};
  const branchOf: Record<string, string> = {};
  const orderOf: Record<string, number> = {};
  const nodeTypes: Record<string, string> = {};
  for (const [id, node] of Object.entries(graph.nodes)) nodeTypes[id] = node.type;
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "parallel" || !Array.isArray(node.attrs.branches)) continue;
    const join = typeof node.attrs.join === "string" ? node.attrs.join : undefined;
    for (const bc of fanoutBranchClosures(graph, { branches: node.attrs.branches, join })) {
      orderOf[bc.entry] = bc.index;
      for (const x of bc.nodes) {
        parentOf[x] = node.id;
        branchOf[x] = bc.entry;
      }
    }
  }
  return { parentOf, branchOf, orderOf, nodeTypes };
}

function collectHitlDecisions(events: StoredEvent[]): Record<string, { route: string; note?: string }> | undefined {
  let gateNode: string | null = null;
  let decisions: Record<string, { route: string; note?: string }> | undefined;
  for (const ev of events) {
    if (ev.type === "fact.run_paused_human") {
      const nodeId = (ev.payload as { nodeId?: unknown }).nodeId;
      gateNode = typeof nodeId === "string" ? nodeId : null;
    } else if (ev.type === "intent.human_input" && gateNode != null) {
      const p = ev.payload as { route?: unknown; note?: unknown };
      if (typeof p.route === "string") {
        decisions ??= {};
        decisions[gateNode] = typeof p.note === "string" ? { route: p.route, note: p.note } : { route: p.route };
      }
      gateNode = null;
    }
  }
  return decisions;
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
 *
 * Active-pause patch: a node aborted because the run paused (budget /
 * operator / provider_error / …) lands as `failed` from its `node_aborted`,
 * but it re-dispatches on resume — it's suspended, not failed. When the
 * latest run-state fact is `fact.run_paused`, reset that pause's node back
 * to `running` (the UI renders running + paused as "paused"). Mirrors the
 * live overlay's `fact.run_paused` handling.
 */
function deriveNodeStates(events: StoredEvent[]): NodeState[] {
  const byKey = new Map<
    string,
    { nodeId: string; iteration: number; pass: number; state: NodeState["state"]; lastEventSeq: number }
  >();
  // Keyed by (nodeId, pass, iteration): a goal-gate retarget resets per-node
  // retry counters (§3.4), so two passes of the same node both run at
  // iteration 0 — without the pass in the key the second pass silently
  // overwrote the first and the projection lost the loop's history.
  const keyOf = (nodeId: string, pass: number, iteration: number) => `${nodeId}#${pass}.${iteration}`;
  const bump = (nodeId: string, pass: number, iteration: number, state: NodeState["state"], seq: number) => {
    byKey.set(keyOf(nodeId, pass, iteration), { nodeId, iteration, pass, state, lastEventSeq: seq });
  };
  for (const ev of events) {
    const nodeId = nodeIdOf(ev);
    if (nodeId == null) continue;
    const iteration = iterationOf(ev) ?? 0;
    switch (ev.type) {
      case "fact.node_started":
        bump(nodeId, passOf(ev), iteration, "running", ev.seq);
        break;
      // `dispatch_started` fires on every dispatch including resume after an
      // abort — operator-pause for a linear node, and (since the executor emits
      // one on re-dispatch) a fan-out BRANCH resumed by the sweep. Without this
      // the prior `node_aborted` wins as the last-counted event and the node
      // stays "failed" until `node_completed` finally fires — long minutes for a
      // chatty agent.
      case "fact.dispatch_started":
        bump(nodeId, passOf(ev), iteration, "running", ev.seq);
        break;
      case "fact.fanout_started": {
        // A parallel node's branch ENTRIES are seeded into the active set here;
        // they never emit node_started/dispatch_started (that would unpin the
        // run pointer from the parallel node), so mark each branch running so
        // the graph glows it. Its own node_completed later flips it to done.
        // The seed inherits the region's pass so a goal-gate re-seed opens
        // fresh entries instead of reviving the prior pass's completed ones.
        // Null-safe read: a corrupted store row with `payload === null` would
        // throw on property access before `?? []` could fire.
        const raw = ev.payload as Record<string, unknown> | null | undefined;
        const rawBranches = raw?.["branches"];
        const branches = Array.isArray(rawBranches) ? (rawBranches as string[]) : [];
        // The parallel node itself runs for the whole region — it never gets
        // a node_started/node_completed of its own (current_node stays pinned
        // to it; the join advances it), so without these two bumps it rendered
        // "waiting" through the entire fan-out and forever after.
        bump(nodeId, passOf(ev), iteration, "running", ev.seq);
        for (const b of branches) bump(b, passOf(ev), 0, "running", ev.seq);
        break;
      }
      case "fact.fanout_joined":
        bump(nodeId, passOf(ev), iteration, "completed", ev.seq);
        break;
      case "fact.node_completed": {
        const outcome = (ev.payload as { outcomeStatus?: string }).outcomeStatus;
        bump(nodeId, passOf(ev), iteration, outcome === "fail" ? "failed" : "completed", ev.seq);
        break;
      }
      case "fact.node_aborted":
        bump(nodeId, passOf(ev), iteration, "failed", ev.seq);
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

  // Active-pause patch: when the latest run-state-changing fact is
  // `fact.run_paused`, its node was flipped to `failed` by the preceding
  // `node_aborted` but will re-dispatch on resume. Reset it to `running`
  // (the UI renders running + paused as "paused") so a paused step doesn't
  // read as a failure.
  const activePause = latestRunPaused(events);
  if (activePause != null) {
    for (const [k, v] of byKey) {
      if (v.nodeId === activePause.nodeId && v.state === "failed") {
        byKey.set(k, { ...v, state: "running", lastEventSeq: activePause.seq });
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

/** Run-state-changing facts. A `fact.run_paused` is the *active* pause only
 *  when it's the latest of these in the trail — a later resume/terminal/
 *  human-pause supersedes it. */
const RUN_STATE_FACT_TYPES = new Set<string>([
  "fact.run_paused",
  "fact.run_paused_human",
  "fact.run_resumed",
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_cancelled",
  "fact.run_quarantined",
]);

/** The currently-active `fact.run_paused` node + seq, or `null` when the
 *  run isn't paused (no pause fact, or a later run-state fact superseded it).
 *  Pauses without a `nodeId` (e.g. max_loops, engine_incompatible) return
 *  `null` — there's no aborted node to reset. */
function latestRunPaused(events: StoredEvent[]): { nodeId: string; seq: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (!RUN_STATE_FACT_TYPES.has(ev.type)) continue;
    if (ev.type !== "fact.run_paused") return null;
    const nodeId = (ev.payload as { nodeId?: unknown }).nodeId;
    return typeof nodeId === "string" ? { nodeId, seq: ev.seq } : null;
  }
  return null;
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
  const seen = new Set<string>();
  const pushEdge = (from: string, to: string, iteration: number, pass: number) => {
    const key = `${from} ${to} ${pass} ${iteration}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from, to, iteration, pass });
  };
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.type === "edge.selected") {
      const p = ev.payload as { from?: unknown; to?: unknown; iteration?: unknown };
      if (typeof p.from !== "string" || typeof p.to !== "string") continue;
      const iteration = typeof p.iteration === "number" && Number.isFinite(p.iteration) ? p.iteration : 0;
      const pass = passOf(ev);
      const retargetTo = goalGateRetargetTarget(events, i, p.from);
      pushEdge(p.from, retargetTo ?? p.to, iteration, pass);
    }
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

/** Goal-gate re-entry epoch from a fact payload — absent/invalid ⇒ 0.
 * Null-payload-safe (a corrupted store row must not throw the projection). */
function passOf(event: StoredEvent): number {
  const v = (event.payload as { pass?: unknown } | null | undefined)?.pass;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export { deriveNodeStates, deriveSelectedEdges };

export type ListRunsOpts = ListRunIdsOpts;

/** Wire to `IEventReader.listRunIds` — kept for callers that already
 *  imported `listRuns`. SQL pushdown lives in the store. */
export function listRuns(store: Pick<IEventReader, "listRunIds">, opts: ListRunsOpts = {}): string[] {
  return store.listRunIds(opts);
}
