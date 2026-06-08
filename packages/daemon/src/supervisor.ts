// Supervisor fiber — ARCHITECTURE.md §1.3 / §6.
//
// One 50ms tick that consolidates:
//   (a) heartbeat — keeps daemon_lock alive
//   (b) intent detection — trips per-run AbortControllers when web writes
//       a non-steer intent while the executor is mid-handler; forwards
//       steer text to the llm backend's queue without tripping
//   (c) stuck-node watchdog — detects handlers that exceeded their
//       maxMs + leak grace and force-aborts them
//
// The supervisor owns no state of its own; it reads run_state and events and
// trips controllers held by the abort registry.

import { type IEventStore, readActiveNodes, type StoredEvent } from "@fragua/store";
import type { AbortRegistry } from "./abort-registry.ts";
import { DEFAULT_FANOUT_BRANCH_TIMEOUT_MS } from "./executor.ts";

export interface SupervisorOpts {
  store: IEventStore;
  registry: AbortRegistry;
  pid: number;
  shutdownSignal: AbortSignal;
  tickMs?: number;
  heartbeatIntervalMs?: number;
  /** Max time a node may run past its maxMs before supervisor trips it. */
  nodeLeakGraceMs?: number;
  /** Per-handler maxMs lookup. Supervisor uses this to compute leak threshold.
   * Returns `undefined` for nodes that opted out of wall-clock bounding
   * (llm `max_ms=0`); the supervisor skips the leak-trip for those nodes. */
  handlerMaxMsFor?: (workflowSha: string, nodeId: string) => number | undefined;
  /** Wall-clock backstop (ms) the leak watchdog budgets an UNBOUNDED fan-out
   * branch against, so a runaway llm branch that ignores its abort signal is
   * still reclaimable (gap 5a). Mirrors the executor's per-branch deadline;
   * defaults to `DEFAULT_FANOUT_BRANCH_TIMEOUT_MS`. */
  fanoutBranchTimeoutMs?: number;
  /** Forward steer text into the llm backend's queue. pi-agent-core's
   * `Agent.steer()` enqueues into a `steeringQueue` that drains at end of
   * turn; tripping the abort controller would force the in-flight LLM
   * call to end with `stopReason: "aborted"`, which the llm handler
   * (backend.ts:464) collapses into a `fail` outcome. Steers must therefore
   * bypass the trip and ride the queue. Only fires for steers in batches
   * with no other intent type — a co-arriving cancel/pause/hitl trips and
   * the steer is left to the standard intent fold on re-dispatch. */
  onSteer?: (runId: string, text: string) => void;
}

const DEFAULT_TICK_MS = 50;
const DEFAULT_HEARTBEAT_MS = 5_000;
// Matches the executor's grace.
const DEFAULT_LEAK_GRACE_MS = 30_000;

// Intent types the supervisor must never trip an in-flight handler on:
// the synthetic queue marker plus the wake drivers that resume a paused /
// quarantined run (see the filter in the tick loop for the full rationale).
const NON_TRIPPING_INTENTS: ReadonlySet<string> = new Set([
  "intent.run_enqueued",
  "intent.resume",
  "intent.human_input",
  "intent.unquarantine",
]);

export function startSupervisor(opts: SupervisorOpts): {
  promise: Promise<void>;
} {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const leakGrace = opts.nodeLeakGraceMs ?? DEFAULT_LEAK_GRACE_MS;
  const fanoutBranchTimeout = opts.fanoutBranchTimeoutMs ?? DEFAULT_FANOUT_BRANCH_TIMEOUT_MS;

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
      // and trip the abort controller if a new non-steer one appeared.
      // Steers bypass the trip — pi-agent-core's steeringQueue is the
      // intended ingestion path (see SupervisorOpts.onSteer).
      for (const runId of opts.registry.activeRuns()) {
        const prev = lastIntentSeq.get(runId) ?? 0;
        const unapplied = opts.store.getUnappliedIntents(runId);
        if (unapplied.length === 0) continue;
        const newest = unapplied[unapplied.length - 1]!.seq;
        if (newest <= prev) continue;
        const fresh = unapplied.filter((e) => e.seq > prev);
        // Drop intents that are never a mid-flight control. Two classes:
        //
        //  - `intent.run_enqueued` — the synthetic queue marker that caused
        //    the run to exist, not an operator action.
        //  - wake-driver intents (`intent.resume`, `intent.human_input`,
        //    `intent.unquarantine`) — these bring a run OUT of a paused /
        //    quarantined state, so the run had no active handler when they
        //    were issued; they can't be a mid-handler abort. The wake-pending
        //    sweeper (wake-pending.ts) deliberately leaves resume/human_input
        //    UNAPPLIED so the next dispatch's fold can still process earlier
        //    hitched-along intents (e.g. a budget_adjusted before a resume).
        //    That leaves the wake-driver visible to getUnappliedIntents while
        //    the resumed handler runs — without this filter the supervisor
        //    trips the controller on it, killing the in-flight call (cause:
        //    "aborted", tokens=0) and forcing a spurious `resumeOf:"fresh"`
        //    respawn on every clean resume.
        const operatorIntents = fresh.filter((e) => !NON_TRIPPING_INTENTS.has(e.type));
        const hasNonSteer = operatorIntents.some((e) => e.type !== "intent.steering_requested");
        lastIntentSeq.set(runId, newest);
        if (operatorIntents.length === 0) continue;
        if (hasNonSteer) {
          // Skip steer forwarding — the abort kills the in-flight call
          // before pi-agent-core could drain the queue, and the standard
          // intent fold replays the steer text on the next dispatch.
          opts.registry.trip(runId, new IntentArrivedError(runId, newest));
          continue;
        }
        if (opts.onSteer != null) {
          for (const ev of fresh) {
            const text = readSteerText(ev);
            if (text !== undefined) opts.onSteer(runId, text);
          }
        }
      }

      // (c) Stuck-node watchdog. Uses each handler's in-process `startedAt`
      // (via liveHandlers) so daemon pauses and restart gaps don't count — the
      // node's maxMs budget applies to active execution only. A run reclaimed via
      // startup-sweep gets a fresh budget; wall-clock accrued before the crash
      // is not charged.
      //
      // Each in-flight handler is budgeted against ITS OWN node deadline and
      // tripped INDIVIDUALLY — under a fan-out the branches have different maxMs,
      // so budgeting the whole set against the longest let a short-deadline branch
      // evade detection until the longest sibling expired. An UNBOUNDED fan-out
      // branch (maxMs 0/undefined) is budgeted against the backstop — NOT skipped
      // — so a runaway llm branch that ignores its abort signal is still
      // reclaimable (gap 5a). A linear unbounded node opted out of wall-clock
      // bounding, so it's left alone. The executor arms the same backstop as an
      // AbortSignal.timeout, so a well-behaved branch self-aborts first; this is
      // the leak backstop.
      if (opts.handlerMaxMsFor != null) {
        for (const runId of opts.registry.activeRuns()) {
          const state = opts.store.getState(runId);
          if (state == null || state.status !== "running") continue;
          const active = readActiveNodes(state.routing);
          for (const h of opts.registry.liveHandlers(runId)) {
            let deadline = opts.handlerMaxMsFor(state.workflowSha, h.nodeId);
            if (deadline === undefined || deadline === 0) {
              // Unbounded: apply the backstop only to a fan-out branch (in the
              // active set); a linear unbounded node is intentionally unbounded.
              if (active?.includes(h.nodeId)) deadline = fanoutBranchTimeout;
              else continue;
            }
            if (h.elapsedMs > deadline + leakGrace) {
              h.controller.abort(new HandlerLeakedError(runId, h.nodeId));
            }
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

function readSteerText(ev: StoredEvent): string | undefined {
  if (ev.type !== "intent.steering_requested") return undefined;
  const payload = ev.payload as { text?: unknown } | null | undefined;
  const text = payload?.text;
  return typeof text === "string" && text.length > 0 ? text : undefined;
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
