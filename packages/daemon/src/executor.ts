// Executor fiber — ARCHITECTURE.md §6.
//
// One executor loop per daemon. It repeatedly:
//   1. Polls for the next claimable run (concurrency-capped).
//   2. For each claimed run, walks turns until a terminal or paused state.
//   3. On each turn: fold intents, build handler context, dispatch, map
//      result → facts, commit via appendFact with OCC.
//
// No files, no sockets, no IPC. Just the store.

import { type ExecutionEnvironment, evaluateBudget, type Graph } from "@fragua/core";
import * as core from "@fragua/core/handler";
import {
  EVENT_CONTRACT_VERSION,
  type FactEvent,
  type IEventStore,
  MIN_COMPATIBLE_CONTRACT_VERSION,
  materializeRouting,
} from "@fragua/store";
import type { AbortRegistry } from "./abort-registry.ts";
import type { AutoTitler, TitleRequest } from "./auto-titler.ts";
import type { Dispatcher } from "./dispatch.ts";
import {
  buildSubstitutionArgs,
  classifyAbortCause,
  deriveResumeOf,
  errorMessage,
  MAX_LOOPS_OVERRIDE_KEY,
  nodeRetryCount,
  readBudgetOverrides,
  readBudgetWarned,
  readNumber,
  readStringMap,
  routingString,
  sleep,
} from "./executor-helpers.ts";
import { type GraphLoader, makeGraphLoader } from "./graph-loader.ts";

// Compatibility re-exports: these helpers moved to executor-helpers.ts but
// are imported from executor.ts by tests and other call sites.
export { buildSubstitutionArgs, classifyAbortCause, resolveBackoff } from "./executor-helpers.ts";

import { planAbort } from "./abort-planner.ts";
import { invokeHandler } from "./invoke-handler.ts";
import { makeOccController, tryAppendFact } from "./occ-append.ts";
import { processOperatorActions } from "./operator-actions.ts";
import { CommittingRecorder } from "./recorder.ts";
import { cancelToFacts } from "./result-to-facts.ts";
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

export interface ExecutorOpts {
  store: IEventStore;
  dispatcher: Dispatcher;
  registry: AbortRegistry;
  tools: core.ToolRegistry;
  llmCall: LlmCallFn;
  maxConcurrentRuns: number;
  /** Upper bound on node-less poll waits in ms. Tests inject a smaller value. */
  pollIntervalMs?: number;
  /** Grace period beyond handler maxMs before we treat the node as leaked. */
  leakGraceMs?: number;
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
   * stuck runs on restart. The callback fires at most once per process. */
  onLeakLimitExceeded?: (count: number) => void;
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
  // leaked handlers will land `fact.run_halted` via their own catch
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
    // runOne appends `fact.run_halted` before rethrowing on crash; this
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
    // the run, append `fact.run_halted` so the `running` capacity slot
    // doesn't leak. Covers throws outside the existing inner try/catch
    // that wraps only `spec.handler(ctx)` — e.g. foldIntents / graphFor
    // / selectEdge / tryAppendFact failures. Belt-and-suspenders: the
    // store's startupSweep also requeues stuck `running` rows on
    // daemon restart.
    const state = opts.store.getState(runId);
    if (state != null && state.status === "running") {
      await tryAppendFact(opts.store, runId, state.version, [
        {
          type: "fact.run_halted",
          payload: { reason: "error", detail: `executor crashed: ${errorMessage(err)}` },
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
  let consecutiveAborts = 0;
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
  const graphFor = (workflowSha: string | null): Graph | null => {
    if (workflowSha == null) return null;
    if (cachedGraph != null) return cachedGraph;
    const result = loader.load(workflowSha);
    if (result.ok) {
      cachedGraph = result.graph;
      return cachedGraph;
    }
    if (result.reason === "unparseable") workflowUnparseable = true;
    return null;
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
            type: "fact.run_halted",
            payload: { reason: "error", detail: "workflow_parse_failed" },
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
          "fact.run_cancelled",
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
      await tryAppendFact(
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
            type: "fact.run_halted",
            payload: {
              reason: "error",
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
        // in the title seed as their full string values.
        const structuredInputs = readStringMap(effectiveRouting["inputs"]);
        const inputLines = Object.entries(structuredInputs)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n");
        let seed = "";
        let workflowName: string | undefined;
        if (inputLines !== "") {
          const wf = workflowSha != null ? opts.store.getWorkflow(workflowSha) : null;
          workflowName = wf?.name;
          const parts: string[] = [];
          if (workflowName !== undefined) parts.push(`workflow=${workflowName}`);
          parts.push(inputLines);
          seed = parts.join("\n");
        }
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
      const ok = await tryAppendFact(opts.store, runId, state.version, [
        {
          type: "fact.dispatch_started",
          payload: {
            nodeId: currentNode,
            iteration: dispatchIteration,
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
    if (spec.maxMs !== undefined) signals.push(AbortSignal.timeout(spec.maxMs));
    const signal = AbortSignal.any(signals);

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
    const observability: { type: string; payload: Record<string, unknown> }[] = [];
    // Mid-handler micro-batch timer. See OBSERVABILITY_FLUSH_*_MS notes.
    // Owned by `emitObservability` (schedules) and `flushObservability`
    // (clears). Always null-checked before clearTimeout / setTimeout so
    // the leak-budget / abort / normal completion paths can call
    // `flushObservability` unconditionally.
    let observabilityFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushObservability = (): void => {
      if (observabilityFlushTimer != null) {
        clearTimeout(observabilityFlushTimer);
        observabilityFlushTimer = null;
      }
      if (observability.length === 0) return;
      // Drain into a fresh array before the (sync) write so the buffer
      // is empty if the write throws — best-effort telemetry; we swallow
      // and log on failure rather than retry.
      const drained = observability.splice(0, observability.length);
      try {
        opts.store.appendObservabilityEvents(runId, drained);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[executor] observability flush failed for run ${runId}:`, err);
      }
    };

    let turnBilled = 0;
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let lastModel: string | undefined;
    // Reactive budget halt: when a `cost.recorded` event mid-handler
    // pushes cumulative spend over a `budget_policy="stop"` ceiling,
    // we abort the in-flight handler and emit fact.run_halted{
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
    const accounting: core.LlmAccounting = {
      addUsage: ({ tokens, costUsd, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) => {
        turnBilled += tokens;
        totalCostUsd += costUsd;
        totalInputTokens += inputTokens ?? 0;
        totalOutputTokens += outputTokens ?? 0;
        totalCacheReadTokens += cacheReadTokens ?? 0;
        totalCacheWriteTokens += cacheWriteTokens ?? 0;
        lastModel = model;
      },
    };

    // Hard-filter ctx.tools by the node's allowed_tools / denied_tools.
    // A handler that reaches for `ctx.tools.get("bash")` on a node that
    // didn't allow "bash" gets `unknown tool: bash`, same as for an
    // unregistered tool. The filter lives at HandlerContext construction
    // so every handler kind respects the same structural enforcement.
    const graph = graphFor(state.workflowSha);
    const nodeAttrs = graph?.nodes[currentNode]?.attrs;
    const allowedTools = Array.isArray(nodeAttrs?.allowed_tools)
      ? (nodeAttrs.allowed_tools as readonly string[])
      : undefined;
    const deniedTools = Array.isArray(nodeAttrs?.denied_tools)
      ? (nodeAttrs.denied_tools as readonly string[])
      : undefined;

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
        accounting,
      }),
      http: core.makeHttpClient(
        opts.defaultHttpTimeoutMs != null ? { signal, defaultTimeoutMs: opts.defaultHttpTimeoutMs } : { signal },
      ),
      tools: opts.tools,
      recorder,
      args: buildSubstitutionArgs(effectiveRouting, graph?.attrs.inputs),
      emitObservability: (type, payload) => {
        // Stamp nodeId + iteration so the UI can scope without the
        // handler having to thread it through every payload.
        observability.push({
          type,
          payload: { nodeId: currentNode, iteration, ...payload },
        });
        // Mirror handler-emitted `cost.recorded` into the per-turn
        // accumulator. Llm bypasses ctx.llm.call() and reports
        // usage through ctx.emit (handler-bridge.ts forwards every
        // pi-agent-core message_end → cost.recorded). Without this
        // mirror, the abort branch's `partial` payload reads zero on
        // llm handlers — fact.node_aborted would land with
        // partialTokens=0/partialCostUsd=0 and run_state.metrics +
        // budget_usd would silently undercount aborted spend. The
        // completion path is unaffected: it only backfills result
        // fields when the handler returned zeros (executor.ts §below),
        // and llm's HandlerResult already carries populated
        // tokens/costUsd from its own accumulator (handler-bridge
        // surfaces the same cost.recorded stream into the result).
        // Per AGENTS.md ground rule #5: this accumulator is turn-local,
        // not a reducer fold of cost.recorded.
        if (type === "cost.recorded") {
          const p = payload as Record<string, unknown>;
          turnBilled += readNumber(p["total_tokens"]);
          totalCostUsd += readNumber(p["cost_usd"]);
          totalInputTokens += readNumber(p["input_tokens"]);
          totalOutputTokens += readNumber(p["output_tokens"]);
          totalCacheReadTokens += readNumber(p["cache_read_tokens"]);
          totalCacheWriteTokens += readNumber(p["cache_write_tokens"]);
          const model = p["model"];
          if (typeof model === "string") lastModel = model;

          // Reactive budget gate. Bounds peak overshoot to one
          // in-flight LLM message rather than the turn's full spend.
          // Fires once per dispatch — the halt / pause flags
          // short-circuit subsequent events. Both stop AND pause
          // policies abort mid-handler; the post-handler arm still
          // exists as a belt-and-suspenders catch for handlers that
          // don't emit `cost.recorded`.
          if (reactiveBudgetHaltDetail === undefined && reactiveBudgetPauseBreach === undefined) {
            const completedNodeAttrs = graph?.nodes[currentNode]?.attrs;
            const priorNodeBucket = state.metrics.nodeCosts[currentNode] ?? { tokens: 0, costUsd: 0 };
            const priorRunFresh = state.metrics.totalInputTokens + state.metrics.totalOutputTokens;
            // Read overrides from effective routing (post-fold) so the
            // Raise & Resume flow takes effect on the FIRST dispatch
            // after resume, not the second. Same for warned-tags.
            const overrides = readBudgetOverrides(effectiveRouting);
            const reactive = evaluateBudget({
              graphAttrs: graph?.attrs ?? {},
              ...(completedNodeAttrs !== undefined ? { completedNodeAttrs } : {}),
              completedNodeId: currentNode,
              cumulativeCostUsd: state.metrics.totalCostUsd + totalCostUsd,
              cumulativeTokens: priorRunFresh + turnBilled,
              nodeCumulativeCostUsd: priorNodeBucket.costUsd + totalCostUsd,
              nodeCumulativeTokens: priorNodeBucket.tokens + turnBilled,
              alreadyWarned: readBudgetWarned(effectiveRouting),
              ...(overrides !== undefined ? { overrides } : {}),
            });
            if (reactive.shouldHalt) {
              reactiveBudgetHaltDetail = reactive.haltReason ?? "";
              for (const ev of reactive.events) {
                observability.push({
                  type: ev.type,
                  payload: { nodeId: currentNode, iteration, ...ev.payload },
                });
              }
              steerCtrl.abort(new Error("budget"));
            } else if (reactive.pauseBreach !== undefined) {
              reactiveBudgetPauseBreach = reactive.pauseBreach;
              for (const ev of reactive.events) {
                observability.push({
                  type: ev.type,
                  payload: { nodeId: currentNode, iteration, ...ev.payload },
                });
              }
              steerCtrl.abort(new Error("budget_pause"));
            }
          }
        }
        // Hard ceiling — bound peak memory and per-batch render cost
        // when a provider streams a burst of deltas faster than the
        // soft timer can drain.
        if (observability.length >= OBSERVABILITY_FLUSH_SIZE_THRESHOLD) {
          flushObservability();
          return;
        }
        // Soft ceiling — coalesce small bursts so we don't hammer the
        // writer lock with one txn per text delta.
        if (observabilityFlushTimer == null) {
          observabilityFlushTimer = setTimeout(flushObservability, OBSERVABILITY_FLUSH_INTERVAL_MS);
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
      flushObservability();
      await tryAppendFact(opts.store, runId, recorder.version(), [
        {
          type: "fact.handler_timeout_leaked",
          payload: { nodeId: currentNode, leakedAt: clock() },
        },
        {
          type: "fact.run_halted",
          payload: { reason: "error", detail: "handler_leaked" },
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
      flushObservability();
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
        usage: {
          tokens: turnBilled,
          costUsd: totalCostUsd,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadTokens: totalCacheReadTokens,
          cacheWriteTokens: totalCacheWriteTokens,
        },
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
      accounting: {
        turnBilled,
        totalCostUsd,
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens,
        totalCacheWriteTokens,
        lastModel,
      },
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
    for (const ev of plan.observability) observability.push(ev);
    flushObservability();

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
    await captureBoundarySnapshot(opts, runId, facts, currentNode);
    return { kind: "continue" };
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
}

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
  return {
    recordLeak: (runId, nodeId) => {
      n += 1;
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
          onExceeded(n);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[executor] onLeakLimitExceeded threw:", err);
        }
      }
    },
    count: () => n,
  };
}
