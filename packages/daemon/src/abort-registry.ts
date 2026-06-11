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
  /** The node whose handler this controller belongs to. The leak watchdog
   * budgets each entry against ITS OWN node deadline — under a fan-out, branches
   * have different `maxMs`, and budgeting the whole set against the longest let a
   * short-deadline branch evade detection until the longest sibling expired. */
  nodeId: string;
  /** `Date.now()` at register() time. Only meaningful within the
   * current process; tripped if `now - startedAt > deadlineMs + leakGrace`. */
  startedAt: number;
  /** The wall-clock deadline the dispatcher actually ARMED for this handler
   * (the tighter of the node's `max_ms` and any fan-out branch backstop),
   * stamped by invoke-handler at register() time. The leak watchdog budgets
   * against THIS — never a graph re-derivation or a config mirror, which can
   * disagree with the in-flight signal. `undefined` ⇒ intentionally unbounded
   * (a linear node that opted out of wall-clock bounding). */
  deadlineMs?: number;
}

/** One in-flight handler, with its own elapsed time + node + armed deadline —
 * the unit the supervisor's leak watchdog checks (and trips) per-branch. */
export interface LiveHandler {
  nodeId: string;
  controller: AbortController;
  elapsedMs: number;
  deadlineMs?: number;
}

export class AbortRegistry {
  private readonly entries = new Map<string, Set<AbortRegistryEntry>>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** Register an in-flight handler's controller for a run, tagged with the node
   * it runs and the armed wall-clock deadline (the production caller,
   * invoke-handler, always passes `ctx.nodeId` + the watchdog deadline; the
   * defaults are for registry-mechanics tests that don't exercise the watchdog).
   * Returns a disposer that removes exactly this entry (so concurrent fan-out
   * branches each clean up their own registration without clobbering siblings). */
  register(runId: string, controller: AbortController, nodeId = "", deadlineMs?: number): () => void {
    const entry: AbortRegistryEntry = { controller, nodeId, startedAt: this.clock() };
    if (deadlineMs !== undefined) entry.deadlineMs = deadlineMs;
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

  /** Every in-flight handler for a run — each with its own node id, elapsed
   * time, and armed deadline — so the watchdog can check each against ITS OWN
   * deadline and trip only the offending controller (not the whole fan-out set). */
  liveHandlers(runId: string): LiveHandler[] {
    const set = this.entries.get(runId);
    if (set === undefined) return [];
    const now = this.clock();
    return Array.from(set, (e) => {
      const h: LiveHandler = { nodeId: e.nodeId, controller: e.controller, elapsedMs: now - e.startedAt };
      if (e.deadlineMs !== undefined) h.deadlineMs = e.deadlineMs;
      return h;
    });
  }
}
