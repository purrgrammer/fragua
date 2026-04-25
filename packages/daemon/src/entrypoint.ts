// Daemon orchestration — ARCHITECTURE.md §6.
//
// Top-level: acquire the daemon lock (with TTL-based reclaim of stale
// holders), run the startup sweep, start the supervisor fiber, then the
// executor loop. On SIGTERM/SIGINT: trip shutdownSignal; executor finishes
// its current turn; supervisor exits; release lock.

import { hostname as osHostname } from "node:os";
import type * as coreHandler from "@swarm/core/handler";
import type { IEventStore } from "@swarm/store";
import { AbortRegistry } from "./abort-registry.ts";
import type { AutoTitler } from "./auto-titler.ts";
import type { Dispatcher } from "./dispatch.ts";
import { runExecutor } from "./executor.ts";
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
   * codergen budget (30m) so the watchdog never trips a legitimate
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
}

const DEFAULT_LOCK_TTL_MS = 30_000;
const DEFAULT_CONCURRENCY = 8;
// Matches @swarm/agent's codergen default — the supervisor must never
// trip a legitimate long-running codergen node just because the spec
// wasn't resolvable at the moment of the leak check.
const DEFAULT_UNKNOWN_SPEC_FALLBACK_MS = 30 * 60 * 1000;

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
    const lock = opts.store.acquireDaemonLock(pid, hostname);
    if (!lock.acquired) {
      const current = lock.current;
      const now = Date.now();
      if (now - current.heartbeatAt > lockTtl) {
        opts.store.forceAcquireDaemonLock(pid, hostname);
      } else {
        throw new DaemonAlreadyRunningError(current.pid, current.hostname);
      }
    }

    try {
      opts.store.startupSweep();

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
      const supervisor = startSupervisor(supervisorOpts);

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
      // When too many handlers leak, trip the shutdown controller so the
      // outer drain takes over. The daemon singleton + startup sweep
      // recovers stuck runs when a fresh daemon takes over.
      executorOpts.onLeakLimitExceeded = (count) => {
        // eslint-disable-next-line no-console
        console.error(`[daemon] ${count} handler leaks — initiating shutdown so a fresh daemon can recover`);
        ctrl.abort();
      };
      await runExecutor(executorOpts);

      registry.tripAll(new Error("shutdown"));
      await supervisor.promise;
      if (opts.autoTitler) await opts.autoTitler.drain();
    } finally {
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
