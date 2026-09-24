// Per-run registry of live agents + buffered steer messages.
//
// Extracted from PiLlmBackend so the concurrency-critical slot-
// management logic lives in one focused class, independent of pi-ai /
// pi-agent-core. This makes property-based tests tractable: the PBT can
// exercise the registry directly with a minimal fake agent instead of
// spinning up the full LLM stack.
//
// A run may have MORE THAN ONE live agent at once: a `type: parallel`
// fan-out dispatches N concurrent `llm` branches under the SAME runId,
// each calling `beginRun(runId, agent)`. The registry therefore holds a
// SET of live agents per run, and a steer BROADCASTS to every one of
// them — fan-out branches are independent sub-pipelines and a steer
// applies to the run, not to whichever branch happened to register last.
//
// WHAT THE BUFFER IS FOR — narrower than it looks. A steer issued while
// nothing is dispatched never reaches this class: the intent fold stashes
// it in `run_state.routing.internal.pending_steer`, and the executor
// surfaces it as `ctx.steering` on the next dispatch, already delivering
// it to EVERY branch of a `parallel` (docs/intent-fold.md §"pre-claim
// steer"). The supervisor only calls `steer()` for runs the ABORT
// registry reports active — i.e. a handler is already running. So the
// buffer covers exactly one window: a handler has been dispatched but its
// agent has not called `beginRun` yet. That window is a race, not a
// lifecycle phase, and under fan-out it is N racing branches.
//
// Which is why the buffer is cleared when the live set EMPTIES, not when
// it is first drained. Draining into the first agent to register hands
// the message to whichever branch won the race and drops it for the rest
// — the exact bug this class was rewritten to fix, surviving in the one
// path that didn't broadcast. The non-empty interval is operationally the
// superstep, so "deliver to everyone who registers before the set empties"
// gets per-fan-out delivery without the registry needing to know what a
// superstep is. It doesn't, and shouldn't.
//
// Semantics:
//   - `beginRun(runId, agent, target)` adds `agent` to the run's live
//     set (tagged with its `(nodeId, iteration)` for delivery records)
//     and injects every buffered message this agent has not already
//     received, in FIFO order. The buffer SURVIVES the drain.
//   - `endRun(runId, agent)` removes `agent` from the run's live set;
//     the last agent out drops the run's entry AND the buffer, so a
//     later node never receives a steer typed for an earlier one.
//   - `steer(runId, message)` injects into EVERY live agent for `runId`
//     if any exist (returning a `delivered` outcome listing them);
//     otherwise buffers (returning `buffered`). Empty strings are dropped.
//     The buffer is capped at MAX_BUFFERED_STEERS, oldest dropped first.
//   - `forgetRun(runId)` drops both the live set (if any) and the buffer
//     (if any) for `runId`. Idempotent.
//
// Concurrency: every op is synchronous; there's no `await` anywhere.
// Under a single-threaded JS runtime this makes the registry safe to
// call from any number of concurrent async callers without further
// locking — the only cross-call state is the two Maps, and Map ops
// don't yield mid-mutation.

import type { SteerDelivery, SteerTarget } from "@fragua/types";

/** Minimal contract the registry needs on an agent. The real
 * pi-agent-core `Agent` satisfies this; tests provide a fake. */
export interface SteerableAgent {
  steer(message: { role: "user"; content: [{ type: "text"; text: string }]; timestamp: number }): void;
}

const UNTAGGED_TARGET: SteerTarget = { nodeId: "", iteration: 0 };

/** Per-run cap on buffered steers. The buffer only fills during a
 *  dispatch race, so anything approaching this is an operator (or an
 *  integration) steering a run far faster than it dispatches; keeping the
 *  newest is the useful end. Bounded because the buffer now outlives its
 *  first drain, and an unbounded structure with a longer lifetime is
 *  strictly worse than an unbounded one with a short one. */
export const MAX_BUFFERED_STEERS = 32;

export class SteeringRegistry {
  private readonly activeAgents = new Map<string, Map<SteerableAgent, SteerTarget>>();
  private readonly pendingSteers = new Map<string, string[]>();
  /** Agents that have already been handed the run's current buffer, so a
   *  branch that ends and re-dispatches while its siblings are still live
   *  is not injected twice. Dropped with the buffer when the set empties.
   *  Weak so a discarded agent cannot pin memory through this map. */
  private readonly drainedInto = new Map<string, WeakSet<SteerableAgent>>();

  /** Register `agent` as a live agent for `runId` (tagged with the branch
   * it runs) and inject every buffered message it has not already received.
   * The buffer is NOT consumed here — see the note at the top of the file:
   * the other branches of a fan-out register a moment later and must get
   * the same messages. `endRun` clears it when the last one leaves. */
  beginRun(runId: string, agent: SteerableAgent, target: SteerTarget = UNTAGGED_TARGET): void {
    let agents = this.activeAgents.get(runId);
    if (agents === undefined) {
      agents = new Map();
      this.activeAgents.set(runId, agents);
    }
    agents.set(agent, target);

    const buffered = this.pendingSteers.get(runId);
    if (buffered === undefined || buffered.length === 0) return;
    let drained = this.drainedInto.get(runId);
    if (drained === undefined) {
      drained = new WeakSet();
      this.drainedInto.set(runId, drained);
    }
    if (drained.has(agent)) return;
    drained.add(agent);
    for (const msg of buffered) this.inject(agent, msg);
  }

  /** Remove `agent` from the run's live set. The last agent out drops the
   * run's entry so `hasActive` and `activeSize` stay accurate — and with it
   * the buffer, so a steer typed during one superstep is never replayed
   * into the next one's agents. */
  endRun(runId: string, agent: SteerableAgent): void {
    const agents = this.activeAgents.get(runId);
    if (agents === undefined) return;
    agents.delete(agent);
    if (agents.size > 0) return;
    this.activeAgents.delete(runId);
    this.pendingSteers.delete(runId);
    this.drainedInto.delete(runId);
  }

  /** Inject `message` into EVERY live agent for `runId`, or buffer it for
   * the run's next `beginRun`. Empty strings are dropped (returns a
   * `buffered` outcome with no targets and no state change). */
  steer(runId: string, message: string): SteerDelivery {
    if (!message) return { disposition: "buffered", targets: [] };
    const agents = this.activeAgents.get(runId);
    if (agents !== undefined && agents.size > 0) {
      const targets: SteerTarget[] = [];
      for (const [agent, target] of agents) {
        this.inject(agent, message);
        targets.push(target);
      }
      return { disposition: "delivered", targets };
    }
    const existing = this.pendingSteers.get(runId);
    if (existing !== undefined) {
      existing.push(message);
      // Keep the newest: a buffer this deep means steers are arriving far
      // faster than the run dispatches, and the stale head is the least
      // useful thing in it.
      if (existing.length > MAX_BUFFERED_STEERS) existing.splice(0, existing.length - MAX_BUFFERED_STEERS);
    } else this.pendingSteers.set(runId, [message]);
    return { disposition: "buffered", targets: [] };
  }

  /** Drop every per-run entry for `runId`. Called when a run reaches a
   * terminal status so buffered-but-never-drained messages don't leak
   * until daemon restart. Idempotent. */
  forgetRun(runId: string): void {
    this.activeAgents.delete(runId);
    this.pendingSteers.delete(runId);
    this.drainedInto.delete(runId);
  }

  /** Is at least one agent currently registered for `runId`? */
  hasActive(runId: string): boolean {
    return (this.activeAgents.get(runId)?.size ?? 0) > 0;
  }

  /** Number of live agents registered for `runId` (0 when none). Exposed
   * for the broadcast invariant checks in tests. */
  activeCount(runId: string): number {
    return this.activeAgents.get(runId)?.size ?? 0;
  }

  /** Return the buffer size for `runId` (0 when no buffer exists).
   * Exposed for invariant checks in tests; not used by production callers. */
  pendingCount(runId: string): number {
    return this.pendingSteers.get(runId)?.length ?? 0;
  }

  /** Number of runs with at least one live agent registered. Exposed for tests. */
  activeSize(): number {
    return this.activeAgents.size;
  }

  /** Run ids with buffered messages. Exposed for tests. */
  pendingRunIds(): string[] {
    return [...this.pendingSteers.keys()];
  }

  private inject(agent: SteerableAgent, message: string): void {
    agent.steer({
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    });
  }
}
