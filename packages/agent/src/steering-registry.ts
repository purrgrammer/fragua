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
// Semantics:
//   - `beginRun(runId, agent, target)` adds `agent` to the run's live
//     set (tagged with its `(nodeId, iteration)` for delivery records)
//     and drains any messages buffered while no agent was active. Drains
//     in FIFO order into the beginning agent.
//   - `endRun(runId, agent)` removes `agent` from the run's live set;
//     the last agent out drops the run's set entry.
//   - `steer(runId, message)` injects into EVERY live agent for `runId`
//     if any exist (returning a `delivered` outcome listing them);
//     otherwise buffers (returning `buffered`). Empty strings are dropped.
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

export class SteeringRegistry {
  private readonly activeAgents = new Map<string, Map<SteerableAgent, SteerTarget>>();
  private readonly pendingSteers = new Map<string, string[]>();

  /** Register `agent` as a live agent for `runId` (tagged with the branch
   * it runs) and drain any messages buffered while no agent was active. */
  beginRun(runId: string, agent: SteerableAgent, target: SteerTarget = UNTAGGED_TARGET): void {
    let agents = this.activeAgents.get(runId);
    if (agents === undefined) {
      agents = new Map();
      this.activeAgents.set(runId, agents);
    }
    agents.set(agent, target);
    const buffered = this.pendingSteers.get(runId);
    if (buffered !== undefined) {
      this.pendingSteers.delete(runId);
      for (const msg of buffered) this.inject(agent, msg);
    }
  }

  /** Remove `agent` from the run's live set. The last agent out drops the
   * run's entry so `hasActive` and `activeSize` stay accurate. */
  endRun(runId: string, agent: SteerableAgent): void {
    const agents = this.activeAgents.get(runId);
    if (agents === undefined) return;
    agents.delete(agent);
    if (agents.size === 0) this.activeAgents.delete(runId);
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
    if (existing !== undefined) existing.push(message);
    else this.pendingSteers.set(runId, [message]);
    return { disposition: "buffered", targets: [] };
  }

  /** Drop every per-run entry for `runId`. Called when a run reaches a
   * terminal status so buffered-but-never-drained messages don't leak
   * until daemon restart. Idempotent. */
  forgetRun(runId: string): void {
    this.activeAgents.delete(runId);
    this.pendingSteers.delete(runId);
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
