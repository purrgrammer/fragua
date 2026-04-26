// Pure reducer: StoredEvent[] → StepSnapshot[].
//
// A "step" is one `llm.start` event (one backend.run() call). Companion
// events fold onto the step opened at that llm.start until the next
// llm.start for the same nodeId starts a new one:
//   - `llm.done`       → records `durationMs`. We do NOT close the step:
//                        tool-using turns emit multiple message_end events
//                        under one llm.start, each with its own `done`.
//                        The LAST llm.done's timestamp wins.
//   - `cost.recorded`  → DELIBERATELY NOT folded here. Cost / token sums
//                        are aggregated in SQL via
//                        `IEventStore.getStepAggregates()`. The route
//                        merges those aggregates onto these snapshots
//                        keyed by `startSeq`. SQL is the single source
//                        of truth for numerical totals; folding events
//                        in TS quietly mis-counted whenever the window
//                        model didn't match the agent's actual flow.
//
// The snapshot is shaped for `CostInspector` only — one row per LLM call,
// showing nodeId / iteration / model / duration / cost. Step bodies
// (prompt, system prompt, messages, tools, context files, skills,
// settings, budget, final text) are NOT included: that content lives
// in the Conversation tab + the messages table, and shipping it doubled
// (or, with prior-message accumulation, O(N²)-ed) the wire payload for
// no UI benefit.

export interface StepEvent {
  type: string;
  payload: unknown;
  ts: number;
  /** Stream sequence number of the event. Used to key SQL aggregates back
   * onto these snapshots; required on `llm.start` events. */
  seq?: number;
}

export interface StepSnapshot {
  /** 0-based index within the run, by stream order. Stable across refetches. */
  stepIdx: number;
  /** Stream seq of the originating `llm.start`. Joins with the SQL
   * aggregate row for this step (`getStepAggregates(runId)`). */
  startSeq: number;
  /** Real DOT node id (or a synthetic id for summariser steps). */
  nodeId: string;
  /** Iteration metadata when the caller is a loop. */
  iteration?: { n: number; max: number };
  /** ISO timestamp of the originating `llm.start`. Used by the UI to
   * compute live elapsed time for in-flight steps (`now - startedAt`)
   * before `durationMs` lands. */
  startedAt: string;
  /** Set on the LAST `llm.done` in this step's window. Absent while the
   * step is still in flight — the UI ticks `now - startedAt` instead. */
  durationMs?: number;
  // ---- what the agent was asked ----
  provider?: string;
  model?: string;
  fidelity?: string;
  // ---- what came back (populated by `attachStepAggregates`) ----
  cost?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_usd: number;
  };
}

/**
 * Fold a run's event stream into one StepSnapshot per `llm.start`.
 *
 * Pure: same input ⇒ same output. No clocks, no I/O. Called from the
 * HTTP route handler and from tests. Unknown payload fields are ignored
 * rather than rejected — the event envelope evolves independently of the
 * UI shape and rejecting unknown fields would break replay.
 */
export function eventsToSteps(events: readonly StepEvent[]): StepSnapshot[] {
  const steps: StepSnapshot[] = [];
  // nodeId → index of most-recently-opened still-open step on that node.
  const openStepByNode = new Map<string, number>();

  for (const ev of events) {
    const data = (ev.payload ?? {}) as Record<string, unknown>;
    const nodeId = stringField(data, "nodeId");
    if (ev.type === "llm.start") {
      const startedAt = new Date(ev.ts).toISOString();
      const step: StepSnapshot = {
        stepIdx: steps.length,
        startSeq: ev.seq ?? steps.length,
        nodeId: nodeId || "__unknown",
        startedAt,
      };
      assignOptional(step, data);
      steps.push(step);
      if (step.nodeId) openStepByNode.set(step.nodeId, steps.length - 1);
      continue;
    }

    if (ev.type !== "llm.done") continue;
    if (!nodeId) continue;
    const idx = openStepByNode.get(nodeId);
    if (idx === undefined) continue;
    const step = steps[idx]!;
    // LAST llm.done in the window wins for durationMs — tool-using turns
    // emit one llm.done per assistant message, all under a single
    // llm.start. Step stays open until the next llm.start for this node.
    const startedMs = Date.parse(step.startedAt);
    const endedMs = ev.ts;
    if (Number.isFinite(startedMs) && endedMs >= startedMs) {
      step.durationMs = endedMs - startedMs;
    }
  }

  return steps;
}

/**
 * Cost / token aggregate row produced by `IEventStore.getStepAggregates()`,
 * shaped here to avoid a hard dependency on `@swarm/store` types in the
 * UI bundle. Wire-compatible with `StepAggregateRow`.
 */
export interface StepCostAggregate {
  startSeq: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costEventCount: number;
}

/**
 * Fill `durationMs` for steps using their effective end timestamp.
 *
 * Per-step end timestamps:
 *   1. **Non-last orphan step** — the next step's `startedAt` (the agent
 *      moved on, so this step is effectively done as of that moment).
 *   2. **Last step on a terminal run** — always the run's last event
 *      timestamp, even if the step already had its own `llm.done`. This
 *      is the "stop step" anchor: a synthetic/instant final step (like
 *      a `merge` node whose `llm.done` fires in the same millisecond as
 *      `llm.start`, giving `durationMs=0`) gets a meaningful wall-clock
 *      duration instead of `0s`.
 *   3. **Last step on a live run** — `durationMs` stays as-is (undefined
 *      for in-flight, set if the step's `llm.done` already fired) so the
 *      client can tick `now - startedAt` for the active step.
 *
 * Returns a new array with new step objects; never mutates inputs.
 */
export function fillOrphanDurations(
  steps: readonly StepSnapshot[],
  opts: { lastEventTs: number | undefined; runIsTerminal: boolean },
): StepSnapshot[] {
  return steps.map((step, i) => {
    const isLast = i === steps.length - 1;
    const next = steps[i + 1];
    // Last step on a terminal run anchors against `lastEventTs` even
    // when it already has a `durationMs` — see the "stop step" rationale
    // above. All other cases only fill when `durationMs` is undefined.
    const forceFill = isLast && opts.runIsTerminal;
    if (!forceFill && step.durationMs !== undefined) return step;
    const endTs = next != null ? Date.parse(next.startedAt) : opts.runIsTerminal ? opts.lastEventTs : undefined;
    if (endTs === undefined || !Number.isFinite(endTs)) return step;
    const startedMs = Date.parse(step.startedAt);
    if (!Number.isFinite(startedMs) || endTs < startedMs) return step;
    return { ...step, durationMs: endTs - startedMs };
  });
}

/**
 * Merge SQL-aggregated cost / token totals onto the step snapshots
 * produced by `eventsToSteps`. Steps with zero cost events get no
 * `cost` field — the UI uses that to decide whether to render the
 * cost-related badges and the context ring.
 */
export function attachStepAggregates(steps: StepSnapshot[], aggregates: readonly StepCostAggregate[]): StepSnapshot[] {
  const byStartSeq = new Map<number, StepCostAggregate>();
  for (const a of aggregates) byStartSeq.set(a.startSeq, a);
  return steps.map((s) => {
    const agg = byStartSeq.get(s.startSeq);
    if (!agg || agg.costEventCount === 0) return s;
    return {
      ...s,
      cost: {
        input_tokens: agg.inputTokens,
        output_tokens: agg.outputTokens,
        total_tokens: agg.totalTokens,
        cache_read_tokens: agg.cacheReadTokens,
        cache_write_tokens: agg.cacheWriteTokens,
        cost_usd: agg.costUsd,
      },
    };
  });
}

// ── field plucking helpers ──────────────────────────────────────────────
// Tolerant of missing / wrong-typed fields — older event envelopes
// shouldn't break replay.

function assignOptional(step: StepSnapshot, data: Record<string, unknown>): void {
  const provider = stringField(data, "provider");
  if (provider) step.provider = provider;
  const model = stringField(data, "model");
  if (model) step.model = model;
  const fidelity = stringField(data, "fidelity");
  if (fidelity) step.fidelity = fidelity;
  const iteration = iterationField(data, "iteration");
  if (iteration) step.iteration = iteration;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v : "";
}

function iterationField(data: Record<string, unknown>, key: string): { n: number; max: number } | undefined {
  const v = data[key];
  if (!v || typeof v !== "object") return undefined;
  const vv = v as Record<string, unknown>;
  if (typeof vv["n"] !== "number" || typeof vv["max"] !== "number") return undefined;
  return { n: vv["n"] as number, max: vv["max"] as number };
}
