// Daemon orchestration — ARCHITECTURE.md §6.
//
// Top-level: acquire the daemon lock (with TTL-based reclaim of stale
// holders), run the startup sweep, start the supervisor fiber, then the
// executor loop. On SIGTERM/SIGINT: trip shutdownSignal; executor finishes
// its current turn; supervisor exits; release lock.

import { hostname as osHostname } from "node:os";
import type * as coreHandler from "@fragua/core/handler";
import type { IEventStore } from "@fragua/store";
import { AbortRegistry } from "./abort-registry.ts";
import type { AutoTitler } from "./auto-titler.ts";
import { type BlobGcOpts, DEFAULT_BLOB_GC_INTERVAL_MS, DEFAULT_BLOB_GC_MAX_ROWS, startBlobGc } from "./blob-gc.ts";
import type { Dispatcher } from "./dispatch.ts";
import { runExecutor } from "./executor.ts";
import { DEFAULT_SCHEDULE_TICK_MS, startScheduleDispatcher } from "./schedule-dispatcher.ts";
import { startSupervisor } from "./supervisor.ts";
import type { Provisioner } from "./worktree-provisioner.ts";

export interface DaemonMainOpts {
  store: IEventStore;
  dispatcher: Dispatcher;
  tools: coreHandler.ToolRegistry;
  llmCall: coreHandler.LlmCallFn;
  maxConcurrentRuns?: number;
  pid?: number;
  hostname?: string;
  lockTtlMs?: number;
  /** If omitted, SIGTERM/SIGINT will trigger shutdown. */
  shutdownSignal?: AbortSignal;
  /** Optional auto-title summariser. When provided, the executor fires
   * `autoTitler.titleRun` right after each run's `fact.run_started`
   * append, and the daemon awaits `drain()` after the executor loop
   * exits so in-flight title calls get a graceful shutdown. */
  autoTitler?: AutoTitler;
  /** Optional worktree provisioner. When set, every run runs inside
   * a dedicated `git worktree` with its own branch — the executor
   * calls `ensure(runId)` before dispatch and `dispose(runId)` on
   * terminal status. Omit to run every handler inside the daemon's
   * process cwd (legacy / test behaviour). */
  provisioner?: Provisioner;
  /** Supervisor's leak watchdog fallback when the dispatcher cannot
   * resolve a spec for the run's current node. Defaults to the
   * llm budget (30m) so the watchdog never trips a legitimate
   * long-running node ahead of the executor's own deadline. Tests
   * can pass a smaller value. */
  unknownSpecFallbackMs?: number;
  /** Forwarded into executor + supervisor as their leak grace. */
  leakGraceMs?: number;
  /** Forwarded into executor as shutdown-drain budget. */
  shutdownDrainMs?: number;
  /** Forwarded into executor's per-context `makeHttpClient`. */
  defaultHttpTimeoutMs?: number;
  /** Run-level handler-dispatch ceiling. A pathological workflow that
   * loops without ever aborting halts with `reason: "max_loops"` once
   * this many handlers have run for the same run_id. Defaults to the
   * executor's built-in (1000). */
  maxLoops?: number;
  /** Cap on per-process leaked handlers (handler ignored AbortSignal
   * past `maxMs + leakGrace`). When the count crosses this, the daemon
   * shuts itself down — the singleton + sweep recovers stuck runs on
   * restart. Defaults to the executor's built-in (3). */
  maxLeakedHandlers?: number;
  /** Maximum consecutive handler aborts on the same node before the
   * run halts with `reason: "abort_loop"`. Defaults to the executor's
   * built-in (5). */
  abortLoopCeiling?: number;
  /** Interval (ms) between background `gcBlobs` sweeps. Defaults to 6h.
   * Set to 0 to disable the background sweep entirely (operator runs
   * `fragua db gc` manually). */
  blobGcIntervalMs?: number;
  /** Max rows visited per `gcBlobs` sweep. Bounds latency on huge
   * stores. Defaults to 1000. */
  blobGcMaxRows?: number;
  /** Forward steer text into the llm backend's queue when an
   * `intent.steering_requested` arrives mid-handler. Wired by the CLI to
   * a daemon-scoped `SteeringRegistry` shared across every llm
   * backend. Without this, steers either land via the standard intent
   * fold on re-dispatch or stay buffered until the next `beginRun`. */
  onSteer?: (runId: string, text: string) => void;
  /** Tick interval for the schedule-dispatcher fiber. Defaults to
   * 60s; tests inject smaller values. Set to 0 to disable scheduled
   * runs entirely. */
  scheduleTickMs?: number;
}

const DEFAULT_LOCK_TTL_MS = 30_000;
const DEFAULT_CONCURRENCY = 16;
// Matches @fragua/agent's llm default — the supervisor must never
// trip a legitimate long-running llm node just because the spec
// wasn't resolvable at the moment of the leak check.
const DEFAULT_UNKNOWN_SPEC_FALLBACK_MS = 4 * 60 * 60 * 1000;

export interface DaemonHandle {
  /** Resolves when the daemon loop exits cleanly. */
  done: Promise<void>;
  /** Trip the internal shutdown controller. */
  shutdown(): void;
}

export function startDaemon(opts: DaemonMainOpts): DaemonHandle {
  const pid = opts.pid ?? process.pid;
  const hostname = opts.hostname ?? hostnameSafe();
  const lockTtl = opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;

  const ctrl = new AbortController();
  const externalSignal = opts.shutdownSignal;
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  const done = (async () => {
    let priorHeartbeatAt: number | undefined;
    const lock = opts.store.acquireDaemonLock(pid, hostname);
    if (!lock.acquired) {
      const current = lock.current;
      const now = Date.now();
      if (now - current.heartbeatAt > lockTtl) {
        opts.store.forceAcquireDaemonLock(pid, hostname);
        priorHeartbeatAt = current.heartbeatAt;
        opts.store.appendDaemonEvent({
          type: "daemon.reaper_took_over",
          payload: {
            priorPid: current.pid,
            priorHostname: current.hostname,
            priorHeartbeatAt: current.heartbeatAt,
            staleForMs: now - current.heartbeatAt,
          },
        });
      } else {
        throw new DaemonAlreadyRunningError(current.pid, current.hostname);
      }
    }

    opts.store.appendDaemonEvent({
      type: "daemon.started",
      payload: { pid, hostname },
    });

    let stoppedReason: "clean" | "leak_limit" | "signal" | "error" = "clean";
    let stoppedDetail: string | undefined;
    try {
      const sweepStart = Date.now();
      const sweepResult = opts.store.startupSweep(priorHeartbeatAt != null ? { priorHeartbeatAt } : undefined);
      opts.store.appendDaemonEvent({
        type: "daemon.sweep_completed",
        payload: {
          requeued: sweepResult.requeued.length,
          quarantined: sweepResult.quarantined.length,
          durationMs: Date.now() - sweepStart,
        },
      });
      const registry = new AbortRegistry();

      const unknownSpecFallbackMs = opts.unknownSpecFallbackMs ?? DEFAULT_UNKNOWN_SPEC_FALLBACK_MS;
      const supervisorOpts: Parameters<typeof startSupervisor>[0] = {
        store: opts.store,
        registry,
        pid,
        shutdownSignal: ctrl.signal,
        handlerMaxMsFor: (sha, nodeId) => {
          if (!opts.dispatcher.has(sha, nodeId)) return unknownSpecFallbackMs;
          return opts.dispatcher.get(sha, nodeId).maxMs;
        },
      };
      if (opts.leakGraceMs !== undefined) supervisorOpts.nodeLeakGraceMs = opts.leakGraceMs;
      if (opts.onSteer !== undefined) supervisorOpts.onSteer = opts.onSteer;
      const supervisor = startSupervisor(supervisorOpts);

      // Background blob GC. Only starts when interval > 0 (operators can
      // disable by setting `blob_gc.interval: 0` and run `fragua db gc`
      // manually). Lifetimes track the executor: on shutdown signal the
      // sweep wakes from sleep and exits before `done` resolves.
      const gcInterval = opts.blobGcIntervalMs ?? DEFAULT_BLOB_GC_INTERVAL_MS;
      let blobGc: { promise: Promise<void> } | undefined;
      if (gcInterval > 0) {
        const gcOpts: BlobGcOpts = {
          store: opts.store,
          shutdownSignal: ctrl.signal,
          intervalMs: gcInterval,
          maxRows: opts.blobGcMaxRows ?? DEFAULT_BLOB_GC_MAX_ROWS,
        };
        blobGc = startBlobGc(gcOpts);
      }

      // Schedule dispatcher fiber.
      // Peer to supervisor + executor + blob-gc; ticks once a minute and
      // fires runs for every due schedule. Disable by setting
      // `scheduleTickMs: 0` (CI primitives without recurring workloads).
      const scheduleTickMs = opts.scheduleTickMs ?? DEFAULT_SCHEDULE_TICK_MS;
      let scheduleDispatcher: { promise: Promise<void> } | undefined;
      if (scheduleTickMs > 0) {
        scheduleDispatcher = startScheduleDispatcher({
          store: opts.store,
          shutdownSignal: ctrl.signal,
          tickIntervalMs: scheduleTickMs,
        });
      }

      const executorOpts: Parameters<typeof runExecutor>[0] = {
        store: opts.store,
        dispatcher: opts.dispatcher,
        registry,
        tools: opts.tools,
        llmCall: opts.llmCall,
        maxConcurrentRuns: opts.maxConcurrentRuns ?? DEFAULT_CONCURRENCY,
        shutdownSignal: ctrl.signal,
      };
      if (opts.autoTitler) executorOpts.autoTitler = opts.autoTitler;
      if (opts.provisioner) executorOpts.provisioner = opts.provisioner;
      if (opts.leakGraceMs !== undefined) executorOpts.leakGraceMs = opts.leakGraceMs;
      if (opts.shutdownDrainMs !== undefined) executorOpts.shutdownDrainMs = opts.shutdownDrainMs;
      if (opts.defaultHttpTimeoutMs !== undefined) executorOpts.defaultHttpTimeoutMs = opts.defaultHttpTimeoutMs;
      if (opts.maxLoops !== undefined) executorOpts.maxLoops = opts.maxLoops;
      if (opts.maxLeakedHandlers !== undefined) executorOpts.maxLeakedHandlers = opts.maxLeakedHandlers;
      if (opts.abortLoopCeiling !== undefined) executorOpts.abortLoopCeiling = opts.abortLoopCeiling;
      // When too many handlers leak, trip the shutdown controller so the
      // outer drain takes over. The daemon singleton + startup sweep
      // recovers stuck runs when a fresh daemon takes over.
      executorOpts.onLeakLimitExceeded = (count) => {
        stoppedReason = "leak_limit";
        stoppedDetail = `${count} handler leaks`;
        // eslint-disable-next-line no-console
        console.error(`[daemon] ${count} handler leaks — initiating shutdown so a fresh daemon can recover`);
        ctrl.abort();
      };
      await runExecutor(executorOpts);
      if (stoppedReason === "clean" && externalSignal?.aborted) stoppedReason = "signal";

      registry.tripAll(new Error("shutdown"));
      await supervisor.promise;
      if (blobGc) await blobGc.promise;
      if (scheduleDispatcher) await scheduleDispatcher.promise;
      if (opts.autoTitler) await opts.autoTitler.drain();
    } catch (err) {
      stoppedReason = "error";
      stoppedDetail = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      try {
        const stoppedPayload: { pid: number; reason: typeof stoppedReason; detail?: string } = {
          pid,
          reason: stoppedReason,
        };
        if (stoppedDetail !== undefined) stoppedPayload.detail = stoppedDetail;
        opts.store.appendDaemonEvent({ type: "daemon.stopped", payload: stoppedPayload });
      } catch {
        // Best-effort — never let event-emit failure mask the underlying stop.
      }
      try {
        opts.store.releaseDaemonLock(pid);
      } catch {
        // Swallow — release is best-effort on shutdown.
      }
    }
  })();

  return {
    done,
    shutdown: () => ctrl.abort(),
  };
}

export class DaemonAlreadyRunningError extends Error {
  constructor(
    public readonly pid: number,
    public readonly hostname: string,
  ) {
    super(`daemon already running: pid=${pid} host=${hostname}`);
    this.name = "DaemonAlreadyRunningError";
  }
}

function hostnameSafe(): string {
  try {
    return osHostname();
  } catch {
    return "unknown-host";
  }
}
