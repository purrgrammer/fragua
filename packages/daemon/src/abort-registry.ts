// Per-run AbortController registry.
//
// The supervisor fiber trips these when it detects new intents between turns;
// shutdown trips all of them at once. A run's controllers are live only while
// handlers are executing on that run.
//
// A run usually has exactly one in-flight handler, but a `parallel` fan-out
// (Model A, docs/proposals/fan-out-nodes.md) runs K branch handlers
// concurrently — so a run maps to a SET of controllers. `register` returns a
// disposer that removes the one entry it added (concurrent branches don't
// clobber each other), and `trip(runId)` aborts the whole set (an operator
// cancel / steer / shutdown ends the superstep).
//
// Each entry carries a monotonic `startedAt` timestamp stamped at register()
// time. Supervisor's leak watchdog reads that — not the DB's
// `run_state.node_started_at` — so daemon pauses and cross-restart resumption
// don't accumulate wall-clock time against a node's maxMs.

export interface AbortRegistryEntry {
  controller: AbortController;
  /** `Date.now()` at register() time. Only meaningful within the
   * current process; tripped if `now - startedAt > maxMs + leakGrace`. */
  startedAt: number;
}

export class AbortRegistry {
  private readonly entries = new Map<string, Set<AbortRegistryEntry>>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** Register an in-flight handler's controller for a run. Returns a disposer
   * that removes exactly this entry (so concurrent fan-out branches each clean
   * up their own registration without clobbering siblings). */
  register(runId: string, controller: AbortController): () => void {
    const entry: AbortRegistryEntry = { controller, startedAt: this.clock() };
    let set = this.entries.get(runId);
    if (set === undefined) {
      set = new Set();
      this.entries.set(runId, set);
    }
    set.add(entry);
    return () => {
      const s = this.entries.get(runId);
      if (s === undefined) return;
      s.delete(entry);
      if (s.size === 0) this.entries.delete(runId);
    };
  }

  /** Remove every controller for a run. */
  unregister(runId: string): void {
    this.entries.delete(runId);
  }

  /** Trip every live controller for a run. Returns true if any were found. */
  trip(runId: string, reason?: unknown): boolean {
    const set = this.entries.get(runId);
    if (set === undefined || set.size === 0) return false;
    for (const entry of set) entry.controller.abort(reason);
    return true;
  }

  /** Trip every controller across every run. Used at shutdown. */
  tripAll(reason?: unknown): void {
    for (const set of this.entries.values()) {
      for (const entry of set) entry.controller.abort(reason);
    }
  }

  has(runId: string): boolean {
    return (this.entries.get(runId)?.size ?? 0) > 0;
  }

  activeRuns(): string[] {
    return Array.from(this.entries.keys()).filter((id) => (this.entries.get(id)?.size ?? 0) > 0);
  }

  /** Milliseconds since the OLDEST live handler for the run registered (the
   * longest-running branch under a fan-out — the conservative leak bound).
   * `undefined` when no handler is in flight. Process-local — not derivable
   * from the store across restarts. */
  elapsedMs(runId: string): number | undefined {
    const set = this.entries.get(runId);
    if (set === undefined || set.size === 0) return undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const entry of set) oldest = Math.min(oldest, entry.startedAt);
    return this.clock() - oldest;
  }
}
