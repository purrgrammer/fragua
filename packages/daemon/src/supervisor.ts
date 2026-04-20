// Supervisor fiber — ARCHITECTURE.md §1.3 / §6.
//
// One 50ms tick that consolidates:
//   (a) heartbeat — keeps daemon_lock alive
//   (b) intent detection — trips per-run AbortControllers when web writes
//       an intent while the executor is mid-handler
//   (c) stuck-node watchdog — detects handlers that exceeded their
//       maxMs + leak grace and force-aborts them
//
// The supervisor owns no state of its own; it reads run_state and events and
// trips controllers held by the abort registry.

import type { IEventStore } from "@swarm/store";
import type { AbortRegistry } from "./abort-registry.ts";

export interface SupervisorOpts {
  store: IEventStore;
  registry: AbortRegistry;
  pid: number;
  shutdownSignal: AbortSignal;
  tickMs?: number;
  heartbeatIntervalMs?: number;
  /** Max time a node may run past its maxMs before supervisor trips it. */
  nodeLeakGraceMs?: number;
  /** Per-handler maxMs lookup. Supervisor uses this to compute leak threshold. */
  handlerMaxMsFor?: (workflowSha: string, nodeId: string) => number;
}

const DEFAULT_TICK_MS = 50;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_LEAK_GRACE_MS = 5_000;

export function startSupervisor(opts: SupervisorOpts): {
  promise: Promise<void>;
} {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const leakGrace = opts.nodeLeakGraceMs ?? DEFAULT_LEAK_GRACE_MS;

  // Track per-run state so we only trip on NEW intents (seq > lastSeen).
  const lastIntentSeq = new Map<string, number>();
  let lastHeartbeatAt = 0;

  const promise = (async () => {
    while (!opts.shutdownSignal.aborted) {
      const now = Date.now();

      // (a) Heartbeat at a slower cadence.
      if (now - lastHeartbeatAt >= heartbeatMs) {
        try {
          opts.store.heartbeatDaemonLock(opts.pid);
          lastHeartbeatAt = now;
        } catch {
          // Ignore; supervisor must never crash the daemon.
        }
      }

      // (b) Intent detection. For each active run, scan unapplied intents
      // and trip the abort controller if a new one appeared.
      for (const runId of opts.registry.activeRuns()) {
        const prev = lastIntentSeq.get(runId) ?? 0;
        const unapplied = opts.store.getUnappliedIntents(runId);
        if (unapplied.length === 0) continue;
        const newest = unapplied[unapplied.length - 1]!.seq;
        if (newest > prev) {
          lastIntentSeq.set(runId, newest);
          opts.registry.trip(runId, new IntentArrivedError(runId, newest));
        }
      }

      // (c) Stuck-node watchdog. A run that's been 'running' for longer
      // than handler.maxMs + grace gets its controller tripped.
      if (opts.handlerMaxMsFor != null) {
        for (const runId of opts.registry.activeRuns()) {
          const state = opts.store.getState(runId);
          if (state == null) continue;
          if (state.status !== "running") continue;
          if (state.nodeStartedAt == null) continue;
          if (state.currentNode == null) continue;
          const maxMs = opts.handlerMaxMsFor(state.workflowSha, state.currentNode);
          if (now - state.nodeStartedAt > maxMs + leakGrace) {
            opts.registry.trip(runId, new HandlerLeakedError(runId, state.currentNode));
          }
        }
      }

      // Reap runs that are no longer active (so the intent-seq map doesn't grow).
      for (const runId of lastIntentSeq.keys()) {
        if (!opts.registry.has(runId)) lastIntentSeq.delete(runId);
      }

      await sleep(tickMs, opts.shutdownSignal);
    }
  })();

  return { promise };
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

export class IntentArrivedError extends Error {
  constructor(
    public readonly runId: string,
    public readonly seq: number,
  ) {
    super(`new intent ${seq} arrived for ${runId}`);
    this.name = "AbortError";
  }
}

export class HandlerLeakedError extends Error {
  constructor(
    public readonly runId: string,
    public readonly nodeId: string,
  ) {
    super(`handler leaked on ${runId}/${nodeId}`);
    this.name = "AbortError";
  }
}
