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
  AUTO_RESUME_AT_KEY,
  type EdgeSelection,
  type ExecutionEnvironment,
  evaluateBudget,
  GOAL_GATE_RETRIES_KEY,
  type Graph,
  type GraphAttrs,
  goalGateOutcomeKey,
  goalGateStep,
  isRetryPresetName,
  type NodeAttrs,
  parseDotSource,
  prepareGraph,
  RETRY_PRESETS,
  type RetryPresetName,
  readGateOutcomes,
  readGoalGateRetries,
  resolveFailRetarget,
  retryCountKey,
  retryStep,
  selectEdge,
} from "@swarm/core";
import * as core from "@swarm/core/handler";
import {
  ConcurrencyError,
  CURRENT_SCHEMA_VERSION,
  type FactEvent,
  type IEventStore,
  MIN_COMPATIBLE_SCHEMA_VERSION,
} from "@swarm/store";
import type { AbortRegistry } from "./abort-registry.ts";
import type { AutoTitler, TitleRequest } from "./auto-titler.ts";
import type { Dispatcher } from "./dispatch.ts";
import {
  decideProviderRetry,
  PROVIDER_RETRY_ATTEMPT_KEY,
  type ProviderRetryDecision,
} from "./provider-retry-policy.ts";
import { CommittingRecorder } from "./recorder.ts";
import { abortResultToFacts, cancelToFacts, resultToFacts } from "./result-to-facts.ts";
import { wakePending } from "./wake-pending.ts";
import type { Provisioner } from "./worktree-provisioner.ts";

type HandlerResult = core.HandlerResult;
type LlmCallFn = core.LlmCallFn;

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
   * resets on any non-abort handler return (transition / yield_hitl /
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
  /** Called when the per-process leaked-handler counter crosses
   * `maxLeakedHandlers`. Default: log to stderr (tests use this). The
   * production daemon entrypoint wires this to `ctrl.abort()` so the
   * outer shutdown drain takes over and the singleton + sweep recover
   * stuck runs on restart. The callback fires at most once per process. */
  onLeakLimitExceeded?: (count: number) => void;
}

const DEFAULT_POLL_MS = 50;
const DEFAULT_LEAK_GRACE_MS = 10_000;
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
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise<void>((resolve) => setTimeout(resolve, drainMs)),
    ]);
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
    // the daemon.
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
  let consecutiveAborts = 0;
  let turns = 0;
  // Dispatches counted for the max_loops ceiling. Incremented just before
  // each `spec.handler(ctx)` call — OCC-retry `continue`s and schema/start
  // bookkeeping iterations don't inflate the count. Pathological workflows
  // that loop without ever aborting (so ABORT_LOOP_CEILING doesn't fire)
  // halt here instead of running forever.
  let dispatches = 0;

  // OCC ceiling guards the unbounded `if (!ok) continue` retry path.
  // Each fact-append site that retries on `ConcurrencyError` increments
  // a counter; the counter resets on the first successful append. At
  // OCC_WARN_AT we emit one observability event per (run, node,
  // iteration); at OCC_CEILING we halt the run with a structured
  // `occ_exhausted` payload. The counter is in-memory, scoped to this
  // dispatch — daemon restart re-enters with a fresh count, which is
  // the correct semantics: the bug shape is "supervisor wedged this
  // turn", which doesn't survive a process restart.
  const OCC_CEILING = 3;
  const OCC_WARN_AT = 2;
  const OCC_BACKOFF_CAP_MS = 16;
  let occCount = 0;
  let occWarned = false;
  const onOccConflict = async (
    attemptedFactType: string,
    nodeId: string,
    iteration: number,
    lastVersion: number,
  ): Promise<{ halted: boolean }> => {
    occCount++;
    if (occCount >= OCC_CEILING) {
      const fresh = opts.store.getState(runId);
      if (fresh != null && fresh.status === "running") {
        await tryAppendFact(opts.store, runId, fresh.version, [
          {
            type: "fact.run_halted",
            payload: {
              reason: "occ_exhausted",
              detail: `${occCount} consecutive OCC conflicts on ${attemptedFactType} for node ${nodeId}`,
              occContext: { count: occCount, nodeId, iteration, lastVersion, attemptedFactType },
            },
          },
        ]);
      }
      return { halted: true };
    }
    if (occCount === OCC_WARN_AT && !occWarned) {
      opts.store.appendObservabilityEvents(runId, [
        {
          type: "occ_conflict_warning",
          payload: { count: occCount, ceiling: OCC_CEILING, nodeId, iteration },
        },
      ]);
      occWarned = true;
    }
    // Exponential backoff: 1ms, 2ms, then capped at 16ms. Gives the
    // conflicting writer's commit a chance to land so the next OCC
    // version-read sees the advanced state.
    const delayMs = Math.min(2 ** (occCount - 1), OCC_BACKOFF_CAP_MS);
    await sleep(delayMs, opts.shutdownSignal);
    return { halted: false };
  };
  const onOccResolved = (nodeId: string, iteration: number): void => {
    if (occCount > 0) {
      opts.store.appendObservabilityEvents(runId, [
        {
          type: "occ_conflict_resolved",
          payload: { count: occCount, nodeId, iteration },
        },
      ]);
    }
    occCount = 0;
    occWarned = false;
  };

  let runEnv: ExecutionEnvironment | undefined;
  // Lazy per-run graph cache. Parsed once on first edge-selection need.
  // The graph is run through `prepareGraph` so transforms (stylesheet,
  // future variable-expansion, …) populate node.attrs before the
  // executor reads them. Stylesheet syntax errors are dropped here —
  // the validator catches them at upload-time via E015, so by the time
  // a graph reaches the executor any stylesheet is well-formed.
  let cachedGraph: Graph | null = null;
  const graphFor = (workflowSha: string | null): Graph | null => {
    if (workflowSha == null) return null;
    if (cachedGraph != null) return cachedGraph;
    const wf = opts.store.getWorkflow(workflowSha);
    if (wf == null) return null;
    try {
      const parsed = parseDotSource(wf.dotSource);
      prepareGraph(parsed);
      cachedGraph = parsed;
      return cachedGraph;
    } catch {
      return null;
    }
  };

  try {
    while (!opts.shutdownSignal.aborted && turns < maxTurns) {
      turns++;
      const state = opts.store.getState(runId);
      if (state == null) return;
      const workflowSha = state.workflowSha;

      if (
        state.status === "completed" ||
        state.status === "cancelled" ||
        state.status === "halted" ||
        state.status === "paused" ||
        state.status === "paused_hitl" ||
        state.status === "paused_provider_retry" ||
        state.status === "paused_retry" ||
        state.status === "quarantined"
      ) {
        return;
      }

      // Schema drift refusal. Versions in the compatibility range
      // [MIN_COMPATIBLE_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION] resume
      // cleanly; only out-of-range pins (older than MIN, or newer than
      // CURRENT — i.e. the daemon was downgraded) halt. See
      // packages/store/src/pragmas.ts for the bumping policy.
      if (state.schemaVersion < MIN_COMPATIBLE_SCHEMA_VERSION || state.schemaVersion > CURRENT_SCHEMA_VERSION) {
        await tryAppendFact(opts.store, runId, state.version, [
          {
            type: "fact.run_halted",
            payload: { reason: "schema_drift" },
          },
        ]);
        return;
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
        await tryAppendFact(opts.store, runId, state.version, cancelToFacts(decision.intentSeq));
        return;
      }

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
        return;
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
          runEnv = await opts.provisioner.ensure(runId, state.cwd != null ? { cwd: state.cwd } : {});
          opts.store.appendDaemonEvent(
            { type: "daemon.worktree_provisioned", payload: { runId, ok: true } },
            { runId },
          );
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
          return;
        }
      }

      if (needsStart) {
        const start = routingString(state.routing, "start_node") ?? "start";
        const baseGitSha = opts.provisioner?.baseGitSha(runId) ?? undefined;
        const startFacts: FactEvent[] = [
          {
            type: "fact.run_started",
            payload: {
              workflowSha: state.workflowSha,
              schemaVersion: state.schemaVersion,
              startNode: start,
              ...(baseGitSha != null ? { baseGitSha } : {}),
            },
          },
        ];
        // Seed graph-level routing keys at run start so $goal substitution
        // and `${context.graph.goal}` references resolve from turn 1
        // onward (attractor §4.5 / §5.1). Closes the silent bug where
        // the agent reads routing["graph.goal"] but nothing wrote it.
        const startGraph = graphFor(state.workflowSha);
        const startRoutingPatch: Record<string, unknown> = {};
        if (typeof startGraph?.attrs.goal === "string" && startGraph.attrs.goal !== "") {
          startRoutingPatch["graph.goal"] = startGraph.attrs.goal;
        }
        if (typeof startGraph?.attrs.label === "string" && startGraph.attrs.label !== "") {
          startRoutingPatch["graph.label"] = startGraph.attrs.label;
        }
        const ok = await tryAppendFact(
          opts.store,
          runId,
          state.version,
          startFacts,
          Object.keys(startRoutingPatch).length > 0 ? { routingPatch: startRoutingPatch } : undefined,
        );
        if (!ok) {
          const { halted } = await onOccConflict("fact.run_started", start, 0, state.version);
          if (halted) return;
          continue;
        }
        onOccResolved(start, 0);
        if (opts.autoTitler) {
          const input = routingString(state.routing, "input") ?? "";
          const goal = graphFor(workflowSha)?.attrs.goal;
          const req: TitleRequest = {
            runId,
            workflowSha,
            input,
          };
          if (goal !== undefined) req.goal = goal;
          opts.autoTitler.titleRun(req);
        }
        continue; // Reload state next turn with the new run_started applied.
      }

      if (currentNode == null) return;

      // Production ceiling on handler dispatches. A workflow that loops
      // without ever aborting (so ABORT_LOOP_CEILING never fires) would
      // otherwise run until budget or wall-clock killed it. This is the
      // last-resort guard; workflow authors should bound loops via
      // `max_retries` on backward edges.
      if (dispatches >= maxLoops) {
        await tryAppendFact(opts.store, runId, state.version, [
          {
            type: "fact.run_halted",
            payload: { reason: "max_loops", detail: `exceeded ${maxLoops} dispatches` },
          },
        ]);
        return;
      }
      dispatches++;

      // Stamp dispatchStartedAt before handing control to the handler
      // so activeMs accounting captures this dispatch interval.
      // fact.run_started covers the very first dispatch (it stamps
      // dispatchStartedAt directly via its own reducer case), so we
      // only emit here when the projection's dispatchStartedAt was
      // reset by a prior terminal/pause fact.
      if (state.dispatchStartedAt == null) {
        const dispatchIteration = nodeRetryCount(state.routing);
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
          dispatches--;
          const { halted } = await onOccConflict(
            "fact.dispatch_started",
            currentNode,
            dispatchIteration,
            state.version,
          );
          if (halted) return;
          continue;
        }
        onOccResolved(currentNode, dispatchIteration);
        continue;
      }

      // Dispatch.
      const spec = opts.dispatcher.get(workflowSha, currentNode);
      const steerCtrl = new AbortController();
      const signals: AbortSignal[] = [steerCtrl.signal, AbortSignal.timeout(spec.maxMs), opts.shutdownSignal];
      const signal = AbortSignal.any(signals);
      opts.registry.register(runId, steerCtrl);

      const iteration = nodeRetryCount(state.routing);
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
      // so every handler kind (codergen, tool, parallel branches, custom)
      // respects the same structural enforcement.
      const graph = graphFor(state.workflowSha);
      const nodeAttrs = graph?.nodes[currentNode]?.attrs;
      const allowedTools = Array.isArray(nodeAttrs?.allowed_tools)
        ? (nodeAttrs.allowed_tools as readonly string[])
        : undefined;
      const deniedTools = Array.isArray(nodeAttrs?.denied_tools)
        ? (nodeAttrs.denied_tools as readonly string[])
        : undefined;

      // Captured outputs of every prior node, keyed by nodeId. Re-folded on
      // every dispatch from `fact.node_completed` events that carry an
      // outputRef. Without this, downstream `$<nodeId>.output` substitution
      // resolves to the empty string and aborts cascade through the graph.
      const nodeOutputs = opts.store.getNodeOutputs(runId);

      const ctxOpts: core.BuildContextOpts = {
        runId,
        nodeId: currentNode,
        iteration,
        signal,
        routing: state.routing,
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
        args: buildSubstitutionArgs(runId, state.routing),
        nodeOutputs,
        emitObservability: (type, payload) => {
          // Stamp nodeId + iteration so the UI can scope without the
          // handler having to thread it through every payload.
          observability.push({
            type,
            payload: { nodeId: currentNode, iteration, ...payload },
          });
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
      if (decision.hitlInput !== undefined) ctxOpts.hitlInput = decision.hitlInput;
      if (decision.steering !== undefined) ctxOpts.steering = decision.steering;
      if (runEnv !== undefined) ctxOpts.env = runEnv;
      // Budget snapshot at dispatch time. The backend embeds this verbatim
      // into `llm.start.budget` so the UI can render "X of Y used" without
      // cross-referencing the graph attrs. Only populated when at least one
      // ceiling (run-level or node-level cost) is configured.
      const runMaxCostUsd = graph?.attrs.budget_usd;
      const nodeMaxCostUsd = nodeAttrs?.max_cost_usd;
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
      try {
        // Promise.race against a marker rather than a rejecting timer: a
        // rejection from the timer would mask an ignored-AbortSignal as
        // "handler error" in the catch block (the original code's
        // `.then(_ => …)` callback never fired because `timeoutReject`
        // never fulfilled). Resolving with a sentinel lets us detect the
        // leak unambiguously.
        const raced = await Promise.race<HandlerResult | typeof TIMEOUT_SENTINEL>([
          spec.handler(ctx),
          new Promise<typeof TIMEOUT_SENTINEL>((res) =>
            setTimeout(() => res(TIMEOUT_SENTINEL), spec.maxMs + leakGrace),
          ),
        ]);
        if (raced === TIMEOUT_SENTINEL) {
          leakedTimeout = true;
          result = { kind: "halt", reason: "error", detail: "timeout_leaked" };
        } else {
          result = raced;
        }
      } catch (err) {
        wasAborted = isAbortError(err);
        if (wasAborted) abortCause = classifyAbortCause(signal, err);
        result = {
          kind: "halt",
          reason: "error",
          detail: errorMessage(err),
        };
      } finally {
        opts.registry.unregister(runId);
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
        return;
      }

      if (wasAborted) {
        flushObservability();
        // Reapply partial usage to node_aborted; executor doesn't roll back blobs.
        // Side-effect facts are already durable via the pre-commit recorder.
        const facts = abortResultToFacts(currentNode, iteration, abortCause, {
          tokens: turnBilled,
          costUsd: totalCostUsd,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadTokens: totalCacheReadTokens,
          cacheWriteTokens: totalCacheWriteTokens,
        });
        await tryAppendFact(opts.store, runId, recorder.version(), facts);
        consecutiveAborts++;
        // One-shot warning the abort before the halt lands so a watcher
        // sees the trend before the run dies. Observability (no version
        // bump, no OCC) so it can ride alongside the just-committed
        // fact.node_aborted in causal order.
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
                type: "fact.run_halted",
                payload: { reason: "abort_loop" },
              },
            ],
          );
          return;
        }
        continue;
      } else {
        consecutiveAborts = 0;
      }

      // Attach LLM accounting into the node_completed fact if the handler
      // didn't set these explicitly.
      if (result.kind === "transition") {
        if (result.tokens === 0 && turnBilled > 0) result.tokens = turnBilled;
        if (result.costUsd === 0 && totalCostUsd > 0) result.costUsd = totalCostUsd;
        // Split fields: only fill from executor accounting when the handler
        // didn't already report any. Handlers that already know their own
        // split (handler-bridge aggregating cost.recorded) win — the
        // executor's LlmAccounting doesn't see codergen calls that go
        // through the agent backend.
        if ((result.inputTokens ?? 0) === 0 && totalInputTokens > 0) result.inputTokens = totalInputTokens;
        if ((result.outputTokens ?? 0) === 0 && totalOutputTokens > 0) result.outputTokens = totalOutputTokens;
        if ((result.cacheReadTokens ?? 0) === 0 && totalCacheReadTokens > 0) {
          result.cacheReadTokens = totalCacheReadTokens;
        }
        if ((result.cacheWriteTokens ?? 0) === 0 && totalCacheWriteTokens > 0) {
          result.cacheWriteTokens = totalCacheWriteTokens;
        }
        if (result.modelName == null && lastModel != null) result.modelName = lastModel;

        // Edge selection: when the handler left `nextNode` unset, pick from
        // the current node's outgoing edges via the 5-rule selector (SPEC
        // §3.8). With it set, the handler is bypassing routing on purpose.
        if (result.nextNode == null) {
          const graph = graphFor(state.workflowSha);
          const srcNode = graph?.nodes[currentNode];
          if (graph != null && srcNode != null) {
            const selection = selectEdge({
              graph,
              source: srcNode,
              outcome: {
                status: result.outcomeStatus ?? "success",
                context_updates: {},
                preferred_label: result.preferredLabel ?? "",
                suggested_next_ids: result.suggestedNextIds ?? [],
                notes: "",
              },
              context: state.routing,
            });
            if (selection != null) {
              result.nextNode = selection.edge.to;
              recordEdgeSelected(observability, currentNode, iteration, selection);
            } else if (result.outcomeStatus === "fail") {
              // §3.7 step 2/3 — when no fail-edge claimed the failure,
              // consult the source node's retry_target / fallback_retry_target
              // before halting. Step 4 (pipeline termination) is the
              // `__end__` fallback below when no retarget resolves.
              const retarget = resolveFailRetarget(graph, currentNode);
              if (retarget != null) {
                result.nextNode = retarget;
              } else {
                // No fail-edge and no retarget — terminal halt path.
                result.nextNode = "__end__";
              }
            } else {
              // No outgoing edges or no viable selection — terminal.
              result.nextNode = "__end__";
            }
          } else {
            // Graph unavailable (already-running test fixtures without a
            // parseable workflow) — terminal by default.
            result.nextNode = "__end__";
          }
        }
      }

      // Budget enforcement at the post-handler boundary. The check sees
      // cumulative spend INCLUDING this turn (state.metrics doesn't have
      // the new fact applied yet, so we add result.{tokens,costUsd} in).
      // On halt, rewrite `result` to a budget halt before resultToFacts
      // runs so the resulting fact chain is `[budget.stop, fact.run_halted]`.
      // On warn-only, prepend the warn event(s) to observability and let
      // the transition continue.
      let budgetWarnedTags: readonly string[] = [];
      let budgetPause: { scope: "node" | "run"; metric: "cost" | "tokens"; limit: number; actual: number } | undefined;
      if (result.kind === "transition") {
        const graph = graphFor(state.workflowSha);
        const completedNodeAttrs = graph?.nodes[currentNode]?.attrs;
        const turnFresh = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
        const turnCost = result.costUsd ?? 0;
        const priorNodeBucket = state.metrics.nodeCosts[currentNode] ?? { tokens: 0, costUsd: 0 };
        const priorRunFresh = state.metrics.totalInputTokens + state.metrics.totalOutputTokens;
        const alreadyWarned = readBudgetWarned(state.routing);
        const overrides = readBudgetOverrides(state.routing);
        const decisionBudget = evaluateBudget({
          graphAttrs: graph?.attrs ?? {},
          ...(completedNodeAttrs !== undefined ? { completedNodeAttrs } : {}),
          completedNodeId: currentNode,
          cumulativeCostUsd: state.metrics.totalCostUsd + turnCost,
          cumulativeTokens: priorRunFresh + turnFresh,
          nodeCumulativeCostUsd: priorNodeBucket.costUsd + turnCost,
          nodeCumulativeTokens: priorNodeBucket.tokens + turnFresh,
          alreadyWarned,
          ...(overrides !== undefined ? { overrides } : {}),
        });
        for (const ev of decisionBudget.events) {
          observability.push({ type: ev.type, payload: { nodeId: currentNode, iteration, ...ev.payload } });
        }
        budgetWarnedTags = decisionBudget.newlyWarned;
        if (decisionBudget.shouldHalt) {
          result = {
            kind: "halt",
            reason: "budget",
            ...(decisionBudget.haltReason !== undefined ? { detail: decisionBudget.haltReason } : {}),
          };
        } else if (decisionBudget.pauseBreach !== undefined) {
          budgetPause = decisionBudget.pauseBreach;
        }
      }

      // Goal-gate enforcement (attractor §3.4). Two responsibilities:
      //   1. Record this node's outcome under `goal_gates.<id>` whenever it
      //      has goal_gate=true, so terminal-arrival can read the fold.
      //   2. When the resolved transition leads to a terminal, check every
      //      visited gate: if any unsatisfied, redirect to the §3.4 chain
      //      (gate.retry_target → gate.fallback_retry_target → graph.retry_target
      //      → graph.fallback_retry_target) bounded by max_goal_gate_retries.
      //   3. Counter exhaust → halt with `goal_gate_unsatisfied`.
      //
      // The current-turn outcome is folded into a synthetic snapshot before
      // checking gates, so a final-stage gate that just completed can be
      // evaluated without waiting for the next turn's projection refresh.
      let goalGateRetargetTarget: string | undefined;
      let goalGateRetriesPatch: number | undefined;
      if (result.kind === "transition") {
        const graph = graphFor(state.workflowSha);
        const completedNode = graph?.nodes[currentNode];
        if (graph != null && completedNode != null) {
          const isTerminalNext =
            result.nextNode === "__end__" ||
            result.nextNode === "end" ||
            result.nextNode === "done" ||
            (result.nextNode != null && graph.nodes[result.nextNode]?.shape === "Msquare");
          // Synthetic outcome map: prior gates from routing + this turn's gate.
          const priorOutcomes = readGateOutcomes(state.routing);
          const synthOutcomes = new Map(priorOutcomes);
          if (completedNode.attrs.goal_gate === true && result.outcomeStatus != null) {
            synthOutcomes.set(currentNode, result.outcomeStatus);
          }
          if (isTerminalNext) {
            const action = goalGateStep({
              graph,
              outcomes: synthOutcomes,
              retries: readGoalGateRetries(state.routing),
            });
            if (action.kind === "retarget") {
              goalGateRetargetTarget = action.target;
              goalGateRetriesPatch = action.nextRetries;
              result.nextNode = action.target;
              observability.push({
                type: "goal_gate.retarget",
                payload: { failedGate: action.gate, target: action.target, retries: action.nextRetries },
              });
            } else if (action.kind === "halt") {
              observability.push({
                type: "goal_gate.unsatisfied",
                payload: { gate: action.gate },
              });
              result = {
                kind: "halt",
                reason: "goal_gate_unsatisfied",
                detail: action.gate,
              };
            }
          }
        }
      }

      // Retry-policy enforcement (attractor §3.5 / §3.6). When the handler
      // returns outcomeStatus="retry", consult retryStep to decide:
      //   - retry → emit fact.run_paused_retry (transitions to paused_retry,
      //     freeing the slot); wake-pending re-queues the run after delayMs
      //   - halt → run halts with `max_retries_exceeded`
      //   - advance_partial → rewrite outcomeStatus to "partial_success"
      //     and let edge selection advance (allow_partial branch, §3.5)
      //
      // For the retry path we DO emit fact.node_completed first (metrics
      // are real spend), THEN swap fact.node_started for fact.run_paused_retry
      // — the run sleeps without a slot held, and resume re-dispatches the
      // same node since state.currentNode points back at the retrying id.
      let retryCounterPatch: Record<string, number> | undefined;
      let retryPause:
        | {
            nodeId: string;
            attempt: number;
            delayMs: number;
            resumeAt: number;
            maxRetries: number;
          }
        | undefined;
      if (result.kind === "transition" && result.outcomeStatus === "retry") {
        const graph = graphFor(state.workflowSha);
        const completedNode = graph?.nodes[currentNode];
        if (graph != null && completedNode != null) {
          const backoff = resolveBackoff(completedNode.attrs, graph.attrs);
          const maxRetries = resolveMaxRetries(completedNode.attrs, graph.attrs);
          const allowPartial = completedNode.attrs.allow_partial === true;
          const counterKey = retryCountKey(currentNode);
          const priorRetries = readNumber(state.routing[counterKey]);
          const action = retryStep({
            state: { retries: priorRetries, maxRetries },
            status: "retry",
            backoff,
            allowPartial,
          });
          if (action.kind === "retry") {
            const now = clock();
            const resumeAt = now + Math.max(0, Math.round(action.delayMs));
            observability.push({
              type: "node.retry_scheduled",
              payload: {
                nodeId: currentNode,
                attempt: priorRetries + 1,
                delayMs: action.delayMs,
                maxRetries,
                resumeAt,
              },
            });
            // Set nextNode = currentNode so fact.node_completed records
            // the loop intent (state.currentNode lands on the retrying
            // node; resume re-dispatches it).
            result.nextNode = currentNode;
            retryCounterPatch = {
              [counterKey]: priorRetries + 1,
            };
            retryPause = {
              nodeId: currentNode,
              attempt: priorRetries + 1,
              delayMs: action.delayMs,
              resumeAt,
              maxRetries,
            };
          } else if (action.kind === "halt") {
            observability.push({
              type: "node.retry_exhausted",
              payload: { nodeId: currentNode, attempts: priorRetries + 1, maxRetries },
            });
            result = {
              kind: "halt",
              reason: "max_retries_exceeded",
              detail: `node "${currentNode}" exhausted ${maxRetries} retries`,
            };
          } else if (action.kind === "advance_partial") {
            observability.push({
              type: "node.retry_partial_accept",
              payload: { nodeId: currentNode, attempts: priorRetries + 1, maxRetries },
            });
            result.outcomeStatus = "partial_success";
          }
        }
      }

      // Provider auto-retry: when a codergen turn returns pause_provider,
      // consult the policy module to decide whether this is auto-retry
      // (transient transport error, schedule a backoff), manual (operator
      // must intervene — auth/billing/schema), or halt-exhausted (chain
      // cap exceeded). The decision drives fact mutation + routing patches
      // below; manual is the existing behaviour and needs no further work.
      // The exhausted branch emits a `provider_exhausted` halt fact
      // directly — that reason is executor-only (not in the handler-side
      // HaltReason union) so we don't go through resultToFacts.
      let providerRetryDecision: ProviderRetryDecision | undefined;
      let providerExhausted: { attempt: number; reason: "max_attempts" | "max_cumulative_ms" } | undefined;
      if (result.kind === "pause_provider") {
        providerRetryDecision = decideProviderRetry({
          httpStatus: result.httpStatus,
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
          priorAttempt: readNumber(state.routing[PROVIDER_RETRY_ATTEMPT_KEY]),
          now: clock(),
          cumulativeDelayMs: 0,
        });
        if (providerRetryDecision.kind === "exhausted") {
          providerExhausted = { attempt: providerRetryDecision.attempt, reason: providerRetryDecision.reason };
          providerRetryDecision = undefined;
        }
      }

      // Tail-drain: the handler may have streamed most of its deltas
      // mid-flight via the timer, but `edge.selected` and any post-handler
      // observability (e.g. budget warnings above) still need to flush
      // before the terminal fact for causal ordering.
      flushObservability();

      // Side-effect facts are already durable via the pre-commit recorder;
      // resultToFacts only emits the terminal node_* / run_* facts.
      const factsCtx = {
        state,
        appliedIntentSeqs: decision.appliedSeqs,
      };
      let facts = resultToFacts(result, factsCtx);

      // R3 — pause defers when paired with steer/hitl: keep the
      // node_completed accounting, then pause instead of advancing to
      // the next node. wakePending will rouse the run on the next
      // intent.hitl_input. Terminal halts (run_halted) beat pause; we
      // only swap the success continuations (node_started / run_completed).
      // Mid-dispatch pause races (intent arrives AFTER the fold but
      // BEFORE the handler returned) flow through the abort-throw path:
      // the codergen agent rethrows on signal-tripped + aborted-stream
      // so the executor's catch block writes fact.node_aborted, leaves
      // the run running, and the next dispatch's fold consumes the
      // pause intent normally.
      if (result.kind === "transition" && decision.shouldPauseAfterDispatch) {
        const swapTypes = new Set(["fact.node_started", "fact.run_completed"]);
        const swapped = facts.some((f) => swapTypes.has(f.type));
        if (swapped) {
          facts = facts.filter((f) => !swapTypes.has(f.type));
          facts.push({
            type: "fact.run_paused",
            payload: {
              reason: "operator",
              nodeId: state.currentNode ?? "",
            },
          });
        }
      }

      // Retry pause: swap fact.node_started for fact.run_paused_retry so
      // the run releases its concurrency slot during the backoff window.
      // node_completed is preserved (metrics + the nextNode=currentNode
      // routing fact). wake-pending re-queues the run once `resumeAt`
      // has elapsed.
      if (retryPause !== undefined) {
        facts = facts.filter((f) => f.type !== "fact.node_started");
        facts.push({
          type: "fact.run_paused_retry",
          payload: retryPause,
        });
      }

      // Provider exhausted: swap fact.run_paused for a terminal halt with
      // reason="provider_exhausted". Carry the attempt count + cap-reason
      // in detail for post-mortem.
      if (providerExhausted !== undefined) {
        facts = facts.filter((f) => f.type !== "fact.run_paused");
        facts.push({
          type: "fact.run_halted",
          payload: {
            reason: "provider_exhausted",
            detail: `provider retry chain exhausted after ${providerExhausted.attempt} attempts (${providerExhausted.reason})`,
          },
        });
      }

      // Provider auto-retry: extend the existing fact.run_paused payload
      // (which carries reason="provider_error") with policy + attempt +
      // resumeAt so the reducer projects status to `paused_provider_retry`
      // and the wake-pending sweeper auto-resumes once `resumeAt` has
      // elapsed. The chain is recorded separately via
      // fact.provider_retry_attempted (one per attempt).
      if (providerRetryDecision?.kind === "auto-retry") {
        for (const f of facts) {
          if (f.type === "fact.run_paused" && f.payload.reason === "provider_error") {
            f.payload.policy = "auto-retry";
            f.payload.attempt = providerRetryDecision.attempt;
            f.payload.resumeAt = providerRetryDecision.resumeAt;
            break;
          }
        }
        facts.push({
          type: "fact.provider_retry_attempted",
          payload: {
            nodeId: state.currentNode ?? "",
            attempt: providerRetryDecision.attempt,
            httpStatus: result.kind === "pause_provider" ? result.httpStatus : null,
            delayMs: providerRetryDecision.delayMs,
          },
        });
      }

      // Budget pause: swap fact.node_started for fact.run_paused{reason:"budget"}
      // so the run releases its slot and waits for `intent.budget_adjusted`
      // + `intent.resume`. node_completed is preserved (metrics + the
      // nextNode routing fact).
      //
      // EXCEPTION: when this turn's transition was terminal,
      // result-to-facts has already emitted `fact.run_completed`
      // (or `fact.run_halted` for fail outcomes). Adding
      // `fact.run_paused` afterwards would clobber the terminal
      // status in the reducer (paused wins because it's last) and
      // leave `currentNode` pointed at a terminal sentinel — on
      // resume, the dispatcher crashes trying to find a handler for
      // `done` / `__end__`. Budget enforcement after a successful
      // terminal transition is moot anyway: the run is finished.
      if (budgetPause !== undefined) {
        const alreadyTerminal = facts.some((f) => f.type === "fact.run_completed" || f.type === "fact.run_halted");
        if (!alreadyTerminal) {
          facts = facts.filter((f) => f.type !== "fact.node_started");
          facts.push({
            type: "fact.run_paused",
            payload: {
              reason: "budget",
              nodeId: state.currentNode ?? "",
              scope: budgetPause.scope,
              metric: budgetPause.metric,
              limit: budgetPause.limit,
              actual: budgetPause.actual,
            },
          });
        }
      }

      let routingPatch = mergeRoutingPatches(decision.routingDelta, result);
      if (budgetWarnedTags.length > 0) {
        const prior = readBudgetWarned(state.routing);
        const merged = new Set(prior);
        for (const tag of budgetWarnedTags) merged.add(tag);
        routingPatch = { ...(routingPatch ?? {}), [BUDGET_WARNED_KEY]: [...merged].sort() };
      }
      // Per-node retry counter: bumped when retryStep returned `retry`
      // above. Lives at `internal.retry_count.<nodeId>` (see
      // packages/core/src/types/context.ts:retryCountKey).
      if (retryCounterPatch !== undefined) {
        routingPatch = { ...(routingPatch ?? {}), ...retryCounterPatch };
      }
      // Retry pause: stamp the wake-eligibility timestamp so wake-pending
      // can re-queue this run when the backoff has elapsed.
      if (retryPause !== undefined) {
        routingPatch = { ...(routingPatch ?? {}), [AUTO_RESUME_AT_KEY]: retryPause.resumeAt };
      }
      // Provider auto-retry: same shape, plus persist the attempt counter
      // so the next pause_provider in the chain reads it and the cap
      // bounds the run even across manual `intent.resume` interruptions.
      if (providerRetryDecision?.kind === "auto-retry") {
        routingPatch = {
          ...(routingPatch ?? {}),
          [AUTO_RESUME_AT_KEY]: providerRetryDecision.resumeAt,
          [PROVIDER_RETRY_ATTEMPT_KEY]: providerRetryDecision.attempt,
        };
      }
      // Clear the provider-retry chain counter on any successful turn
      // so future failures in this run start a fresh chain. Keep the
      // counter on `transition` outcomes regardless of outcomeStatus —
      // a `fail` outcome from the agent (not a transport error) means
      // the call landed; the chain-counter doesn't apply.
      if (result.kind === "transition" && readNumber(state.routing[PROVIDER_RETRY_ATTEMPT_KEY]) > 0) {
        routingPatch = { ...(routingPatch ?? {}), [PROVIDER_RETRY_ATTEMPT_KEY]: 0 };
      }
      // Goal-gate routing keys: record the completed gate's outcome and
      // (when goalGateStep retargeted) the bumped retry counter. These keys
      // power the §3.4 fold across turns — readGateOutcomes /
      // readGoalGateRetries pick them up next turn.
      if (result.kind === "transition") {
        const graph = graphFor(state.workflowSha);
        const completedNode = graph?.nodes[currentNode];
        if (completedNode?.attrs.goal_gate === true && result.outcomeStatus != null) {
          routingPatch = {
            ...(routingPatch ?? {}),
            [goalGateOutcomeKey(currentNode)]: result.outcomeStatus,
          };
        }
        if (goalGateRetargetTarget !== undefined && goalGateRetriesPatch !== undefined) {
          routingPatch = {
            ...(routingPatch ?? {}),
            [GOAL_GATE_RETRIES_KEY]: goalGateRetriesPatch,
          };
        }
      }
      const advanceAppliedTo = decision.appliedSeqs.length > 0 ? Math.max(...decision.appliedSeqs) : undefined;
      const appendOpts: {
        routingPatch?: Record<string, unknown>;
        advanceAppliedTo?: number;
      } = {};
      if (routingPatch !== undefined) appendOpts.routingPatch = routingPatch;
      if (advanceAppliedTo !== undefined) appendOpts.advanceAppliedTo = advanceAppliedTo;
      const ok = await tryAppendFact(opts.store, runId, recorder.version(), facts, appendOpts);
      if (!ok) {
        const turnIteration = nodeRetryCount(state.routing);
        const turnFactType = facts[0]?.type ?? "fact.unknown";
        const { halted } = await onOccConflict(turnFactType, currentNode, turnIteration, recorder.version());
        if (halted) return;
        continue; // OCC retry — rebuild from fresh state
      }
      onOccResolved(currentNode, nodeRetryCount(state.routing));
    }
  } finally {
    // Dispose the worktree env when the run reaches a hard-terminal
    // status. We intentionally skip dispose on paused_hitl so the env
    // survives across HITL pauses and the same worktree can be reused
    // on resume. completed / cancelled / halted / quarantined are all
    // truly terminal — the run will never execute another node.
    //
    // Dispose may preserve the worktree's working state on a fresh
    // `swarm/runs/<runId>` branch. When it does, emit a follow-up
    // `fact.run_branched` so `run_state.branch` is set and `swarm gc
    // --branches` can later reason about the ref. The terminal fact has
    // already landed by this point — `fact.run_branched` is post-terminal
    // metadata, not a status transition.
    if (opts.provisioner) {
      const finalState = opts.store.getState(runId);
      const terminalStatuses = new Set(["completed", "cancelled", "halted", "quarantined"]);
      if (finalState != null && terminalStatuses.has(finalState.status) && finalState.workflowSha != null) {
        const workflow = opts.store.getWorkflow(finalState.workflowSha);
        const ctx = {
          status: finalState.status,
          workflowName: workflow?.name ?? "unknown",
          workflowSha: finalState.workflowSha,
        };
        try {
          const { branch } = await opts.provisioner.dispose(runId, ctx);
          if (branch != null) {
            // Best-effort — if the OCC retry races us, the run is
            // already terminal and the executor is exiting, so a single
            // append attempt is enough. Don't loop.
            await tryAppendFact(opts.store, runId, finalState.version, [
              { type: "fact.run_branched", payload: { branch } },
            ]);
          }
        } catch (err) {
          opts.store.appendDaemonEvent(
            {
              type: "daemon.worktree_provisioned",
              payload: {
                runId,
                ok: false,
                errorDetail: `dispose failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            },
            { runId },
          );
        }
      }
    }
  }
}

async function tryAppendFact(
  store: IEventStore,
  runId: string,
  expectedVersion: number,
  facts: FactEvent[],
  opts?: {
    routingPatch?: Record<string, unknown>;
    advanceAppliedTo?: number;
  },
): Promise<boolean> {
  if (facts.length === 0) return true;
  try {
    store.appendFact(runId, facts, expectedVersion, opts);
    return true;
  } catch (err) {
    if (err instanceof ConcurrencyError) return false;
    throw err;
  }
}

function mergeRoutingPatches(
  fromIntents: Record<string, unknown>,
  result: core.HandlerResult,
): Record<string, unknown> | undefined {
  const fromResult = result.kind === "transition" || result.kind === "yield_hitl" ? result.routingDelta : undefined;
  const merged: Record<string, unknown> = { ...fromIntents, ...fromResult };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Sentinel returned by the leak-detection timer in `Promise.race` so
 * the executor can tell "the handler ignored its AbortSignal past
 * `maxMs + leakGrace`" from "the handler rejected normally" (which goes
 * through the catch branch). Symbol equality is the only check needed —
 * no risk of a handler returning the same value. */
const TIMEOUT_SENTINEL: unique symbol = Symbol("timeout-sentinel");

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  return false;
}

/**
 * Decide whether an abort was due to the node's own maxMs deadline
 * or an operator / shutdown / steer signal. Reads `signal.reason`
 * first (set by the aborting source via `AbortSignal.any`'s
 * reason-propagation) and falls back to the thrown error's name.
 * A TimeoutError reason indicates the `AbortSignal.timeout(maxMs)`
 * branch tripped; any other error name means an explicit abort
 * tripped first.
 */
export function classifyAbortCause(signal: AbortSignal, err: unknown): "timeout" | "aborted" {
  const reason = signal.aborted ? signal.reason : undefined;
  if (reason instanceof Error && reason.name === "TimeoutError") return "timeout";
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  return "aborted";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function routingString(routing: Record<string, unknown>, key: string): string | undefined {
  const v = routing[key];
  return typeof v === "string" ? v : undefined;
}

/** Read the per-node retry counter from routing. Attractor §3.6:
 * bumped each time a backward edge re-enters a node after a
 * non-success outcome. */
function nodeRetryCount(routing: Record<string, unknown>): number {
  const v = routing["retry_count"];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

type ResumeOf = "fresh" | "crash" | "paused" | "paused_hitl" | "paused_provider_retry" | "paused_retry" | "quarantined";

/** Determine why this dispatch is starting, for fact.dispatch_started's
 * resumeOf field. Walks recent facts looking for the one that flipped
 * the run back to a dispatchable state:
 *   fact.run_resumed{fromStatus} → forward fromStatus
 *   fact.run_requeued_after_crash → "crash"
 *   any other fact (run_started, dispatch_started, node_*) → "fresh"
 * Bounded lookback — 20 events is plenty when the trigger fact is the
 * most recent one. We can't gate on status alone because claimNextRun
 * flips queued → running before this point. */
function deriveResumeOf(
  store: { getEvents: (runId: string, opts?: { limit?: number }) => Array<{ type: string; payload: unknown }> },
  runId: string,
): ResumeOf {
  const recent = store.getEvents(runId, { limit: 20 });
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (e == null) continue;
    if (e.type === "fact.run_resumed") {
      const fs = (e.payload as { fromStatus?: string } | null)?.fromStatus;
      if (
        fs === "paused" ||
        fs === "paused_hitl" ||
        fs === "paused_provider_retry" ||
        fs === "paused_retry" ||
        fs === "quarantined"
      )
        return fs;
      return "fresh";
    }
    if (e.type === "fact.run_requeued_after_crash") return "crash";
    if (e.type.startsWith("fact.")) return "fresh";
  }
  return "fresh";
}

/** Reserved routing key for budget-warn dedup. Holds the set of
 * `(scope:metric)` tags that have already fired their once-per-run
 * `budget.warn` event. The budget policy reads + extends it; the
 * executor merges new tags into the routing patch on commit. */
const BUDGET_WARNED_KEY = "__budget_warned";

function readBudgetWarned(routing: Record<string, unknown>): ReadonlySet<string> {
  const v = routing[BUDGET_WARNED_KEY];
  if (!Array.isArray(v)) return new Set();
  const out = new Set<string>();
  for (const item of v) if (typeof item === "string") out.add(item);
  return out;
}

/** Read operator-supplied budget overrides from `routing.budget_override.<scope>.<metric>`
 * (folded by intent-fold from `intent.budget_adjusted`). Returns undefined when
 * no overrides are set; the budget policy falls back to graph/node attrs. */
function readBudgetOverrides(routing: Record<string, unknown>):
  | {
      run?: { cost?: number; tokens?: number };
      node?: { cost?: number; tokens?: number };
    }
  | undefined {
  const run: { cost?: number; tokens?: number } = {};
  const node: { cost?: number; tokens?: number } = {};
  for (const [k, v] of Object.entries(routing)) {
    if (typeof v !== "number") continue;
    if (k === "budget_override.run.cost") run.cost = v;
    else if (k === "budget_override.run.tokens") run.tokens = v;
    else if (k === "budget_override.node.cost") node.cost = v;
    else if (k === "budget_override.node.tokens") node.tokens = v;
  }
  const hasRun = run.cost !== undefined || run.tokens !== undefined;
  const hasNode = node.cost !== undefined || node.tokens !== undefined;
  if (!hasRun && !hasNode) return undefined;
  const out: { run?: { cost?: number; tokens?: number }; node?: { cost?: number; tokens?: number } } = {};
  if (hasRun) out.run = run;
  if (hasNode) out.node = node;
  return out;
}

/**
 * Stamp the selected edge into the observability buffer so the UI and
 * replay tools see exactly which rule picked the traversal. `edge.selected`
 * is in the core EventType union; emitted alongside `fact.node_completed`
 * at commit time.
 */
function recordEdgeSelected(
  buffer: { type: string; payload: Record<string, unknown> }[],
  fromNode: string,
  iteration: number,
  selection: EdgeSelection,
): void {
  const payload: Record<string, unknown> = {
    from: fromNode,
    to: selection.edge.to,
    iteration,
    rule: selection.rule,
  };
  if (selection.matched !== undefined) {
    if (selection.rule === "condition") payload["matched_condition"] = selection.matched;
    else if (selection.rule === "preferred_label") payload["matched_label"] = selection.matched;
    else payload["matched"] = selection.matched;
  }
  buffer.push({ type: "edge.selected", payload });
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

export function buildSubstitutionArgs(_runId: string, routing: Record<string, unknown>): Record<string, string> {
  const args: Record<string, string> = {};
  const input = routing["input"];
  if (typeof input === "string") args["$ARGUMENTS"] = input;
  return args;
}

function readNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Resolve the effective BackoffConfig for a node from
 * (node.retry_policy → graph.default_retry_policy → "none") plus the
 * custom-override attrs (retry_initial_delay_ms / retry_backoff_factor /
 * retry_max_delay_ms / retry_jitter). */
function resolveBackoff(
  nodeAttrs: NodeAttrs,
  graphAttrs: GraphAttrs,
): {
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
  jitter: boolean;
} {
  const presetName: RetryPresetName = isRetryPresetName(nodeAttrs.retry_policy)
    ? nodeAttrs.retry_policy
    : isRetryPresetName(graphAttrs.default_retry_policy)
      ? graphAttrs.default_retry_policy
      : "none";
  const preset = RETRY_PRESETS[presetName];
  return {
    initialDelayMs:
      typeof nodeAttrs.retry_initial_delay_ms === "number" ? nodeAttrs.retry_initial_delay_ms : preset.initialDelayMs,
    backoffFactor:
      typeof nodeAttrs.retry_backoff_factor === "number" ? nodeAttrs.retry_backoff_factor : preset.backoffFactor,
    maxDelayMs: typeof nodeAttrs.retry_max_delay_ms === "number" ? nodeAttrs.retry_max_delay_ms : preset.maxDelayMs,
    jitter: typeof nodeAttrs.retry_jitter === "boolean" ? nodeAttrs.retry_jitter : preset.jitter,
  };
}

/** Resolve max_retries (= max_attempts - 1, attractor §3.5). Precedence:
 * explicit node.max_retries → preset.maxAttempts - 1 →
 * graph.default_max_retries → 0. */
function resolveMaxRetries(nodeAttrs: NodeAttrs, graphAttrs: GraphAttrs): number {
  if (typeof nodeAttrs.max_retries === "number") return Math.max(0, Math.floor(nodeAttrs.max_retries));
  const presetName: RetryPresetName = isRetryPresetName(nodeAttrs.retry_policy)
    ? nodeAttrs.retry_policy
    : isRetryPresetName(graphAttrs.default_retry_policy)
      ? graphAttrs.default_retry_policy
      : "none";
  const preset = RETRY_PRESETS[presetName];
  if (preset.maxAttempts > 0) return preset.maxAttempts - 1;
  if (typeof graphAttrs.default_max_retries === "number") {
    return Math.max(0, Math.floor(graphAttrs.default_max_retries));
  }
  return 0;
}
