// The linear per-turn dispatch driver — `dispatchOne` and its commit arms,
// lifted out of `runOneInner`'s closure into top-level functions over the
// explicit `RunDeps` + `RunTurnState` records. Behaviour is byte-identical to
// the prior inline implementation. This file does store I/O (on IO_ALLOWED).
//
// ARCHITECTURE.md §6.1.

import {
  evaluateBudget,
  GRAPH_GOAL_KEY,
  getInputs,
  getLimits,
  PAUSE_AFTER_DISPATCH_KEY,
  PENDING_STEER_KEY,
  PENDING_STEER_MAX_BYTES,
  readGoalGateRetries,
  readPauseAfterDispatch,
  readPendingSteer,
  utf8Truncate,
} from "@fragua/core";
import * as core from "@fragua/core/handler";
import {
  EVENT_CONTRACT_VERSION,
  type FactEvent,
  MIN_COMPATIBLE_CONTRACT_VERSION,
  materializeRouting,
  type RunState,
} from "@fragua/store";
import { planAbort, planAbortLoop } from "./abort-planner.ts";
import type { TitleRequest } from "./auto-titler.ts";
import {
  buildDispatchContext,
  graphFor,
  invalidateOutputsCacheIf,
  type ObservabilitySink,
  type RunDeps,
  type UsageAccumulator,
} from "./dispatch-wiring.ts";
import {
  classifyAbortCause,
  deriveResumeOf,
  errorMessage,
  nodeRetryCount,
  passField,
  readBudgetOverrides,
  readBudgetWarned,
  routingString,
} from "./executor-helpers.ts";
import { runFanout } from "./fanout.ts";
import { invokeHandler } from "./invoke-handler.ts";
import { commitParkOrTerminal, commitWithOcc, type DispatchOutcome, occAppendOnce } from "./occ-append.ts";
import { planLeakHalt, planPreDispatch } from "./predispatch-planner.ts";
import { cancelToFacts } from "./result-to-facts.ts";
import { countDispatch, type RunTurnState, recordAbort, resetAborts } from "./run-turn-state.ts";
import { captureBoundarySnapshot } from "./snapshot-service.ts";
import { computeAdvanceAppliedTo, planTransition } from "./transition-planner.ts";

type HandlerResult = core.HandlerResult;
type ProceedDecision = Extract<core.IntentDecision, { kind: "proceed" }>;

/** Statuses on which the turn ends immediately (the run stopped progressing on
 * its own). */
const TERMINAL_OR_PAUSED = new Set<string>([
  "completed",
  "cancelled",
  "halted",
  "paused",
  "paused_human",
  "paused_auto",
  "quarantined",
]);

const CONTRACT_WINDOW = { min: MIN_COMPATIBLE_CONTRACT_VERSION, max: EVENT_CONTRACT_VERSION };

/** One dispatch turn: fold intents, apply the pre-handler gates, then dispatch
 * the handler (or delegate to the fan-out region). Returns the turn outcome and
 * the (mutated) turn state. */
export async function dispatchOne(
  deps: RunDeps,
  ts: RunTurnState,
): Promise<{ outcome: DispatchOutcome; state: RunTurnState }> {
  const outcome = await dispatchTurn(deps, ts);
  return { outcome, state: ts };
}

async function dispatchTurn(deps: RunDeps, ts: RunTurnState): Promise<DispatchOutcome> {
  const opts = deps.opts;
  const runState = opts.store.getState(deps.runId);
  if (runState == null) return { kind: "terminal" };
  if (TERMINAL_OR_PAUSED.has(runState.status)) return { kind: "terminal" };

  const entry = await applyEntryGate(deps, ts, runState);
  if (entry !== undefined) return entry;

  const unapplied = opts.store.getUnappliedIntents(deps.runId);
  const decision = core.foldIntents(unapplied, runState.status);
  if (decision.dropped.length > 0) {
    opts.store.appendObservabilityEvents(
      deps.runId,
      decision.dropped.map((d) => ({
        type: "intent.dropped",
        payload: { originalSeq: d.seq, originalType: d.type, reason: d.reason },
      })),
    );
  }
  if (decision.kind === "cancel") return commitCancel(deps, runState, decision);

  const effectiveRouting = buildEffectiveRouting(deps, runState, decision);
  if (decision.shouldPause) return commitPause(deps, runState, decision);

  const currentNode = runState.currentNode;
  const needsStart = runState.currentNode == null && (runState.status === "queued" || runState.status === "running");

  const provisioned = await ensureRunEnv(deps, ts, runState);
  if (provisioned !== undefined) return provisioned;

  if (needsStart) return startRun(deps, ts, runState, decision, effectiveRouting);
  if (currentNode == null) return { kind: "terminal" };

  const deferredPause = readPauseAfterDispatch(effectiveRouting);
  if (graphFor(deps, ts, runState.workflowSha)?.nodes[currentNode]?.type === "parallel") {
    return runFanout(deps, ts, runState, decision, currentNode, effectiveRouting, deferredPause);
  }

  const marker = await commitDispatchMarker(deps, runState, currentNode);
  if (marker !== undefined) return marker;

  const loop = await applyLoopGate(deps, ts, runState, currentNode, effectiveRouting);
  if (loop !== undefined) return loop;
  countDispatch(ts);

  return dispatchHandler(deps, ts, runState, decision, currentNode, effectiveRouting, deferredPause);
}

/** The contract-version gate + unparseable-workflow refusal, decided by the pure
 * pre-dispatch planner. Returns an outcome when the entry gate terminalises the
 * turn, else undefined to proceed. */
async function applyEntryGate(
  deps: RunDeps,
  ts: RunTurnState,
  runState: RunState,
): Promise<DispatchOutcome | undefined> {
  const workflowSha = runState.workflowSha;
  if (workflowSha != null) graphFor(deps, ts, workflowSha);
  const entryGate = planPreDispatch({
    state: runState,
    contractWindow: CONTRACT_WINDOW,
    ...(ts.workflowUnparseable ? { graphParseError: ts.workflowParseError ?? "" } : {}),
    dispatches: 0,
    effectiveMaxLoops: Number.POSITIVE_INFINITY,
  });
  if (!entryGate.terminal) return undefined;
  return commitParkOrTerminal(
    {
      store: deps.opts.store,
      runId: deps.runId,
      occ: deps.occ,
      nodeId: runState.currentNode ?? "",
      iteration: nodeRetryCount(runState.routing, runState.currentNode ?? ""),
      expectedVersion: runState.version,
    },
    entryGate.facts,
  );
}

/** Effective routing for this turn: the projection view merged with the fold's
 * routing delta, with any `$fragua_blob` inputs materialized. */
function buildEffectiveRouting(
  deps: RunDeps,
  runState: RunState,
  decision: ProceedDecision,
): Readonly<Record<string, unknown>> {
  const rawEffectiveRouting: Readonly<Record<string, unknown>> =
    Object.keys(decision.routingDelta).length > 0
      ? { ...runState.routing, ...decision.routingDelta }
      : runState.routing;
  return materializeRouting(rawEffectiveRouting as Record<string, unknown>, (sha) => {
    const bytes = deps.opts.store.readBlob(sha);
    if (bytes == null) throw new Error(`routing blob missing: ${sha}`);
    return bytes;
  });
}

async function commitCancel(
  deps: RunDeps,
  runState: RunState,
  decision: Extract<core.IntentDecision, { kind: "cancel" }>,
): Promise<DispatchOutcome> {
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: runState.currentNode ?? "",
      iteration: nodeRetryCount(runState.routing, runState.currentNode ?? ""),
      expectedVersion: runState.version,
      attemptedFactType: "fact.run_terminated",
      commit: occAppendOnce(deps.opts.store, deps.runId, runState.version),
      successOutcome: { kind: "terminal" },
      statusOutcome: { kind: "terminal" },
    },
    cancelToFacts(decision.intentSeq),
  );
}

async function commitPause(deps: RunDeps, runState: RunState, decision: ProceedDecision): Promise<DispatchOutcome> {
  const advanceAppliedTo = computeAdvanceAppliedTo(decision.appliedSeqs);
  const appendOpts = advanceAppliedTo !== undefined ? { advanceAppliedTo } : undefined;
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: runState.currentNode ?? "",
      iteration: nodeRetryCount(runState.routing, runState.currentNode ?? ""),
      expectedVersion: runState.version,
      attemptedFactType: "fact.run_paused",
      commit: occAppendOnce(deps.opts.store, deps.runId, runState.version, appendOpts),
      successOutcome: { kind: "terminal" },
      statusOutcome: { kind: "terminal" },
    },
    [{ type: "fact.run_paused", payload: { reason: "operator", nodeId: runState.currentNode ?? "" } }],
  );
}

/** Provision the run's worktree before the first `fact.run_started`. Returns an
 * outcome on provision failure, else undefined (env cached on `ts.runEnv`). */
async function ensureRunEnv(deps: RunDeps, ts: RunTurnState, runState: RunState): Promise<DispatchOutcome | undefined> {
  const opts = deps.opts;
  if (!(opts.provisioner && ts.runEnv === undefined)) return undefined;
  try {
    const provisionOpts: { cwd?: string; baseRef?: string } = {};
    if (runState.cwd != null) provisionOpts.cwd = runState.cwd;
    if (runState.baseGitSha != null) provisionOpts.baseRef = runState.baseGitSha;
    const alreadyProvisioned = opts.provisioner.envFor(deps.runId) !== undefined;
    ts.runEnv = await opts.provisioner.ensure(deps.runId, provisionOpts);
    if (!alreadyProvisioned) {
      opts.store.appendDaemonEvent(
        { type: "daemon.worktree_provisioned", payload: { runId: deps.runId, ok: true } },
        { runId: deps.runId },
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.store.appendDaemonEvent(
      { type: "daemon.worktree_provisioned", payload: { runId: deps.runId, ok: false, errorDetail: detail } },
      { runId: deps.runId },
    );
    const worktreeHalt = planPreDispatch({
      state: runState,
      contractWindow: CONTRACT_WINDOW,
      worktreeError: detail,
      dispatches: 0,
      effectiveMaxLoops: Number.POSITIVE_INFINITY,
    });
    return commitParkOrTerminal(
      {
        store: opts.store,
        runId: deps.runId,
        occ: deps.occ,
        nodeId: runState.currentNode ?? "",
        iteration: nodeRetryCount(runState.routing, runState.currentNode ?? ""),
        expectedVersion: runState.version,
      },
      worktreeHalt.facts,
    );
  }
  return undefined;
}

/** Emit `fact.run_started` on the just-claimed run, seeding graph-goal / steer /
 * deferred-pause routing and firing the auto-titler once. */
async function startRun(
  deps: RunDeps,
  ts: RunTurnState,
  runState: RunState,
  decision: ProceedDecision,
  effectiveRouting: Readonly<Record<string, unknown>>,
): Promise<DispatchOutcome> {
  const opts = deps.opts;
  const workflowSha = runState.workflowSha;
  const start = routingString(runState.routing, "start_node") ?? "start";
  const baseGitSha = runState.baseGitSha ?? opts.provisioner?.baseGitSha(deps.runId) ?? undefined;
  const baseGitRef = runState.baseGitRef ?? opts.provisioner?.baseGitRef(deps.runId) ?? undefined;
  const startFacts: FactEvent[] = [
    {
      type: "fact.run_started",
      payload: {
        workflowSha: runState.workflowSha,
        contractVersion: runState.contractVersion,
        startNode: start,
        ...(baseGitSha != null ? { baseGitSha } : {}),
        ...(baseGitRef != null ? { baseGitRef } : {}),
      },
    },
  ];
  const startGraph = graphFor(deps, ts, runState.workflowSha);
  const startRoutingPatch: Record<string, unknown> = { ...decision.routingDelta };
  if (typeof startGraph?.attrs.goal === "string" && startGraph.attrs.goal !== "")
    startRoutingPatch[GRAPH_GOAL_KEY] = startGraph.attrs.goal;
  if (decision.steering !== undefined && decision.steering.length > 0) {
    startRoutingPatch[PENDING_STEER_KEY] = utf8Truncate(decision.steering, PENDING_STEER_MAX_BYTES);
  }
  if (decision.shouldPauseAfterDispatch) startRoutingPatch[PAUSE_AFTER_DISPATCH_KEY] = true;
  const startAdvanceTo = computeAdvanceAppliedTo(decision.appliedSeqs);
  const startAppendOpts: { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number } = {};
  if (Object.keys(startRoutingPatch).length > 0) startAppendOpts.routingPatch = startRoutingPatch;
  if (startAdvanceTo !== undefined) startAppendOpts.advanceAppliedTo = startAdvanceTo;
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: start,
      iteration: 0,
      expectedVersion: runState.version,
      attemptedFactType: "fact.run_started",
      commit: occAppendOnce(opts.store, deps.runId, runState.version, startAppendOpts),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
      onSuccess: () => {
        deps.occ.onResolved(start, 0);
        if (opts.autoTitler && runState.title == null) {
          const graph = graphFor(deps, ts, workflowSha);
          const goal = graph?.attrs.goal;
          const inputLines = Object.entries(getInputs(effectiveRouting))
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join("\n");
          const wf = workflowSha != null ? opts.store.getWorkflow(workflowSha) : null;
          const workflowName = wf?.name;
          const parts: string[] = [];
          if (workflowName !== undefined) parts.push(`workflow=${workflowName}`);
          if (inputLines !== "") parts.push(inputLines);
          const seed = parts.join("\n");
          const req: TitleRequest = { runId: deps.runId, workflowSha, input: seed };
          if (goal !== undefined) req.goal = goal;
          if (workflowName !== undefined) req.workflowName = workflowName;
          opts.autoTitler.titleRun(req);
        }
      },
    },
    startFacts,
  );
}

/** Stamp `fact.dispatch_started` when the projection's `dispatchStartedAt` was
 * reset by a prior terminal/pause fact. Returns an outcome (the marker turn), or
 * undefined when the marker is already set (proceed to dispatch). */
async function commitDispatchMarker(
  deps: RunDeps,
  runState: RunState,
  currentNode: string,
): Promise<DispatchOutcome | undefined> {
  if (runState.dispatchStartedAt != null) return undefined;
  const opts = deps.opts;
  const dispatchIteration = nodeRetryCount(runState.routing, currentNode);
  const dispatchPass = readGoalGateRetries(runState.routing);
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: currentNode,
      iteration: dispatchIteration,
      expectedVersion: runState.version,
      attemptedFactType: "fact.dispatch_started",
      commit: occAppendOnce(opts.store, deps.runId, runState.version),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
      onSuccess: () => {
        deps.occ.onResolved(currentNode, dispatchIteration);
      },
    },
    [
      {
        type: "fact.dispatch_started",
        payload: {
          nodeId: currentNode,
          iteration: dispatchIteration,
          ...passField(dispatchPass),
          resumeOf: deriveResumeOf(opts.store, deps.runId),
        },
      },
    ],
  );
}

/** Production ceiling on handler dispatches. Returns an outcome when the ceiling
 * halts the run, else undefined (caller counts the dispatch and proceeds). */
async function applyLoopGate(
  deps: RunDeps,
  ts: RunTurnState,
  runState: RunState,
  currentNode: string,
  effectiveRouting: Readonly<Record<string, unknown>>,
): Promise<DispatchOutcome | undefined> {
  const effectiveMaxLoops = getLimits(effectiveRouting).maxLoops || deps.maxLoops;
  const loopGate = planPreDispatch({
    state: runState,
    contractWindow: CONTRACT_WINDOW,
    dispatches: ts.dispatches,
    effectiveMaxLoops,
  });
  if (!loopGate.terminal) return undefined;
  return commitParkOrTerminal(
    {
      store: deps.opts.store,
      runId: deps.runId,
      occ: deps.occ,
      nodeId: currentNode,
      iteration: nodeRetryCount(runState.routing, currentNode),
      expectedVersion: runState.version,
    },
    loopGate.facts,
  );
}

type ReactiveBudgetPause = { scope: "run" | "node"; metric: "cost" | "tokens"; limit: number; actual: number };

/** Wire and invoke the handler, classify the outcome (leak / abort / result),
 * and commit through the appropriate arm. */
async function dispatchHandler(
  deps: RunDeps,
  ts: RunTurnState,
  runState: RunState,
  decision: ProceedDecision,
  currentNode: string,
  effectiveRouting: Readonly<Record<string, unknown>>,
  deferredPause: boolean,
): Promise<DispatchOutcome> {
  const opts = deps.opts;
  const spec = opts.dispatcher.get(runState.workflowSha, currentNode);
  const graph = graphFor(deps, ts, runState.workflowSha);
  const nodeAttrs = graph?.nodes[currentNode]?.attrs;
  const iteration = nodeRetryCount(runState.routing, currentNode);

  let reactiveBudgetHaltDetail: string | undefined;
  let reactiveBudgetPauseBreach: ReactiveBudgetPause | undefined;

  const built = buildDispatchContext({
    deps,
    state: ts,
    nodeId: currentNode,
    iteration,
    routing: effectiveRouting,
    spec,
    graph,
    nodeAttrs,
    initialVersion: runState.version,
    obsLabel: "linear",
    onCostRecorded: (payload, w) => {
      w.usage.mirrorCostRecorded(payload);
      if (reactiveBudgetHaltDetail !== undefined || reactiveBudgetPauseBreach !== undefined) return;
      const completedNodeAttrs = graph?.nodes[currentNode]?.attrs;
      const priorNodeBucket = runState.metrics.nodeCosts[currentNode] ?? { tokens: 0, costUsd: 0 };
      const priorRunFresh = runState.metrics.totalInputTokens + runState.metrics.totalOutputTokens;
      const turn = w.usage.totals();
      const overrides = readBudgetOverrides(effectiveRouting);
      const reactive = evaluateBudget({
        graphAttrs: graph?.attrs ?? {},
        ...(completedNodeAttrs !== undefined ? { completedNodeAttrs } : {}),
        completedNodeId: currentNode,
        cumulativeCostUsd: runState.metrics.totalCostUsd + turn.totalCostUsd,
        cumulativeTokens: priorRunFresh + turn.turnBilled,
        nodeCumulativeCostUsd: priorNodeBucket.costUsd + turn.totalCostUsd,
        nodeCumulativeTokens: priorNodeBucket.tokens + turn.turnBilled,
        alreadyWarned: readBudgetWarned(effectiveRouting),
        ...(overrides !== undefined ? { overrides } : {}),
      });
      if (reactive.shouldHalt) {
        reactiveBudgetHaltDetail = reactive.haltReason ?? "";
        for (const ev of reactive.events)
          w.obs.push({ type: ev.type, payload: { nodeId: currentNode, iteration, ...ev.payload } });
        w.steerCtrl.abort(new Error("budget"));
      } else if (reactive.pauseBreach !== undefined) {
        reactiveBudgetPauseBreach = reactive.pauseBreach;
        for (const ev of reactive.events)
          w.obs.push({ type: ev.type, payload: { nodeId: currentNode, iteration, ...ev.payload } });
        w.steerCtrl.abort(new Error("budget_pause"));
      }
    },
  });
  const { steerCtrl, signal, releaseSignal, deadlines, recorder, obs, usage, ctxOpts } = built;
  if (decision.humanInput !== undefined) ctxOpts.humanInput = decision.humanInput;
  const pendingSteer = readPendingSteer(effectiveRouting);
  const mergedSteer = [pendingSteer, decision.steering].filter((s): s is string => s != null && s.length > 0);
  if (mergedSteer.length > 0) ctxOpts.steering = mergedSteer.join("\n");
  applyBudgetSnapshot(ctxOpts, runState, graph, nodeAttrs, effectiveRouting);
  const ctx = core.buildHandlerContext(ctxOpts);

  const invocation = await invokeHandlerFor(deps, spec, ctx, steerCtrl);
  for (const disarm of deadlines) disarm();
  if (invocation.kind !== "leak") releaseSignal();

  let result: HandlerResult;
  let wasAborted = false;
  let abortCause: "timeout" | "aborted" = "aborted";
  let leakedTimeout = false;
  if (invocation.kind === "leak") {
    leakedTimeout = true;
    result = { kind: "halt", reason: "error", detail: "timeout_leaked" };
  } else if (invocation.kind === "thrown") {
    wasAborted = invocation.abortByName;
    if (
      !wasAborted &&
      signal.aborted &&
      (reactiveBudgetHaltDetail !== undefined || reactiveBudgetPauseBreach !== undefined)
    ) {
      wasAborted = true;
    }
    if (wasAborted) abortCause = classifyAbortCause(signal, invocation.error);
    result = { kind: "halt", reason: "error", detail: errorMessage(invocation.error) };
  } else {
    result = invocation.result;
  }

  if (leakedTimeout) {
    obs.flush();
    return commitLeak(deps, currentNode, iteration, recorder);
  }
  if (wasAborted) {
    obs.flush();
    return commitAbort(deps, ts, runState, decision, {
      currentNode,
      iteration,
      abortCause,
      reactiveBudgetHaltDetail,
      reactiveBudgetPauseBreach,
      usage,
      effectiveRouting,
      spec,
      recorder,
    });
  }
  resetAborts(ts);
  return commitTransition(deps, ts, runState, decision, {
    currentNode,
    iteration,
    result,
    usage,
    effectiveRouting,
    deferredPause,
    obs,
    recorder,
  });
}

/** The budget snapshot the backend embeds into `llm.start.budget`. */
function applyBudgetSnapshot(
  ctxOpts: core.BuildContextOpts,
  runState: RunState,
  graph: ReturnType<typeof graphFor>,
  nodeAttrs: { max_cost_usd?: unknown } | undefined,
  effectiveRouting: Readonly<Record<string, unknown>>,
): void {
  const budgetSnapshotOverrides = readBudgetOverrides(effectiveRouting);
  const runMaxCostUsd = budgetSnapshotOverrides?.run?.cost ?? graph?.attrs.budget_usd;
  const nodeMaxCostUsd = budgetSnapshotOverrides?.node?.cost ?? (nodeAttrs?.max_cost_usd as number | undefined);
  if (typeof runMaxCostUsd !== "number" && typeof nodeMaxCostUsd !== "number") return;
  const snap: core.BudgetSnapshotInput = {
    cumulative_cost_usd: runState.metrics.totalCostUsd,
    cumulative_tokens: runState.metrics.totalInputTokens + runState.metrics.totalOutputTokens,
  };
  if (typeof runMaxCostUsd === "number") snap.run_max_cost_usd = runMaxCostUsd;
  if (typeof nodeMaxCostUsd === "number") snap.max_cost_usd = nodeMaxCostUsd;
  ctxOpts.budgetSnapshot = snap;
}

async function invokeHandlerFor(
  deps: RunDeps,
  spec: core.HandlerSpec,
  ctx: core.HandlerContext,
  steerCtrl: AbortController,
): ReturnType<typeof invokeHandler> {
  return invokeHandler({
    spec,
    ctx,
    registry: deps.opts.registry,
    runId: deps.runId,
    steerCtrl,
    leakGraceMs: deps.leakGrace,
  });
}

/** Leak arm: halt the run (leaked handler is unrecoverable) and bump the leak
 * budget. */
async function commitLeak(
  deps: RunDeps,
  currentNode: string,
  iteration: number,
  recorder: { version: () => number },
): Promise<DispatchOutcome> {
  const leakHalt = planLeakHalt({ nodeId: currentNode, leakedAt: deps.clock() });
  const leakOutcome = await commitParkOrTerminal(
    {
      store: deps.opts.store,
      runId: deps.runId,
      occ: deps.occ,
      nodeId: currentNode,
      iteration,
      expectedVersion: recorder.version(),
    },
    leakHalt.facts,
  );
  deps.leakBudget.recordLeak(deps.runId, currentNode);
  return leakOutcome;
}

interface AbortArgs {
  currentNode: string;
  iteration: number;
  abortCause: "timeout" | "aborted";
  reactiveBudgetHaltDetail: string | undefined;
  reactiveBudgetPauseBreach: ReactiveBudgetPause | undefined;
  usage: UsageAccumulator;
  effectiveRouting: Readonly<Record<string, unknown>>;
  spec: core.HandlerSpec;
  recorder: { version: () => number };
}

/** Abort arm: the pure plan (reactive-budget halt/pause, timeout-retry/exhausted,
 * or a plain abort) applied under OCC, with the abort-loop trend-warn / ceiling. */
async function commitAbort(
  deps: RunDeps,
  ts: RunTurnState,
  runState: RunState,
  decision: ProceedDecision,
  a: AbortArgs,
): Promise<DispatchOutcome> {
  const opts = deps.opts;
  const { currentNode, iteration, recorder } = a;
  const abortPlan = planAbort({
    currentNode,
    iteration,
    abortCause: a.abortCause,
    reactiveBudgetHaltDetail: a.reactiveBudgetHaltDetail,
    reactiveBudgetPauseBreach: a.reactiveBudgetPauseBreach,
    usage: a.usage.totals(),
    routingDelta: decision.routingDelta,
    appliedSeqs: decision.appliedSeqs,
    effectiveRouting: a.effectiveRouting,
    now: deps.clock(),
    attemptedMs: a.spec.maxMs ?? 0,
  });
  const abortAppendOpts: { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number } = {};
  if (abortPlan.routingPatch !== undefined) abortAppendOpts.routingPatch = abortPlan.routingPatch;
  if (abortPlan.advanceAppliedTo !== undefined) abortAppendOpts.advanceAppliedTo = abortPlan.advanceAppliedTo;

  if (abortPlan.outcome === "timeout_retry") {
    return commitWithOcc(
      {
        occ: deps.occ,
        nodeId: currentNode,
        iteration,
        expectedVersion: recorder.version(),
        attemptedFactType: "fact.run_paused",
        commit: occAppendOnce(opts.store, deps.runId, recorder.version(), abortAppendOpts),
        successOutcome: { kind: "terminal" },
        statusOutcome: { kind: "terminal" },
      },
      abortPlan.facts,
    );
  }
  if (abortPlan.outcome === "halt" || abortPlan.outcome === "pause") {
    return commitParkOrTerminal(
      {
        store: opts.store,
        runId: deps.runId,
        occ: deps.occ,
        nodeId: currentNode,
        iteration,
        expectedVersion: recorder.version(),
        appendOpts: abortAppendOpts,
      },
      abortPlan.facts,
    );
  }
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: currentNode,
      iteration,
      expectedVersion: recorder.version(),
      attemptedFactType: "fact.node_aborted",
      commit: occAppendOnce(opts.store, deps.runId, recorder.version(), abortAppendOpts),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
      onSuccess: () => {
        recordAbort(ts);
        const loopPlan = planAbortLoop({
          consecutiveAborts: ts.consecutiveAborts,
          ceiling: deps.abortLoopCeiling,
          nodeId: currentNode,
        });
        if (loopPlan.warn !== undefined) opts.store.appendObservabilityEvents(deps.runId, [loopPlan.warn]);
        if (loopPlan.pause !== undefined) {
          return commitParkOrTerminal(
            {
              store: opts.store,
              runId: deps.runId,
              occ: deps.occ,
              nodeId: currentNode,
              iteration,
              expectedVersion: opts.store.getState(deps.runId)?.version ?? runState.version,
            },
            [loopPlan.pause],
          );
        }
        return undefined;
      },
    },
    abortPlan.facts,
  );
}

interface TransitionArgs {
  currentNode: string;
  iteration: number;
  result: HandlerResult;
  usage: UsageAccumulator;
  effectiveRouting: Readonly<Record<string, unknown>>;
  deferredPause: boolean;
  obs: ObservabilitySink;
  recorder: { version: () => number };
}

/** Transition arm: the pure plan (edge selection → facts → routing patch)
 * applied under OCC, then the boundary snapshot. */
async function commitTransition(
  deps: RunDeps,
  ts: RunTurnState,
  runState: RunState,
  decision: ProceedDecision,
  a: TransitionArgs,
): Promise<DispatchOutcome> {
  const opts = deps.opts;
  const { currentNode, iteration, obs, recorder } = a;
  const planDecision =
    a.deferredPause && !decision.shouldPauseAfterDispatch ? { ...decision, shouldPauseAfterDispatch: true } : decision;
  const plan = planTransition({
    state: runState,
    decision: planDecision,
    graph: graphFor(deps, ts, runState.workflowSha),
    handlerResult: a.result,
    accounting: a.usage.totals(),
    effectiveRouting: a.effectiveRouting,
    currentNode,
    iteration,
    now: deps.clock(),
    random: deps.random,
  });
  for (const ev of plan.observability) obs.push(ev);
  obs.flush();
  const facts = plan.facts;
  const appendOpts: { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number } = {};
  if (plan.routingPatch !== undefined) appendOpts.routingPatch = plan.routingPatch;
  if (plan.advanceAppliedTo !== undefined) appendOpts.advanceAppliedTo = plan.advanceAppliedTo;
  const turnIteration = nodeRetryCount(runState.routing, currentNode);
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: currentNode,
      iteration: turnIteration,
      expectedVersion: recorder.version(),
      attemptedFactType: facts[0]?.type ?? "fact.unknown",
      commit: occAppendOnce(opts.store, deps.runId, recorder.version(), appendOpts),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
      onSuccess: async () => {
        deps.occ.onResolved(currentNode, turnIteration);
        invalidateOutputsCacheIf(ts, facts);
        await captureBoundarySnapshot(opts, deps.runId, facts, currentNode);
      },
    },
    facts,
  );
}
