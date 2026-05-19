// wait.human handler — ARCHITECTURE.md §0.
//
// First call: returns yield_hitl with the configured label and the
// structured option list (one per outgoing edge, with parsed accelerator
// keys). The executor commits fact.run_paused_human and frees the slot.
//
// Second call (after intent.human_input arrives): ctx.humanInput is
// populated by the executor from the fold. The handler resolves the
// chosen option (case-insensitive key match against the wire `route`
// value) and returns a transition with suggestedNextIds=[chosen.to]
// + preferredLabel; edge selection routes via Step-2 label match
// (disambiguates parallel edges to the same target) falling through
// to Step-3 suggestedNextIds. No conditions involved. No routing
// writes — the operator's chosen route and optional note are
// preserved verbatim in the intent.human_input event payload for
// audit, and operators who need free-text input on a running thread
// use intent.steer (docs/SPEC.md §6.4).

import { parseAcceleratorKey, stripAcceleratorPrefix } from "../../accelerator.ts";
import type { Handler, HandlerResult, HandlerSpec } from "../types.ts";

export { parseAcceleratorKey, stripAcceleratorPrefix };

export interface HitlOption {
  key: string;
  label: string;
  to: string;
}

export interface HumanInput {
  route: string;
  note?: string;
}

export interface WaitHumanConfig {
  label?: string;
  options: HitlOption[];
}

export function makeWaitHumanHandler(cfg: WaitHumanConfig): HandlerSpec {
  validateOptions(cfg.options);
  const label = cfg.label ?? "Select an option:";
  const options = cfg.options;

  const handler: Handler = async (ctx) => {
    if (ctx.humanInput === undefined) {
      return { kind: "yield_hitl", label, options } satisfies HandlerResult;
    }

    const { route } = normaliseHumanInput(ctx.humanInput);
    const chosen = options.find((o) => o.key.toUpperCase() === route.toUpperCase());
    if (chosen === undefined) {
      const valid = options.map((o) => o.key).join(", ");
      return {
        kind: "halt",
        reason: "error",
        detail: `wait.human: unknown route "${route}" (expected one of: ${valid})`,
      } satisfies HandlerResult;
    }

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

function normaliseHumanInput(raw: HumanInput | string): HumanInput {
  if (typeof raw === "string") return { route: raw };
  // Empty-string note is treated as absent (matches server-side trim).
  if (raw.note !== undefined && raw.note.length > 0) return { route: raw.route, note: raw.note };
  return { route: raw.route };
}
