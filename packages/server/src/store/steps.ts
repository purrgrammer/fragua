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
// buffered duration. On run 01kq4fp0vvygdwz6hp the 4 llm steps
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
  runId?: string;
  originRunId?: string;
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
  /** Run that wrote the step, so UI keys never collide across per-run
   * `seq` spaces. */
  originRunId?: string;
  /** Additional `llm.start` seqs that fold into this same step — used
   *  when a node is paused (operator / HITL / provider-error / budget /
   *  payment) and resumes without an intervening `fact.node_completed`.
   *  The post-resume `llm.start` belongs conceptually to the same node
   *  activation; collapsing it into one row keeps the Cost breakdown
   *  honest. `attachStepAggregates` folds cost rows for every entry
   *  here onto the surviving step. */
  extraStartSeqs?: number[];
  /** Real workflow node id (or a synthetic id for summariser steps). */
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
  summary?: string;
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
  // nodeIds for which we've already opened the FIRST step of the
  // current node window. The first step uses `fact.node_started.ts`;
  // subsequent loop iterations fall back to `llm.start.ts` (we have no
  // truthful per-iteration boundary). Cleared on each new
  // `fact.node_started`, except when the prior pause is operator-class
  // (see `pendingResumeFold` below) — the resume re-emits
  // `fact.node_started` for the same nodeId but the step window
  // didn't close.
  const firstStepEmittedForNode = new Set<string>();
  // nodeIds that were paused without an intervening `fact.node_completed`
  // (operator / HITL / provider-error / budget / payment_required). The
  // post-resume `fact.node_started` for such a node should NOT open a
  // fresh step — the next `llm.start` for that node folds into the
  // existing step's `extraStartSeqs` so the Cost breakdown shows one
  // unified row. Cleared by `fact.node_completed` (real window close).
  const pausedOpenNodes = new Set<string>();
  // nodeIds whose next `llm.start` should fold into their existing
  // step rather than open a new one. Set when a `fact.node_started`
  // arrives for a node that's in `pausedOpenNodes`; cleared after the
  // fold so subsequent normal events behave as usual. Maps nodeId →
  // index into `steps` to fold into.
  const pendingResumeFold = new Map<string, number>();
  // nodeId → index of the most recent step opened for that nodeId.
  // Used to find the fold target when resuming.
  const lastStepIdxForNode = new Map<string, number>();
  // nodeId → metadata captured on `fact.node_started` for a node
  // that may turn out to be a tool node (tool node). If an
  // `llm.start` arrives for the nodeId before its `fact.node_completed`,
  // the entry is cleared (it's a llm, the existing path handles
  // it). If `fact.node_completed` arrives with the entry still
  // present, we emit a synthetic tool step so tool nodes appear in
  // the Cost breakdown alongside LLM steps — tool nodes are
  // otherwise invisible there. Real duration is
  // `completed.ts − started.ts`; cost stays absent.
  const pendingToolNode = new Map<string, { startTs: number; startSeq: number }>();

  for (const ev of events) {
    const data = (ev.payload ?? {}) as Record<string, unknown>;
    const nodeId = stringField(data, "nodeId");

    if (ev.type === "fact.node_started") {
      if (nodeId) {
        // Resumption-after-pause: the node window never closed (no
        // `fact.node_completed`), so don't reset its anchors — mark
        // the next `llm.start` for this node to fold into the
        // existing step instead of opening a new one.
        const isResumeFold = pausedOpenNodes.has(nodeId) && lastStepIdxForNode.has(nodeId);
        if (isResumeFold) {
          pendingResumeFold.set(nodeId, lastStepIdxForNode.get(nodeId) as number);
          pausedOpenNodes.delete(nodeId);
        } else {
          lastNodeStartedTs.set(nodeId, ev.ts);
          firstStepEmittedForNode.delete(nodeId);
          // Mark this node as a potential tool step. If an `llm.start`
          // arrives before completion, this entry is cleared (it's a
          // llm and the existing path opens a real step for it).
          // Otherwise we emit a tool step at completion.
          pendingToolNode.set(nodeId, {
            startTs: ev.ts,
            startSeq: ev.seq ?? steps.length,
          });
        }
      }
      continue;
    }

    if (ev.type === "fact.node_completed") {
      // Real window close: any pending fold for this node is moot.
      if (nodeId) {
        pausedOpenNodes.delete(nodeId);
        pendingResumeFold.delete(nodeId);
        const pending = pendingToolNode.get(nodeId);
        if (pending !== undefined) {
          // Tool node — no `llm.start` ever opened a step for this
          // window. Synthesise one from the lifecycle facts. Real
          // duration (both endpoints are daemon-written sync); no
          // cost (no LLM call → no `cost.recorded` events).
          const dur = ev.ts - pending.startTs;
          const step: StepSnapshot = {
            stepIdx: steps.length,
            startSeq: pending.startSeq,
            nodeId,
            startedAt: new Date(pending.startTs).toISOString(),
          };
          const originRunId = ev.originRunId ?? ev.runId;
          if (originRunId) step.originRunId = originRunId;
          if (Number.isFinite(dur) && dur >= 0) step.durationMs = dur;
          steps.push(step);
          lastStepIdxForNode.set(nodeId, steps.length - 1);
          pendingToolNode.delete(nodeId);
        }
      }
      continue;
    }

    if (ev.type === "fact.run_paused" || ev.type === "fact.run_paused_human") {
      // Pauses (operator / HITL / provider_error / payment_required /
      // budget / provider_retry / handler_retry) do NOT emit
      // `fact.node_completed`, so the node window stays open across
      // the pause. The resume re-emits `fact.node_started` for the
      // same nodeId; we want both halves to fold into a single
      // Cost-breakdown row.
      const pausedNodeId = stringField(data, "nodeId");
      if (pausedNodeId) pausedOpenNodes.add(pausedNodeId);
      continue;
    }

    if (ev.type === "llm.start") {
      // This node opened an LLM call — it's a llm, not a tool
      // node. Clear any pending tool-step entry so we don't emit a
      // duplicate row at fact.node_completed time.
      if (nodeId !== "") pendingToolNode.delete(nodeId);
      // Resume-fold: a paused node has just re-emitted `fact.node_started`
      // and this is its post-resume `llm.start`. Append its seq to the
      // existing step's `extraStartSeqs` so SQL aggregates from both
      // halves fold onto one row, and skip pushing a new snapshot.
      const foldIdx = nodeId !== "" ? pendingResumeFold.get(nodeId) : undefined;
      if (foldIdx !== undefined) {
        const target = steps[foldIdx];
        if (target !== undefined) {
          const seq = ev.seq;
          if (typeof seq === "number") {
            const extras = target.extraStartSeqs ?? [];
            extras.push(seq);
            target.extraStartSeqs = extras;
          }
        }
        pendingResumeFold.delete(nodeId);
        continue;
      }

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
      const originRunId = ev.originRunId ?? ev.runId;
      if (originRunId) step.originRunId = originRunId;
      assignOptional(step, data);
      steps.push(step);
      if (nodeId) {
        firstStepEmittedForNode.add(nodeId);
        lastStepIdxForNode.set(nodeId, steps.length - 1);
      }
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
 * shaped here to avoid a hard dependency on `@fragua/store` types in the
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
    // A row that already carries a truthful `durationMs` (e.g. a tool
    // step synthesised from `fact.node_started`/`fact.node_completed`)
    // keeps it — don't overwrite from neighbour-step boundaries.
    if (step.durationMs !== undefined) return step;
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
    // Pause/resume coalesces multiple `llm.start` halves into one
    // step; sum the SQL aggregates across every seq that belongs to
    // this step so the row's cost reflects the entire node activation.
    const seqs = [s.startSeq, ...(s.extraStartSeqs ?? [])];
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let billedTokens = 0;
    let costEventCount = 0;
    for (const seq of seqs) {
      const agg = byStartSeq.get(seq);
      if (!agg) continue;
      costUsd += agg.costUsd;
      inputTokens += agg.inputTokens;
      outputTokens += agg.outputTokens;
      cacheReadTokens += agg.cacheReadTokens;
      cacheWriteTokens += agg.cacheWriteTokens;
      billedTokens += agg.billedTokens;
      costEventCount += agg.costEventCount;
    }
    if (costEventCount === 0) return s;
    return {
      ...s,
      cost: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        billed_tokens: billedTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        cost_usd: costUsd,
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
  const summary = stringField(data, "summary");
  if (summary) step.summary = summary;
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
