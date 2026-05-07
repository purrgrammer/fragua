// wait.human handler — ARCHITECTURE.md §0.
//
// First call: returns yield_hitl with the configured label and the
// structured option list (one per outgoing edge, with parsed accelerator
// keys). The executor commits fact.run_paused_hitl and frees the slot.
//
// Second call (after intent.hitl_input arrives): ctx.hitlInput is populated
// by the executor from the fold. The handler resolves the chosen option
// (case-insensitive key match) and returns a transition with
// suggestedNextIds=[chosen.to] plus context updates under `human.gate.*`.
// Edge selection routes without conditions.

import { parseAcceleratorKey, stripAcceleratorPrefix } from "../../accelerator.ts";
import type { Handler, HandlerResult, HandlerSpec } from "../types.ts";

export { parseAcceleratorKey, stripAcceleratorPrefix };

export interface HitlOption {
  key: string;
  label: string;
  to: string;
}

export interface HitlInput {
  selected: string;
  note?: string;
}

export interface WaitHumanConfig {
  label?: string;
  options: HitlOption[];
  /** Optional routing key where the operator-supplied selected key is
   * mirrored on resume. When unset, only the canonical
   * `human.gate.selected` / `human.gate.label` pair is written. */
  inputKey?: string;
}

export function makeWaitHumanHandler(cfg: WaitHumanConfig): HandlerSpec {
  validateOptions(cfg.options);
  const label = cfg.label ?? "Select an option:";
  const options = cfg.options;
  const inputKey = cfg.inputKey;

  const handler: Handler = async (ctx) => {
    if (ctx.hitlInput === undefined) {
      return { kind: "yield_hitl", label, options } satisfies HandlerResult;
    }

    const { selected } = normaliseHitlInput(ctx.hitlInput);
    const chosen = options.find((o) => o.key.toUpperCase() === selected.toUpperCase());
    if (chosen === undefined) {
      const valid = options.map((o) => o.key).join(", ");
      return {
        kind: "halt",
        reason: "error",
        detail: `wait.human: unknown selected key "${selected}" (expected one of: ${valid})`,
      } satisfies HandlerResult;
    }

    // Per attractor §4.6 the wait.human handler writes only
    // `human.gate.selected` and `human.gate.label`. The optional `note`
    // field on intent.hitl_input is recorded in the event payload for
    // audit but is no longer mirrored into routing — operators who need
    // free-text input on a running thread should use intent.steer
    // (a swarm extension that fills that gap; see docs/SPEC.md §6.4).
    const routingDelta: Record<string, unknown> = {
      "human.gate.selected": chosen.key,
      "human.gate.label": chosen.label,
    };
    if (inputKey !== undefined) routingDelta[inputKey] = chosen.key;

    return {
      kind: "transition",
      // `preferredLabel` lets the engine's Step-2 selector pick the
      // exact edge the operator chose when multiple HITL options route
      // to the same target (e.g. `[O] Output only -> done` and `[R]
      // Reject -> done` both terminate at `done`). Without it the
      // selector falls through to Step 3 (`suggested_next_ids`) and
      // picks the first edge to the target — silently ambiguating the
      // operator's choice in `selectedEdges` / UI highlighting.
      preferredLabel: chosen.label,
      suggestedNextIds: [chosen.to],
      routingDelta,
      tokens: 0,
      costUsd: 0,
    } satisfies HandlerResult;
  };

  return { kind: "wait.human", sideEffect: "none", maxMs: 1_000, handler };
}

function validateOptions(options: HitlOption[]): void {
  if (options.length === 0) {
    throw new Error("wait.human: at least one option is required (a hexagon node must have outgoing edges)");
  }
  const seen = new Set<string>();
  for (const o of options) {
    const k = o.key.toUpperCase();
    if (seen.has(k)) {
      throw new Error(
        `wait.human: duplicate accelerator key "${k}" — disambiguate edge labels (e.g. [A] Approve, [B] Acknowledge)`,
      );
    }
    seen.add(k);
  }
}

function normaliseHitlInput(raw: HitlInput | string): HitlInput {
  if (typeof raw === "string") return { selected: raw };
  // Empty-string note is treated as absent (matches server-side trim).
  if (raw.note !== undefined && raw.note.length > 0) return { selected: raw.selected, note: raw.note };
  return { selected: raw.selected };
}
