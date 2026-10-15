import type * as core from "@fragua/core/handler";

/** Bounded-concurrency gate for fan-out sub-node dispatch. A slot transfers
 * directly to the next waiter on `release()` so `active` never exceeds `limit`. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.active--;
  }
}

/** Signalled into an in-flight branch's controller when the fan-out pool takes
 * an early-terminal exit. Named `AbortError` so the branch classifies it as a
 * plain abort (not a timeout, not a leak). */
export class FanoutBailError extends Error {
  constructor(public readonly runId: string) {
    super(`fan-out pool bailed for ${runId}`);
    this.name = "AbortError";
  }
}

/** A clean proceed decision for a branch sub-node — deep-frozen so the shared
 * constant can't be cross-corrupted across concurrent branches. */
export const PROCEED_DECISION: Extract<core.IntentDecision, { kind: "proceed" }> = (() => {
  const d: Extract<core.IntentDecision, { kind: "proceed" }> = {
    kind: "proceed",
    routingDelta: {},
    shouldPause: false,
    shouldPauseAfterDispatch: false,
    appliedSeqs: [],
    dropped: [],
  };
  Object.freeze(d.routingDelta);
  Object.freeze(d.appliedSeqs);
  Object.freeze(d.dropped);
  return Object.freeze(d);
})();

export type ProceedDecision = Extract<core.IntentDecision, { kind: "proceed" }>;
