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
import { ConcurrencyError, type FactEvent, type IEventReader, type RunState } from "@fragua/store";
import {
  buildDispatchContext,
  type FanoutAppendOpts,
  graphFor,
  invalidateOutputsCacheIf,
  mergeFanoutAppendOpts,
  type RunDeps,
} from "./dispatch-wiring.ts";
import {
  BUDGET_WARNED_KEY,
  classifyAbortCause,
  nodeRetryCount,
  passField,
  readBudgetOverrides,
  readBudgetWarned,
  sleep,
} from "./executor-helpers.ts";
import {
  type FanoutPlan,
  noteDisposition,
  planBranchAbortLoop,
  planBranchTerminal,
  planFanoutStep,
} from "./fanout-planner.ts";
import { invokeHandler } from "./invoke-handler.ts";
import { type CommitResult, commitParkOrTerminal, type DispatchOutcome } from "./occ-append.ts";
import { abortResultToFacts } from "./result-to-facts.ts";
import { bumpBranchAbort, clearBranchAbort, countDispatch, type RunTurnState } from "./run-turn-state.ts";
import { computeAdvanceAppliedTo, planTransition } from "./transition-planner.ts";

/** Default cap on concurrent in-flight fan-out sub-nodes when a `parallel` node
 * declares no `concurrency:`. */
const DEFAULT_FANOUT_CONCURRENCY = 8;

/** Append attempts for a serialized fan-out commit before giving up. */
const FANOUT_COMMIT_ATTEMPTS = 8;

/** Bounded-concurrency gate for fan-out sub-node dispatch. A slot transfers
 * directly to the next waiter on `release()` so `active` never exceeds `limit`. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.active--;
  }
}

/** Signalled into an in-flight branch's controller when the fan-out pool takes
 * an early-terminal exit. Named `AbortError` so the branch classifies it as a
 * plain abort (not a timeout, not a leak). */
class FanoutBailError extends Error {
  constructor(public readonly runId: string) {
    super(`fan-out pool bailed for ${runId}`);
    this.name = "AbortError";
  }
}

/** Outcome of executing one fan-out branch sub-node. */
type BranchOutcome =
  | { kind: "success"; nodeId: string; nextNode: string | undefined; facts: FactEvent[]; appendOpts: FanoutAppendOpts }
  | { kind: "abort"; nodeId: string; facts: FactEvent[] }
  | { kind: "leak"; nodeId: string; leakedAt: number }
  | { kind: "skipped"; nodeId: string };

/** A clean proceed decision for a branch sub-node — deep-frozen so the shared
 * constant can't be cross-corrupted across concurrent branches. */
const PROCEED_DECISION: Extract<core.IntentDecision, { kind: "proceed" }> = (() => {
  const d: Extract<core.IntentDecision, { kind: "proceed" }> = {
    kind: "proceed",
    routingDelta: {},
    shouldPause: false,
    shouldPauseAfterDispatch: false,
    appliedSeqs: [],
    dropped: [],
  };
  Object.freeze(d.routingDelta);
  Object.freeze(d.appliedSeqs);
  Object.freeze(d.dropped);
  return Object.freeze(d);
})();

type ProceedDecision = Extract<core.IntentDecision, { kind: "proceed" }>;

/** Active fan-out branches whose latest lifecycle fact is `node_aborted` — they
 * are being re-dispatched and need a fresh `dispatch_started` so they project as
 * running, not failed. */
function abortedActiveBranches(store: IEventReader, runId: string, active: readonly string[]): string[] {
  if (active.length === 0) return [];
  const latest = new Map(store.getLatestLifecycleByNode(runId).map((r) => [r.nodeId, r.type]));
  return active.filter((n) => latest.get(n) === "fact.node_aborted");
}

/** Serialized fan-out commit lane. Re-reads the live version each attempt; a
 * sibling's commit having moved `version` is benign — retry the APPEND (never
 * re-execute). The `false` arm is TAGGED: `status` ⇒ the run left `running`,
 * `occ` ⇒ genuine OCC exhaustion. */
async function commitFanoutFact(
  deps: RunDeps,
  ts: RunTurnState,
  facts: FactEvent[],
  appendOpts: FanoutAppendOpts,
): Promise<CommitResult> {
  if (facts.length === 0) return { ok: true };
  const store = deps.opts.store;
  for (let attempt = 0; attempt < FANOUT_COMMIT_ATTEMPTS; attempt++) {
    const fresh = store.getState(deps.runId);
    if (fresh == null || fresh.status !== "running") return { ok: false, reason: "status" };
    let effectiveOpts = appendOpts;
    if (ts.pendingWarnTags.size > 0) {
      const prior = readBudgetWarned(fresh.routing);
      const merged = new Set(prior);
      for (const t of ts.pendingWarnTags) merged.add(t);
      if (merged.size > prior.size) {
        effectiveOpts = {
          ...appendOpts,
          routingPatch: { ...(appendOpts.routingPatch ?? {}), [BUDGET_WARNED_KEY]: [...merged].sort() },
        };
      }
    }
    try {
      const res = store.appendFact(deps.runId, facts, fresh.version, effectiveOpts);
      ts.lastFanoutState = res.state;
      invalidateOutputsCacheIf(ts, facts);
      return { ok: true };
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
    }
    await sleep(Math.min(2 ** attempt, 16), deps.opts.shutdownSignal);
  }
  return { ok: false, reason: "occ" };
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
    onCostRecorded: (payload, w) => w.usage.mirrorCostRecorded(payload),
  });
  const { steerCtrl, signal, releaseSignal, deadlines, obs, usage, ctxOpts } = built;
  const branchSteer = [readPendingSteer(branchRouting as Record<string, unknown>), foldSteer].filter(
    (s): s is string => s != null && s.length > 0,
  );
  if (branchSteer.length > 0) ctxOpts.steering = branchSteer.join("\n");
  const ctx = core.buildHandlerContext(ctxOpts);

  const invocation = await invokeHandler({
    spec,
    ctx,
    registry: deps.opts.registry,
    runId: deps.runId,
    steerCtrl,
    leakGraceMs: deps.leakGrace,
    maxMsOverride: branchTimeoutMs,
  });
  for (const disarm of deadlines) disarm();
  if (invocation.kind !== "leak") releaseSignal();
  obs.flush();

  if (invocation.kind === "leak") return { kind: "leak", nodeId: branchNode, leakedAt: deps.clock() };
  if (invocation.kind === "thrown") {
    const cause = classifyAbortCause(signal, invocation.error);
    return {
      kind: "abort",
      nodeId: branchNode,
      facts: abortResultToFacts(branchNode, iteration, cause, usage.totals(), branchPass),
    };
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
  liveRouting: Readonly<Record<string, unknown>>;
  disposition: FactEvent | undefined;
  poolBailed: boolean;
  freshState: RunState;
  branchEntries: Set<string>;
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
  if (budget.shouldHalt) {
    const payload: { status: "errored"; reason: "budget"; detail?: string } = { status: "errored", reason: "budget" };
    if (budget.haltReason !== undefined && budget.haltReason.length > 0) payload.detail = budget.haltReason;
    return { type: "fact.run_terminated", payload };
  }
  if (budget.pauseBreach !== undefined) {
    const b = budget.pauseBreach;
    return {
      type: "fact.run_paused",
      payload: {
        reason: "budget",
        nodeId: parallelNode,
        scope: b.scope,
        metric: b.metric,
        limit: b.limit,
        actual: b.actual,
      },
    };
  }
  return undefined;
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
  if (ctx.ts.dispatches >= ctx.effectiveMaxLoops) {
    ctx.disposition = noteDisposition(ctx.disposition, {
      type: "fact.run_paused",
      payload: { reason: "max_loops", currentLimit: ctx.effectiveMaxLoops, dispatches: ctx.ts.dispatches },
    });
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
 * bounded by `leakGrace` so a genuinely-leaked handler can't dam the turn. */
async function drainInflightPool(ctx: FanoutCtx): Promise<void> {
  if (ctx.pool.size === 0) return;
  await Promise.race([
    Promise.allSettled([...ctx.pool.values()]),
    sleep(ctx.deps.leakGrace, ctx.deps.opts.shutdownSignal),
  ]);
}

/** Fold one settled branch outcome. Returns a DispatchOutcome to return from
 * `runFanout`, or undefined to keep draining the pool. */
async function settleBranch(ctx: FanoutCtx, outcome: BranchOutcome): Promise<DispatchOutcome | undefined> {
  const { deps, ts } = ctx;
  if (outcome.kind === "skipped") return undefined;

  if (outcome.kind === "leak") {
    deps.leakBudget.recordLeak(deps.runId, outcome.nodeId);
    abortInflightPool(ctx);
    await drainInflightPool(ctx);
    return commitFanoutDisposition(ctx, [
      { type: "fact.handler_timeout_leaked", payload: { nodeId: outcome.nodeId, leakedAt: outcome.leakedAt } },
      { type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: "handler_leaked" } },
    ]);
  }

  if (outcome.kind === "abort") {
    const abortRes = await commitFanoutFact(deps, ts, outcome.facts, takeFold(ctx));
    if (!abortRes.ok) {
      abortInflightPool(ctx);
      if (abortRes.reason === "occ") {
        const { halted } = await deps.occ.onConflict(
          "fact.node_aborted",
          outcome.nodeId,
          nodeRetryCount(ctx.liveRouting as Record<string, unknown>, outcome.nodeId),
          ctx.runState.version,
        );
        if (halted) return { kind: "terminal" };
      }
      await drainInflightPool(ctx);
      return { kind: "continue" };
    }
    foldCommittedRetryCounts(ctx);
    bumpBranchAbort(ts, outcome.nodeId);
    captureDisposition(ctx);
    return undefined;
  }

  const branchFacts: FactEvent[] = [];
  let branchTerminal = false;
  for (const f of outcome.facts) {
    if (f.type === "fact.run_terminated" && f.payload.status === "completed") {
      branchTerminal = true;
    } else if (f.type === "fact.run_terminated" || f.type === "fact.run_paused") {
      ctx.disposition = noteDisposition(ctx.disposition, f);
    } else if (f.type !== "fact.node_started") {
      branchFacts.push(f);
    }
  }
  let successor = outcome.nextNode !== undefined && outcome.nextNode !== ctx.join ? outcome.nextNode : undefined;
  if (successor !== undefined && ctx.graph?.nodes[successor] === undefined) {
    branchTerminal = true;
    successor = undefined;
  }
  if (branchTerminal) {
    successor = undefined;
    ctx.disposition = noteDisposition(ctx.disposition, planBranchTerminal(outcome.nodeId));
  }
  if (successor !== undefined) {
    const successorRouting =
      outcome.appendOpts.routingPatch !== undefined
        ? { ...(ctx.liveRouting as Record<string, unknown>), ...outcome.appendOpts.routingPatch }
        : (ctx.liveRouting as Record<string, unknown>);
    branchFacts.push({
      type: "fact.dispatch_started",
      payload: {
        nodeId: successor,
        iteration: nodeRetryCount(successorRouting, successor),
        ...passField(ctx.pass),
        resumeOf: "fresh",
      },
    });
  }
  const successRes = await commitFanoutFact(
    deps,
    ts,
    branchFacts,
    mergeFanoutAppendOpts(takeFold(ctx), outcome.appendOpts),
  );
  if (!successRes.ok) {
    abortInflightPool(ctx);
    if (successRes.reason === "occ") {
      const { halted } = await deps.occ.onConflict(
        "fact.node_completed",
        outcome.nodeId,
        nodeRetryCount(ctx.liveRouting as Record<string, unknown>, outcome.nodeId),
        ctx.runState.version,
      );
      if (halted) return { kind: "terminal" };
    }
    await drainInflightPool(ctx);
    return { kind: "continue" };
  }
  foldCommittedRetryCounts(ctx);
  clearBranchAbort(ts, outcome.nodeId);
  captureDisposition(ctx);
  if (successor !== undefined && ctx.disposition === undefined) poolDispatch(ctx, successor);
  return undefined;
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
  const res = await commitFanoutFact(
    deps,
    ctx.ts,
    [
      {
        type: "fact.fanout_started",
        payload: { nodeId: parallelNode, iteration, ...passField(pass), branches: [...plan.branches] },
      },
    ],
    seedOpts,
  );
  if (!res.ok) {
    if (res.reason !== "occ") return { kind: "continue" };
    const { halted } = await deps.occ.onConflict("fact.fanout_started", parallelNode, iteration, ctx.runState.version);
    return halted ? { kind: "terminal" } : { kind: "continue" };
  }
  return { kind: "continue" };
}

/** Frontier drained → advance `current_node` to the join (budget first). */
async function advanceJoin(ctx: FanoutCtx, plan: Extract<FanoutPlan, { kind: "join" }>): Promise<DispatchOutcome> {
  const { deps, parallelNode, iteration, pass, deferredPause } = ctx;
  const drainedBarrier = fanoutBudgetDisposition(ctx, { fresh: true });
  if (drainedBarrier !== undefined) return commitFanoutDisposition(ctx, [drainedBarrier]);
  const joinFact: FactEvent = deferredPause
    ? { type: "fact.run_paused", payload: { reason: "operator", nodeId: parallelNode } }
    : {
        type: "fact.fanout_joined",
        payload: {
          nodeId: parallelNode,
          iteration,
          ...passField(pass),
          nextNode: plan.nextNode,
          branchesCompleted: plan.branchesCompleted,
        },
      };
  let joinOpts = takeFold(ctx);
  if (deferredPause) {
    joinOpts = { ...joinOpts, routingPatch: { ...(joinOpts.routingPatch ?? {}), [PAUSE_AFTER_DISPATCH_KEY]: false } };
  }
  const res = await commitFanoutFact(deps, ctx.ts, [joinFact], joinOpts);
  if (!res.ok) {
    if (res.reason !== "occ") return { kind: "continue" };
    const { halted } = await deps.occ.onConflict(joinFact.type, parallelNode, iteration, ctx.runState.version);
    return halted ? { kind: "terminal" } : { kind: "continue" };
  }
  deps.occ.onResolved(parallelNode, iteration);
  return { kind: "continue" };
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
  const facts: FactEvent[] = reDispatched.map((n) => ({
    type: "fact.dispatch_started",
    payload: { nodeId: n, iteration: nodeRetryCount(ctx.runState.routing, n), ...passField(pass), resumeOf: "paused" },
  }));
  const reRes = await commitFanoutFact(deps, ctx.ts, facts, takeFold(ctx));
  if (!reRes.ok) {
    if (reRes.reason === "occ") {
      const first = reDispatched[0]!;
      const { halted } = await deps.occ.onConflict(
        "fact.dispatch_started",
        first,
        nodeRetryCount(ctx.runState.routing, first),
        ctx.runState.version,
      );
      if (halted) return { kind: "terminal" };
    }
    return { kind: "continue" };
  }
  return undefined;
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
  const branchLoopPause = planBranchAbortLoop(ts.branchAborts, deps.abortLoopCeiling);
  if (branchLoopPause !== undefined) return commitFanoutDisposition(ctx, [branchLoopPause]);
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
      [{ type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: "fanout_malformed" } }],
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
    liveRouting: effectiveRouting,
    disposition: undefined,
    poolBailed: false,
    freshState: runState,
    branchEntries: new Set(branches),
  };

  if (ts.pendingFanoutDisposition !== undefined) return commitFanoutDisposition(ctx, ts.pendingFanoutDisposition);
  if (plan.kind === "seed") return seedFrontier(ctx, plan);
  if (plan.kind === "join") return advanceJoin(ctx, plan);

  const reRes = await redispatchAborted(ctx, plan);
  if (reRes !== undefined) return reRes;
  return runFanoutPool(ctx, plan);
}
