// Pure read-plane projection: synthesise a run's event log into a structured
// narrative. No I/O, no store calls — all inputs are plain arrays of already-
// fetched rows. Called by `ReadPlane.explain` which assembles them.

import type { StoredEvent } from "@fragua/store";
import type { RunDetail } from "./schemas.ts";
import type { SnapshotItem } from "./snapshots.ts";
import type { StepSnapshot } from "./steps.ts";

// ── Wire types ────────────────────────────────────────────────────────────

export interface ExplainDiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** One executed step (LLM call or tool node) in the narrative. */
export interface ExplainStep {
  /** 0-based step index, matching `StepSnapshot.stepIdx`. */
  stepIdx: number;
  nodeId: string;
  /** When this step is a `type: parallel` branch sub-node, the parent parallel
   * node's id (from `fact.fanout_started`). Lets a renderer nest branches under
   * their parent — mirroring the Cost tab — instead of listing them flat. Absent
   * for non-branch steps. */
  parentNodeId?: string;
  iteration?: { n: number; max: number };
  /** Goal-gate re-entry epoch the step ran under. Absent ⇒ pass 0. */
  pass?: number;
  outcome: "success" | "fail" | "unknown";
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  billedTokens: number;
  durationMs?: number;
  model?: string;
}

/** How the run ended. */
export type ExplainOutcome =
  | { kind: "completed" }
  | { kind: "halted"; reason: string; detail?: string }
  | { kind: "cancelled"; reason?: string }
  | { kind: "paused"; reason: string }
  | { kind: "paused_human"; label?: string }
  | { kind: "quarantined"; reason: string }
  | { kind: "running" };

/** Soft budget warning surfaced from `budget.warn` events. */
export interface BudgetWarnEntry {
  scope: string;
  metric: string;
  limit: number;
  actual: number;
  ratio: number;
}

/** The full structured explanation for one run. */
export interface RunExplanation {
  runId: string;
  /** Edge path actually traversed, in traversal order. */
  path: Array<{ from: string; to: string; iteration: number; pass: number }>;
  /** One entry per executed step (LLM calls + tool nodes). */
  steps: ExplainStep[];
  /** Snapshots captured during the run. */
  snapshots: Array<{
    label: "terminal" | "hitl" | "step";
    nodeId: string | null;
    commitSha: string;
    committed: ExplainDiffSummary | null;
    uncommitted: ExplainDiffSummary | null;
  }>;
  /** Net diff vs base, summed across all snapshots' committed stats. */
  diffSummary: ExplainDiffSummary | null;
  /** How the run ended. */
  outcome: ExplainOutcome;
  /** Soft budget warnings that fired without a subsequent hard stop for the
   * same (scope, metric) — still active as of the event log tail. */
  budgetWarnings: BudgetWarnEntry[];
  /** Total cost and tokens for the run. */
  totals: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    billedTokens: number;
    durationMs?: number;
  };
  /** Fan-out topology served on the run detail (read-plane derived) —
   * consumers order branch rows by declared `branches:` order instead of
   * settle order, the same structural answer the web grouping uses. */
  fanout?: RunDetail["fanout"];
}

// ── Pure builder ──────────────────────────────────────────────────────────

/**
 * Build a `RunExplanation` from pre-fetched run data. Pure — same inputs
 * produce the same output; no I/O, no clocks.
 */
export function buildExplanation(
  detail: RunDetail,
  events: StoredEvent[],
  snapshots: SnapshotItem[],
  steps: StepSnapshot[],
): RunExplanation {
  const path = (detail.selectedEdges ?? []).map((e) => ({
    from: e.from,
    to: e.to,
    iteration: e.iteration,
    pass: e.pass,
  }));

  const explainSteps = buildSteps(events, steps);
  const snapshotRows = snapshots.map((s) => ({
    label: s.label,
    nodeId: s.nodeId,
    commitSha: s.commitSha,
    committed: s.committed
      ? {
          filesChanged: s.committed.filesChanged,
          insertions: s.committed.insertions,
          deletions: s.committed.deletions,
        }
      : null,
    uncommitted: s.uncommitted
      ? {
          filesChanged: s.uncommitted.filesChanged,
          insertions: s.uncommitted.insertions,
          deletions: s.uncommitted.deletions,
        }
      : null,
  }));
  const diffSummary = buildDiffSummary(snapshotRows);
  const outcome = deriveOutcome(events);
  const budgetWarnings = collectBudgetWarnings(events);

  const totalCostUsd = explainSteps.reduce((sum, s) => sum + s.costUsd, 0);
  const totalInputTokens = explainSteps.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOutputTokens = explainSteps.reduce((sum, s) => sum + s.outputTokens, 0);
  const totalCacheReadTokens = explainSteps.reduce((sum, s) => sum + s.cacheReadTokens, 0);
  const totalCacheWriteTokens = explainSteps.reduce((sum, s) => sum + s.cacheWriteTokens, 0);
  const totalBilledTokens = explainSteps.reduce((sum, s) => sum + s.billedTokens, 0);
  const totalDuration =
    detail.durationMs !== undefined
      ? detail.durationMs
      : explainSteps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) || undefined;

  return {
    runId: detail.runId,
    path,
    steps: explainSteps,
    snapshots: snapshotRows,
    diffSummary,
    outcome,
    budgetWarnings,
    totals: {
      costUsd: totalCostUsd,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheWriteTokens: totalCacheWriteTokens,
      billedTokens: totalBilledTokens,
      ...(totalDuration !== undefined ? { durationMs: totalDuration } : {}),
    },
    ...(detail.fanout !== undefined ? { fanout: detail.fanout } : {}),
  };
}

// ── Private helpers ───────────────────────────────────────────────────────

/** Map `fact.node_completed.outcomeStatus` by `(nodeId, pass, iteration)` from
 * the event stream, then merge onto the StepSnapshot array. Pass-keyed: a
 * goal-gate retarget resets per-node retry counters, so a later pass's
 * completion at the same `(nodeId, iteration)` would otherwise overwrite the
 * earlier pass's outcome (a failed first gate attempt rendering "success"). */
function buildSteps(events: StoredEvent[], steps: StepSnapshot[]): ExplainStep[] {
  // Build outcome lookup from node_completed events.
  const outcomeByKey = new Map<string, "success" | "fail">();
  for (const ev of events) {
    if (ev.type !== "fact.node_completed") continue;
    const p = ev.payload as { nodeId?: unknown; iteration?: unknown; pass?: unknown; outcomeStatus?: unknown };
    if (typeof p.nodeId !== "string") continue;
    const iter = typeof p.iteration === "number" ? p.iteration : 0;
    const pass = typeof p.pass === "number" ? p.pass : 0;
    const key = `${p.nodeId}#${pass}.${iter}`;
    const status = p.outcomeStatus === "fail" ? "fail" : "success";
    outcomeByKey.set(key, status);
  }

  return steps.map((s) => {
    const iter = s.iteration?.n ?? 0;
    const key = `${s.nodeId}#${s.pass ?? 0}.${iter}`;
    const outcome = outcomeByKey.get(key) ?? "unknown";
    return {
      stepIdx: s.stepIdx,
      nodeId: s.nodeId,
      ...(s.parentNodeId !== undefined ? { parentNodeId: s.parentNodeId } : {}),
      ...(s.iteration !== undefined ? { iteration: s.iteration } : {}),
      ...(s.pass !== undefined ? { pass: s.pass } : {}),
      outcome,
      costUsd: s.cost?.cost_usd ?? 0,
      inputTokens: s.cost?.input_tokens ?? 0,
      outputTokens: s.cost?.output_tokens ?? 0,
      cacheReadTokens: s.cost?.cache_read_tokens ?? 0,
      cacheWriteTokens: s.cost?.cache_write_tokens ?? 0,
      billedTokens:
        s.cost?.billed_tokens ??
        (s.cost?.input_tokens ?? 0) +
          (s.cost?.output_tokens ?? 0) +
          (s.cost?.cache_read_tokens ?? 0) +
          (s.cost?.cache_write_tokens ?? 0),
      ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
      ...(s.model !== undefined ? { model: s.model } : {}),
    };
  });
}

/** Sum committed diff stats across all snapshots. Returns `null` when there
 * are no snapshots with committed data. */
function buildDiffSummary(snapshots: Array<{ committed: ExplainDiffSummary | null }>): ExplainDiffSummary | null {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  let any = false;
  for (const s of snapshots) {
    if (s.committed == null) continue;
    any = true;
    filesChanged += s.committed.filesChanged;
    insertions += s.committed.insertions;
    deletions += s.committed.deletions;
  }
  return any ? { filesChanged, insertions, deletions } : null;
}

/** Walk events from the tail to find the terminal/pause fact. */
function deriveOutcome(events: StoredEvent[]): ExplainOutcome {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    switch (ev.type) {
      case "fact.run_terminated": {
        const p = ev.payload as { status?: unknown; reason?: unknown; detail?: unknown };
        if (p.status === "completed") return { kind: "completed" };
        if (p.status === "aborted") {
          return {
            kind: "cancelled",
            ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
          };
        }
        // status === "errored"
        return {
          kind: "halted",
          reason: typeof p.reason === "string" ? p.reason : "unknown",
          ...(typeof p.detail === "string" ? { detail: p.detail } : {}),
        };
      }
      case "fact.run_paused": {
        const p = ev.payload as { reason?: unknown; text?: unknown };
        if (p.reason === "human") {
          return {
            kind: "paused_human",
            ...(typeof p.text === "string" ? { label: p.text } : {}),
          };
        }
        return {
          kind: "paused",
          reason: typeof p.reason === "string" ? p.reason : "unknown",
        };
      }
      case "fact.run_quarantined": {
        const p = ev.payload as { reason?: unknown };
        return {
          kind: "quarantined",
          reason: typeof p.reason === "string" ? p.reason : "unknown",
        };
      }
      default:
        break;
    }
  }
  return { kind: "running" };
}

/** Collect `budget.warn` events that have no later `budget.stop` for the same
 * `(scope, metric)` pair — those are the still-active soft warnings. */
function collectBudgetWarnings(events: StoredEvent[]): BudgetWarnEntry[] {
  // Forward scan to find the last `budget.stop` seq for each (scope,metric).
  const stopSeqByTag = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "budget.stop") {
      const p = ev.payload as { scope?: unknown; metric?: unknown };
      if (typeof p.scope === "string" && typeof p.metric === "string") {
        stopSeqByTag.set(`${p.scope}:${p.metric}`, ev.seq);
      }
    }
  }
  const warnings: BudgetWarnEntry[] = [];
  for (const ev of events) {
    if (ev.type !== "budget.warn") continue;
    const p = ev.payload as {
      scope?: unknown;
      metric?: unknown;
      limit?: unknown;
      actual?: unknown;
      ratio?: unknown;
    };
    if (typeof p.scope !== "string" || typeof p.metric !== "string") continue;
    const tag = `${p.scope}:${p.metric}`;
    const stopSeq = stopSeqByTag.get(tag);
    if (stopSeq !== undefined && stopSeq > ev.seq) continue;
    warnings.push({
      scope: p.scope,
      metric: p.metric,
      limit: typeof p.limit === "number" ? p.limit : 0,
      actual: typeof p.actual === "number" ? p.actual : 0,
      ratio: typeof p.ratio === "number" ? p.ratio : 0,
    });
  }
  return warnings;
}
