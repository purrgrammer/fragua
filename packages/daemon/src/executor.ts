// Executor fiber — ARCHITECTURE.md §6.
//
// One executor loop per daemon. It repeatedly:
//   1. Polls for the next claimable run (concurrency-capped).
//   2. For each claimed run, walks turns until a terminal or paused state.
//   3. On each turn: fold intents, build handler context, dispatch, map
//      result → facts, commit via appendFact with OCC.
//
// No files, no sockets, no IPC. Just the store.
//
// This file is the orchestration entry point + public facade. The per-turn
// dispatch logic lives in `dispatch-turn.ts` (linear) and `fanout.ts`
// (parallel), over the explicit `RunDeps` (dispatch-wiring.ts) + `RunTurnState`
// (run-turn-state.ts) records. See ARCHITECTURE.md §6.1.

import type * as core from "@fragua/core/handler";
import {
  ClaimLostError,
  type FactEvent,
  type IDaemonCoordinator,
  type IEventReader,
  type IEventWriter,
  PayloadTooLargeError,
} from "@fragua/store";
import type { AbortRegistry } from "./abort-registry.ts";
import type { AutoTitler } from "./auto-titler.ts";
import { bindClaim } from "./claim-bound-store.ts";
import type { Dispatcher } from "./dispatch.ts";
import { dispatchOne } from "./dispatch-turn.ts";
import type { RunDeps } from "./dispatch-wiring.ts";
import { errorMessage, sleep, TERMINAL_STATUSES } from "./executor-helpers.ts";
import { type GraphLoader, makeGraphLoader } from "./graph-loader.ts";
import { planCrashHalt, planCrashHaltMinimal } from "./lifecycle-planner.ts";
import { commitParkOrTerminal, HALT_APPEND_MAX_ATTEMPTS, makeOccController, type OccController } from "./occ-append.ts";
import { processOperatorActions } from "./operator-actions.ts";
import { PROVIDER_RETRY_AFTER_MAX_MS } from "./provider-retry-policy.ts";
import { create as createTurnState } from "./run-turn-state.ts";
import { disposeTerminalWorktree } from "./snapshot-service.ts";
import { wakePending } from "./wake-pending.ts";
import type { Provisioner } from "./worktree-provisioner.ts";

export { mergeFanoutAppendOpts } from "./dispatch-wiring.ts";
// Compatibility re-exports: these helpers moved to sibling modules but are
// imported from executor.ts by tests and other call sites.
export { buildSubstitutionArgs, classifyAbortCause, resolveBackoff } from "./executor-helpers.ts";
export type { DispatchOutcome } from "./occ-append.ts";

type LlmCallFn = core.LlmCallFn;

/** Wall-clock backstop per fan-out branch when neither the branch (`max_ms`) nor
 * the `parallel` node (`timeout-minutes:` → its own `max_ms`) bounds it. A branch
 * is a read-class deliberation step, so an unbounded llm loop that never
 * self-terminates would otherwise dam the join forever (the live post-mortem's
 * runaway lens). The branch's own bound still wins when tighter (min via
 * AbortSignal.any). Override per-executor with `fanoutBranchTimeoutMs`. The
 * effective armed deadline rides each AbortRegistry entry, so the supervisor's
 * leak watchdog budgets against exactly this value — never a re-derivation. */
export const DEFAULT_FANOUT_BRANCH_TIMEOUT_MS = 20 * 60_000;

export interface ExecutorOpts {
  store: IEventWriter & IEventReader & IDaemonCoordinator;
  dispatcher: Dispatcher;
  registry: AbortRegistry;
  tools: core.ToolRegistry;
  llmCall: LlmCallFn;
  /** System One client for `type: judge` steps; absent ⇒ judge nodes halt
   * with a "not configured" error. */
  judgeClient?: core.JudgeClient;
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
  /** Longest provider Retry-After (ms) the daemon waits out as an
   * auto-retry; a longer request pauses for the operator. Defaults to
   * `PROVIDER_RETRY_AFTER_MAX_MS` (6h). */
  providerRetryAfterMaxMs?: number;
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
  /** Called after a committed transition moves the run's cursor off `nodeId`
   * (a retry or self-loop keeps the cursor, so it does not fire). The CLI wires
   * it to release the node's pooled MCP connections. Best-effort: a throw is
   * swallowed. */
  onNodeExited?: (runId: string, nodeId: string) => void;
  /** Called once a run's fiber ends with the run in a hard-terminal status
   * (not on a pause). Best-effort: a throw is swallowed. */
  onRunTerminal?: (runId: string) => void;
  /** The daemon pid that must hold `daemon_lock` for a claim to succeed. A
   * daemon evicted from the lock claims nothing, even before its heartbeat
   * notices. Absent (`fragua ci`, tests), claims are not lock-gated. */
  claimerPid?: number;
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
  const claimOpts = opts.claimerPid !== undefined ? { claimerPid: opts.claimerPid } : undefined;
  while (!opts.shutdownSignal.aborted) {
    wakePending(opts.store);
    processOperatorActions(opts.store);
    if (opts.shutdownSignal.aborted) break;
    const claimed = opts.store.claimNextRun(opts.maxConcurrentRuns, claimOpts);
    if (claimed == null) {
      await sleep(pollMs, opts.shutdownSignal);
      continue;
    }
    const p = runOneSafe(claimed.runId, opts, leakBudget, { epoch: claimed.claimEpoch });
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
async function runOneSafe(
  runId: string,
  opts: ExecutorOpts,
  leakBudget: LeakBudget,
  claim: { epoch: number },
): Promise<void> {
  try {
    await runOne(runId, opts, leakBudget, claim);
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

/** Drive one claimed run until it stops progressing. `claim.epoch` is the
 * `claim_epoch` `claimNextRun` returned; every fact this fiber appends carries
 * it, so a crash requeue or re-claim fences the fiber out. Omitted, the run's
 * current epoch is adopted (callers that drive an already-claimed run). */
export async function runOne(
  runId: string,
  opts: ExecutorOpts,
  leakBudget?: LeakBudget,
  claim?: { epoch: number },
): Promise<void> {
  const epoch = claim?.epoch ?? opts.store.getClaimEpoch(runId) ?? 0;
  try {
    await runOneGuarded(runId, { ...opts, store: bindClaim(opts.store, epoch) }, epoch, leakBudget);
  } finally {
    notifyRunTerminal(runId, opts);
  }
}

// After the crash-halt path too, so a run terminalised by the outer safety net
// still releases its per-run resources.
function notifyRunTerminal(runId: string, opts: ExecutorOpts): void {
  if (opts.onRunTerminal === undefined) return;
  const state = opts.store.getState(runId);
  if (state == null || !TERMINAL_STATUSES.has(state.status)) return;
  try {
    opts.onRunTerminal(runId);
  } catch {
    // best-effort cleanup hook — must not mask the run's own outcome.
  }
}

async function runOneGuarded(runId: string, opts: ExecutorOpts, epoch: number, leakBudget?: LeakBudget): Promise<void> {
  const budget = leakBudget ?? makeLeakBudget(opts);
  const runOcc = makeOccController({ store: opts.store, runId, shutdownSignal: opts.shutdownSignal });
  try {
    await runOneInner(runId, opts, epoch, budget, runOcc);
  } catch (err) {
    // The run was requeued or re-claimed under us: it is another fiber's, so
    // there is nothing to terminalise.
    if (err instanceof ClaimLostError) return;
    // Outer safety net: if the main body escaped without terminalising
    // the run, terminate it IN-PROCESS so the `running` capacity slot
    // doesn't leak. Covers throws outside the existing inner try/catch
    // that wraps only `spec.handler(ctx)` — e.g. foldIntents / graphFor
    // / selectEdge / commit failures. The crash-terminal append can lose
    // its own OCC race (a sibling advanced the version between our read
    // and this write), so we drive it through a fresh OCC controller: on
    // conflict we re-read fresh state and retry, bounded by
    // HALT_APPEND_MAX_ATTEMPTS, escalating to `occ_exhausted` at the
    // ceiling rather than silently rethrowing with the terminal fact
    // lost. The store's startupSweep is only a last-resort backstop for a
    // process that dies mid-recovery, not the primary recovery path.
    await commitCrashHalt(runId, opts, epoch, err, runOcc.pendingSpend());
    throw err;
  }
}

/** Terminalise a run whose body escaped without doing so. The clipped crash
 * halt is tried first; if the store still rejects it as too large, a fixed
 * minimal detail is committed instead. Both lead with the spend of any commit
 * the crash interrupted. A run still `running` afterwards (every append lost or
 * threw, or abandoned at the OCC ceiling) gives its claim back. */
async function commitCrashHalt(
  runId: string,
  opts: ExecutorOpts,
  epoch: number,
  err: unknown,
  spend: FactEvent[],
): Promise<void> {
  const state = opts.store.getState(runId);
  if (state == null || state.status !== "running") return;
  const nodeId = state.currentNode ?? "<no-node>";
  const occ = makeOccController({ store: opts.store, runId, shutdownSignal: opts.shutdownSignal });
  try {
    try {
      await driveCrashHalt(
        runId,
        opts,
        occ,
        nodeId,
        planCrashHalt({ detail: `executor crashed at ${nodeId}: ${errorMessage(err)}`, spend }).facts,
      );
    } catch (appendErr) {
      if (!(appendErr instanceof PayloadTooLargeError)) throw appendErr;
      await driveCrashHalt(runId, opts, occ, nodeId, planCrashHaltMinimal({ spend }).facts);
    }
  } finally {
    releaseIfAbandoned(runId, opts, epoch, occ);
    releaseIfStillRunning(runId, opts, epoch);
  }
}

async function driveCrashHalt(
  runId: string,
  opts: ExecutorOpts,
  occ: OccController,
  nodeId: string,
  facts: FactEvent[],
): Promise<void> {
  for (let attempt = 0; attempt < HALT_APPEND_MAX_ATTEMPTS; attempt++) {
    const fresh = opts.store.getState(runId);
    if (fresh == null || fresh.status !== "running") return;
    const outcome = await commitParkOrTerminal(
      { store: opts.store, runId, occ, nodeId, iteration: 0, expectedVersion: fresh.version },
      facts,
    );
    if (outcome.kind === "terminal") return;
  }
}

function releaseIfStillRunning(runId: string, opts: ExecutorOpts, epoch: number): void {
  if (opts.store.getState(runId)?.status !== "running") return;
  opts.store.releaseClaim(runId, epoch, { lastAliveAt: (opts.clock ?? Date.now)() });
}

/** Every `occ_exhausted` halt append lost its race and the run is still
 * `running`: give the claim back (requeue) so the run never sits `running`
 * with no fiber driving it. */
function releaseIfAbandoned(runId: string, opts: ExecutorOpts, epoch: number, occ: OccController): void {
  if (!occ.wasAbandoned()) return;
  opts.store.releaseClaim(runId, epoch, { lastAliveAt: (opts.clock ?? Date.now)() });
}

async function runOneInner(
  runId: string,
  opts: ExecutorOpts,
  epoch: number,
  leakBudget: LeakBudget,
  occ: OccController,
): Promise<void> {
  const maxTurns = opts.maxTurnsForTesting ?? Number.POSITIVE_INFINITY;
  const loader = opts.graphLoader ?? makeGraphLoader(opts.store);
  const deps: RunDeps = {
    opts,
    runId,
    occ,
    loader,
    leakBudget,
    leakGrace: opts.leakGraceMs ?? DEFAULT_LEAK_GRACE_MS,
    maxLoops: opts.maxLoops ?? DEFAULT_MAX_LOOPS,
    abortLoopCeiling: opts.abortLoopCeiling ?? DEFAULT_ABORT_LOOP_CEILING,
    providerRetryAfterMaxMs: opts.providerRetryAfterMaxMs ?? PROVIDER_RETRY_AFTER_MAX_MS,
    fanoutBranchTimeoutMs: opts.fanoutBranchTimeoutMs ?? DEFAULT_FANOUT_BRANCH_TIMEOUT_MS,
    clock: opts.clock ?? Date.now,
    random: opts.random ?? Math.random,
  };
  const state = createTurnState();
  try {
    while (!opts.shutdownSignal.aborted && state.turns < maxTurns) {
      state.turns++;
      const { outcome } = await dispatchOne(deps, state);
      if (outcome.kind === "terminal") break;
    }
    releaseIfAbandoned(runId, opts, epoch, occ);
    if (state.leakedNodes.size > 0) releaseIfStillRunning(runId, opts, epoch);
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
