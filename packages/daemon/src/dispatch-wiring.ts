// Per-dispatch wiring shared by the linear turn (dispatch-turn.ts) and the
// fan-out branch (fanout.ts). `buildDispatchContext` composes the abort signals,
// the pre-commit recorder, the streaming observability sink, the usage
// accumulator, tool scoping, and the handler context — the block both paths
// once carried as near-identical copies. Also holds the per-run `RunDeps`
// bundle, the store-reading lazy caches (graph / outputs), and the small
// fan-out append-opts merge. This file does store I/O, so it is on
// decision-core-discipline.test.ts's IO_ALLOWED list.

import type { ExecutionEnvironment, Graph, OutputsValue } from "@fragua/core";
import * as core from "@fragua/core/handler";
import type { FactEvent, IEventReader, IEventWriter } from "@fragua/store";
import type { ExecutorOpts, LeakBudget } from "./executor.ts";
import { armTimeout, buildSubstitutionArgs, composeAbortSignals, makeUsageAccumulator } from "./executor-helpers.ts";
import type { GraphLoader } from "./graph-loader.ts";
import type { OccController } from "./occ-append.ts";
import { CommittingRecorder } from "./recorder.ts";
import type { RunTurnState } from "./run-turn-state.ts";

// Observability is best-effort streaming telemetry, not a transactional bundle:
// flush on a 50ms timer so the SSE poll (~100ms) can deliver mid-call deltas;
// cap the buffer at 64 events so a bursty provider can't pin memory.
const OBSERVABILITY_FLUSH_INTERVAL_MS = 50;
const OBSERVABILITY_FLUSH_SIZE_THRESHOLD = 64;

/** Immutable per-run dependency bundle threaded into the dispatch / fan-out
 * functions alongside the mutable {@link RunTurnState}. Assembled once in
 * `runOneInner`. */
export interface RunDeps {
  opts: ExecutorOpts;
  runId: string;
  /** The per-`runOne` OCC conflict controller (warn / halt escalation). */
  occ: OccController;
  /** Parse-once graph loader (shared across runs when the daemon passes one). */
  loader: GraphLoader;
  /** Per-process handler-leak budget. */
  leakBudget: LeakBudget;
  /** Grace period beyond `maxMs` before a node is treated as leaked. */
  leakGrace: number;
  /** Production ceiling on handler dispatches within this run. */
  maxLoops: number;
  /** Max consecutive handler aborts on the same node before `abort_loop`. */
  abortLoopCeiling: number;
  /** Per-fan-out-branch wall-clock backstop when neither the branch nor its
   * `parallel` node sets a tighter bound. */
  fanoutBranchTimeoutMs: number;
  /** Wall-clock provider for timestamps that land in persistent state. */
  clock: () => number;
  /** PRNG for retry/provider-retry backoff jitter. */
  random: () => number;
}

export type FanoutAppendOpts = { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number };

export type ObservabilitySink = {
  push: (ev: { type: string; payload: Record<string, unknown> }) => void;
  flush: () => void;
};

export type UsageAccumulator = ReturnType<typeof makeUsageAccumulator>;

/** Merge the operator fold's append opts with a branch plan's. Key-wise merge on
 * `routingPatch` (plan wins per key) — a shallow spread would silently REPLACE
 * the fold's routingDelta with the plan's patch while `advanceAppliedTo` still
 * committed, durably consuming the operator intent without applying it. */
export function mergeFanoutAppendOpts(fold: FanoutAppendOpts, plan: FanoutAppendOpts): FanoutAppendOpts {
  const merged: FanoutAppendOpts = { ...fold, ...plan };
  if (fold.routingPatch !== undefined && plan.routingPatch !== undefined) {
    merged.routingPatch = { ...fold.routingPatch, ...plan.routingPatch };
  }
  if (fold.advanceAppliedTo !== undefined && plan.advanceAppliedTo !== undefined) {
    merged.advanceAppliedTo = Math.max(fold.advanceAppliedTo, plan.advanceAppliedTo);
  }
  return merged;
}

/** The optional per-run context fields, applied identically at the linear and
 * the fan-out-branch dispatch sites so a field added to one can't be silently
 * missing inside a `parallel` branch. */
export function applyOptionalCtxFields(
  ctxOpts: core.BuildContextOpts,
  runEnv: ExecutionEnvironment | undefined,
  judgeClient: core.JudgeClient | undefined,
): void {
  if (runEnv !== undefined) ctxOpts.env = runEnv;
  if (judgeClient !== undefined) ctxOpts.judge = judgeClient;
}

/** A node's allowed/denied tool scope from its graph attrs — hard-filters
 * `ctx.tools` at HandlerContext construction so a handler can't reach a tool the
 * node didn't declare. Shared by the linear + fan-out dispatch paths. */
export function readToolScope(nodeAttrs: { allowed_tools?: unknown; denied_tools?: unknown } | undefined): {
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
} {
  const scope: { allowedTools?: readonly string[]; deniedTools?: readonly string[] } = {};
  if (Array.isArray(nodeAttrs?.allowed_tools)) scope.allowedTools = nodeAttrs.allowed_tools as readonly string[];
  if (Array.isArray(nodeAttrs?.denied_tools)) scope.deniedTools = nodeAttrs.denied_tools as readonly string[];
  return scope;
}

/** Per-dispatch observability buffer with the mid-handler streaming flush — a
 * soft coalescing timer plus a hard size ceiling. Shared by the linear and
 * fan-out dispatch paths so this batching can't drift between them. */
export function makeObservabilitySink(store: IEventWriter, runId: string, label: string): ObservabilitySink {
  const buffer: { type: string; payload: Record<string, unknown> }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const drained = buffer.splice(0, buffer.length);
    try {
      store.appendObservabilityEvents(runId, drained);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[executor] ${label} observability flush failed for run ${runId}:`, err);
    }
  };
  const push = (ev: { type: string; payload: Record<string, unknown> }): void => {
    buffer.push(ev);
    if (buffer.length >= OBSERVABILITY_FLUSH_SIZE_THRESHOLD) {
      flush();
      return;
    }
    if (timer == null) timer = setTimeout(flush, OBSERVABILITY_FLUSH_INTERVAL_MS);
  };
  return { push, flush };
}

/** Pre-fetch all emitted outputs for a run from the outputs index and fold them
 * into a `Record<nodeId, OutputsValue>` with last-write-wins semantics. */
function resolveRunOutputs(store: IEventReader, runId: string): Record<string, OutputsValue> | undefined {
  const rows = store.getOutputsForRun(runId);
  if (rows.length === 0) return undefined;
  const out: Record<string, OutputsValue> = {};
  for (const row of rows) {
    try {
      out[row.nodeId] = JSON.parse(row.struct) as OutputsValue;
    } catch {
      // Corrupt row — skip.
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Lazy per-run graph cache. Parsed once on first edge-selection need; held on
 * `state` so repeated `graphFor` calls skip even the loader's map lookup. Sets
 * `workflowUnparseable` / `workflowParseError` when the workflow row exists but
 * won't parse. */
export function graphFor(deps: RunDeps, state: RunTurnState, workflowSha: string | null): Graph | null {
  if (workflowSha == null) return null;
  if (state.cachedGraph != null) return state.cachedGraph;
  const result = deps.loader.load(workflowSha);
  if (result.ok) {
    state.cachedGraph = result.graph;
    return state.cachedGraph;
  }
  if (result.reason === "unparseable") {
    state.workflowUnparseable = true;
    state.workflowParseError = result.errorMessage;
  }
  return null;
}

/** Lazy per-run outputs cache — folded once and reused until a committed fact
 * carries fresh `outputs`. */
export function outputsFor(deps: RunDeps, state: RunTurnState): Record<string, OutputsValue> | undefined {
  if (!state.outputsCacheValid) {
    state.cachedOutputs = resolveRunOutputs(deps.opts.store, deps.runId);
    state.outputsCacheValid = true;
  }
  return state.cachedOutputs;
}

/** Invalidate the outputs cache when a committed fact carries fresh `outputs`
 * — the sole writer of the index on the live path. */
export function invalidateOutputsCacheIf(state: RunTurnState, facts: readonly FactEvent[]): void {
  if (facts.some((f) => f.type === "fact.node_completed" && (f.payload as { outputs?: unknown }).outputs != null)) {
    state.outputsCacheValid = false;
  }
}

/** The wiring pieces `buildDispatchContext` returns for a caller to invoke a
 * handler and interpret its outcome. */
export interface BuiltDispatch {
  steerCtrl: AbortController;
  signal: AbortSignal;
  releaseSignal: () => void;
  deadlines: Array<() => void>;
  recorder: CommittingRecorder;
  obs: ObservabilitySink;
  usage: UsageAccumulator;
  ctxOpts: core.BuildContextOpts;
}

/** Compose the per-dispatch abort signals + deadlines, the pre-commit recorder,
 * the streaming observability sink, the usage accumulator, tool scoping, and the
 * base handler-context opts. The linear path passes a reactive-budget
 * `onCostRecorded` hook; the branch path passes a plain `mirrorCostRecorded`.
 * Path-specific ctx fields (`humanInput`, `steering`, `budgetSnapshot`) are added
 * by the caller before `buildHandlerContext`. */
export function buildDispatchContext(args: {
  deps: RunDeps;
  state: RunTurnState;
  nodeId: string;
  iteration: number;
  routing: Readonly<Record<string, unknown>>;
  spec: core.HandlerSpec;
  graph: Graph | null;
  nodeAttrs: { allowed_tools?: unknown; denied_tools?: unknown } | undefined;
  initialVersion: number;
  obsLabel: string;
  /** Extra wall-clock backstop (the fan-out branch deadline). */
  backstopMs?: number;
  onCostRecorded: (
    payload: Record<string, unknown>,
    wiring: { obs: ObservabilitySink; usage: UsageAccumulator; steerCtrl: AbortController },
  ) => void;
}): BuiltDispatch {
  const { deps, state, nodeId, iteration, routing, spec, graph, nodeAttrs, initialVersion, obsLabel, onCostRecorded } =
    args;
  const opts = deps.opts;
  const steerCtrl = new AbortController();
  const signals: AbortSignal[] = [steerCtrl.signal, opts.shutdownSignal];
  const deadlines: Array<() => void> = [];
  if (spec.maxMs !== undefined) {
    const t = armTimeout(spec.maxMs);
    signals.push(t.signal);
    deadlines.push(t.disarm);
  }
  if (args.backstopMs !== undefined) {
    const backstop = armTimeout(args.backstopMs);
    signals.push(backstop.signal);
    deadlines.push(backstop.disarm);
  }
  const { signal, release: releaseSignal } = composeAbortSignals(signals);
  const recorder = new CommittingRecorder({
    store: opts.store,
    runId: deps.runId,
    nodeId,
    iteration,
    initialVersion,
  });
  const obs = makeObservabilitySink(opts.store, deps.runId, obsLabel);
  const usage = makeUsageAccumulator();
  const { allowedTools, deniedTools } = readToolScope(nodeAttrs);
  const ctxOpts: core.BuildContextOpts = {
    runId: deps.runId,
    nodeId,
    iteration,
    signal,
    routing,
    store: opts.store,
    llm: core.makeLlmClient({
      signal,
      call: opts.llmCall,
      accounting: usage.accounting,
    }),
    http: core.makeHttpClient(
      opts.defaultHttpTimeoutMs != null ? { signal, defaultTimeoutMs: opts.defaultHttpTimeoutMs } : { signal },
    ),
    tools: opts.tools,
    recorder,
    args: buildSubstitutionArgs(routing as Record<string, unknown>, graph?.attrs.inputs, outputsFor(deps, state)),
    emitObservability: (type, payload) => {
      obs.push({ type, payload: { nodeId, iteration, ...payload } });
      if (type === "cost.recorded") onCostRecorded(payload as Record<string, unknown>, { obs, usage, steerCtrl });
    },
  };
  if (allowedTools !== undefined) ctxOpts.allowedTools = allowedTools;
  if (deniedTools !== undefined) ctxOpts.deniedTools = deniedTools;
  applyOptionalCtxFields(ctxOpts, state.runEnv, opts.judgeClient);
  return { steerCtrl, signal, releaseSignal, deadlines, recorder, obs, usage, ctxOpts };
}
