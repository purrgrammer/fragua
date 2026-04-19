// Per-run AbortController registry.
//
// The supervisor fiber trips these when it detects new intents between turns;
// shutdown trips all of them at once. A run's controller is live only while a
// handler is executing on that run.

export class AbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(runId: string, controller: AbortController): void {
    const existing = this.controllers.get(runId);
    if (existing != null) {
      throw new Error(`abort controller already registered for ${runId}`);
    }
    this.controllers.set(runId, controller);
  }

  unregister(runId: string): void {
    this.controllers.delete(runId);
  }

  /** Trip the controller for a run, if any. Returns true if a controller was found. */
  trip(runId: string, reason?: unknown): boolean {
    const controller = this.controllers.get(runId);
    if (controller == null) return false;
    controller.abort(reason);
    return true;
  }

  /** Trip every controller. Used at shutdown. */
  tripAll(reason?: unknown): void {
    for (const controller of this.controllers.values()) {
      controller.abort(reason);
    }
  }

  has(runId: string): boolean {
    return this.controllers.has(runId);
  }

  activeRuns(): string[] {
    return Array.from(this.controllers.keys());
  }
}
