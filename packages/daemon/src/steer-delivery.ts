// Steer delivery + observability — the daemon side of a mid-flight steer.
//
// The supervisor forwards an `intent.steering_requested` into the shared
// steer registry via `onSteer`; the registry injects the text into every
// in-flight LLM branch (or buffers it) and reports the outcome. This module
// turns that outcome into a durable `fact.steering_applied` so an operator
// can see whether the model actually saw the steer — the intent alone only
// records that the request was appended, not that it landed.
//
// Fact writing lives here (the daemon is the sole fact writer, ground rule 5)
// rather than in the agent package, which has no store handle. The append is
// OCC-checked against `run_state.version`; a fan-out steer competes with the
// branches' own commits, so a bounded retry re-reads the live version. The
// fact is projection-neutral, so a conflict that outlives the budget is
// swallowed rather than crashing the supervisor fiber.

import { ConcurrencyError, type IEventReader, type IEventWriter, type SteerDelivery } from "@fragua/store";

/** Structural view of the steer registry — the daemon needs only its
 * broadcast entry point, so it doesn't take a hard dependency on
 * `@fragua/agent`'s `SteeringRegistry`. */
export interface SteerForwarder {
  steer(runId: string, text: string): SteerDelivery;
}

const STEER_FACT_APPEND_ATTEMPTS = 8;

/** Most branches a receipt names before it starts truncating. Payloads are
 * capped at 4 KB (I7) and a breach THROWS — which, inside the supervisor tick,
 * is swallowed, costing the operator the entire receipt. A `SteerTarget` is a
 * short nodeId plus an iteration, so 50 of them sit far inside the cap while
 * covering every fan-out width this engine actually runs. */
const MAX_RECORDED_TARGETS = 50;

export function buildSteerDelivery(deps: {
  store: IEventWriter & IEventReader;
  registry: SteerForwarder;
}): (runId: string, text: string, intentSeq: number) => void {
  const { store, registry } = deps;
  return (runId, text, intentSeq) => {
    const delivery = registry.steer(runId, text);
    for (let attempt = 0; attempt < STEER_FACT_APPEND_ATTEMPTS; attempt++) {
      const state = store.getState(runId);
      if (state == null || state.status !== "running") return;
      try {
        store.appendFact(
          runId,
          [
            {
              type: "fact.steering_applied",
              payload: {
                intentSeq,
                disposition: delivery.disposition,
                targets: delivery.targets.slice(0, MAX_RECORDED_TARGETS),
                targetCount: delivery.targets.length,
              },
            },
          ],
          state.version,
        );
        return;
      } catch (err) {
        if (err instanceof ConcurrencyError) continue;
        // `fact.steering_applied` is observability: it records where a steer
        // landed, it does not gate anything. A store fault here (SQLITE_FULL,
        // SQLITE_IOERR, a constraint violation) must not propagate — this runs
        // inside the supervisor's tick, whose only try/catch wraps the
        // heartbeat, so a throw rejects the loop promise and takes the
        // watchdog fiber down with it. The steer itself has already been
        // handed to the registry above; losing its receipt is the small loss.
        return;
      }
    }
  };
}
