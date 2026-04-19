// Daemon orchestration — REARCHITECTURE.md §6.
//
// Top-level: acquire the daemon lock (with TTL-based reclaim of stale
// holders), run the startup sweep, start the supervisor fiber, then the
// executor loop. On SIGTERM/SIGINT: trip shutdownSignal; executor finishes
// its current turn; supervisor exits; release lock.

import { hostname as osHostname } from "node:os";
import type { handler as coreHandler } from "@swarm/core";
import type { IEventStore } from "@swarm/store";
import { AbortRegistry } from "./abort-registry.ts";
import type { Dispatcher } from "./dispatch.ts";
import { runExecutor } from "./executor.ts";
import { startSupervisor } from "./supervisor.ts";

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
}

const DEFAULT_LOCK_TTL_MS = 30_000;
const DEFAULT_CONCURRENCY = 8;

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

      const supervisor = startSupervisor({
        store: opts.store,
        registry,
        pid,
        shutdownSignal: ctrl.signal,
        handlerMaxMsFor: (sha, nodeId) => {
          if (!opts.dispatcher.has(sha, nodeId)) return 30_000;
          return opts.dispatcher.get(sha, nodeId).maxMs;
        },
      });

      await runExecutor({
        store: opts.store,
        dispatcher: opts.dispatcher,
        registry,
        tools: opts.tools,
        llmCall: opts.llmCall,
        maxConcurrentRuns: opts.maxConcurrentRuns ?? DEFAULT_CONCURRENCY,
        shutdownSignal: ctrl.signal,
      });

      registry.tripAll(new Error("shutdown"));
      await supervisor.promise;
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
  constructor(public readonly pid: number, public readonly hostname: string) {
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
