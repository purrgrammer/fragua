// Per-run registry of live agents + buffered steer messages.
//
// Extracted from PiCodergenBackend so the concurrency-critical slot-
// management logic lives in one focused ~60-line class, independent of
// pi-ai / pi-agent-core. This makes property-based tests tractable: the
// PBT can exercise the registry directly with a minimal fake agent
// instead of spinning up the full LLM stack.
//
// Semantics:
//   - `beginRun(runId, agent)` registers the live agent for a run and
//     drains any messages that were buffered while no agent was active
//     for that run. Drains in FIFO order.
//   - `endRun(runId, agent)` clears the slot iff the registered agent is
//     still the same instance (defensive; a re-entrant begin/end cycle
//     for the same runId would otherwise risk erasing the wrong agent).
//   - `steer(runId, message)` injects into the live agent for `runId` if
//     one exists; otherwise buffers. Empty strings are ignored.
//   - `forgetRun(runId)` drops both the live slot (if any) and the
//     buffer (if any) for `runId`. Idempotent.
//
// Concurrency: every op is synchronous; there's no `await` anywhere.
// Under a single-threaded JS runtime this makes the registry safe to
// call from any number of concurrent async callers without further
// locking — the only cross-call state is the two Maps, and Map ops
// don't yield mid-mutation.

/** Minimal contract the registry needs on an agent. The real
 * pi-agent-core `Agent` satisfies this; tests provide a fake. */
export interface SteerableAgent {
  steer(message: { role: "user"; content: [{ type: "text"; text: string }]; timestamp: number }): void;
}

export class SteeringRegistry {
  private readonly activeAgents = new Map<string, SteerableAgent>();
  private readonly pendingSteers = new Map<string, string[]>();

  /** Register `agent` as the live agent for `runId` and drain any
   * messages that were buffered while no agent was active. */
  beginRun(runId: string, agent: SteerableAgent): void {
    this.activeAgents.set(runId, agent);
    const buffered = this.pendingSteers.get(runId);
    if (buffered !== undefined) {
      this.pendingSteers.delete(runId);
      for (const msg of buffered) this.inject(agent, msg);
    }
  }

  /** Clear the live slot for `runId` iff the registered agent is still
   * `agent`. Defensive against re-entrant begin/end cycles. */
  endRun(runId: string, agent: SteerableAgent): void {
    if (this.activeAgents.get(runId) === agent) this.activeAgents.delete(runId);
  }

  /** Inject `message` into the live agent for `runId`, or buffer it for
   * the run's next `beginRun`. Empty strings are dropped. */
  steer(runId: string, message: string): void {
    if (!message) return;
    const agent = this.activeAgents.get(runId);
    if (agent !== undefined) {
      this.inject(agent, message);
      return;
    }
    const existing = this.pendingSteers.get(runId);
    if (existing !== undefined) existing.push(message);
    else this.pendingSteers.set(runId, [message]);
  }

  /** Drop every per-run entry for `runId`. Called when a run reaches a
   * terminal status so buffered-but-never-drained messages don't leak
   * until daemon restart. Idempotent. */
  forgetRun(runId: string): void {
    this.activeAgents.delete(runId);
    this.pendingSteers.delete(runId);
  }

  /** Is an agent currently registered for `runId`? */
  hasActive(runId: string): boolean {
    return this.activeAgents.has(runId);
  }

  /** Return the buffer size for `runId` (0 when no buffer exists).
   * Exposed for invariant checks in tests; not used by production callers. */
  pendingCount(runId: string): number {
    return this.pendingSteers.get(runId)?.length ?? 0;
  }

  /** Number of runs with a live agent registered. Exposed for tests. */
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
