// Intent fold — ARCHITECTURE.md §6.
//
// The daemon collects unapplied intents between node turns and reduces them
// to a single decision. The fold is a deterministic pure function: the
// run's current status decides which intents are actionable, and a small
// set of precedence rules decides what happens when multiple actionable
// intents collide. Dropped intents (wrong state, superseded, etc.) are
// reported in the decision so the executor can emit `intent.dropped`
// observability events for audit.
//
// Precedence summary:
//
//   R1  cancel beats everything → terminal cancel
//   R2  first-cancel wins (for the recorded reason; later cancels drop)
//   R3  (steer OR hitl) + pause → specific wins this turn,
//        pause defers to AFTER the handler returns
//        (`shouldPauseAfterDispatch`). The pause IS still applied —
//        just on a different boundary — so it is not in `dropped`.
//   R4  pause-only (no specific) → `shouldPause` this turn (current behaviour)
//   R5  steers merge in seq-ascending order with `\n` separators
//   R6  multiple hitl_input → last-write-wins; earlier dropped (later_input_won)
//   R7  multiple priority_adjusted → last-write-wins; earlier dropped
//
// See `docs/intent-fold.md` for the full truth table.

import type { RunStatus, StoredEvent } from "@swarm/store";

export type DroppedReason = "wrong_state" | "superseded_by_cancel" | "later_input_won" | "already_paused";

export interface DroppedIntent {
  seq: number;
  type: string;
  reason: DroppedReason;
}

export type IntentDecision =
  | {
      kind: "cancel";
      intentSeq: number;
      reason?: string;
      /** Intents in the same batch that did not effect cancel — every
       * non-cancel intent is recorded here so the executor can audit
       * the drop via `intent.dropped` observability events. */
      dropped: DroppedIntent[];
    }
  | {
      kind: "proceed";
      routingDelta: Record<string, unknown>;
      steering?: string;
      hitlInput?: unknown;
      /** Pause this turn (no specific intent in the batch). Executor
       * commits `fact.run_paused_hitl` immediately and skips dispatch. */
      shouldPause: boolean;
      /** Pause AFTER the handler returns successfully (R3 — pause
       * coexists with steer/hitl). The handler runs with the steer /
       * hitl applied; on success the executor commits
       * `fact.run_paused_hitl` instead of selecting the next edge.
       * Mutually exclusive with `shouldPause`. */
      shouldPauseAfterDispatch: boolean;
      /** Every intent that participated in this fold (applied OR dropped),
       * so the executor can advance `last_applied_seq` past all of them
       * and they don't refire next turn. */
      appliedSeqs: number[];
      dropped: DroppedIntent[];
    };

export function foldIntents(intents: StoredEvent[], runStatus: RunStatus): IntentDecision {
  // R1 / R2 — cancel short-circuits. First cancel by seq wins; later cancels
  // and every other intent in the batch are recorded as dropped for audit.
  let firstCancel: StoredEvent | undefined;
  for (const ev of intents) {
    if (ev.type === "intent.cancel_requested") {
      if (firstCancel === undefined || ev.seq < firstCancel.seq) {
        firstCancel = ev;
      }
    }
  }
  if (firstCancel !== undefined) {
    const dropped: DroppedIntent[] = [];
    for (const ev of intents) {
      if (ev.seq === firstCancel.seq) continue;
      dropped.push({
        seq: ev.seq,
        type: ev.type,
        reason: ev.type === "intent.cancel_requested" ? "later_input_won" : "superseded_by_cancel",
      });
    }
    const p = firstCancel.payload as { reason?: string };
    return {
      kind: "cancel",
      intentSeq: firstCancel.seq,
      ...(p.reason !== undefined ? { reason: p.reason } : {}),
      dropped,
    };
  }

  const routingDelta: Record<string, unknown> = {};
  const steerEvents: { seq: number; text: string }[] = [];
  const hitlEvents: { seq: number; input: unknown }[] = [];
  const priorityEvents: { seq: number; newPriority: number }[] = [];
  const pauseSeqs: number[] = [];
  const dropped: DroppedIntent[] = [];
  const applied: number[] = [];

  // The fold only runs while the executor is dispatching, which means
  // the run is `queued` (just-claimed, about to transition to running)
  // or `running`. `paused_hitl` and `quarantined` runs are skipped by
  // the executor before this point — but we accept them here defensively
  // so the fold is a total function over RunStatus.
  const isDispatching = runStatus === "queued" || runStatus === "running";
  const isPaused = runStatus === "paused_hitl";

  for (const ev of intents) {
    applied.push(ev.seq);
    switch (ev.type) {
      case "intent.pause_requested": {
        if (isPaused) {
          dropped.push({ seq: ev.seq, type: ev.type, reason: "already_paused" });
        } else if (!isDispatching) {
          dropped.push({ seq: ev.seq, type: ev.type, reason: "wrong_state" });
        } else {
          pauseSeqs.push(ev.seq);
        }
        break;
      }
      case "intent.steering_requested": {
        const p = ev.payload as { text: string };
        // Steer is meaningful on dispatching runs (delivered to the
        // current handler) and on paused_hitl runs (buffered for the
        // dispatch after wake). Quarantined: dropped.
        if ((isDispatching || isPaused) && typeof p.text === "string" && p.text.length > 0) {
          steerEvents.push({ seq: ev.seq, text: p.text });
        } else if (!isDispatching && !isPaused) {
          dropped.push({ seq: ev.seq, type: ev.type, reason: "wrong_state" });
        }
        // Empty-text steer with valid state: silently ignored (treated
        // as applied; no audit value). Considered a benign no-op.
        break;
      }
      case "intent.hitl_input": {
        const p = ev.payload as { input: unknown };
        // hitl_input only makes sense for a run that's been (or is being)
        // woken from paused_hitl. By the time the executor enters the
        // fold the wakePending path has already moved the run to queued/
        // running, so we accept here on the dispatching path. Other
        // states: dropped.
        if (isDispatching || isPaused) {
          hitlEvents.push({ seq: ev.seq, input: p.input });
        } else {
          dropped.push({ seq: ev.seq, type: ev.type, reason: "wrong_state" });
        }
        break;
      }
      case "intent.priority_adjusted": {
        const p = ev.payload as { newPriority: number };
        priorityEvents.push({ seq: ev.seq, newPriority: p.newPriority });
        break;
      }
      case "intent.run_enqueued":
      case "intent.unquarantine":
      case "intent.cancel_requested":
        // run_enqueued is projection-level (already applied at enqueue
        // time). unquarantine has its own handler path outside the
        // dispatch fold (currently a known gap — see top.md). Cancel was
        // already short-circuited above.
        break;
    }
  }

  // R6 — multiple hitl_input: last-wins, earlier dropped.
  let hitlInput: unknown | undefined;
  if (hitlEvents.length > 0) {
    const lastIdx = hitlEvents.length - 1;
    hitlInput = hitlEvents[lastIdx]!.input;
    for (let i = 0; i < lastIdx; i++) {
      dropped.push({
        seq: hitlEvents[i]!.seq,
        type: "intent.hitl_input",
        reason: "later_input_won",
      });
    }
  }

  // R7 — multiple priority_adjusted: last-wins, earlier dropped.
  if (priorityEvents.length > 0) {
    const lastIdx = priorityEvents.length - 1;
    routingDelta["priority"] = priorityEvents[lastIdx]!.newPriority;
    for (let i = 0; i < lastIdx; i++) {
      dropped.push({
        seq: priorityEvents[i]!.seq,
        type: "intent.priority_adjusted",
        reason: "later_input_won",
      });
    }
  }

  // R5 — steering merges by seq order. Already in input order; sort defensively.
  let steering: string | undefined;
  if (steerEvents.length > 0) {
    steerEvents.sort((a, b) => a.seq - b.seq);
    steering = steerEvents.map((s) => s.text).join("\n");
  }

  // R3 — specific intents (steer or hitl) plus pause: pause defers to
  // after the dispatch. The pause is still APPLIED (visible state
  // transition will happen post-handler), just not on the same boundary,
  // so it does NOT go into `dropped`.
  const hasSpecific = steering !== undefined || hitlInput !== undefined;
  const shouldPause = pauseSeqs.length > 0 && !hasSpecific;
  const shouldPauseAfterDispatch = pauseSeqs.length > 0 && hasSpecific;

  const decision: IntentDecision = {
    kind: "proceed",
    routingDelta,
    shouldPause,
    shouldPauseAfterDispatch,
    appliedSeqs: applied,
    dropped,
  };
  if (steering !== undefined) decision.steering = steering;
  if (hitlInput !== undefined) decision.hitlInput = hitlInput;
  return decision;
}
