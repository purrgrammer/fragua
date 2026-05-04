// Pure reducer: StoredEvent[] → StepSnapshot[].
//
// A "step" is one `llm.start` event (one backend.run() call). Companion
// events fold onto the step opened at that llm.start until the next
// llm.start for the same nodeId starts a new one:
//   - `cost.recorded`  → DELIBERATELY NOT folded here. Cost / token sums
//                        are aggregated in SQL via
//                        `IEventStore.getStepAggregates()`. The route
//                        merges those aggregates onto these snapshots
//                        keyed by `startSeq`. SQL is the single source
//                        of truth for numerical totals; folding events
//                        in TS quietly mis-counted whenever the window
//                        model didn't match the agent's actual flow.
//
// **Wall-clock anchoring (the timestamp story).** pi-agent-core buffers
// observability events (`llm.start`, `llm.text_delta`, `cost.recorded`,
// …) and flushes them in a single transaction at the end of each LLM
// call. Every flushed event gets the *flush* timestamp, not the
// happen-time. So `llm.start.ts` is closer to "when the call ended"
// than "when it started" — and the durations we'd derive from
// `llm.start → next llm.start` understate node activity by exactly the
// buffered duration. On run 01kq4fp0vvygdwz6hp the 4 codergen steps
// summed to 96s against a 251s run total: 155s missing.
//
// `fact.node_started` and `fact.node_completed` are written by the
// daemon synchronously with the actual transition, so their timestamps
// are truthful. `eventsToSteps` therefore anchors each step's
// `startedAt` to the matching `fact.node_started.ts` (for the first
// iteration of each node window), falling back to `llm.start.ts` for
// loop iterations where we don't have per-iteration node facts. Sum-of-
// step-durations now matches run total within a few seconds of run
// start/teardown overhead.
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
  /** ISO timestamp of when this step's node started running. For the
   * first step in each node window this comes from `fact.node_started`
   * (truthful — written sync by the daemon). For loop iterations 2+
   * inside the same node window we fall back to the (buffered)
   * `llm.start.ts`. */
  startedAt: string;
  /** Wall-clock time the step was the active step. Filled by
   * `fillOrphanDurations` from the next step's `startedAt` or — for the
   * last step on a terminal run — the run's last event timestamp. */
  durationMs?: number;
  // ---- what the agent was asked ----
  provider?: string;
  model?: string;
  fidelity?: string;
  /** Set when this step ran as a branch of a parallel/component fan-out:
   * the parent component's nodeId. Sourced from the matching
   * `fact.node_started.payload.parentNodeId` (the parallel handler
   * attaches it on lifecycle facts, not on `llm.start`). The UI groups
   * branch rows under their parent step. */
  parentNodeId?: string;
  /** Branch index within the parallel parent's `children` list.
   * Populated only for parallel branches. */
  parallelIndex?: number;
  // ---- what came back (populated by `attachStepAggregates`) ----
  cost?: {
    input_tokens: number;
    output_tokens: number;
    billed_tokens?: number;
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
  // nodeId → ts of the most recent `fact.node_started` for that node.
  // Used to override a step's `startedAt` with the truthful node-open
  // timestamp instead of the buffered `llm.start.ts`. See the file
  // header for the wall-clock-anchoring story.
  const lastNodeStartedTs = new Map<string, number>();
  // nodeId → branch metadata last seen on `fact.node_started`. The
  // parallel handler tags only the lifecycle facts with parentNodeId /
  // parallelIndex (not `llm.start`); we stamp them onto the next
  // `llm.start` snapshot for the same nodeId. A top-level re-run of the
  // same id (parentNodeId unset) clears the entry so stale branch
  // metadata never leaks across windows.
  const branchMetaByNode = new Map<string, { parentNodeId: string; parallelIndex?: number }>();
  // nodeIds for which we've already opened the FIRST step of the
  // current node window. The first step uses `fact.node_started.ts`;
  // subsequent loop iterations fall back to `llm.start.ts` (we have no
  // truthful per-iteration boundary). Cleared on each new
  // `fact.node_started`.
  const firstStepEmittedForNode = new Set<string>();

  for (const ev of events) {
    const data = (ev.payload ?? {}) as Record<string, unknown>;
    const nodeId = stringField(data, "nodeId");

    if (ev.type === "fact.node_started") {
      if (nodeId) {
        lastNodeStartedTs.set(nodeId, ev.ts);
        firstStepEmittedForNode.delete(nodeId);
        const parentNodeId = stringField(data, "parentNodeId");
        if (parentNodeId) {
          const piRaw = data["parallelIndex"];
          const meta: { parentNodeId: string; parallelIndex?: number } = { parentNodeId };
          if (typeof piRaw === "number") meta.parallelIndex = piRaw;
          branchMetaByNode.set(nodeId, meta);
        } else {
          branchMetaByNode.delete(nodeId);
        }
      }
      continue;
    }

    if (ev.type === "llm.start") {
      // First step of this node window? Anchor to `fact.node_started.ts`
      // (truthful). Otherwise (loop iteration 2+) fall back to the
      // buffered `llm.start.ts`.
      const isFirstStepForNode = nodeId !== "" && !firstStepEmittedForNode.has(nodeId);
      const startTs =
        isFirstStepForNode && lastNodeStartedTs.has(nodeId) ? (lastNodeStartedTs.get(nodeId) as number) : ev.ts;
      const step: StepSnapshot = {
        stepIdx: steps.length,
        startSeq: ev.seq ?? steps.length,
        nodeId: nodeId || "__unknown",
        startedAt: new Date(startTs).toISOString(),
      };
      assignOptional(step, data);
      const branchMeta = nodeId ? branchMetaByNode.get(nodeId) : undefined;
      if (branchMeta) {
        step.parentNodeId = branchMeta.parentNodeId;
        if (branchMeta.parallelIndex !== undefined) step.parallelIndex = branchMeta.parallelIndex;
      }
      steps.push(step);
      if (nodeId) firstStepEmittedForNode.add(nodeId);
    }
    // No other event types affect step boundaries — `llm.done` was
    // previously consulted to set `durationMs`, but that timestamp is
    // also pi-agent-core-buffered and produced misleading 8ms windows
    // (see file header). `fillOrphanDurations` derives durations from
    // step-to-step boundaries instead.
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
  billedTokens: number;
  costEventCount: number;
}

/**
 * Fill `durationMs` for every step.
 *
 * Each step's end timestamp is the next step's `startedAt` (the moment
 * the agent moved on), with the run's last event timestamp standing in
 * for the final step on a terminal run. Step's start anchors are
 * already truthful (set by `eventsToSteps` from `fact.node_started`),
 * so `endTs - startedAt` is a wall-clock figure that sums to the run
 * total within a few seconds of run-level start/teardown overhead.
 *
 * Returns a new array with new step objects; never mutates inputs.
 */
export function fillOrphanDurations(
  steps: readonly StepSnapshot[],
  opts: { lastEventTs: number | undefined; runIsTerminal: boolean },
): StepSnapshot[] {
  return steps.map((step, i) => {
    const next = steps[i + 1];
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
        billed_tokens: agg.billedTokens,
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
