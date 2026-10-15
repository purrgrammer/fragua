// Parallel fan-out region driver (Model A on-log reactive frontier). One
// superstep per `runFanout` call: seed the frontier, advance the join, or
// dispatch the live frontier concurrently and fold each completion. Lifted out
// of `runOneInner`'s closure into top-level functions over the explicit
// `RunDeps` + `RunTurnState` records. Behaviour is byte-identical to the prior
// inline implementation. This file does store I/O (on IO_ALLOWED).
//
// ARCHITECTURE.md §6.1 / §6.2.

import {
  evaluateBudget,
  fanoutClosureUnion,
  type Graph,
  getFrontier,
  getLimits,
  OPERATOR_NOTES_KEY,
  PAUSE_AFTER_DISPATCH_KEY,
  PENDING_STEER_KEY,
  PENDING_STEER_MAX_BYTES,
  readGoalGateRetries,
  readOperatorNotes,
  readPendingSteer,
  retryCountKey,
  utf8Truncate,
} from "@fragua/core";
import * as core from "@fragua/core/handler";
import type { FactEvent, RunState } from "@fragua/store";
import {
  classifyExit,
  type ExitKind,
  type ExitPlan,
  planAbortLoops,
  planBudgetBreach,
  planExit,
} from "./abort-planner.ts";
import {
  type BudgetCumulative,
  BudgetTripError,
  buildDispatchContext,
  type FanoutAppendOpts,
  graphFor,
  makeReactiveBudgetGate,
  mergeFanoutAppendOpts,
  type ReactiveBudgetGate,
  type RunDeps,
  type UsageAccumulator,
} from "./dispatch-wiring.ts";
import {
  classifyAbortCause,
  errorMessage,
  fireNodeExited,
  nodeRetryCount,
  readBudgetOverrides,
  readBudgetWarned,
  sleep,
} from "./executor-helpers.ts";
import { abortedActiveBranches, commitFanoutFact } from "./fanout-commit.ts";
import {
  type FanoutPlan,
  noteDisposition,
  planBailSettlement,
  planBranchSettlement,
  planFanoutMalformed,
  planFanoutStep,
  planJoin,
  planSeedFanout,
} from "./fanout-planner.ts";
import { FanoutBailError, PROCEED_DECISION, type ProceedDecision, Semaphore } from "./fanout-support.ts";
import { invokeHandler } from "./invoke-handler.ts";
import { planDispatchStarted } from "./lifecycle-planner.ts";
import { commitParkOrTerminal, commitWithOcc, type DispatchOutcome } from "./occ-append.ts";
import { planLoopCeiling } from "./predispatch-planner.ts";
import { bumpBranchAbort, clearBranchAbort, countDispatch, type RunTurnState } from "./run-turn-state.ts";
import { computeAdvanceAppliedTo, planTransition } from "./transition-planner.ts";

/** Default cap on concurrent in-flight fan-out sub-nodes when a `parallel` node
 * declares no `concurrency:`. */
const DEFAULT_FANOUT_CONCURRENCY = 8;

/** Outcome of executing one fan-out branch sub-node. A non-result exit carries
 * the same `planExit` plan the linear path commits. */
type BranchOutcome =
  | { kind: "success"; nodeId: string; nextNode: string | undefined; facts: FactEvent[]; appendOpts: FanoutAppendOpts }
  | { kind: "exit"; nodeId: string; exit: ExitKind; plan: ExitPlan; appendOpts: FanoutAppendOpts }
  | { kind: "skipped"; nodeId: string };

/** A branch whose handler is still running — what an early bail credits when
 * the bounded drain gives up on it. */
interface InflightBranch {
  usage: UsageAccumulator;
  iteration: number;
  pass: number;
}

/** Execute one fan-out branch sub-node: build ctx → invoke → plan the completion,
 * returning NODE-scoped facts WITHOUT committing (the pool serializes commits). */
async function executeBranchNode(
  deps: RunDeps,
  ts: RunTurnState,
  branchNode: string,
  baseState: RunState,
  branchRouting: Readonly<Record<string, unknown>>,
  branchTimeoutMs: number,
  foldSteer: string | undefined,
  inflight: Map<string, InflightBranch>,
  gate: ReactiveBudgetGate,
): Promise<BranchOutcome> {
  const graph = graphFor(deps, ts, baseState.workflowSha);
  const spec = deps.opts.dispatcher.get(baseState.workflowSha, branchNode);
  const iteration = nodeRetryCount(branchRouting as Record<string, unknown>, branchNode);
  const branchPass = readGoalGateRetries(baseState.routing);
  const nodeAttrs = graph?.nodes[branchNode]?.attrs;
  const built = buildDispatchContext({
    deps,
    state: ts,
    nodeId: branchNode,
    iteration,
    routing: branchRouting,
    spec,
    graph,
    nodeAttrs,
    initialVersion: baseState.version,
    obsLabel: "fan-out",
    backstopMs: branchTimeoutMs,
    onCostRecorded: gate.onCostRecorded,
  });
  const { steerCtrl, sources, releaseSignal, deadlines, obs, usage, ctxOpts } = built;
  const branchSteer = [readPendingSteer(branchRouting as Record<string, unknown>), foldSteer].filter(
    (s): s is string => s != null && s.length > 0,
  );
  if (branchSteer.length > 0) ctxOpts.steering = branchSteer.join("\n");
  const ctx = core.buildHandlerContext(ctxOpts);

  inflight.set(branchNode, { usage, iteration, pass: branchPass });
  const invocation = await invokeHandler({
    spec,
    ctx,
    registry: deps.opts.registry,
    runId: deps.runId,
    steerCtrl,
    leakGraceMs: deps.leakGrace,
    maxMsOverride: branchTimeoutMs,
  });
  inflight.delete(branchNode);
  for (const disarm of deadlines) disarm();
  if (invocation.kind !== "leak") releaseSignal();
  obs.flush();

  if (invocation.kind !== "result") {
    const thrown = invocation.kind === "thrown" ? invocation : undefined;
    const trip = gate.tripped();
    const exit = classifyExit({
      invocation: invocation.kind,
      cause: classifyAbortCause(sources),
      budgetTripped: trip !== undefined,
    });
    const now = deps.clock();
    const plan = planExit({
      exit,
      currentNode: branchNode,
      iteration,
      ...(thrown !== undefined ? { errorDetail: errorMessage(thrown.error) } : {}),
      leakedAt: now,
      reactiveBudgetHaltDetail: trip?.haltDetail,
      reactiveBudgetPauseBreach: trip?.pauseBreach,
      usage: usage.totals(),
      routingDelta: {},
      appliedSeqs: [],
      effectiveRouting: branchRouting,
      now,
      attemptedMs: spec.maxMs !== undefined ? Math.min(spec.maxMs, branchTimeoutMs) : branchTimeoutMs,
    });
    const exitOpts: FanoutAppendOpts = {};
    if (plan.routingPatch !== undefined) exitOpts.routingPatch = plan.routingPatch;
    return { kind: "exit", nodeId: branchNode, exit, plan, appendOpts: exitOpts };
  }

  const plan = planTransition({
    state: { ...baseState, currentNode: branchNode },
    decision: PROCEED_DECISION,
    graph,
    handlerResult: invocation.result,
    accounting: usage.totals(),
    effectiveRouting: branchRouting,
    currentNode: branchNode,
    iteration,
    now: deps.clock(),
    random: deps.random,
    providerRetryAfterMaxMs: deps.providerRetryAfterMaxMs,
  });
  if (plan.observability.length > 0) {
    deps.opts.store.appendObservabilityEvents(
      deps.runId,
      plan.observability.map((o) => ({ type: o.type, payload: o.payload })),
    );
  }
  const nc = plan.facts.find((f) => f.type === "fact.node_completed");
  const nextNode = nc?.type === "fact.node_completed" ? nc.payload.nextNode : undefined;
  const appendOpts: FanoutAppendOpts = {};
  if (plan.routingPatch !== undefined) appendOpts.routingPatch = plan.routingPatch;
  if (plan.advanceAppliedTo !== undefined) appendOpts.advanceAppliedTo = plan.advanceAppliedTo;
  return { kind: "success", nodeId: branchNode, nextNode, facts: plan.facts, appendOpts };
}

/** The mutable per-superstep context: the invariant region data plus the fold /
 * pool state the helpers below read and mutate. */
interface FanoutCtx {
  deps: RunDeps;
  ts: RunTurnState;
  runState: RunState;
  decision: ProceedDecision;
  graph: Graph | null;
  node: Graph["nodes"][string] | undefined;
  parallelNode: string;
  branches: string[];
  join: string | undefined;
  iteration: number;
  pass: number;
  closureNodes: Set<string>;
  branchTimeoutMs: number;
  effectiveMaxLoops: number;
  deferredPause: boolean;
  effectiveRouting: Readonly<Record<string, unknown>>;
  foldOpts: FanoutAppendOpts;
  foldPending: boolean;
  sem: Semaphore;
  pool: Map<string, Promise<{ nodeId: string; outcome: BranchOutcome }>>;
  inflight: Map<string, InflightBranch>;
  liveRouting: Readonly<Record<string, unknown>>;
  disposition: FactEvent | undefined;
  poolBailed: boolean;
  freshState: RunState;
  branchEntries: Set<string>;
  /** Set once a branch's reactive budget gate trips mid-handler: every live
   * branch is stopped and no successor is dispatched. */
  budgetTrip: boolean;
}

/** Consume the operator fold once — the first commit applies the routing delta
 * AND advances `last_applied_seq` past the queued intents. */
function takeFold(ctx: FanoutCtx): FanoutAppendOpts {
  if (!ctx.foldPending) return {};
  ctx.foldPending = false;
  return ctx.foldOpts;
}

/** Commit a fan-out park/terminal disposition through the shared honest lane;
 * the disposition RIDES `takeFold()` so a resume that re-pauses still advances
 * past the resume intent. An OCC-lost disposition parks in
 * `ts.pendingFanoutDisposition` for re-commit next turn. */
function commitFanoutDisposition(ctx: FanoutCtx, facts: FactEvent[]): Promise<DispatchOutcome> {
  return commitParkOrTerminal(
    {
      store: ctx.deps.opts.store,
      runId: ctx.deps.runId,
      occ: ctx.deps.occ,
      nodeId: ctx.parallelNode,
      iteration: ctx.iteration,
      expectedVersion: ctx.runState.version,
      commit: (f) => commitFanoutFact(ctx.deps, ctx.ts, f, takeFold(ctx)),
      onPark: (f) => {
        ctx.ts.pendingFanoutDisposition = f;
      },
    },
    facts,
  );
}

/** Run-level budget against the NOW-folded cumulative — the parallel node's
 * per-node cap sums over its fan-out closure. Returns the disposition fact, or
 * undefined. */
function fanoutBudgetDisposition(ctx: FanoutCtx, gate: { fresh?: boolean } = {}): FactEvent | undefined {
  const { deps, ts, runState, decision, graph, node, parallelNode, closureNodes } = ctx;
  const store = deps.opts.store;
  const folded =
    (gate.fresh ? store.getState(deps.runId) : ts.lastFanoutState) ?? store.getState(deps.runId) ?? runState;
  const overrideRouting =
    Object.keys(decision.routingDelta).length > 0 ? { ...folded.routing, ...decision.routingDelta } : folded.routing;
  const overrides = readBudgetOverrides(overrideRouting);
  let nodeCumulativeCostUsd = 0;
  let nodeCumulativeTokens = 0;
  for (const id of closureNodes) {
    const bucket = folded.metrics.nodeCosts[id];
    if (bucket === undefined) continue;
    nodeCumulativeCostUsd += bucket.costUsd;
    nodeCumulativeTokens += bucket.tokens;
  }
  const alreadyWarned = new Set([...readBudgetWarned(folded.routing), ...ts.pendingWarnTags]);
  const budget = evaluateBudget({
    graphAttrs: graph?.attrs ?? {},
    ...(node?.attrs !== undefined ? { completedNodeAttrs: node.attrs } : {}),
    completedNodeId: parallelNode,
    cumulativeCostUsd: folded.metrics.totalCostUsd,
    cumulativeTokens: folded.metrics.totalInputTokens + folded.metrics.totalOutputTokens,
    nodeCumulativeCostUsd,
    nodeCumulativeTokens,
    alreadyWarned,
    ...(overrides !== undefined ? { overrides } : {}),
  });
  if (budget.events.length > 0) {
    store.appendObservabilityEvents(
      deps.runId,
      budget.events.map((e) => ({ type: e.type, payload: { nodeId: parallelNode, ...e.payload } })),
    );
    for (const t of budget.newlyWarned) ts.pendingWarnTags.add(t);
  }
  return planBudgetBreach(
    { haltDetail: budget.shouldHalt ? (budget.haltReason ?? "") : undefined, pauseBreach: budget.pauseBreach },
    parallelNode,
  );
}

/** Fold committed same-turn retry-count bumps into `liveRouting` so a successor
 * queued behind the semaphore sees every bump committed while it waited. */
function foldCommittedRetryCounts(ctx: FanoutCtx): void {
  const committed = ctx.ts.lastFanoutState?.routing;
  if (committed === undefined) return;
  const retryCountPrefix = retryCountKey("");
  let next: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(committed)) {
    // routing-index-allow: dynamic-key fold of committed same-turn retry counts
    if (k.startsWith(retryCountPrefix) && ctx.liveRouting[k] !== v) {
      if (next === undefined) next = { ...ctx.liveRouting };
      next[k] = v;
    }
  }
  if (next !== undefined) ctx.liveRouting = next;
}

/** Strip pending operator notes for a non-entry sub-node — gate notes address
 * the region entries, no deeper sub-node. */
function routingForBranch(ctx: FanoutCtx, nodeId: string): Readonly<Record<string, unknown>> {
  if (ctx.branchEntries.has(nodeId)) return ctx.liveRouting;
  if (readOperatorNotes(ctx.liveRouting as Record<string, unknown>).length === 0) return ctx.liveRouting;
  return { ...ctx.liveRouting, [OPERATOR_NOTES_KEY]: [] };
}

/** The reactive budget gate for one fan-out branch. It evaluates the parallel
 * node's run and closure caps against the last committed projection plus the
 * live spend of every in-flight branch, so a branch is stopped at the same
 * crossing the linear path stops at. A trip stops every live branch. */
function branchBudgetGate(ctx: FanoutCtx): ReactiveBudgetGate {
  const { deps, ts } = ctx;
  return makeReactiveBudgetGate({
    nodeId: ctx.parallelNode,
    iteration: ctx.iteration,
    graphAttrs: ctx.graph?.attrs ?? {},
    nodeAttrs: ctx.node?.attrs,
    read: () => fanoutLiveCumulative(ctx),
    suppressed: () => ctx.budgetTrip,
    onTrip: (plan) => {
      ctx.budgetTrip = true;
      for (const t of plan.newlyWarned) ts.pendingWarnTags.add(t);
      const reason = new BudgetTripError(plan.haltDetail !== undefined ? "halt" : "pause");
      for (const h of deps.opts.registry.liveHandlers(deps.runId)) h.controller.abort(reason);
    },
  });
}

function fanoutLiveCumulative(ctx: FanoutCtx): BudgetCumulative {
  const { deps, ts, runState, decision, closureNodes } = ctx;
  const folded = ts.lastFanoutState ?? deps.opts.store.getState(deps.runId) ?? runState;
  let liveCost = 0;
  let liveTokens = 0;
  for (const b of ctx.inflight.values()) {
    const t = b.usage.totals();
    liveCost += t.totalCostUsd;
    liveTokens += t.turnBilled;
  }
  let nodeCost = 0;
  let nodeTokens = 0;
  for (const id of closureNodes) {
    const bucket = folded.metrics.nodeCosts[id];
    if (bucket === undefined) continue;
    nodeCost += bucket.costUsd;
    nodeTokens += bucket.tokens;
  }
  const overrideRouting =
    Object.keys(decision.routingDelta).length > 0 ? { ...folded.routing, ...decision.routingDelta } : folded.routing;
  const overrides = readBudgetOverrides(overrideRouting);
  return {
    cumulativeCostUsd: folded.metrics.totalCostUsd + liveCost,
    cumulativeTokens: folded.metrics.totalInputTokens + folded.metrics.totalOutputTokens + liveTokens,
    nodeCumulativeCostUsd: nodeCost + liveCost,
    nodeCumulativeTokens: nodeTokens + liveTokens,
    alreadyWarned: new Set([...readBudgetWarned(folded.routing), ...ts.pendingWarnTags]),
    ...(overrides !== undefined ? { overrides } : {}),
  };
}

/** Capture a run-level budget breach into the single disposition slot (halt over
 * pause precedence). */
function captureDisposition(ctx: FanoutCtx): void {
  if (ctx.disposition?.type === "fact.run_terminated") return;
  const disp = fanoutBudgetDisposition(ctx);
  if (disp !== undefined) ctx.disposition = noteDisposition(ctx.disposition, disp);
}

/** Drive one sub-node into the reactive pool (bounded by the semaphore and the
 * loop budget). */
function poolDispatch(ctx: FanoutCtx, nodeId: string): void {
  if (ctx.budgetTrip) return;
  const ceiling = planLoopCeiling({ dispatches: ctx.ts.dispatches, effectiveMaxLoops: ctx.effectiveMaxLoops });
  if (ceiling !== undefined) {
    ctx.disposition = noteDisposition(ctx.disposition, ceiling);
    return;
  }
  countDispatch(ctx.ts);
  ctx.pool.set(
    nodeId,
    (async () => {
      await ctx.sem.acquire();
      try {
        if (ctx.poolBailed) return { nodeId, outcome: { kind: "skipped", nodeId } satisfies BranchOutcome };
        return {
          nodeId,
          outcome: await executeBranchNode(
            ctx.deps,
            ctx.ts,
            nodeId,
            ctx.freshState,
            routingForBranch(ctx, nodeId),
            ctx.branchTimeoutMs,
            ctx.decision.steering,
            ctx.inflight,
            branchBudgetGate(ctx),
          ),
        };
      } finally {
        ctx.sem.release();
      }
    })(),
  );
}

/** Signal every still-in-flight branch to stop burning LLM cost on an early bail. */
function abortInflightPool(ctx: FanoutCtx): void {
  ctx.poolBailed = true;
  for (const h of ctx.deps.opts.registry.liveHandlers(ctx.deps.runId))
    h.controller.abort(new FanoutBailError(ctx.deps.runId));
}

/** After an early bail, wait for the just-aborted handlers to tear down —
 * bounded by `leakGrace` so a genuinely-leaked handler can't dam the turn.
 * Returns the outcomes that settled inside the bound. */
async function drainInflightPool(ctx: FanoutCtx): Promise<BranchOutcome[]> {
  if (ctx.pool.size === 0) return [];
  const settled: BranchOutcome[] = [];
  const tracked = [...ctx.pool.values()].map((p) =>
    p.then(
      (r) => {
        settled.push(r.outcome);
      },
      () => undefined,
    ),
  );
  await Promise.race([Promise.all(tracked), sleep(ctx.deps.leakGrace, ctx.deps.opts.shutdownSignal)]);
  return settled;
}

/** A leaked branch bails the pool: abort the in-flight siblings, wait for them
 * (bounded), and commit their completions / exits and the spend of any still
 * running ahead of the leak's own halt in one batch. */
async function bailWithSiblings(
  ctx: FanoutCtx,
  outcome: Extract<BranchOutcome, { kind: "exit" }>,
): Promise<DispatchOutcome> {
  const { deps } = ctx;
  deps.leakBudget.recordLeak(deps.runId, outcome.nodeId);
  abortInflightPool(ctx);
  const settled = await drainInflightPool(ctx);
  const siblings = planBailSettlement({
    settled: settled.flatMap((o) =>
      o.kind === "success" ? [{ facts: o.facts }] : o.kind === "exit" ? [{ facts: o.plan.facts }] : [],
    ),
    unsettled: [...ctx.inflight].map(([nodeId, b]) => ({
      nodeId,
      iteration: b.iteration,
      pass: b.pass,
      usage: b.usage.totals(),
    })),
  });
  return commitFanoutDisposition(ctx, [...siblings, ...outcome.plan.facts]);
}

/** Fold one branch's non-result exit: node-scoped facts (the spend-bearing
 * `node_aborted`, plus a timeout-retry's counter patch) commit on the branch
 * lane; the plan's park/terminal fact joins the pool disposition. A leak bails. */
async function settleExit(
  ctx: FanoutCtx,
  outcome: Extract<BranchOutcome, { kind: "exit" }>,
): Promise<DispatchOutcome | undefined> {
  const { deps, ts } = ctx;
  if (outcome.exit === "leak") return bailWithSiblings(ctx, outcome);
  const branchFacts: FactEvent[] = [];
  for (const f of outcome.plan.facts) {
    if (f.type === "fact.run_paused" || f.type === "fact.run_terminated") {
      ctx.disposition = noteDisposition(ctx.disposition, f);
    } else {
      branchFacts.push(f);
    }
  }
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: outcome.nodeId,
      iteration: nodeRetryCount(ctx.liveRouting as Record<string, unknown>, outcome.nodeId),
      expectedVersion: ctx.runState.version,
      attemptedFactType: "fact.node_aborted",
      commit: (f) => commitFanoutFact(deps, ts, f, mergeFanoutAppendOpts(takeFold(ctx), outcome.appendOpts)),
      successOutcome: undefined,
      statusOutcome: { kind: "continue" },
      onFail: () => abortInflightPool(ctx),
      onNonHalt: async () => {
        await drainInflightPool(ctx);
      },
      onSuccess: () => {
        foldCommittedRetryCounts(ctx);
        if (outcome.plan.outcome === "abort_step") bumpBranchAbort(ts, outcome.nodeId);
        captureDisposition(ctx);
      },
    },
    branchFacts,
  );
}

/** Fold one settled branch outcome. Returns a DispatchOutcome to return from
 * `runFanout`, or undefined to keep draining the pool. */
async function settleBranch(ctx: FanoutCtx, outcome: BranchOutcome): Promise<DispatchOutcome | undefined> {
  const { deps, ts } = ctx;
  if (outcome.kind === "skipped") return undefined;

  if (outcome.kind === "exit") return settleExit(ctx, outcome);

  const settlement = planBranchSettlement({
    nodeId: outcome.nodeId,
    facts: outcome.facts,
    nextNode: outcome.nextNode,
    join: ctx.join,
    graphNodes: ctx.graph?.nodes ?? null,
    pass: ctx.pass,
    liveRouting: ctx.liveRouting as Record<string, unknown>,
    routingPatch: outcome.appendOpts.routingPatch,
    disposition: ctx.disposition,
  });
  ctx.disposition = settlement.disposition;
  const successor = settlement.successor;
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: outcome.nodeId,
      iteration: nodeRetryCount(ctx.liveRouting as Record<string, unknown>, outcome.nodeId),
      expectedVersion: ctx.runState.version,
      attemptedFactType: "fact.node_completed",
      commit: (f) => commitFanoutFact(deps, ts, f, mergeFanoutAppendOpts(takeFold(ctx), outcome.appendOpts)),
      successOutcome: undefined,
      statusOutcome: { kind: "continue" },
      onFail: () => abortInflightPool(ctx),
      onNonHalt: async () => {
        await drainInflightPool(ctx);
      },
      onSuccess: () => {
        foldCommittedRetryCounts(ctx);
        clearBranchAbort(ts, outcome.nodeId);
        captureDisposition(ctx);
        if (successor !== outcome.nodeId) fireNodeExited(deps.opts.onNodeExited, deps.runId, outcome.nodeId);
        if (successor !== undefined && ctx.disposition === undefined) poolDispatch(ctx, successor);
      },
    },
    settlement.branchFacts,
  );
}

/** Seed the frontier with the branch entries (fresh entry). */
async function seedFrontier(ctx: FanoutCtx, plan: Extract<FanoutPlan, { kind: "seed" }>): Promise<DispatchOutcome> {
  const { deps, decision, parallelNode, iteration, pass } = ctx;
  let seedOpts = takeFold(ctx);
  if (decision.steering !== undefined && decision.steering.length > 0) {
    seedOpts = {
      ...seedOpts,
      routingPatch: {
        ...(seedOpts.routingPatch ?? {}),
        [PENDING_STEER_KEY]: utf8Truncate(decision.steering, PENDING_STEER_MAX_BYTES),
      },
    };
  }
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: parallelNode,
      iteration,
      expectedVersion: ctx.runState.version,
      attemptedFactType: "fact.fanout_started",
      commit: (f) => commitFanoutFact(deps, ctx.ts, f, seedOpts),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
    },
    planSeedFanout({ nodeId: parallelNode, iteration, pass, branches: plan.branches }),
  );
}

/** Frontier drained → advance `current_node` to the join (budget first). */
async function advanceJoin(ctx: FanoutCtx, plan: Extract<FanoutPlan, { kind: "join" }>): Promise<DispatchOutcome> {
  const { deps, parallelNode, iteration, pass, deferredPause } = ctx;
  const drainedBarrier = fanoutBudgetDisposition(ctx, { fresh: true });
  if (drainedBarrier !== undefined) return commitFanoutDisposition(ctx, [drainedBarrier]);
  const joinFact = planJoin({
    deferredPause,
    nodeId: parallelNode,
    iteration,
    pass,
    nextNode: plan.nextNode,
    branchesCompleted: plan.branchesCompleted,
  });
  let joinOpts = takeFold(ctx);
  if (deferredPause) {
    joinOpts = { ...joinOpts, routingPatch: { ...(joinOpts.routingPatch ?? {}), [PAUSE_AFTER_DISPATCH_KEY]: false } };
  }
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: parallelNode,
      iteration,
      expectedVersion: ctx.runState.version,
      attemptedFactType: joinFact.type,
      commit: (f) => commitFanoutFact(deps, ctx.ts, f, joinOpts),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
      onSuccess: () => {
        deps.occ.onResolved(parallelNode, iteration);
      },
    },
    [joinFact],
  );
}

/** Re-mark active branches whose latest lifecycle fact is `node_aborted` with a
 * fresh `dispatch_started` before the pool dispatches. Returns a DispatchOutcome
 * to short-circuit, or undefined to proceed into the pool. */
async function redispatchAborted(
  ctx: FanoutCtx,
  plan: Extract<FanoutPlan, { kind: "dispatch" }>,
): Promise<DispatchOutcome | undefined> {
  const { deps, pass } = ctx;
  const reDispatched = plan.redispatch;
  if (reDispatched.length === 0) return undefined;
  const facts: FactEvent[] = reDispatched.flatMap(
    (n) =>
      planDispatchStarted({ nodeId: n, iteration: nodeRetryCount(ctx.runState.routing, n), pass, resumeOf: "paused" })
        .facts,
  );
  const first = reDispatched[0]!;
  return commitWithOcc(
    {
      occ: deps.occ,
      nodeId: first,
      iteration: nodeRetryCount(ctx.runState.routing, first),
      expectedVersion: ctx.runState.version,
      attemptedFactType: "fact.dispatch_started",
      commit: (f) => commitFanoutFact(deps, ctx.ts, f, takeFold(ctx)),
      successOutcome: undefined,
      statusOutcome: { kind: "continue" },
    },
    facts,
  );
}

/** The reactive pool: dispatch the live frontier concurrently and, as each
 * branch settles, commit it and dispatch its successor immediately. */
async function runFanoutPool(
  ctx: FanoutCtx,
  plan: Extract<FanoutPlan, { kind: "dispatch" }>,
): Promise<DispatchOutcome> {
  const { deps, ts } = ctx;
  ctx.freshState = deps.opts.store.getState(deps.runId) ?? ctx.runState;
  ctx.liveRouting = ctx.effectiveRouting;
  for (const f of plan.active) poolDispatch(ctx, f);

  try {
    while (ctx.pool.size > 0) {
      const { nodeId, outcome } = await Promise.race(ctx.pool.values());
      ctx.pool.delete(nodeId);
      const settled = await settleBranch(ctx, outcome);
      if (settled !== undefined) return settled;
    }
  } catch (err) {
    abortInflightPool(ctx);
    await drainInflightPool(ctx);
    throw err;
  }

  if (ctx.disposition !== undefined) return commitFanoutDisposition(ctx, [ctx.disposition]);
  const abortLoops = planAbortLoops(ts.branchAborts, deps.abortLoopCeiling);
  if (abortLoops.warns.length > 0) deps.opts.store.appendObservabilityEvents(deps.runId, abortLoops.warns);
  if (abortLoops.pause !== undefined) return commitFanoutDisposition(ctx, [abortLoops.pause]);
  if (ts.branchAborts.size > 0) return { kind: "continue" };
  const barrier = fanoutBudgetDisposition(ctx, { fresh: true });
  if (barrier !== undefined) return commitFanoutDisposition(ctx, [barrier]);
  return { kind: "continue" };
}

/** Drive one fan-out superstep for a `type: parallel` node. */
export async function runFanout(
  deps: RunDeps,
  ts: RunTurnState,
  runState: RunState,
  decision: ProceedDecision,
  parallelNode: string,
  effectiveRouting: Readonly<Record<string, unknown>>,
  deferredPause: boolean,
): Promise<DispatchOutcome> {
  const graph = graphFor(deps, ts, runState.workflowSha);
  const node = graph?.nodes[parallelNode];
  const branches = Array.isArray(node?.attrs.branches) ? (node.attrs.branches as string[]) : [];
  const join = typeof node?.attrs.join === "string" ? node.attrs.join : undefined;
  const iteration = nodeRetryCount(runState.routing, parallelNode);
  const pass = readGoalGateRetries(runState.routing);
  const concurrency =
    typeof node?.attrs.concurrency === "number" && node.attrs.concurrency > 0
      ? node.attrs.concurrency
      : DEFAULT_FANOUT_CONCURRENCY;
  const branchTimeoutMs =
    typeof node?.attrs.max_ms === "number" && node.attrs.max_ms > 0 ? node.attrs.max_ms : deps.fanoutBranchTimeoutMs;

  const active = getFrontier(effectiveRouting as Record<string, unknown>);
  const plan: FanoutPlan = planFanoutStep({
    active,
    branches,
    join,
    redispatch: active !== null && active.length > 0 ? abortedActiveBranches(deps.opts.store, deps.runId, active) : [],
  });

  if (plan.kind === "malformed") {
    return commitParkOrTerminal(
      {
        store: deps.opts.store,
        runId: deps.runId,
        occ: deps.occ,
        nodeId: parallelNode,
        iteration,
        expectedVersion: runState.version,
      },
      [planFanoutMalformed()],
    );
  }

  const foldOpts: FanoutAppendOpts = {};
  if (Object.keys(decision.routingDelta).length > 0) foldOpts.routingPatch = decision.routingDelta;
  const foldAdvanceTo = computeAdvanceAppliedTo(decision.appliedSeqs);
  if (foldAdvanceTo !== undefined) foldOpts.advanceAppliedTo = foldAdvanceTo;
  const foldPending = foldOpts.routingPatch !== undefined || foldOpts.advanceAppliedTo !== undefined;

  const closureNodes = graph !== null ? fanoutClosureUnion(graph, { branches, join }) : new Set<string>();
  const effectiveMaxLoops = getLimits(effectiveRouting).maxLoops || deps.maxLoops;

  const ctx: FanoutCtx = {
    deps,
    ts,
    runState,
    decision,
    graph,
    node,
    parallelNode,
    branches,
    join,
    iteration,
    pass,
    closureNodes,
    branchTimeoutMs,
    effectiveMaxLoops,
    deferredPause,
    effectiveRouting,
    foldOpts,
    foldPending,
    sem: new Semaphore(concurrency),
    pool: new Map(),
    inflight: new Map(),
    liveRouting: effectiveRouting,
    disposition: undefined,
    poolBailed: false,
    freshState: runState,
    branchEntries: new Set(branches),
    budgetTrip: false,
  };

  if (ts.pendingFanoutDisposition !== undefined) return commitFanoutDisposition(ctx, ts.pendingFanoutDisposition);
  if (plan.kind === "seed") return seedFrontier(ctx, plan);
  if (plan.kind === "join") return advanceJoin(ctx, plan);

  const reRes = await redispatchAborted(ctx, plan);
  if (reRes !== undefined) return reRes;
  return runFanoutPool(ctx, plan);
}
