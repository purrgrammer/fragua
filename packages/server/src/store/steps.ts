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
  /** Additional `llm.start` seqs that fold into this same step — used
   *  when a node is paused (operator / HITL / provider-error / budget /
   *  payment) and resumes without an intervening `fact.node_completed`.
   *  The post-resume `llm.start` belongs conceptually to the same node
   *  activation; collapsing it into one row keeps the Cost breakdown
   *  honest. `attachStepAggregates` folds cost rows for every entry
   *  here onto the surviving step. */
  extraStartSeqs?: number[];
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
  /** Per-invocation discriminator for sub-agent steps: the parent
   *  step's `startSeq` at the moment the sub-agent was spawned. Lets
   *  the Cost-tab consumer group sub-agents under the right parent
   *  invocation when a goal_gate retargets back to a `parentNodeId`
   *  that has already spawned children — without this, the second
   *  invocation's sub-agents pool with the first under the same
   *  `parentNodeId` key. Optional for back-compat with parallel
   *  branches (a parallel parent runs once per node window, no
   *  collision risk). */
  parentStartSeq?: number;
  /** Per-spawn discriminator for sub-agent steps. Populated when the
   *  step's `nodeId` starts with `__subagent:` — sub-agents emit their
   *  events under a synthetic nodeId so they don't conflate with the
   *  parent step's totals in `getStepAggregates`. */
  subagentId?: string;
  /** Short name the calling LLM passed via `agent({ name })`,
   *  surfaced for the UI as a friendly alternative to the raw
   *  `__subagent:<uuid>` nodeId. Empty when the caller didn't supply
   *  one. */
  subagentName?: string;
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
  // subagent_id → { displayName?, parentNodeId, startTs } captured
  // from `subagent.start` events. Drives three pieces of step
  // enrichment:
  //   - `subagentName` for the operator-friendly name in the UI. Pick
  //     the free-form `name` label first, fall back to the resolved
  //     `agent_def` profile name. Either can be present; both can
  //     coexist; the label wins because the caller chose it
  //     specifically for this spawn.
  //   - `parentNodeId` so sub-agent steps render as indented children
  //     under the calling parent step (same path the parallel-branch
  //     UI already uses for fan-out branches).
  //   - `startTs` anchors the sub-agent step's `startedAt` to the
  //     truthful `subagent.start.ts` (daemon parentEmit, sync) instead
  //     of the pi-agent-core-buffered child `llm.start.ts`. Same
  //     story as `fact.node_started` for normal nodes.
  //   - `parentStartSeq` captures the parent step's `startSeq` at
  //     spawn time so the Cost-tab can group sub-agents per parent
  //     invocation rather than per parentNodeId — the bug a
  //     goal_gate-retargeted re-invocation of the same parent node
  //     surfaces.
  const subagentMetaById = new Map<
    string,
    { displayName?: string; parentNodeId?: string; startTs?: number; parentStartSeq?: number }
  >();
  // subagent_id → index of the step opened for that sub-agent's
  // `llm.start`. Lets `subagent.end` (which arrives later, also
  // truthful) stamp `durationMs = end.ts − start.ts` directly onto
  // the row — both endpoints are daemon-written sync, so the wall
  // figure exactly matches what the parent observed.
  const subagentStepIdxById = new Map<string, number>();
  // nodeId → metadata captured on `fact.node_started` for a node
  // that may turn out to be a tool node (parallelogram). If an
  // `llm.start` arrives for the nodeId before its `fact.node_completed`,
  // the entry is cleared (it's a codergen, the existing path handles
  // it). If `fact.node_completed` arrives with the entry still
  // present, we emit a synthetic tool step so tool nodes appear in
  // the Cost breakdown alongside LLM steps — the parallelogram
  // branches in a fan-out are otherwise invisible there. Real
  // duration is `completed.ts − started.ts`; cost stays absent.
  const pendingToolNode = new Map<
    string,
    { startTs: number; startSeq: number; parentNodeId?: string; parallelIndex?: number }
  >();

  for (const ev of events) {
    const data = (ev.payload ?? {}) as Record<string, unknown>;
    const nodeId = stringField(data, "nodeId");

    if (ev.type === "subagent.start") {
      const sid = stringField(data, "subagent_id");
      if (sid) {
        const meta: { displayName?: string; parentNodeId?: string; startTs?: number; parentStartSeq?: number } = {
          startTs: ev.ts,
        };
        const displayName = stringField(data, "name") || stringField(data, "agent_def");
        if (displayName) meta.displayName = displayName;
        const parentNode = stringField(data, "parent_node_id");
        if (parentNode) {
          meta.parentNodeId = parentNode;
          // Snapshot the parent's currently-open step's `startSeq`.
          // The parent's `llm.start` always precedes its toolcall (the
          // `agent({...})` call that triggered this `subagent.start`),
          // so `lastStepIdxForNode.get(parentNode)` resolves to the
          // step the sub-agent should be grouped under. A goal_gate
          // retarget that re-opens the same `parentNode` later will
          // give a fresh `startSeq` to its new step, so subsequent
          // sub-agents key off a different value.
          const parentStepIdx = lastStepIdxForNode.get(parentNode);
          if (parentStepIdx !== undefined) {
            const parentStep = steps[parentStepIdx];
            if (parentStep !== undefined) meta.parentStartSeq = parentStep.startSeq;
          }
        }
        subagentMetaById.set(sid, meta);
      }
      continue;
    }

    if (ev.type === "subagent.end") {
      // Stamp the truthful wall duration onto the sub-agent's step
      // row. `subagent.start` and `subagent.end` are both written
      // synchronously by the daemon's parentEmit, so the delta is
      // the operator-visible runtime of the bracketed slice. The
      // child's own `llm.start` / `llm.done` timestamps are pi-
      // agent-core-buffered (flushed at end-of-call) and collapse
      // to a near-zero delta — that's the '0ms' the Cost tab used
      // to render. `fillOrphanDurations` preserves this value
      // rather than overwriting it from neighbour-step boundaries.
      const sid = stringField(data, "subagent_id");
      if (sid) {
        const stepIdx = subagentStepIdxById.get(sid);
        const meta = subagentMetaById.get(sid);
        if (stepIdx !== undefined && meta?.startTs !== undefined) {
          const target = steps[stepIdx];
          if (target !== undefined) {
            const dur = ev.ts - meta.startTs;
            if (Number.isFinite(dur) && dur >= 0) target.durationMs = dur;
          }
        }
      }
      continue;
    }

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
          const parentNodeId = stringField(data, "parentNodeId");
          const piRaw = data["parallelIndex"];
          const parallelIndex = typeof piRaw === "number" ? piRaw : undefined;
          if (parentNodeId) {
            const meta: { parentNodeId: string; parallelIndex?: number } = { parentNodeId };
            if (parallelIndex !== undefined) meta.parallelIndex = parallelIndex;
            branchMetaByNode.set(nodeId, meta);
          } else {
            branchMetaByNode.delete(nodeId);
          }
          // Mark this node as a potential tool step. If an `llm.start`
          // arrives before completion, this entry is cleared (it's a
          // codergen and the existing path opens a real step for it).
          // Otherwise we emit a tool step at completion.
          const pending: { startTs: number; startSeq: number; parentNodeId?: string; parallelIndex?: number } = {
            startTs: ev.ts,
            startSeq: ev.seq ?? steps.length,
          };
          if (parentNodeId) pending.parentNodeId = parentNodeId;
          if (parallelIndex !== undefined) pending.parallelIndex = parallelIndex;
          pendingToolNode.set(nodeId, pending);
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
          if (Number.isFinite(dur) && dur >= 0) step.durationMs = dur;
          if (pending.parentNodeId !== undefined) step.parentNodeId = pending.parentNodeId;
          if (pending.parallelIndex !== undefined) step.parallelIndex = pending.parallelIndex;
          steps.push(step);
          lastStepIdxForNode.set(nodeId, steps.length - 1);
          pendingToolNode.delete(nodeId);
        }
      }
      continue;
    }

    if (ev.type === "fact.run_paused" || ev.type === "fact.run_paused_hitl") {
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
      // This node opened an LLM call — it's a codergen, not a tool
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
      assignOptional(step, data);
      const branchMeta = nodeId ? branchMetaByNode.get(nodeId) : undefined;
      if (branchMeta) {
        step.parentNodeId = branchMeta.parentNodeId;
        if (branchMeta.parallelIndex !== undefined) step.parallelIndex = branchMeta.parallelIndex;
      }
      // Sub-agent steps: the `__subagent:<id>` nodeId is a synthetic
      // namespace (chosen so the SQL aggregator doesn't conflate
      // sub-agent cost with the parent's calling node). Stamp the
      // discriminator + the operator-friendly label so the UI can
      // render `agent · <label>` in place of the raw uuid, and stamp
      // `parentNodeId` so the sub-agent row renders as an indented
      // child under the calling parent step (same path the parallel
      // branch UI already uses).
      const SUBAGENT_PREFIX = "__subagent:";
      if (step.nodeId.startsWith(SUBAGENT_PREFIX)) {
        const sid = step.nodeId.slice(SUBAGENT_PREFIX.length);
        step.subagentId = sid;
        const meta = subagentMetaById.get(sid);
        if (meta?.displayName) step.subagentName = meta.displayName;
        if (meta?.parentNodeId) step.parentNodeId = meta.parentNodeId;
        if (meta?.parentStartSeq !== undefined) step.parentStartSeq = meta.parentStartSeq;
        // Override the buffered `llm.start.ts` anchor with the
        // truthful `subagent.start.ts` so the row's `startedAt`
        // matches what the operator observed. The `subagent.end`
        // handler later stamps `durationMs` against this same
        // anchor.
        if (meta?.startTs !== undefined) step.startedAt = new Date(meta.startTs).toISOString();
        subagentStepIdxById.set(sid, steps.length);
      }
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
    // Sub-agent rows already carry a truthful `durationMs` stamped
    // by `eventsToSteps` from `subagent.end.ts − subagent.start.ts`
    // (both daemon-written sync). Don't overwrite it from
    // neighbour-step boundaries — those boundaries come from
    // pi-agent-core-buffered `llm.start.ts` values that flush
    // back-to-back at end-of-call and produce a meaningless near-
    // zero delta.
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
