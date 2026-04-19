// Intent fold — REARCHITECTURE.md §6.
//
// The daemon collects unapplied intents between node turns and reduces them
// to a single decision. Cancel wins; otherwise we collapse pause / steer /
// hitl_input into routing and steering hints that feed the next handler.

import type { StoredEvent } from "@swarm/store";

export type IntentDecision =
  | { kind: "cancel"; intentSeq: number; reason?: string }
  | {
      kind: "proceed";
      routingDelta: Record<string, unknown>;
      steering?: string;
      hitlInput?: unknown;
      shouldPause: boolean;
      appliedSeqs: number[];
    };

export function foldIntents(intents: StoredEvent[]): IntentDecision {
  // Cancel short-circuits.
  for (const ev of intents) {
    if (ev.type === "intent.cancel_requested") {
      const p = ev.payload as { reason?: string };
      return {
        kind: "cancel",
        intentSeq: ev.seq,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      };
    }
  }

  const routingDelta: Record<string, unknown> = {};
  const steeringParts: string[] = [];
  let hitlInput: unknown | undefined;
  let shouldPause = false;
  const applied: number[] = [];

  for (const ev of intents) {
    applied.push(ev.seq);
    switch (ev.type) {
      case "intent.pause_requested": {
        shouldPause = true;
        break;
      }
      case "intent.steering_requested": {
        const p = ev.payload as { text: string };
        if (typeof p.text === "string" && p.text.length > 0) {
          steeringParts.push(p.text);
        }
        break;
      }
      case "intent.hitl_input": {
        const p = ev.payload as { input: unknown };
        hitlInput = p.input;
        break;
      }
      case "intent.priority_adjusted": {
        const p = ev.payload as { newPriority: number };
        routingDelta["priority"] = p.newPriority;
        break;
      }
      case "intent.run_enqueued":
      case "intent.unquarantine":
      case "intent.cancel_requested":
        // run_enqueued is projection-level; unquarantine handled elsewhere;
        // cancel_requested already short-circuited above.
        break;
    }
  }

  const decision: IntentDecision = {
    kind: "proceed",
    routingDelta,
    shouldPause,
    appliedSeqs: applied,
  };
  if (steeringParts.length > 0) {
    decision.steering = steeringParts.join("\n");
  }
  if (hitlInput !== undefined) {
    decision.hitlInput = hitlInput;
  }
  return decision;
}
