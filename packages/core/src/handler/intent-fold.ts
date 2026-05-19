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
// **Purity contract (P0.1 of docs/proposals/parallel.md):** `foldIntents`
// is total over `RunStatus`, deterministic (same inputs → byte-identical
// output), and free of side effects (no I/O, no clocks, no mutation of
// the input array, no reads of ambient state). The function exists as
// the same reducer for top-level runs and (post P2) sub-runs; both call
// it with `(getUnappliedIntents(runId), state.status)` and consume the
// returned `IntentDecision` the same way. Property tests in
// `intent-fold.test.ts` enforce the contract; the executor in
// `daemon/src/executor.ts` is the only top-level caller today.
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
//   R6  multiple human_input → last-write-wins; earlier dropped (later_input_won)
//   R7  multiple priority_adjusted → last-write-wins; earlier dropped
//
// See `docs/intent-fold.md` for the full truth table.

import type { RunStatus } from "@swarm/types";

export type DroppedReason = "wrong_state" | "superseded_by_cancel" | "later_input_won" | "already_paused";

export interface DroppedIntent {
  seq: number;
  type: string;
  reason: DroppedReason;
}

export interface IntentFoldEvent {
  seq: number;
  type: string;
  payload: unknown;
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
      humanInput?: { route: string; note?: string } | string;
      /** Pause this turn (no specific intent in the batch). Executor
       * commits `fact.run_paused_human` immediately and skips dispatch. */
      shouldPause: boolean;
      /** Pause AFTER the handler returns successfully (R3 — pause
       * coexists with steer/human). The handler runs with the steer /
       * human applied; on success the executor commits
       * `fact.run_paused_human` instead of selecting the next edge.
       * Mutually exclusive with `shouldPause`. */
      shouldPauseAfterDispatch: boolean;
      /** Every intent that participated in this fold (applied OR dropped),
       * so the executor can advance `last_applied_seq` past all of them
       * and they don't refire next turn. */
      appliedSeqs: number[];
      dropped: DroppedIntent[];
    };

export function foldIntents(intents: IntentFoldEvent[], runStatus: RunStatus): IntentDecision {
  // R1 / R2 — cancel short-circuits. First cancel by seq wins; later cancels
  // and every other intent in the batch are recorded as dropped for audit.
  let firstCancel: IntentFoldEvent | undefined;
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
  const humanEvents: { seq: number; input: { route: string; note?: string } }[] = [];
  const priorityEvents: { seq: number; newPriority: number }[] = [];
  const pauseSeqs: number[] = [];
  const dropped: DroppedIntent[] = [];
  const applied: number[] = [];

  // The fold only runs while the executor is dispatching, which means
  // the run is `queued` (just-claimed, about to transition to running)
  // or `running`. `paused_*` and `quarantined` runs are skipped by the
  // executor before this point — but we accept them here defensively so
  // the fold is a total function over RunStatus.
  const isDispatching = runStatus === "queued" || runStatus === "running";
  const isPaused = runStatus === "paused_human" || runStatus === "paused" || runStatus === "paused_auto";

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
        // current handler) and on paused_human runs (buffered for the
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
      case "intent.human_input": {
        const p = ev.payload as { route: string; note?: string };
        // human_input only makes sense for a run that's been (or is being)
        // woken from paused_human. By the time the executor enters the
        // fold the wakePending path has already moved the run to queued/
        // running, so we accept here on the dispatching path. Other
        // states: dropped.
        if (isDispatching || isPaused) {
          humanEvents.push({ seq: ev.seq, input: p });
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
      case "intent.budget_adjusted": {
        // Operator raises a budget ceiling on a paused-budget run. Lands
        // in `routing.budget_override.<scope>.<metric>`; the next turn-
        // boundary check in budget-policy.ts reads it before the
        // graph/node attr.
        const p = ev.payload as { scope: "node" | "run"; metric: "cost" | "tokens"; newLimit: number };
        if (
          (p.scope === "node" || p.scope === "run") &&
          (p.metric === "cost" || p.metric === "tokens") &&
          typeof p.newLimit === "number" &&
          p.newLimit > 0
        ) {
          routingDelta[`budget_override.${p.scope}.${p.metric}`] = p.newLimit;
        } else {
          dropped.push({ seq: ev.seq, type: ev.type, reason: "wrong_state" });
        }
        break;
      }
      case "intent.max_retries_adjusted": {
        // Operator raises a node's `max_retries` cap on a
        // `paused{reason:"max_retries"}` run. Stage 3 of
        // docs/proposals/recoverable-budget-pause.md. Lands in
        // `routing.max_retries_override.<nodeId>`; the executor reads
        // it before consulting the static node attr.
        const p = ev.payload as { nodeId: string; newLimit: number };
        if (typeof p.nodeId === "string" && p.nodeId.length > 0 && typeof p.newLimit === "number" && p.newLimit > 0) {
          routingDelta[`max_retries_override.${p.nodeId}`] = p.newLimit;
        } else {
          dropped.push({ seq: ev.seq, type: ev.type, reason: "wrong_state" });
        }
        break;
      }
      case "intent.goal_gate_adjusted": {
        const p = ev.payload as { newLimit: number };
        if (typeof p.newLimit === "number" && p.newLimit > 0) {
          routingDelta["max_goal_gate_retries_override"] = p.newLimit;
        } else {
          dropped.push({ seq: ev.seq, type: ev.type, reason: "wrong_state" });
        }
        break;
      }
      case "intent.max_loops_adjusted": {
        const p = ev.payload as { newLimit: number };
        if (typeof p.newLimit === "number" && p.newLimit > 0) {
          routingDelta["max_loops_override"] = p.newLimit;
        } else {
          dropped.push({ seq: ev.seq, type: ev.type, reason: "wrong_state" });
        }
        break;
      }
      case "intent.run_enqueued":
      case "intent.resume":
      case "intent.unquarantine":
      case "intent.cancel_requested":
        // run_enqueued is projection-level (already applied at enqueue
        // time). resume + unquarantine are handled in wakePending (their
        // wake function emits a fact.run_resumed and advances applied
        // seq, so they shouldn't normally reach this fold; we accept them
        // defensively as no-ops). Cancel was already short-circuited
        // above.
        break;
    }
  }

  // R6 — multiple human_input: last-wins, earlier dropped.
  let humanInput: { route: string; note?: string } | undefined;
  if (humanEvents.length > 0) {
    const lastIdx = humanEvents.length - 1;
    humanInput = humanEvents[lastIdx]!.input;
    for (let i = 0; i < lastIdx; i++) {
      dropped.push({
        seq: humanEvents[i]!.seq,
        type: "intent.human_input",
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

  // R3 — specific intents (steer or human) plus pause: pause defers to
  // after the dispatch. The pause is still APPLIED (visible state
  // transition will happen post-handler), just not on the same boundary,
  // so it does NOT go into `dropped`.
  const hasSpecific = steering !== undefined || humanInput !== undefined;
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
  if (humanInput !== undefined) decision.humanInput = humanInput;
  return decision;
}
