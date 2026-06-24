// Executor fiber — ARCHITECTURE.md §6.
//
// One executor loop per daemon. It repeatedly:
//   1. Polls for the next claimable run (concurrency-capped).
//   2. For each claimed run, walks turns until a terminal or paused state.
//   3. On each turn: fold intents, build handler context, dispatch, map
//      result → facts, commit via appendFact with OCC.
//
// No files, no sockets, no IPC. Just the store.

import {
  type ExecutionEnvironment,
  evaluateBudget,
  fanoutClosureUnion,
  type Graph,
  type OutputsValue,
  readGoalGateRetries,
  retryCountKey,
} from "@fragua/core";
import * as core from "@fragua/core/handler";
import {
  ConcurrencyError,
  EVENT_CONTRACT_VERSION,
  type FactEvent,
  type IDaemonCoordinator,
  type IEventReader,
  type IEventWriter,
  MIN_COMPATIBLE_CONTRACT_VERSION,
  materializeRouting,
  type RunState,
  readActiveNodes,
} from "@fragua/store";
import type { AbortRegistry } from "./abort-registry.ts";
import type { AutoTitler, TitleRequest } from "./auto-titler.ts";
import type { Dispatcher } from "./dispatch.ts";
import {
  armTimeout,
  BUDGET_WARNED_KEY,
  buildSubstitutionArgs,
  classifyAbortCause,
  composeAbortSignals,
  deriveResumeOf,
  errorMessage,
  MAX_LOOPS_OVERRIDE_KEY,
  makeUsageAccumulator,
  nodeRetryCount,
  passField,
  readBudgetOverrides,
  readBudgetWarned,
  readInputMap,
  readNumber,
  routingString,
  sleep,
} from "./executor-helpers.ts";
import { type FanoutPlan, planFanoutStep } from "./fanout-planner.ts";
import { type GraphLoader, makeGraphLoader } from "./graph-loader.ts";

// Compatibility re-exports: these helpers moved to executor-helpers.ts but
// are imported from executor.ts by tests and other call sites.
export { buildSubstitutionArgs, classifyAbortCause, resolveBackoff } from "./executor-helpers.ts";

import { planAbort } from "./abort-planner.ts";
import { invokeHandler } from "./invoke-handler.ts";
import { makeOccController, tryAppendFact } from "./occ-append.ts";
import { processOperatorActions } from "./operator-actions.ts";
import { CommittingRecorder } from "./recorder.ts";
import { abortResultToFacts, cancelToFacts } from "./result-to-facts.ts";
import { captureBoundarySnapshot, disposeTerminalWorktree } from "./snapshot-service.ts";
import { planTransition } from "./transition-planner.ts";
import { wakePending } from "./wake-pending.ts";
import type { Provisioner } from "./worktree-provisioner.ts";

type HandlerResult = core.HandlerResult;
type LlmCallFn = core.LlmCallFn;

/**
 * Outcome of a single dispatch turn. `dispatchOne` returns this so the
 * outer loop can decide whether to continue iterating or exit (because
 * the run reached a terminal / paused state, or another short-circuit).
 */
export type DispatchOutcome = { kind: "terminal" } | { kind: "continue" };

/** Default cap on concurrent in-flight fan-out sub-nodes when a `parallel` node
 * declares no `concurrency:`. Bounds agent loops + provider connections opened
 * at once (the semaphore is `map`'s prerequisite). */
const DEFAULT_FANOUT_CONCURRENCY = 8;

/** Wall-clock backstop per fan-out branch when neither the branch (`max_ms`) nor
 * the `parallel` node (`timeout-minutes:` → its own `max_ms`) bounds it. A branch
 * is a read-class deliberation step, so an unbounded llm loop that never
 * self-terminates would otherwise dam the join forever (the live post-mortem's
 * runaway lens). The branch's own bound still wins when tighter (min via
 * AbortSignal.any). Override per-executor with `fanoutBranchTimeoutMs`. The
 * effective armed deadline rides each AbortRegistry entry, so the supervisor's
 * leak watchdog budgets against exactly this value — never a re-derivation. */
export const DEFAULT_FANOUT_BRANCH_TIMEOUT_MS = 20 * 60_000;

/** Append attempts for a serialized fan-out commit before giving up — a benign
 * sibling-moved-version conflict just re-reads and retries the append. */
const FANOUT_COMMIT_ATTEMPTS = 8;

type FanoutAppendOpts = { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number };

/** Outcome of a serialized fan-out commit. A tagged `false`: `occ` is genuine
 * OCC exhaustion (feed the conflict controller), `status` is the run leaving
 * `running` under us (don't — it's already parked). */
type CommitResult = { ok: true } | { ok: false; reason: "occ" | "status" };

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
 * an early-terminal exit (leak-halt or a commit-fail) — without it the abandoned
 * siblings keep running their LLM handlers to the per-branch backstop, burning
 * cost on work whose late commit just no-ops. Named `AbortError` so the branch
 * classifies it as a plain abort (not a timeout, not a leak). */
class FanoutBailError extends Error {
  constructor(public readonly runId: string) {
    super(`fan-out pool bailed for ${runId}`);
    this.name = "AbortError";
  }
}

/** Outcome of executing one fan-out branch sub-node (executeBranchNode). The
 * facts are NODE-scoped (node_completed + outputs, or node_aborted); runFanout
 * commits them serially and owns the run-level disposition. `skipped` is a
 * branch that acquired its semaphore slot only after the pool bailed — it never
 * executed, so there is nothing to commit. */
type BranchOutcome =
  | { kind: "success"; nodeId: string; nextNode: string | undefined; facts: FactEvent[]; appendOpts: FanoutAppendOpts }
  | { kind: "abort"; nodeId: string; facts: FactEvent[] }
  | { kind: "leak"; nodeId: string; leakedAt: number }
  | { kind: "skipped"; nodeId: string };

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

/** A clean proceed decision for a branch sub-node — branches consume no operator
 * fold (the fan-out applies it once at the superstep boundary, not per branch).
 * Deep-frozen: the constant is shared across every concurrent branch, so a
 * future consumer pushing into `appliedSeqs` or patching `routingDelta` would
 * silently cross-corrupt branches — freezing turns that into a loud throw. */
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

export interface ExecutorOpts {
  store: IEventWriter & IEventReader & IDaemonCoordinator;
  dispatcher: Dispatcher;
  registry: AbortRegistry;
  tools: core.ToolRegistry;
  llmCall: LlmCallFn;
  maxConcurrentRuns: number;
  /** Upper bound on node-less poll waits in ms. Tests inject a smaller value. */
  pollIntervalMs?: number;
  /** Grace period beyond handler maxMs before we treat the node as leaked. */
  leakGraceMs?: number;
  /** Per-fan-out-branch wall-clock backstop (ms) when neither the branch nor
   * its `parallel` node sets a tighter bound. Defaults to
   * `DEFAULT_FANOUT_BRANCH_TIMEOUT_MS`. Tests inject a small value to exercise
   * the hung-branch deadline. */
  fanoutBranchTimeoutMs?: number;
  /** Hook for tests to stop after N turns; defaults to ∞. */
  maxTurnsForTesting?: number;
  /** Production ceiling on handler dispatches within a single run. When
   * exceeded, the run halts with `reason: "max_loops"`. Defaults to
   * `DEFAULT_MAX_LOOPS`. Distinct from `maxTurnsForTesting`, which is a
   * silent test escape hatch. */
  maxLoops?: number;
  /** AbortSignal that stops the executor loop. */
  shutdownSignal: AbortSignal;
  /** Optional auto-titler. When set, `titleRun` fires once per run just
   * after `fact.run_started` is durably committed. */
  autoTitler?: AutoTitler;
  /** Optional worktree provisioner. When set, the executor calls
   * `ensure(runId)` before any handler dispatches so the per-run env
   * is ready, and `dispose(runId)` once the run reaches a terminal
   * status. When unset, handlers fall back to their construction-time
   * env (tests, bare-bones daemons). */
  provisioner?: Provisioner;
  /** Optional shared parse-once boundary. When omitted, each runOne
   * builds its own loader from `opts.store` (existing tests pass no
   * loader). The daemon passes one shared loader so a workflow's source
   * parses once across every run rather than once per run. */
  graphLoader?: GraphLoader;
  /** Max time to wait for in-flight runs to drain on shutdown. Past
   * this, the executor returns anyway — the shutdown signal has
   * already tripped handler aborts. Defaults to 30s. */
  shutdownDrainMs?: number;
  /** Default HTTP request timeout handed to `makeHttpClient` for each
   * handler context. Absent = no default; per-request `init.signal`
   * or `AbortSignal.timeout()` still apply. */
  defaultHttpTimeoutMs?: number;
  /** Cap on leaked handlers (Promise.race lost to timeoutReject because
   * the handler ignored its AbortSignal past `maxMs + leakGrace`). When
   * the per-process counter crosses this, `onLeakLimitExceeded` fires.
   * Defaults to `DEFAULT_MAX_LEAKED_HANDLERS`. */
  maxLeakedHandlers?: number;
  /** Maximum consecutive handler aborts on the same node before the
   * executor halts the run with `reason: "abort_loop"`. The counter
   * resets on any non-abort handler return (transition / yield_human /
   * halt), which implicitly defines "progress" as "the handler ran
   * to completion at least once." Aborts always happen on the run's
   * current_node (fact.node_aborted doesn't transition), so consecutive
   * aborts are by construction same-node. Defaults to
   * `DEFAULT_ABORT_LOOP_CEILING`. An `abort_loop_warning` observability
   * event fires one abort before the limit so the trend is visible
   * before the halt lands. */
  abortLoopCeiling?: number;
  /** Wall-clock provider for timestamps that land in persistent state
   * (e.g. `fact.handler_timeout_leaked.payload.leakedAt`). Defaults to
   * `Date.now`. Tests pin a fake clock here when they want hermetic
   * fact payloads — the store's own `now` covers the events row's
   * `ts` column, but payload fields go through this. Local-timing
   * measurements (`start = Date.now()` for duration accounting) bypass
   * this on purpose; they don't affect projection state. */
  clock?: () => number;
  /** PRNG used for retry/provider-retry backoff jitter — the only
   * non-deterministic input on the step path besides `clock`. Defaults to
   * `Math.random`. Injected (alongside `clock`) so a fault-injecting /
   * property-based harness can drive the executor fully deterministically. */
  random?: () => number;
  /** Called when the per-process leaked-handler counter crosses
   * `maxLeakedHandlers`. Default: log to stderr (tests use this). The
   * production daemon entrypoint wires this to `ctrl.abort()` so the
   * outer shutdown drain takes over and the singleton + sweep recover
   * stuck runs on restart, and records `leaked` (the leaked
   * runId/nodeId pairs, leak order) on the `daemon.stopped` payload.
   * The callback fires at most once per process. */
  onLeakLimitExceeded?: (count: number, leaked: ReadonlyArray<{ runId: string; nodeId: string }>) => void;
}

const DEFAULT_POLL_MS = 50;
// 30s gives a llm handler mid-bash-tool room to honour `signal`
// cleanly: SIGTERM → SIGKILL escalation, file-handle close, fdsync,
// pi-ai abort latency, in-flight blob writes. 10s was too tight on
// real long-running children.
const DEFAULT_LEAK_GRACE_MS = 30_000;
const DEFAULT_SHUTDOWN_DRAIN_MS = 30_000;
const DEFAULT_ABORT_LOOP_CEILING = 5;
const DEFAULT_MAX_LOOPS = 1_000;
const DEFAULT_MAX_LEAKED_HANDLERS = 3;

// Observability is best-effort streaming telemetry, not a transactional
// bundle: SSE consumers tail the events table to render live state, and
// holding an LLM round's deltas until end-of-turn made the conversation
// view land all at once instead of streaming. Flush on a 50ms timer so
// the SSE poll (~100ms) can deliver mid-call deltas; cap the buffer at
// 64 events so a bursty provider can't pin memory or produce a
// pathologically large render-side batch. The end-of-turn drain still
// runs so the trail lands before the terminal fact in causal order.
const OBSERVABILITY_FLUSH_INTERVAL_MS = 50;
const OBSERVABILITY_FLUSH_SIZE_THRESHOLD = 64;

/**
 * Executor loop. Claims queued runs and dispatches each on its own
 * async fiber (fire-and-forget) so many runs can progress concurrently —
 * `store.claimNextRun(maxConcurrentRuns)` is the authoritative capacity
 * gate. Its atomic `COUNT(*) WHERE status='running' < maxInFlight`
 * check (inside a write transaction) ensures we never exceed the cap,
 * even across restarts. An in-process Set would duplicate that truth
 * and desync on restart, so we don't keep one for capacity — only for
 * tracking shutdown drain.
 */
export async function runExecutor(opts: ExecutorOpts): Promise<void> {
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const drainMs = opts.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
  const inflight = new Set<Promise<void>>();
  // One leak budget per executor process — counts handler leaks across
  // every run; fires opts.onLeakLimitExceeded once when the limit trips.
  const leakBudget = makeLeakBudget(opts);
  while (!opts.shutdownSignal.aborted) {
    wakePending(opts.store);
    processOperatorActions(opts.store);
    const claimed = opts.store.claimNextRun(opts.maxConcurrentRuns);
    if (claimed == null) {
      await sleep(pollMs, opts.shutdownSignal);
      continue;
    }
    const p = runOneSafe(claimed.runId, opts, leakBudget);
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }

  // Shutdown drain: stop accepting new claims (loop exited), then wait
  // for in-flight runs to reach terminal within `drainMs`. The shutdown
  // signal has already been observed by handlers via their AbortSignal,
  // so they should wrap up quickly. On timeout we return anyway —
  // leaked handlers will land `fact.run_terminated{errored}` via their own catch
  // blocks, or the next startup sweep will requeue stuck runs.
  if (inflight.size > 0) {
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...inflight]).then(() => {}),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, drainMs);
      }),
    ]);
    // Clear the drain timer when the in-flight runs settled first, so a
    // long drainMs doesn't keep a timer (and the process) alive after the
    // executor has nothing left to wait for.
    if (drainTimer !== undefined) clearTimeout(drainTimer);
  }
}

/** runOne that never rejects — logs unhandled errors and ensures a
 * terminal fact was already appended by runOne's own crash path. */
async function runOneSafe(runId: string, opts: ExecutorOpts, leakBudget: LeakBudget): Promise<void> {
  try {
    await runOne(runId, opts, leakBudget);
  } catch (err) {
    // runOne appends `fact.run_terminated{errored}` before rethrowing on crash; this
    // catch just prevents an unhandled promise rejection from crashing
    // the daemon. Once shutdown is in progress, errors are expected
    // unwind noise (handlers that ignored their abort hitting a torn-
    // down store): the startup sweep will requeue the run on restart,
    // and a real production crash mid-shutdown can't be distinguished
    // here anyway. Stay silent.
    if (opts.shutdownSignal.aborted) return;
    // eslint-disable-next-line no-console
    console.error(`[executor] run ${runId} crashed:`, err);
  }
}

export async function runOne(runId: string, opts: ExecutorOpts, leakBudget?: LeakBudget): Promise<void> {
  const budget = leakBudget ?? makeLeakBudget(opts);
  try {
    await runOneInner(runId, opts, budget);
  } catch (err) {
    // Outer safety net: if the main body escaped without terminalising
    // the run, append `fact.run_terminated{errored}` so the `running` capacity slot
    // doesn't leak. Covers throws outside the existing inner try/catch
    // that wraps only `spec.handler(ctx)` — e.g. foldIntents / graphFor
    // / selectEdge / tryAppendFact failures. Belt-and-suspenders: the
    // store's startupSweep also requeues stuck `running` rows on
    // daemon restart.
    const state = opts.store.getState(runId);
    if (state != null && state.status === "running") {
      await tryAppendFact(opts.store, runId, state.version, [
        {
          type: "fact.run_terminated",
          payload: {
            status: "errored",
            reason: "error",
            detail: `executor crashed at ${state.currentNode ?? "<no-node>"}: ${errorMessage(err)}`,
          },
        },
      ]);
    }
    throw err;
  }
}

async function runOneInner(runId: string, opts: ExecutorOpts, leakBudget: LeakBudget): Promise<void> {
  const leakGrace = opts.leakGraceMs ?? DEFAULT_LEAK_GRACE_MS;
  const maxTurns = opts.maxTurnsForTesting ?? Number.POSITIVE_INFINITY;
  const maxLoops = opts.maxLoops ?? DEFAULT_MAX_LOOPS;
  const abortLoopCeiling = opts.abortLoopCeiling ?? DEFAULT_ABORT_LOOP_CEILING;
  const clock = opts.clock ?? Date.now;
  const random = opts.random ?? Math.random;
  const fanoutBranchTimeoutMs = opts.fanoutBranchTimeoutMs ?? DEFAULT_FANOUT_BRANCH_TIMEOUT_MS;
  let consecutiveAborts = 0;
  // Per-branch abort streak under a fan-out, keyed by sub-node id. A run-wide
  // counter (`consecutiveAborts`) reset whenever ANY sibling succeeded, so a
  // single hard-failing branch could abort forever behind healthy siblings
  // (the live post-mortem's masking bug). Process-local, like consecutiveAborts:
  // a resume OR a daemon restart starts the streak fresh — so a branch that
  // aborts-then-crashes in a loop can outlast `abortLoopCeiling` across restarts.
  // Intended: this ceiling is best-effort liveness, not durable safety. The
  // DURABLE catch on a wedged branch is the per-branch timeout backstop
  // (`fanoutBranchTimeoutMs`) + the run-wide budget — neither resets on restart.
  const branchAborts = new Map<string, number>();
  // A fan-out park/terminal disposition whose commit lost its OCC race —
  // parked for re-commit at the next runFanout entry. Some dispositions
  // (a `fanout_branch_terminal` halt, a leak halt) derive from in-memory
  // branch outcomes that are gone next turn, so "re-derive from fresh
  // state" cannot recapture them; without this slot the halt was silently
  // lost and the run sailed through the join. Process-local: a crash in the
  // (OCC-exhausted → re-commit) window loses it, like branchAborts.
  let pendingFanoutDisposition: FactEvent[] | undefined;
  let turns = 0;
  // Dispatches counted for the max_loops ceiling. Incremented just before
  // each `spec.handler(ctx)` call — OCC-retry `continue`s and schema/start
  // bookkeeping iterations don't inflate the count. Pathological workflows
  // that loop without ever aborting (so ABORT_LOOP_CEILING doesn't fire)
  // halt here instead of running forever.
  let dispatches = 0;

  // OCC controller guards the unbounded `if (!ok) continue` retry path.
  // Each fact-append site that retries on `ConcurrencyError` reports the
  // conflict; the controller backs off, warns once, and halts the run on
  // exhaustion. Scoped to this runOne pass — see occ-append.ts.
  const occ = makeOccController({ store: opts.store, runId, shutdownSignal: opts.shutdownSignal });
  const onOccConflict = occ.onConflict;
  const onOccResolved = occ.onResolved;

  let runEnv: ExecutionEnvironment | undefined;
  const loader = opts.graphLoader ?? makeGraphLoader(opts.store);
  // Lazy per-run graph cache. Parsed once (in the loader) on first
  // edge-selection need; held here so repeated graphFor calls within a
  // run skip even the loader's map lookup.
  let cachedGraph: Graph | null = null;
  // Distinguishes "no graph available" (workflow row missing — bare test
  // fixtures) from "the workflow row exists but won't parse". Only the
  // latter halts the run; graphFor returns null for both.
  let workflowUnparseable = false;
  let workflowParseError: string | undefined;
  const graphFor = (workflowSha: string | null): Graph | null => {
    if (workflowSha == null) return null;
    if (cachedGraph != null) return cachedGraph;
    const result = loader.load(workflowSha);
    if (result.ok) {
      cachedGraph = result.graph;
      return cachedGraph;
    }
    if (result.reason === "unparseable") {
      workflowUnparseable = true;
      workflowParseError = result.errorMessage;
    }
    return null;
  };

  // Lazy per-run outputs cache. `resolveRunOutputs` scans the outputs index and
  // JSON-parses every row; called per dispatch it was O(dispatches · outputs)
  // (worst in emit-each-iteration loops). Cache the folded map and invalidate
  // only when a committed fact carries fresh `outputs` — the sole writer of the
  // index on the live path. Turns that emit no outputs (the common case) reuse it.
  let cachedOutputs: Record<string, OutputsValue> | undefined;
  let outputsCacheValid = false;
  const outputsFor = (): Record<string, OutputsValue> | undefined => {
    if (!outputsCacheValid) {
      cachedOutputs = resolveRunOutputs(opts.store, runId);
      outputsCacheValid = true;
    }
    return cachedOutputs;
  };
  const invalidateOutputsCacheIf = (facts: readonly FactEvent[]): void => {
    if (facts.some((f) => f.type === "fact.node_completed" && (f.payload as { outputs?: unknown }).outputs != null)) {
      outputsCacheValid = false;
    }
  };

  const dispatchOne = async (): Promise<DispatchOutcome> => {
    const state = opts.store.getState(runId);
    if (state == null) return { kind: "terminal" };
    const workflowSha = state.workflowSha;

    if (
      state.status === "completed" ||
      state.status === "cancelled" ||
      state.status === "halted" ||
      state.status === "paused" ||
      state.status === "paused_human" ||
      state.status === "paused_auto" ||
      state.status === "quarantined"
    ) {
      return { kind: "terminal" };
    }

    // Event-contract version gate. A run pins EVENT_CONTRACT_VERSION at
    // enqueue; pins in [MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]
    // fold cleanly. The contract version is DISTINCT from the DB-migration
    // counter (CURRENT_SCHEMA_VERSION) — it bumps only on real fact/intent/
    // reducer changes, so projection-only migrations never trip this gate.
    // An out-of-range pin is RECOVERABLE, not terminal — park the run as
    // `paused{engine_incompatible}` instead of killing it (a downgraded daemon
    // gets upgraded; an imported run lands on a store that later catches up).
    // The payload carries the window, so the operator/UI infers too-new
    // (`pinnedVersion > supportedMax`) vs too-old (`< supportedMin`) without a
    // second reason. Capability-gated auto-wake for the too-new arm is deferred
    // — see docs/proposals/archive/event-contract-version.md §3.2.
    if (state.contractVersion < MIN_COMPATIBLE_CONTRACT_VERSION || state.contractVersion > EVENT_CONTRACT_VERSION) {
      await tryAppendFact(opts.store, runId, state.version, [
        {
          type: "fact.run_paused",
          payload: {
            reason: "engine_incompatible",
            pinnedVersion: state.contractVersion,
            supportedMin: MIN_COMPATIBLE_CONTRACT_VERSION,
            supportedMax: EVENT_CONTRACT_VERSION,
          },
        },
      ]);
      return { kind: "terminal" };
    }

    // Unparseable workflow refusal. A workflow whose source won't parse
    // can't have its edges resolved, so the executor's "graph unavailable
    // → route to __end__" fallback would otherwise let the run complete
    // as a success — masking a broken workflow. Halt instead. (The
    // validator catches this at `fragua validate` / enqueue; this is the
    // last-resort runtime guard for a row that slipped through.)
    if (workflowSha != null) {
      graphFor(workflowSha);
      if (workflowUnparseable) {
        await tryAppendFact(opts.store, runId, state.version, [
          {
            type: "fact.run_terminated",
            payload: { status: "errored", reason: "error", detail: workflowParseFailedDetail(workflowParseError) },
          },
        ]);
        return { kind: "terminal" };
      }
    }

    // Fold unapplied intents into a single decision.
    const unapplied = opts.store.getUnappliedIntents(runId);
    const decision = core.foldIntents(unapplied, state.status);

    // Audit dropped intents before any state transition so SSE consumers
    // see them in causal order with the eventual fact.
    if (decision.dropped.length > 0) {
      const obs = decision.dropped.map((d) => ({
        type: "intent.dropped",
        payload: { originalSeq: d.seq, originalType: d.type, reason: d.reason },
      }));
      opts.store.appendObservabilityEvents(runId, obs);
    }

    if (decision.kind === "cancel") {
      const ok = await tryAppendFact(opts.store, runId, state.version, cancelToFacts(decision.intentSeq));
      // An OCC conflict here doesn't mean the run is done — a concurrent
      // writer advanced the version. Route through the same retry/ceiling
      // controller as every other append so the cancel is re-attempted
      // against fresh state instead of being silently swallowed (which
      // stranded the run as `running`).
      if (!ok) {
        const { halted } = await onOccConflict(
          "fact.run_terminated",
          state.currentNode ?? "",
          nodeRetryCount(state.routing, state.currentNode ?? ""),
          state.version,
        );
        if (halted) return { kind: "terminal" };
        return { kind: "continue" };
      }
      return { kind: "terminal" };
    }

    // Effective routing for this dispatch: state.routing is the
    // PROJECTION view (pre-fold). The fold's `routingDelta` is what
    // operator intents queued for this turn would write — e.g.
    // `intent.budget_adjusted` writes `budget_override.<scope>.<metric>`,
    // `intent.max_retries_adjusted` writes `max_retries_override.<nodeId>`,
    // etc. Without this merge the reactive budget gate (and other
    // per-turn override readers) would see the pre-fold values on the
    // FIRST dispatch after a Raise & Resume — handler aborts at the
    // old ceiling, intent stays unapplied because the abort skips the
    // post-handler commit, resume loops indefinitely. Compute once so
    // every per-turn reader (budget overrides, max_retries override,
    // max_loops override, etc.) sees the same view.
    const rawEffectiveRouting: Readonly<Record<string, unknown>> =
      Object.keys(decision.routingDelta).length > 0 ? { ...state.routing, ...decision.routingDelta } : state.routing;
    // Resolve any $fragua_blob refs in routing.inputs so downstream readers
    // (substitution, auto-titler seed) see the full string values. Structural
    // keys (budget_override, max_retries_override, …) never carry blob refs,
    // so materialization is a shallow no-op for the vast majority of turns.
    const effectiveRouting: Readonly<Record<string, unknown>> = materializeRouting(
      rawEffectiveRouting as Record<string, unknown>,
      (sha) => {
        const bytes = opts.store.readBlob(sha);
        if (bytes == null) throw new Error(`routing blob missing: ${sha}`);
        return bytes;
      },
    );

    if (decision.shouldPause) {
      const paused = await tryAppendFact(
        opts.store,
        runId,
        state.version,
        [
          {
            type: "fact.run_paused",
            payload: {
              reason: "operator",
              nodeId: state.currentNode ?? "",
            },
          },
        ],
        // Advance lastAppliedSeq so the pause intent (and any hitched-along
        // intents that were folded into appliedSeqs) doesn't refire on
        // the next dispatch after wakePending moves the run back to queued.
        decision.appliedSeqs.length > 0 ? { advanceAppliedTo: Math.max(...decision.appliedSeqs) } : undefined,
      );
      // Same OCC handling as the cancel arm above: a swallowed conflict here
      // dropped the pause AND exited the executor — a `running` zombie with
      // the pause intent still queued.
      if (!paused) {
        const { halted } = await onOccConflict(
          "fact.run_paused",
          state.currentNode ?? "",
          nodeRetryCount(state.routing, state.currentNode ?? ""),
          state.version,
        );
        if (halted) return { kind: "terminal" };
        return { kind: "continue" };
      }
      return { kind: "terminal" };
    }

    // Identify the node to run. `claimNextRun` flips status to 'running' but
    // leaves current_node NULL — treat that as the "just-claimed" signal and
    // emit run_started to pin the start node. The start node comes from
    // routing.start_node, defaulting to "start".
    const currentNode = state.currentNode;
    const needsStart = state.currentNode == null && (state.status === "queued" || state.status === "running");

    // Provision the run's worktree before the first fact.run_started
    // commits. If init fails, the run is halted with a clear reason
    // and the provisioner is responsible for any partial-state
    // cleanup. After the first successful provision, runEnv is cached
    // locally and reused on every subsequent turn — `ensure` is
    // idempotent but we avoid the extra lookup.
    if (opts.provisioner && runEnv === undefined) {
      try {
        const provisionOpts: { cwd?: string } = {};
        if (state.cwd != null) provisionOpts.cwd = state.cwd;
        runEnv = await opts.provisioner.ensure(runId, provisionOpts);
        opts.store.appendDaemonEvent({ type: "daemon.worktree_provisioned", payload: { runId, ok: true } }, { runId });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        opts.store.appendDaemonEvent(
          { type: "daemon.worktree_provisioned", payload: { runId, ok: false, errorDetail: detail } },
          { runId },
        );
        await tryAppendFact(opts.store, runId, state.version, [
          {
            type: "fact.run_terminated",
            payload: {
              status: "errored",
              reason: "worktree_error",
              detail: `worktree_provision_failed: ${detail}`,
            },
          },
        ]);
        return { kind: "terminal" };
      }
    }

    if (needsStart) {
      const start = routingString(state.routing, "start_node") ?? "start";
      const baseGitSha = opts.provisioner?.baseGitSha(runId) ?? undefined;
      const baseGitRef = opts.provisioner?.baseGitRef(runId) ?? undefined;
      const startFacts: FactEvent[] = [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: state.workflowSha,
            contractVersion: state.contractVersion,
            startNode: start,
            ...(baseGitSha != null ? { baseGitSha } : {}),
            ...(baseGitRef != null ? { baseGitRef } : {}),
          },
        },
      ];
      // Seed graph-level routing keys at run start so the agent backend
      // can pick up the workflow goal/label for system-prompt framing.
      // Internal plumbing, not user-facing context KV.
      const startGraph = graphFor(state.workflowSha);
      const startRoutingPatch: Record<string, unknown> = {};
      if (typeof startGraph?.attrs.goal === "string" && startGraph.attrs.goal !== "") {
        startRoutingPatch["graph.goal"] = startGraph.attrs.goal;
      }
      if (typeof startGraph?.attrs.label === "string" && startGraph.attrs.label !== "") {
        startRoutingPatch["graph.label"] = startGraph.attrs.label;
      }
      // Advance lastAppliedSeq on run_started so the supervisor doesn't
      // mistake the synthetic `intent.run_enqueued` (the queue marker
      // that caused this run to exist) for a fresh operator intent
      // mid-handler. Without this, the supervisor's first tick can land
      // mid-LLM-call and trip the controller (cause: "aborted",
      // tokens=0), causing a spurious re-dispatch. Fold's `applied`
      // already includes the run_enqueued seq; we just need to actually
      // persist it.
      const startAdvanceTo = decision.appliedSeqs.length > 0 ? Math.max(...decision.appliedSeqs) : undefined;
      const startAppendOpts: { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number } = {};
      if (Object.keys(startRoutingPatch).length > 0) startAppendOpts.routingPatch = startRoutingPatch;
      if (startAdvanceTo !== undefined) startAppendOpts.advanceAppliedTo = startAdvanceTo;
      const ok = await tryAppendFact(opts.store, runId, state.version, startFacts, startAppendOpts);
      if (!ok) {
        const { halted } = await onOccConflict("fact.run_started", start, 0, state.version);
        if (halted) return { kind: "terminal" };
        return { kind: "continue" };
      }
      onOccResolved(start, 0);
      if (opts.autoTitler && state.title == null) {
        const graph = graphFor(workflowSha);
        const goal = graph?.attrs.goal;
        // Use effectiveRouting (already materialized) so spilled inputs appear
        // in the title seed as their full string values. `readInputMap` keeps
        // object / array leaves (a string map would drop them), so a workflow
        // whose identity lives in a structured input still seeds a real title.
        const inputLines = Object.entries(readInputMap(effectiveRouting["inputs"]))
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("\n");
        const wf = workflowSha != null ? opts.store.getWorkflow(workflowSha) : null;
        const workflowName = wf?.name;
        const parts: string[] = [];
        if (workflowName !== undefined) parts.push(`workflow=${workflowName}`);
        if (inputLines !== "") parts.push(inputLines);
        const seed = parts.join("\n");
        const req: TitleRequest = {
          runId,
          workflowSha,
          input: seed,
        };
        if (goal !== undefined) req.goal = goal;
        if (workflowName !== undefined) req.workflowName = workflowName;
        opts.autoTitler.titleRun(req);
      }
      return { kind: "continue" }; // Reload state next turn with the new run_started applied.
    }

    if (currentNode == null) return { kind: "terminal" };

    // `type: parallel` fan-out (Model A, docs/proposals/fan-out-nodes.md). The
    // frontier loop owns dispatch + barrier; `current_node` stays pinned to the
    // parallel node until the join. Branches run concurrently through the same
    // store, each sub-node durable on the log (the linearization invariant —
    // concurrent execute, serialized commit).
    if (graphFor(state.workflowSha)?.nodes[currentNode]?.type === "parallel") {
      return await runFanout(state, decision, currentNode, effectiveRouting);
    }

    // Stamp dispatchStartedAt before handing control to the handler
    // so activeMs accounting captures this dispatch interval.
    // fact.run_started covers the very first dispatch (it stamps
    // dispatchStartedAt directly via its own reducer case), so we
    // only emit here when the projection's dispatchStartedAt was
    // reset by a prior terminal/pause fact. This bookkeeping marker
    // turn precedes — and is deliberately NOT counted by — the
    // max_loops ceiling below: only turns that actually call a handler
    // consume the dispatch budget.
    if (state.dispatchStartedAt == null) {
      const dispatchIteration = nodeRetryCount(state.routing, currentNode);
      const dispatchPass = readGoalGateRetries(state.routing);
      const ok = await tryAppendFact(opts.store, runId, state.version, [
        {
          type: "fact.dispatch_started",
          payload: {
            nodeId: currentNode,
            iteration: dispatchIteration,
            ...passField(dispatchPass),
            resumeOf: deriveResumeOf(opts.store, runId),
          },
        },
      ]);
      if (!ok) {
        const { halted } = await onOccConflict("fact.dispatch_started", currentNode, dispatchIteration, state.version);
        if (halted) return { kind: "terminal" };
        return { kind: "continue" };
      }
      onOccResolved(currentNode, dispatchIteration);
      return { kind: "continue" };
    }

    // Production ceiling on handler dispatches. A workflow that loops
    // without ever aborting (so ABORT_LOOP_CEILING never fires) would
    // otherwise run until budget or wall-clock killed it. This is the
    // last-resort guard; workflow authors should bound loops via
    // `max_retries` on backward edges.
    //
    // The override key is read on every iteration so a Raise & Resume
    // adjustment takes effect on the next dispatch — `dispatches` is
    // a JS-local counter that resets on every runOne entry, so the
    // resume after a pause already starts at 0; the override raises
    // the ceiling for *this* dispatch loop's pass.
    const effectiveMaxLoops = readNumber(effectiveRouting[MAX_LOOPS_OVERRIDE_KEY]) || maxLoops;
    if (dispatches >= effectiveMaxLoops) {
      await tryAppendFact(opts.store, runId, state.version, [
        {
          type: "fact.run_paused",
          payload: {
            reason: "max_loops",
            currentLimit: effectiveMaxLoops,
            dispatches,
          },
        },
      ]);
      return { kind: "terminal" };
    }
    dispatches++;

    // Dispatch.
    const spec = opts.dispatcher.get(workflowSha, currentNode);
    const steerCtrl = new AbortController();
    const signals: AbortSignal[] = [steerCtrl.signal, opts.shutdownSignal];
    const deadlines: Array<() => void> = [];
    if (spec.maxMs !== undefined) {
      const t = armTimeout(spec.maxMs);
      signals.push(t.signal);
      deadlines.push(t.disarm);
    }
    const { signal, release: releaseSignal } = composeAbortSignals(signals);

    const iteration = nodeRetryCount(state.routing, currentNode);
    // Pre-commit recorder: each recordIntent/recordDone/recordFailed
    // commits its own short transaction so a hard crash mid-`fn` leaves
    // the intent durable in the event log. ARCHITECTURE.md §1.1.
    const recorder = new CommittingRecorder({
      store: opts.store,
      runId,
      nodeId: currentNode,
      iteration,
      initialVersion: state.version,
    });
    // Mid-handler streaming flush (see makeObservabilitySink) — shared with the
    // fan-out path. The leak / abort / completion paths call `obs.flush()`
    // unconditionally; the soft timer + hard ceiling live inside `obs.push`.
    const obs = makeObservabilitySink(opts.store, runId, "linear");

    const usage = makeUsageAccumulator();
    // Reactive budget halt: when a `cost.recorded` event mid-handler
    // pushes cumulative spend over a `budget_policy="stop"` ceiling,
    // we abort the in-flight handler and emit fact.run_terminated{errored,
    // reason:"budget"} alongside fact.node_aborted (which captures
    // partial spend). Without this bound, a handler that streams many
    // `cost.recorded` events in a single turn can overshoot the cap
    // several times over before the post-handler boundary check runs.
    let reactiveBudgetHaltDetail: string | undefined;
    // Symmetric to the halt path above, but for `budget_policy="pause"`
    // (the default). The reactive gate aborts the handler mid-flight
    // and the abort arm below emits `fact.run_paused{reason:"budget"}`
    // so the operator can raise the cap and resume. Bounds peak
    // overshoot to one in-flight LLM message.
    let reactiveBudgetPauseBreach:
      | { scope: "run" | "node"; metric: "cost" | "tokens"; limit: number; actual: number }
      | undefined;

    // Hard-filter ctx.tools by the node's allowed_tools / denied_tools.
    // A handler that reaches for `ctx.tools.get("bash")` on a node that
    // didn't allow "bash" gets `unknown tool: bash`, same as for an
    // unregistered tool. The filter lives at HandlerContext construction
    // so every handler kind respects the same structural enforcement.
    const graph = graphFor(state.workflowSha);
    const nodeAttrs = graph?.nodes[currentNode]?.attrs;
    const { allowedTools, deniedTools } = readToolScope(nodeAttrs);

    const ctxOpts: core.BuildContextOpts = {
      runId,
      nodeId: currentNode,
      iteration,
      signal,
      routing: effectiveRouting,
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
      args: buildSubstitutionArgs(effectiveRouting, graph?.attrs.inputs, outputsFor()),
      emitObservability: (type, payload) => {
        // Stamp nodeId + iteration so the UI can scope without the handler
        // threading it through every payload. (obs.push owns the soft timer +
        // hard size ceiling.)
        obs.push({ type, payload: { nodeId: currentNode, iteration, ...payload } });
        if (type === "cost.recorded") {
          usage.mirrorCostRecorded(payload as Record<string, unknown>);

          // Reactive budget gate. Bounds peak overshoot to one in-flight LLM
          // message rather than the turn's full spend. Fires once per dispatch —
          // the halt / pause flags short-circuit subsequent events. Both stop AND
          // pause policies abort mid-handler; the post-handler arm is the
          // belt-and-suspenders catch for handlers that don't emit cost.recorded.
          if (reactiveBudgetHaltDetail === undefined && reactiveBudgetPauseBreach === undefined) {
            const completedNodeAttrs = graph?.nodes[currentNode]?.attrs;
            const priorNodeBucket = state.metrics.nodeCosts[currentNode] ?? { tokens: 0, costUsd: 0 };
            const priorRunFresh = state.metrics.totalInputTokens + state.metrics.totalOutputTokens;
            const turn = usage.totals();
            // Read overrides from effective routing (post-fold) so the Raise &
            // Resume flow takes effect on the FIRST dispatch after resume.
            const overrides = readBudgetOverrides(effectiveRouting);
            const reactive = evaluateBudget({
              graphAttrs: graph?.attrs ?? {},
              ...(completedNodeAttrs !== undefined ? { completedNodeAttrs } : {}),
              completedNodeId: currentNode,
              cumulativeCostUsd: state.metrics.totalCostUsd + turn.totalCostUsd,
              cumulativeTokens: priorRunFresh + turn.turnBilled,
              nodeCumulativeCostUsd: priorNodeBucket.costUsd + turn.totalCostUsd,
              nodeCumulativeTokens: priorNodeBucket.tokens + turn.turnBilled,
              alreadyWarned: readBudgetWarned(effectiveRouting),
              ...(overrides !== undefined ? { overrides } : {}),
            });
            if (reactive.shouldHalt) {
              reactiveBudgetHaltDetail = reactive.haltReason ?? "";
              for (const ev of reactive.events) {
                obs.push({ type: ev.type, payload: { nodeId: currentNode, iteration, ...ev.payload } });
              }
              steerCtrl.abort(new Error("budget"));
            } else if (reactive.pauseBreach !== undefined) {
              reactiveBudgetPauseBreach = reactive.pauseBreach;
              for (const ev of reactive.events) {
                obs.push({ type: ev.type, payload: { nodeId: currentNode, iteration, ...ev.payload } });
              }
              steerCtrl.abort(new Error("budget_pause"));
            }
          }
        }
      },
    };
    if (allowedTools !== undefined) ctxOpts.allowedTools = allowedTools;
    if (deniedTools !== undefined) ctxOpts.deniedTools = deniedTools;
    if (decision.humanInput !== undefined) ctxOpts.humanInput = decision.humanInput;
    if (decision.steering !== undefined) ctxOpts.steering = decision.steering;
    if (runEnv !== undefined) ctxOpts.env = runEnv;
    // Budget snapshot at dispatch time. The backend embeds this verbatim
    // into `llm.start.budget` so the UI can render "X of Y used" without
    // cross-referencing the graph attrs. Only populated when at least one
    // ceiling (run-level or node-level cost) is configured. Operator
    // cap raises (`intent.budget_adjusted` → budget_override.*) win over
    // the static graph/node attrs so the snapshot agrees with what the
    // reactive gate actually enforces this turn — read from
    // effectiveRouting so a same-turn Raise & Resume is reflected.
    const budgetSnapshotOverrides = readBudgetOverrides(effectiveRouting);
    const runMaxCostUsd = budgetSnapshotOverrides?.run?.cost ?? graph?.attrs.budget_usd;
    const nodeMaxCostUsd = budgetSnapshotOverrides?.node?.cost ?? nodeAttrs?.max_cost_usd;
    if (typeof runMaxCostUsd === "number" || typeof nodeMaxCostUsd === "number") {
      const snap: core.BudgetSnapshotInput = {
        cumulative_cost_usd: state.metrics.totalCostUsd,
        cumulative_tokens: state.metrics.totalInputTokens + state.metrics.totalOutputTokens,
      };
      if (typeof runMaxCostUsd === "number") snap.run_max_cost_usd = runMaxCostUsd;
      if (typeof nodeMaxCostUsd === "number") snap.max_cost_usd = nodeMaxCostUsd;
      ctxOpts.budgetSnapshot = snap;
    }
    const ctx = core.buildHandlerContext(ctxOpts);

    let result: HandlerResult;
    let wasAborted = false;
    let abortCause: "timeout" | "aborted" = "aborted";
    let leakedTimeout = false;
    // Run the handler under the abort registry + leak watchdog (see
    // invoke-handler.ts), then interpret the structured outcome here —
    // abort-cause classification + reactive-budget reclassification need
    // this turn's `signal` and budget flags, so they stay in the loop.
    const invocation = await invokeHandler({
      spec,
      ctx,
      registry: opts.registry,
      runId,
      steerCtrl,
      leakGraceMs: leakGrace,
    });
    // The dispatch settled (result, leak, or throw) — disarm the deadline so
    // its timer stops pinning the composite signal + listener closures, and
    // release the composite's source listeners so the long-lived
    // shutdownSignal doesn't accumulate one per dispatch. NOT on leak: a
    // leaked handler still holds the composite, and a later registry abort
    // must still propagate to it.
    for (const disarm of deadlines) disarm();
    if (invocation.kind !== "leak") releaseSignal();
    if (invocation.kind === "leak") {
      leakedTimeout = true;
      result = { kind: "halt", reason: "error", detail: "timeout_leaked" };
    } else if (invocation.kind === "thrown") {
      wasAborted = invocation.abortByName;
      // The reactive budget gate aborts via steerCtrl with a plain
      // `Error("budget")` / `Error("budget_pause")`. A handler that
      // surfaces that by rethrowing `ctx.signal.reason` (rather than
      // letting an in-flight LLM call throw an AbortError) wouldn't look
      // like an abort by name — but it IS our abort, and must flow
      // through the abort arm so the budget halt/pause fact lands instead
      // of a generic `reason:"error"` halt.
      if (
        !wasAborted &&
        signal.aborted &&
        (reactiveBudgetHaltDetail !== undefined || reactiveBudgetPauseBreach !== undefined)
      ) {
        wasAborted = true;
      }
      if (wasAborted) abortCause = classifyAbortCause(signal, invocation.error);
      result = {
        kind: "halt",
        reason: "error",
        detail: errorMessage(invocation.error),
      };
    } else {
      result = invocation.result;
    }

    // Drain anything left in the soft-batch buffer before the terminal
    // fact lands so consumers tailing /events still see the trail
    // followed by node_completed in causal order — the timer-driven
    // flush handles mid-handler streaming, this drain handles the tail.
    if (leakedTimeout) {
      obs.flush();
      await tryAppendFact(opts.store, runId, recorder.version(), [
        {
          type: "fact.handler_timeout_leaked",
          payload: { nodeId: currentNode, leakedAt: clock() },
        },
        {
          type: "fact.run_terminated",
          payload: { status: "errored", reason: "error", detail: "handler_leaked" },
        },
      ]);
      // Bound the blast radius of misbehaving handlers across the
      // process lifetime. Per-process counter; once we cross the limit
      // the daemon entrypoint trips its shutdown controller via the
      // `onLeakLimitExceeded` callback, the singleton + sweep pick up
      // the slack on restart.
      leakBudget.recordLeak(runId, currentNode);
      return { kind: "terminal" };
    }

    if (wasAborted) {
      obs.flush();
      // Pure decision: which facts + routing patch + control outcome for this
      // abort — reactive-budget halt/pause, watchdog timeout-retry/exhausted, or
      // a plain workflow/operator abort. See abort-planner.ts. The fold's
      // routing delta + applied seqs ride the commit so an operator intent
      // queued for the dying dispatch isn't left unapplied (which would
      // re-fold → re-dispatch → re-trip the abort forever). The commit, OCC
      // re-drive, consecutiveAborts bump, and abort-loop ceiling stay here.
      const abortPlan = planAbort({
        currentNode,
        iteration,
        abortCause,
        reactiveBudgetHaltDetail,
        reactiveBudgetPauseBreach,
        usage: usage.totals(),
        routingDelta: decision.routingDelta,
        appliedSeqs: decision.appliedSeqs,
        effectiveRouting,
        now: clock(),
        attemptedMs: spec.maxMs ?? 0,
      });
      const abortAppendOpts: { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number } = {};
      if (abortPlan.routingPatch !== undefined) abortAppendOpts.routingPatch = abortPlan.routingPatch;
      if (abortPlan.advanceAppliedTo !== undefined) abortAppendOpts.advanceAppliedTo = abortPlan.advanceAppliedTo;

      // Watchdog timeout-retry: commit node_aborted + run_paused{timeout_retry};
      // an OCC conflict re-drives (continue) or halts. consecutiveAborts is NOT
      // bumped — the retry is system-initiated.
      if (abortPlan.outcome === "timeout_retry") {
        const ok = await tryAppendFact(opts.store, runId, recorder.version(), abortPlan.facts, abortAppendOpts);
        if (!ok) {
          const { halted } = await onOccConflict("fact.run_paused", currentNode, iteration, recorder.version());
          if (halted) return { kind: "terminal" };
          return { kind: "continue" };
        }
        return { kind: "terminal" };
      }
      // Reactive-budget halt/pause + timeout-exhausted: one atomic terminal
      // commit (the terminal/pause fact rides alongside node_aborted).
      if (abortPlan.outcome === "halt" || abortPlan.outcome === "pause") {
        await tryAppendFact(opts.store, runId, recorder.version(), abortPlan.facts, abortAppendOpts);
        return { kind: "terminal" };
      }
      // Plain workflow/operator abort: commit node_aborted, then bump the
      // abort-loop counter. A one-shot warning the abort before the ceiling so a
      // watcher sees the trend (observability — no version bump, rides alongside
      // the just-committed node_aborted); at the ceiling, a recoverable
      // abort_loop pause (a SECOND commit against a re-read version).
      await tryAppendFact(opts.store, runId, recorder.version(), abortPlan.facts, abortAppendOpts);
      consecutiveAborts++;
      if (consecutiveAborts === abortLoopCeiling - 1) {
        opts.store.appendObservabilityEvents(runId, [
          {
            type: "abort_loop_warning",
            payload: {
              nodeId: currentNode,
              consecutiveAborts,
              ceiling: abortLoopCeiling,
            },
          },
        ]);
      }
      if (consecutiveAborts >= abortLoopCeiling) {
        await tryAppendFact(
          opts.store,
          runId,
          // version may have shifted after the abort append; re-read.
          opts.store.getState(runId)?.version ?? state.version,
          [
            {
              type: "fact.run_paused",
              payload: {
                reason: "abort_loop",
                nodeId: currentNode,
                consecutiveAborts,
              },
            },
          ],
        );
        return { kind: "terminal" };
      }
      return { kind: "continue" };
    } else {
      consecutiveAborts = 0;
    }

    // Plan the transition (pure): edge selection → budget → goal gates →
    // retry → provider retry → resultToFacts → fact-list rewrites → routing
    // patch. See transition-planner.ts. The commit + OCC + snapshot below
    // stay here — the planner has no store, clock, or I/O.
    const plan = planTransition({
      state,
      decision,
      graph: graphFor(state.workflowSha),
      handlerResult: result,
      accounting: usage.totals(),
      effectiveRouting,
      currentNode,
      iteration,
      now: clock(),
      random,
    });

    // Drain the planner's trail (budget warns, goal-gate, retry-scheduled,
    // edge.selected) into the buffer, then flush ahead of the terminal facts
    // — preserving the trail→terminal-fact causal order the old inline flush
    // gave us.
    for (const ev of plan.observability) obs.push(ev);
    obs.flush();

    const facts = plan.facts;
    const routingPatch = plan.routingPatch;
    const advanceAppliedTo = plan.advanceAppliedTo;
    const appendOpts: {
      routingPatch?: Record<string, unknown>;
      advanceAppliedTo?: number;
    } = {};
    if (routingPatch !== undefined) appendOpts.routingPatch = routingPatch;
    if (advanceAppliedTo !== undefined) appendOpts.advanceAppliedTo = advanceAppliedTo;
    const ok = await tryAppendFact(opts.store, runId, recorder.version(), facts, appendOpts);
    if (!ok) {
      const turnIteration = nodeRetryCount(state.routing, currentNode);
      const turnFactType = facts[0]?.type ?? "fact.unknown";
      const { halted } = await onOccConflict(turnFactType, currentNode, turnIteration, recorder.version());
      if (halted) return { kind: "terminal" };
      return { kind: "continue" }; // OCC retry — rebuild from fresh state
    }
    onOccResolved(currentNode, nodeRetryCount(state.routing, currentNode));
    invalidateOutputsCacheIf(facts);
    await captureBoundarySnapshot(opts, runId, facts, currentNode);
    return { kind: "continue" };
  };

  // The post-commit `run_state` from the most recent `commitFanoutFact` — the
  // fan-out budget gate reuses it instead of re-reading (the gate runs right
  // after a commit, so this is always fresh there).
  let lastFanoutState: RunState | undefined;

  // Soft budget-warn tags (`__budget_warned`) accrued by `fanoutBudgetDisposition`
  // this fan-out run, pending a durable fold into routing so an 80% warn fires
  // once per run (the fan-out analog of the linear planner's mark). Drained onto
  // the next commit by `commitFanoutFact`.
  const pendingWarnTags = new Set<string>();

  // ── Fan-out (Model A): serialized commit lane. Re-reads the live version
  // each attempt; a sibling's commit having moved `version` is benign — retry
  // the APPEND (never re-execute). This is the linearization point that makes
  // K concurrent branches OCC-contention-free (concurrency.md). The `false`
  // arm is TAGGED: `status` ⇒ the run left `running` under us (operator
  // pause/cancel / concurrent halt), `occ` ⇒ genuine OCC exhaustion. Only the
  // latter feeds `onOccConflict` — folding a status-stop into the conflict
  // counter would spuriously warn or `occ_exhausted`-halt an already-parked run.
  const commitFanoutFact = async (facts: FactEvent[], appendOpts: FanoutAppendOpts): Promise<CommitResult> => {
    if (facts.length === 0) return { ok: true };
    for (let attempt = 0; attempt < FANOUT_COMMIT_ATTEMPTS; attempt++) {
      const fresh = opts.store.getState(runId);
      if (fresh == null || fresh.status !== "running") return { ok: false, reason: "status" };
      // A pending soft budget-warn mark rides this commit's routing patch (prior ∪
      // pending, sorted) so the 80% warn persists once per run — the fan-out analog
      // of the linear planner's `__budget_warned` fold.
      let effectiveOpts = appendOpts;
      if (pendingWarnTags.size > 0) {
        const prior = readBudgetWarned(fresh.routing);
        const merged = new Set(prior);
        for (const t of pendingWarnTags) merged.add(t);
        if (merged.size > prior.size) {
          effectiveOpts = {
            ...appendOpts,
            routingPatch: { ...(appendOpts.routingPatch ?? {}), [BUDGET_WARNED_KEY]: [...merged].sort() },
          };
        }
      }
      try {
        const res = opts.store.appendFact(runId, facts, fresh.version, effectiveOpts);
        lastFanoutState = res.state;
        invalidateOutputsCacheIf(facts);
        return { ok: true };
      } catch (err) {
        if (!(err instanceof ConcurrencyError)) throw err;
        // Benign sibling-moved-version conflict — re-read + retry the append.
      }
      await sleep(Math.min(2 ** attempt, 16), opts.shutdownSignal);
    }
    return { ok: false, reason: "occ" };
  };

  // ── Execute one fan-out branch sub-node. Branches are deliberation-only llm
  // nodes (E041/E042), so this is a focused kernel: build ctx → invoke → plan
  // the completion, returning NODE-scoped facts WITHOUT committing (runFanout
  // serializes commits). No mid-handler reactive budget gate (overshoot is
  // bounded by the semaphore width + the barrier re-check — fan-out-nodes.md).
  const executeBranchNode = async (
    branchNode: string,
    baseState: RunState,
    branchRouting: Readonly<Record<string, unknown>>,
    branchTimeoutMs: number,
  ): Promise<BranchOutcome> => {
    const graph = graphFor(baseState.workflowSha);
    const spec = opts.dispatcher.get(baseState.workflowSha, branchNode);
    const steerCtrl = new AbortController();
    const signals: AbortSignal[] = [steerCtrl.signal, opts.shutdownSignal];
    const deadlines: Array<() => void> = [];
    if (spec.maxMs !== undefined) {
      const t = armTimeout(spec.maxMs);
      signals.push(t.signal);
      deadlines.push(t.disarm);
    }
    // Backstop deadline so an unbounded llm branch can't dam the join forever.
    // The composite fires on the first source, so a tighter branch `max_ms`
    // (above) still wins.
    const backstop = armTimeout(branchTimeoutMs);
    signals.push(backstop.signal);
    deadlines.push(backstop.disarm);
    const { signal, release: releaseSignal } = composeAbortSignals(signals);
    // Iteration from branchRouting (the live view), not baseState — a same-turn
    // back-edge re-entry must run under its bumped counter.
    const iteration = nodeRetryCount(branchRouting as Record<string, unknown>, branchNode);
    const branchPass = readGoalGateRetries(baseState.routing);
    const recorder = new CommittingRecorder({
      store: opts.store,
      runId,
      nodeId: branchNode,
      iteration,
      initialVersion: baseState.version,
    });

    // Same streaming-flush sink + usage accumulator as the linear path (both
    // once drifted out of this branch copy — now they can't). An IN-FLIGHT
    // branch streams its observability live rather than holding it until it
    // joins.
    const obs = makeObservabilitySink(opts.store, runId, "fan-out");
    const usage = makeUsageAccumulator();
    const nodeAttrs = graph?.nodes[branchNode]?.attrs;
    const { allowedTools, deniedTools } = readToolScope(nodeAttrs);
    const ctxOpts: core.BuildContextOpts = {
      runId,
      nodeId: branchNode,
      iteration,
      signal,
      routing: branchRouting,
      store: opts.store,
      llm: core.makeLlmClient({ signal, call: opts.llmCall, accounting: usage.accounting }),
      http: core.makeHttpClient(
        opts.defaultHttpTimeoutMs != null ? { signal, defaultTimeoutMs: opts.defaultHttpTimeoutMs } : { signal },
      ),
      tools: opts.tools,
      recorder,
      args: buildSubstitutionArgs(branchRouting, graph?.attrs.inputs, outputsFor()),
      emitObservability: (type, payload) => {
        obs.push({ type, payload: { nodeId: branchNode, iteration, ...payload } });
        if (type === "cost.recorded") usage.mirrorCostRecorded(payload as Record<string, unknown>);
      },
    };
    if (allowedTools !== undefined) ctxOpts.allowedTools = allowedTools;
    if (deniedTools !== undefined) ctxOpts.deniedTools = deniedTools;
    if (runEnv !== undefined) ctxOpts.env = runEnv;
    const ctx = core.buildHandlerContext(ctxOpts);

    const invocation = await invokeHandler({
      spec,
      ctx,
      registry: opts.registry,
      runId,
      steerCtrl,
      leakGraceMs: leakGrace,
      // Enforce the branch backstop in the watchdog too — an unbounded branch
      // (spec.maxMs undefined) that ignores its abort signal still leak-halts
      // rather than hanging the pool forever.
      maxMsOverride: branchTimeoutMs,
    });
    // The branch settled — disarm its deadlines so N settled branches don't
    // each pin their signal + handler closures for the rest of the backstop,
    // and release the composite's source listeners (shutdownSignal would
    // otherwise hold one per branch per superstep for the daemon's lifetime).
    // NOT on leak: a leaked handler still consults the composite.
    for (const disarm of deadlines) disarm();
    if (invocation.kind !== "leak") releaseSignal();
    obs.flush();

    if (invocation.kind === "leak") {
      return { kind: "leak", nodeId: branchNode, leakedAt: clock() };
    }
    if (invocation.kind === "thrown") {
      const cause = classifyAbortCause(signal, invocation.error);
      // The same partial-spend payload `planAbort` builds for the linear path
      // (abortResultToFacts) — built through the shared mapper so a new usage
      // field can't land on one path and silently miss the other.
      return {
        kind: "abort",
        nodeId: branchNode,
        facts: abortResultToFacts(branchNode, iteration, cause, usage.totals(), branchPass),
      };
    }

    // Success: plan the completion (edge selection → node_completed + outputs).
    // `currentNode: branchNode` so result-to-facts stamps the BRANCH id.
    const plan = planTransition({
      state: { ...baseState, currentNode: branchNode },
      decision: PROCEED_DECISION,
      graph,
      handlerResult: invocation.result,
      accounting: usage.totals(),
      effectiveRouting: branchRouting,
      currentNode: branchNode,
      iteration,
      now: clock(),
      random,
    });
    if (plan.observability.length > 0) {
      opts.store.appendObservabilityEvents(
        runId,
        plan.observability.map((o) => ({ type: o.type, payload: o.payload })),
      );
    }
    const nc = plan.facts.find((f) => f.type === "fact.node_completed");
    const nextNode = nc?.type === "fact.node_completed" ? nc.payload.nextNode : undefined;
    const appendOpts: FanoutAppendOpts = {};
    if (plan.routingPatch !== undefined) appendOpts.routingPatch = plan.routingPatch;
    if (plan.advanceAppliedTo !== undefined) appendOpts.advanceAppliedTo = plan.advanceAppliedTo;
    return { kind: "success", nodeId: branchNode, nextNode, facts: plan.facts, appendOpts };
  };

  // ── Fan-out superstep (Model A on-log frontier). One superstep per call: seed
  // the frontier (fresh entry), OR advance the join (frontier drained), OR
  // dispatch the current frontier concurrently and fold each completion. The
  // outer dispatchOne loop re-enters this each turn until the join — so resume
  // is per-sub-node by construction (the frontier folds from the log).
  const runFanout = async (
    state: RunState,
    decision: Extract<core.IntentDecision, { kind: "proceed" }>,
    parallelNode: string,
    effectiveRouting: Readonly<Record<string, unknown>>,
  ): Promise<DispatchOutcome> => {
    const graph = graphFor(state.workflowSha);
    const node = graph?.nodes[parallelNode];
    const branches = Array.isArray(node?.attrs.branches) ? (node.attrs.branches as string[]) : [];
    const join = typeof node?.attrs.join === "string" ? node.attrs.join : undefined;
    const iteration = nodeRetryCount(state.routing, parallelNode);
    // Goal-gate re-entry epoch — a retarget re-seeds the whole region with
    // every branch counter reset (§3.4), so the epoch is the only durable
    // discriminator between pass executions of the same (nodeId, iteration).
    const pass = readGoalGateRetries(state.routing);
    const concurrency =
      typeof node?.attrs.concurrency === "number" && node.attrs.concurrency > 0
        ? node.attrs.concurrency
        : DEFAULT_FANOUT_CONCURRENCY;
    // The `parallel` node has no handler of its own, so its `timeout-minutes:`
    // (parsed into `attrs.max_ms`) bounds EACH branch — the per-branch deadline.
    const branchTimeoutMs =
      typeof node?.attrs.max_ms === "number" && node.attrs.max_ms > 0 ? node.attrs.max_ms : fanoutBranchTimeoutMs;

    // PURE frontier decision (fanout-planner.ts) — read the active set from
    // routing and the aborted subset from the lifecycle log (a live frontier
    // only), then classify the transition. The caller below APPLIES the plan.
    const active = readActiveNodes(effectiveRouting as Record<string, unknown>);
    const plan: FanoutPlan = planFanoutStep({
      active,
      branches,
      join,
      redispatch: active !== null && active.length > 0 ? abortedActiveBranches(opts.store, runId, active) : [],
    });

    if (plan.kind === "malformed") {
      await tryAppendFact(opts.store, runId, state.version, [
        { type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: "fanout_malformed" } },
      ]);
      return { kind: "terminal" };
    }

    // A park/terminal fact must actually LAND before the turn reports
    // terminal — a silently failed commit would strand the run `running`
    // with no executor (a zombie until daemon restart). status-stop ⇒ the
    // run is already parked, terminal is correct; OCC exhaustion ⇒ park the
    // facts in `pendingFanoutDisposition` and retry at the next turn's entry
    // (they are NOT re-derivable from durable state once the branch outcomes
    // that produced them are gone).
    const commitParkOrTerminal = async (facts: FactEvent[]): Promise<DispatchOutcome> => {
      const res = await commitFanoutFact(facts, {});
      if (!res.ok && res.reason === "occ") {
        const { halted } = await onOccConflict(
          facts[0]?.type ?? "fact.unknown",
          parallelNode,
          iteration,
          state.version,
        );
        if (halted) {
          pendingFanoutDisposition = undefined;
          return { kind: "terminal" };
        }
        pendingFanoutDisposition = facts;
        return { kind: "continue" };
      }
      pendingFanoutDisposition = undefined;
      return { kind: "terminal" };
    };

    // Land last turn's lost disposition before seeding/dispatching anything.
    if (pendingFanoutDisposition !== undefined) return commitParkOrTerminal(pendingFanoutDisposition);

    // This turn's operator fold (budget raise / resume) — applied on the FIRST
    // commit so the override lands AND `last_applied_seq` advances past the
    // queued intents (else wake-pending re-resumes forever).
    const foldOpts: FanoutAppendOpts = {};
    if (Object.keys(decision.routingDelta).length > 0) foldOpts.routingPatch = decision.routingDelta;
    if (decision.appliedSeqs.length > 0) foldOpts.advanceAppliedTo = Math.max(...decision.appliedSeqs);
    let foldPending = foldOpts.routingPatch !== undefined || foldOpts.advanceAppliedTo !== undefined;
    const takeFold = (): FanoutAppendOpts => {
      if (!foldPending) return {};
      foldPending = false;
      return foldOpts;
    };

    // The parallel node's per-node cost/token cap sums over its fan-out closure
    // (branches + their non-fanout descendants up to the join — the shared
    // `fanoutClosureUnion` walk, so the cap scope can't drift from the set the
    // validator certified). `max_cost_usd`/`max_tokens` summed across the
    // closure accumulate over fan-out iterations too (a goal-gate re-entry
    // re-runs the region), consistent with per-node-cap semantics. Empty when
    // the graph is gone (the budget then sees a 0 node-cumulative — harmless,
    // run-level still fires).
    const closureNodes = graph !== null ? fanoutClosureUnion(graph, { branches, join }) : new Set<string>();

    // Run-level budget against the NOW-folded cumulative. Each commit advanced
    // the durable total, so a branch crossing the cap stops the next dispatch —
    // tighter than a once-per-superstep barrier. Reuses the just-committed
    // projection (`lastFanoutState`, set by every commitFanoutFact in this pool)
    // rather than re-reading. Returns the disposition fact, or undefined.
    const fanoutBudgetDisposition = (gate: { fresh?: boolean } = {}): FactEvent | undefined => {
      // Hot per-commit gate reuses the just-committed projection; the cold once-per-fan-out
      // barrier forces a fresh read so its budget check never trusts a possibly-stale snapshot.
      const folded = (gate.fresh ? opts.store.getState(runId) : lastFanoutState) ?? opts.store.getState(runId) ?? state;
      const overrides = readBudgetOverrides(folded.routing);
      let nodeCumulativeCostUsd = 0;
      let nodeCumulativeTokens = 0;
      for (const id of closureNodes) {
        const bucket = folded.metrics.nodeCosts[id];
        if (bucket === undefined) continue;
        nodeCumulativeCostUsd += bucket.costUsd;
        nodeCumulativeTokens += bucket.tokens;
      }
      // Suppress re-warns for tags already marked (routing) OR emitted-but-not-yet-
      // folded this fan-out run (pendingWarnTags) — else each per-commit gate call
      // re-fires the same 80% warn.
      const alreadyWarned = new Set([...readBudgetWarned(folded.routing), ...pendingWarnTags]);
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
      // Emit the soft budget.warn / budget.stop observability the linear planner
      // emits via its trail, and mark the new tags pending so commitFanoutFact
      // folds them durably. Without this a fan-out 80% crossing — and a
      // budget_policy="warn" ceiling breach — were silent. The durable
      // __budget_warned mark is the once-per-run guarantee; the best-effort warn
      // EVENT itself can re-fire once if an operator pause lands in the window
      // before the tag folds — acceptable for a no-decision-logic telemetry event.
      if (budget.events.length > 0) {
        opts.store.appendObservabilityEvents(
          runId,
          budget.events.map((e) => ({ type: e.type, payload: { nodeId: parallelNode, ...e.payload } })),
        );
        for (const t of budget.newlyWarned) pendingWarnTags.add(t);
      }
      if (budget.shouldHalt) {
        const payload: { status: "errored"; reason: "budget"; detail?: string } = {
          status: "errored",
          reason: "budget",
        };
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
    };

    // Seed the frontier with the branch entries (fresh entry). Through
    // `commitFanoutFact` (not a bare append) so the SAME OCC-vs-status split as
    // the join barrier holds: an operator pause/cancel landing between this
    // turn's state read and the seed append is a `status` stop (yield the turn),
    // not an OCC conflict to feed the controller.
    if (plan.kind === "seed") {
      const res = await commitFanoutFact(
        [
          {
            type: "fact.fanout_started",
            payload: { nodeId: parallelNode, iteration, ...passField(pass), branches },
          },
        ],
        takeFold(),
      );
      if (!res.ok) {
        if (res.reason !== "occ") return { kind: "continue" };
        const { halted } = await onOccConflict("fact.fanout_started", parallelNode, iteration, state.version);
        return halted ? { kind: "terminal" } : { kind: "continue" };
      }
      return { kind: "continue" }; // next turn dispatches the seeded frontier
    }

    // Frontier drained → barrier: advance current_node to the join. Budget
    // first — a breach folded by the LAST branch commit (or a disposition
    // lost to an OCC-continue last turn) must park the run here, not ride
    // through the join into the successor's dispatch.
    if (plan.kind === "join") {
      const drainedBarrier = fanoutBudgetDisposition({ fresh: true });
      if (drainedBarrier !== undefined) return commitParkOrTerminal([drainedBarrier]);
      const res = await commitFanoutFact(
        [
          {
            type: "fact.fanout_joined",
            payload: {
              nodeId: parallelNode,
              iteration,
              ...passField(pass),
              nextNode: plan.nextNode,
              branchesCompleted: plan.branchesCompleted,
            },
          },
        ],
        takeFold(),
      );
      if (!res.ok) {
        // Status-stop ⇒ the run is already leaving `running`; just yield the
        // turn. Only true OCC exhaustion feeds the conflict controller.
        if (res.reason !== "occ") return { kind: "continue" };
        const { halted } = await onOccConflict("fact.fanout_joined", parallelNode, iteration, state.version);
        return halted ? { kind: "terminal" } : { kind: "continue" };
      }
      onOccResolved(parallelNode, iteration);
      return { kind: "continue" };
    }

    // Re-dispatch transition fact. A frontier branch whose latest lifecycle fact
    // is `node_aborted` is being RE-dispatched (resume after a pause/shutdown
    // abort, or an abort-loop re-drive). The initial frontier rides
    // `fanout_started` and a successor rides a bundled `dispatch_started`, but a
    // re-dispatch emits NEITHER — so without this the prior `node_aborted` leaves
    // the branch projected "failed" for the whole re-run. Emit `dispatch_started`
    // so the failed→running transition is a durable fact (ground rule #5) the
    // projection already consumes. Safe: the reducer only ADDS to the active set
    // when absent — the branch is already there, so this is a no-op on the frontier.
    const reDispatched = plan.redispatch;
    if (reDispatched.length > 0) {
      const facts: FactEvent[] = reDispatched.map((n) => ({
        type: "fact.dispatch_started",
        payload: {
          nodeId: n,
          iteration: nodeRetryCount(state.routing, n),
          ...passField(pass),
          resumeOf: "paused",
        },
      }));
      const reRes = await commitFanoutFact(facts, takeFold());
      if (!reRes.ok) {
        // Same OCC-vs-status split as every other commit arm — this was the one
        // commit that still dropped the reason, leaving the warn → occ_exhausted
        // escalation dead under persistent re-dispatch contention.
        if (reRes.reason === "occ") {
          const first = reDispatched[0]!;
          const { halted } = await onOccConflict(
            "fact.dispatch_started",
            first,
            nodeRetryCount(state.routing, first),
            state.version,
          );
          if (halted) return { kind: "terminal" };
        }
        return { kind: "continue" };
      }
    }

    // ── Reactive pool (the on-log frontier, fan-out-nodes.md § Execution). One
    // runFanout call drains the whole region: dispatch the live frontier, then
    // as EACH branch settles, commit it and dispatch its successor immediately —
    // never waiting on siblings. A slow/hung/failed branch can no longer dam the
    // commit of its already-finished siblings (head-of-line blocking — confirmed
    // in a live post-mortem). Commits still serialize through `commitFanoutFact`
    // (the linearization point); only the dispatch side races.
    const sem = new Semaphore(concurrency);
    const freshState = opts.store.getState(runId) ?? state;

    // Routing view that folds the retry-count bumps committed THIS turn. The
    // turn-start snapshot misses a branch back-edge's `internal.retry_count.*`
    // patch riding an earlier same-turn commit — a re-entered node then runs a
    // second time under the SAME (nodeId, iteration), overwriting its outputs
    // and slipping past its max-retries gate until the next turn. Only the
    // retry-count keys fold: the rest of `effectiveRouting` carries
    // materialized values (spilled inputs) the committed routing doesn't have.
    let liveRouting = effectiveRouting;
    const retryCountPrefix = retryCountKey("");
    const foldCommittedRetryCounts = (): void => {
      const committed = lastFanoutState?.routing;
      if (committed === undefined) return;
      let next: Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(committed)) {
        if (k.startsWith(retryCountPrefix) && liveRouting[k] !== v) {
          if (next === undefined) next = { ...liveRouting };
          next[k] = v;
        }
      }
      if (next !== undefined) liveRouting = next;
    };

    // Once a run-level disposition is captured we stop dispatching new
    // successors but keep draining the in-flight pool — bounding overshoot to
    // the branches already running — then commit the disposition at drain.
    // ONE slot with one precedence rule applied at every capture site: a halt
    // always overrides a pause (terminal beats resumable), a pause never
    // downgrades a halt, first-of-each-kind wins. (Twin halt/pause slots filled
    // by two paths made precedence depend on which path saw the breach.)
    let disposition: FactEvent | undefined;
    const noteDisposition = (f: FactEvent): void => {
      // `fact.run_terminated` here is always the errored (halt) disposition —
      // terminal beats a resumable pause, first terminal wins.
      if (f.type === "fact.run_terminated") {
        if (disposition?.type !== "fact.run_terminated") disposition = f;
      } else if (disposition === undefined) {
        disposition = f;
      }
    };
    const captureDisposition = (): void => {
      if (disposition?.type === "fact.run_terminated") return;
      const disp = fanoutBudgetDisposition();
      if (disp !== undefined) noteDisposition(disp);
    };

    // Each sub-node dispatch consumes the same loop budget as a linear handler
    // dispatch (fan-out-nodes.md § semantics digest) — without this a
    // branch-closure cycle (W017) was bounded by nothing but wall-clock and an
    // opt-in budget.
    const effectiveMaxLoops = readNumber(effectiveRouting[MAX_LOOPS_OVERRIDE_KEY]) || maxLoops;

    // Set on any early bail. A branch still queued on the semaphore at bail time
    // has no registry entry for `abortInflightPool` to signal, so it re-checks
    // the flag after acquiring and skips execution instead of starting a fresh,
    // unabortable handler on the freed slot.
    let poolBailed = false;
    const pool = new Map<string, Promise<{ nodeId: string; outcome: BranchOutcome }>>();
    const dispatch = (nodeId: string): void => {
      if (dispatches >= effectiveMaxLoops) {
        noteDisposition({
          type: "fact.run_paused",
          payload: { reason: "max_loops", currentLimit: effectiveMaxLoops, dispatches },
        });
        return;
      }
      dispatches++;
      pool.set(
        nodeId,
        (async () => {
          await sem.acquire();
          try {
            if (poolBailed) return { nodeId, outcome: { kind: "skipped", nodeId } satisfies BranchOutcome };
            // `liveRouting` read at execution time (not dispatch time) so a
            // successor queued behind the semaphore still sees every
            // retry-count bump committed while it waited.
            return { nodeId, outcome: await executeBranchNode(nodeId, freshState, liveRouting, branchTimeoutMs) };
          } finally {
            sem.release();
          }
        })(),
      );
    };
    for (const f of plan.active) dispatch(f);

    // Early-terminal bail: signal every still-in-flight branch so it stops
    // burning LLM cost (a settled branch already disposed its registration, so
    // `liveHandlers` is exactly the in-flight set). Don't await — a leaked branch
    // won't settle on abort (the leak budget owns it); signal-and-return is the fix.
    const abortInflightPool = (): void => {
      poolBailed = true;
      for (const h of opts.registry.liveHandlers(runId)) h.controller.abort(new FanoutBailError(runId));
    };

    // After an early bail that returns `continue` (OCC exhaustion / status-stop),
    // wait for the just-aborted handlers to tear down — bounded by `leakGrace` so a
    // genuinely-leaked handler can't dam the turn. Without this the next turn re-reads
    // the still-active branches (their node_completed/node_aborted never committed) and
    // re-dispatches them WHILE the orphaned handlers are still settling — a window of two
    // billable handlers + two recorder commit streams under the same (nodeId, iteration).
    const drainInflightPool = async (): Promise<void> => {
      if (pool.size === 0) return;
      await Promise.race([Promise.allSettled([...pool.values()]), sleep(leakGrace, opts.shutdownSignal)]);
    };

    try {
      while (pool.size > 0) {
        const { nodeId, outcome } = await Promise.race(pool.values());
        pool.delete(nodeId);

        // A branch that acquired its slot only after a bail never executed —
        // nothing to commit (the bail's own exit path owns the turn).
        if (outcome.kind === "skipped") continue;

        // A leaked handler is unrecoverable — halt the whole run. Through
        // commitParkOrTerminal: an OCC-lost halt here (orphaned recorder
        // streams advancing the version) must re-commit next turn, not
        // silently strand the run `running` with no executor.
        if (outcome.kind === "leak") {
          leakBudget.recordLeak(runId, outcome.nodeId);
          abortInflightPool();
          await drainInflightPool();
          return commitParkOrTerminal([
            { type: "fact.handler_timeout_leaked", payload: { nodeId: outcome.nodeId, leakedAt: outcome.leakedAt } },
            { type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: "handler_leaked" } },
          ]);
        }

        // An aborted branch stays in the active set (node_aborted doesn't mutate
        // it) and re-dispatches on the NEXT runFanout turn — NOT within this pool,
        // which would busy-spin a hard-failing branch. Climb its own streak so it
        // can't hide behind healthy siblings (the run-wide counter's masking bug).
        if (outcome.kind === "abort") {
          const abortRes = await commitFanoutFact(outcome.facts, takeFold());
          if (!abortRes.ok) {
            abortInflightPool();
            // A genuine OCC exhaustion (not a status-stop) feeds the conflict
            // controller so the warn → occ_exhausted escalation fires — the same
            // split the seed/join arms make; the pool arms previously dropped the
            // reason, leaving that escalation dead on the pool path.
            if (abortRes.reason === "occ") {
              const { halted } = await onOccConflict(
                "fact.node_aborted",
                outcome.nodeId,
                nodeRetryCount(liveRouting as Record<string, unknown>, outcome.nodeId),
                state.version,
              );
              if (halted) return { kind: "terminal" };
            }
            await drainInflightPool();
            return { kind: "continue" };
          }
          foldCommittedRetryCounts();
          branchAborts.set(outcome.nodeId, (branchAborts.get(outcome.nodeId) ?? 0) + 1);
          // An abort still folds `partialCostUsd` into the durable total — gate on
          // it too (the success arm does), else real partial spend slips past the cap.
          captureDisposition();
          continue;
        }

        // Success: split run-level facts from node facts, drop the planner's
        // node_started{successor} (it would unpin current_node from the
        // parallel node and deactivate siblings), and bundle dispatch_started
        // for the successor so the frontier advances atomically (I1) — unless
        // the successor IS the join (branch done; node_completed already
        // removed it).
        const branchFacts: FactEvent[] = [];
        let branchTerminal = false;
        for (const f of outcome.facts) {
          if (f.type === "fact.run_terminated" && f.payload.status === "completed") {
            // A branch resolving to a run terminal (`next: exit`, or a fail-only
            // edge succeeding into `__end__`) is a structural defect: the
            // validator rejects the shape (E032/E039/E041), but an unvalidated
            // save still reaches the executor. Completing the run mid-fan-out
            // would strand the in-flight siblings — fail closed instead.
            branchTerminal = true;
          } else if (f.type === "fact.run_terminated" || f.type === "fact.run_paused") {
            noteDisposition(f);
          } else if (f.type !== "fact.node_started") {
            branchFacts.push(f);
          }
        }
        let successor = outcome.nextNode !== undefined && outcome.nextNode !== join ? outcome.nextNode : undefined;
        if (successor !== undefined && graph?.nodes[successor] === undefined) {
          // A sentinel ("exit"/"__end__") or dangling successor must never enter
          // the pool — dispatcher.get would throw and strand the siblings.
          branchTerminal = true;
          successor = undefined;
        }
        if (branchTerminal) {
          // No successor either — a synthesized `exit` node exists in the graph,
          // so the missing-node guard alone wouldn't stop its dispatch_started.
          successor = undefined;
          noteDisposition({
            type: "fact.run_terminated",
            payload: { status: "errored", reason: "error", detail: `fanout_branch_terminal:${outcome.nodeId}` },
          });
        }
        if (successor !== undefined) {
          // A back-edge successor's retry-count bump rides THIS commit's
          // routingPatch — the dispatch_started must stamp the post-patch
          // iteration or it disagrees with what the branch executes under.
          const successorRouting =
            outcome.appendOpts.routingPatch !== undefined
              ? { ...(liveRouting as Record<string, unknown>), ...outcome.appendOpts.routingPatch }
              : (liveRouting as Record<string, unknown>);
          branchFacts.push({
            type: "fact.dispatch_started",
            payload: {
              nodeId: successor,
              iteration: nodeRetryCount(successorRouting, successor),
              ...passField(pass),
              resumeOf: "fresh",
            },
          });
        }
        const successRes = await commitFanoutFact(branchFacts, mergeFanoutAppendOpts(takeFold(), outcome.appendOpts));
        if (!successRes.ok) {
          abortInflightPool();
          // Same OCC-vs-status split as the abort arm: a true OCC exhaustion
          // escalates through the conflict controller rather than silently bailing.
          if (successRes.reason === "occ") {
            const { halted } = await onOccConflict(
              "fact.node_completed",
              outcome.nodeId,
              nodeRetryCount(liveRouting as Record<string, unknown>, outcome.nodeId),
              state.version,
            );
            if (halted) return { kind: "terminal" };
          }
          await drainInflightPool();
          return { kind: "continue" };
        }
        foldCommittedRetryCounts();
        branchAborts.delete(outcome.nodeId);
        captureDisposition();

        // Drive the successor into the pool — but NOT once a disposition is
        // captured. Its dispatch_started already rode the commit (durable in the
        // active set), so on resume it re-dispatches; we just don't spend now.
        if (successor !== undefined && disposition === undefined) dispatch(successor);
      }
    } catch (err) {
      // A rejected branch arm (a dispatcher lookup, an unguarded store write)
      // must not strand the in-flight siblings: signal and drain them before the
      // throw unwinds to runOne's halt handler — without this they keep burning
      // LLM cost against a halted run until the per-branch backstop fires.
      abortInflightPool();
      await drainInflightPool();
      throw err;
    }

    // Disposition. A captured run-level breach (halt or pause) parks the run.
    if (disposition !== undefined) return commitParkOrTerminal([disposition]);
    // Per-branch abort-loop: a branch that aborted `abortLoopCeiling` turns in a
    // row parks the run regardless of sibling success. `branchAborts` holds
    // exactly the branches still aborted this turn — a success deletes its entry.
    for (const [nodeId, streak] of branchAborts) {
      if (streak >= abortLoopCeiling) {
        return commitParkOrTerminal([
          {
            type: "fact.run_paused",
            payload: { reason: "abort_loop", nodeId, consecutiveAborts: streak },
          },
        ]);
      }
    }
    // Aborts below the ceiling: re-drive the still-active (aborted) nodes next turn.
    if (branchAborts.size > 0) return { kind: "continue" };

    // All branches reached the join. Barrier budget re-check (belt + suspenders
    // — the per-commit gate already caught in-region breaches), then let the
    // next turn advance current_node to the join (active is now empty).
    const barrier = fanoutBudgetDisposition({ fresh: true });
    if (barrier !== undefined) return commitParkOrTerminal([barrier]);
    return { kind: "continue" }; // frontier drained — next turn joins
  };

  try {
    while (!opts.shutdownSignal.aborted && turns < maxTurns) {
      turns++;
      const outcome = await dispatchOne();
      if (outcome.kind === "terminal") return;
    }
  } finally {
    // On a hard-terminal status, capture the terminal snapshot and dispose
    // the worktree (gated on the snapshot fact landing). See snapshot-service.
    await disposeTerminalWorktree(opts, runId);
  }
}

/** Per-process accounting for handler leaks (ignored AbortSignal past
 * `maxMs + leakGrace`). The executor instantiates one and shares it
 * across runs; each leak increments and the limit-exceeded callback
 * fires at most once per process. */
export interface LeakBudget {
  recordLeak(runId: string, nodeId: string): void;
  /** Read-only — for tests and observability. */
  count(): number;
  /** The leaked handler sites in leak order, capped at
   * `MAX_RECORDED_LEAK_SITES` so the `daemon.stopped` payload stays
   * under the 4 KB cap regardless of `maxLeakedHandlers`. */
  leaked(): ReadonlyArray<{ runId: string; nodeId: string }>;
}

/** A node's allowed/denied tool scope from its graph attrs — hard-filters
 * `ctx.tools` at HandlerContext construction so a handler can't reach a tool the
 * node didn't declare. Shared by the linear + fan-out dispatch paths. */
// The event-payload cap is 4KB; bound the appended parse error so a
// pathological message can never make the halt append itself fail.
const PARSE_ERROR_DETAIL_MAX = 300;

function workflowParseFailedDetail(errorMessage: string | undefined): string {
  if (errorMessage == null || errorMessage === "") return "workflow_parse_failed";
  const bounded =
    errorMessage.length > PARSE_ERROR_DETAIL_MAX ? `${errorMessage.slice(0, PARSE_ERROR_DETAIL_MAX)}…` : errorMessage;
  return `workflow_parse_failed: ${bounded}`;
}

function readToolScope(nodeAttrs: { allowed_tools?: unknown; denied_tools?: unknown } | undefined): {
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
 * fan-out dispatch paths so this batching can't drift between them (it did once:
 * the fan-out path silently lacked the timer until it was re-added). */
function makeObservabilitySink(
  store: IEventWriter,
  runId: string,
  label: string,
): { push: (ev: { type: string; payload: Record<string, unknown> }) => void; flush: () => void } {
  const buffer: { type: string; payload: Record<string, unknown> }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    // Drain into a fresh array before the (sync) write so the buffer is empty if
    // the write throws — best-effort telemetry; swallow + log rather than retry.
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
    // Hard ceiling — bound peak memory when a provider bursts deltas faster than
    // the soft timer drains. Soft ceiling — coalesce so we don't hammer the
    // writer lock with one txn per delta.
    if (buffer.length >= OBSERVABILITY_FLUSH_SIZE_THRESHOLD) {
      flush();
      return;
    }
    if (timer == null) timer = setTimeout(flush, OBSERVABILITY_FLUSH_INTERVAL_MS);
  };
  return { push, flush };
}

/** Active fan-out branches whose latest lifecycle fact is `node_aborted` — they
 * are being re-dispatched (resume after a pause/shutdown abort, or an abort-loop
 * re-drive) and need a fresh `dispatch_started` so they project as running, not
 * failed. One windowed SQL pass (`NODE_LIFECYCLE_FACT_TYPES`) — this runs every
 * fan-out dispatch turn, and materialising the full event log per turn scaled
 * with run lifetime, not frontier size. */
function abortedActiveBranches(store: IEventReader, runId: string, active: readonly string[]): string[] {
  if (active.length === 0) return [];
  const latest = new Map(store.getLatestLifecycleByNode(runId).map((r) => [r.nodeId, r.type]));
  return active.filter((n) => latest.get(n) === "fact.node_aborted");
}

/** Pre-fetch all emitted outputs for a run from the outputs index and fold
 * them into a Record<nodeId, OutputsValue> with last-write-wins semantics
 * (the last iteration wins per node). Called before each dispatch so
 * outputs substitution resolves in prompts and tool commands. */
function resolveRunOutputs(store: IEventReader, runId: string): Record<string, OutputsValue> | undefined {
  const rows = store.getOutputsForRun(runId);
  if (rows.length === 0) return undefined;
  const out: Record<string, OutputsValue> = {};
  // Rows are ordered (nodeId ASC, iteration ASC). Last row per nodeId wins.
  for (const row of rows) {
    try {
      out[row.nodeId] = JSON.parse(row.struct) as OutputsValue;
    } catch {
      // Corrupt row — skip.
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const MAX_RECORDED_LEAK_SITES = 20;

export function makeLeakBudget(opts: ExecutorOpts): LeakBudget {
  const limit = opts.maxLeakedHandlers ?? DEFAULT_MAX_LEAKED_HANDLERS;
  const onExceeded =
    opts.onLeakLimitExceeded ??
    ((n) => {
      // eslint-disable-next-line no-console
      console.error(`[executor] leak limit exceeded (${n} leaked handlers); daemon will keep running but is degraded`);
    });
  let n = 0;
  let fired = false;
  const sites: Array<{ runId: string; nodeId: string }> = [];
  return {
    recordLeak: (runId, nodeId) => {
      n += 1;
      if (sites.length < MAX_RECORDED_LEAK_SITES) sites.push({ runId, nodeId });
      try {
        opts.store.appendDaemonEvent(
          { type: "daemon.leak_detected", payload: { runId, nodeId, count: n, ceiling: limit } },
          { runId },
        );
      } catch {
        // Best-effort — never let event-emit failure mask the leak signal.
      }
      // eslint-disable-next-line no-console
      console.warn(`[executor] handler leak #${n} on ${runId}/${nodeId} (limit=${limit})`);
      if (!fired && n >= limit) {
        fired = true;
        try {
          onExceeded(n, sites);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[executor] onLeakLimitExceeded threw:", err);
        }
      }
    },
    count: () => n,
    leaked: () => sites,
  };
}
