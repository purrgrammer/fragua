// Pure pre-dispatch decision planner — the driver-side twin of
// transition-planner.ts (the success arm) and abort-planner.ts (the abort arm),
// for the fact-choosing decisions that fire BEFORE, or INSTEAD OF, a handler
// dispatch: the event-contract version gate, the unparseable-workflow refusal, a
// worktree-provision failure, and the per-run max_loops dispatch ceiling. The
// leaked-handler halt (a post-dispatch structural terminal) is planned by the
// sibling `planLeakHalt`. Each was inline in the executor's driver; lifting the
// decision here keeps SPEC §3.11 / I12's decision core complete — no store, no
// clock (`leakedAt` is a value), no RNG, no I/O. The driver applies the plan.

import type { FactEvent, RunState } from "@fragua/store";

// The event-payload cap is 4KB; bound the appended parse error so a
// pathological message can never make the halt append itself fail.
const PARSE_ERROR_DETAIL_MAX = 300;

export function workflowParseFailedDetail(errorMessage: string | undefined): string {
  if (errorMessage == null || errorMessage === "") return "workflow_parse_failed";
  const bounded =
    errorMessage.length > PARSE_ERROR_DETAIL_MAX ? `${errorMessage.slice(0, PARSE_ERROR_DETAIL_MAX)}…` : errorMessage;
  return `workflow_parse_failed: ${bounded}`;
}

export interface PreDispatchInput {
  /** Pre-dispatch run projection — the contract-version pin lives here. */
  state: RunState;
  /** The daemon's fold window `[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]`. */
  contractWindow: { min: number; max: number };
  /** Present iff the workflow row won't parse (KEY-present is the signal; the
   * value is the parser's message, empty when it had none). */
  graphParseError?: string;
  /** Present iff worktree provisioning threw — the caught error's message. */
  worktreeError?: string;
  /** Dispatches counted so far this `runOne` pass (the max_loops metric). */
  dispatches: number;
  /** The per-run dispatch ceiling in force this turn (override ⊕ default). */
  effectiveMaxLoops: number;
}

export interface PreDispatchPlan {
  /** The `fact.*` events to append (the driver commits them under OCC). At most
   * one run-parking fact (`run_paused` / `run_terminated`) — see the property. */
  facts: FactEvent[];
  /** Reserved slot in the plan vocabulary (SPEC §3.11): a pre-dispatch decision
   * carries no routing patch today, but the shape keeps the driver uniform. */
  routingPatch?: Record<string, unknown>;
  /** True when the plan ends the turn (the run parked or terminated). */
  terminal: boolean;
}

/** Decide the single pre-dispatch fact, if any. Pure: same input ⇒ same plan.
 * Precedence mirrors the driver's runtime discovery order (contract gate →
 * unparseable → worktree → max_loops); the driver invokes this at each decision
 * site with only that site's field live, so at most one arm ever fires per call. */
export function planPreDispatch(input: PreDispatchInput): PreDispatchPlan {
  const { state, contractWindow } = input;

  if (state.contractVersion < contractWindow.min || state.contractVersion > contractWindow.max) {
    return {
      terminal: true,
      facts: [
        {
          type: "fact.run_paused",
          payload: {
            reason: "engine_incompatible",
            pinnedVersion: state.contractVersion,
            supportedMin: contractWindow.min,
            supportedMax: contractWindow.max,
          },
        },
      ],
    };
  }

  if (input.graphParseError !== undefined) {
    return {
      terminal: true,
      facts: [
        {
          type: "fact.run_terminated",
          payload: { status: "errored", reason: "error", detail: workflowParseFailedDetail(input.graphParseError) },
        },
      ],
    };
  }

  if (input.worktreeError !== undefined) {
    return {
      terminal: true,
      facts: [
        {
          type: "fact.run_terminated",
          payload: {
            status: "errored",
            reason: "worktree_error",
            detail: `worktree_provision_failed: ${input.worktreeError}`,
          },
        },
      ],
    };
  }

  if (input.dispatches >= input.effectiveMaxLoops) {
    return {
      terminal: true,
      facts: [
        {
          type: "fact.run_paused",
          payload: { reason: "max_loops", currentLimit: input.effectiveMaxLoops, dispatches: input.dispatches },
        },
      ],
    };
  }

  return { terminal: false, facts: [] };
}

/** The leaked-handler structural halt (a handler that ignored its abort past
 * `maxMs + leakGrace`). Two facts — the diagnostic `handler_timeout_leaked`
 * then the terminal `run_terminated` — with `leakedAt` threaded as a value so
 * the planner stays clock-free. The driver still records the leak-budget hit. */
export function planLeakHalt(input: { nodeId: string; leakedAt: number }): PreDispatchPlan {
  return {
    terminal: true,
    facts: [
      { type: "fact.handler_timeout_leaked", payload: { nodeId: input.nodeId, leakedAt: input.leakedAt } },
      { type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: "handler_leaked" } },
    ],
  };
}
