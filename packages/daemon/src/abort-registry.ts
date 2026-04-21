// Per-run AbortController registry.
//
// The supervisor fiber trips these when it detects new intents between turns;
// shutdown trips all of them at once. A run's controller is live only while a
// handler is executing on that run.
//
// Each entry also carries a monotonic `startedAt` timestamp stamped at
// register() time. Supervisor's leak watchdog reads that — not the DB's
// `run_state.node_started_at` — so daemon pauses and cross-restart
// resumption don't accumulate wall-clock time against a node's maxMs.

export interface AbortRegistryEntry {
  controller: AbortController;
  /** `Date.now()` at register() time. Only meaningful within the
   * current process; tripped if `now - startedAt > maxMs + leakGrace`. */
  startedAt: number;
}

export class AbortRegistry {
  private readonly entries = new Map<string, AbortRegistryEntry>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  register(runId: string, controller: AbortController): void {
    const existing = this.entries.get(runId);
    if (existing != null) {
      throw new Error(`abort controller already registered for ${runId}`);
    }
    this.entries.set(runId, { controller, startedAt: this.clock() });
  }

  unregister(runId: string): void {
    this.entries.delete(runId);
  }

  /** Trip the controller for a run, if any. Returns true if a controller was found. */
  trip(runId: string, reason?: unknown): boolean {
    const entry = this.entries.get(runId);
    if (entry == null) return false;
    entry.controller.abort(reason);
    return true;
  }

  /** Trip every controller. Used at shutdown. */
  tripAll(reason?: unknown): void {
    for (const entry of this.entries.values()) {
      entry.controller.abort(reason);
    }
  }

  has(runId: string): boolean {
    return this.entries.has(runId);
  }

  activeRuns(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Milliseconds since `register(runId, …)` was last called. Returns
   * `undefined` when no entry exists for the run. Process-local — not
   * derivable from the store across restarts. */
  elapsedMs(runId: string): number | undefined {
    const entry = this.entries.get(runId);
    if (entry == null) return undefined;
    return this.clock() - entry.startedAt;
  }
}
