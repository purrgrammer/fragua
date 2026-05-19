// Outcome: the result returned by every handler. See docs/SPEC.md §3.6.

import { type Static, Type } from "@sinclair/typebox";
import type { HaltReason } from "@swarm/types";

export type OutcomeStatus = "success" | "fail" | "retry";

export type ContextValue = string | number | boolean | null | ContextValue[] | { [k: string]: ContextValue };

/** Runtime schema kept for checkpoint validation; derived Outcome type matches. */
export const OutcomeSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("success"), Type.Literal("fail"), Type.Literal("retry")]),
    notes: Type.String(),
    failure_reason: Type.Optional(Type.String()),
    /**
     * When true, an unrecovered failure must NOT trigger a goal-gate retry
     * via `graph.attrs.retry_target`. Used for intentional aborts (e.g. a
     * node can't proceed because the task target is missing) so we don't
     * burn tokens re-running the run after an explicit stop.
     */
    non_retryable: Type.Optional(Type.Boolean()),
    /**
     * Set by the llm agent boundary when an LLM provider returns a
     * transport error mid-stream (HTTP 402/429/5xx, pre-response network
     * reset). Routes the run to `paused` (with `fact.run_paused` reason
     * `provider_error` or `payment_required`) instead of the normal
     * fail → halt path, so the operator can `intent.resume` after fixing
     * the underlying issue. `httpStatus` is `null` for failures that
     * never reached the provider's response (DNS/TCP).
     */
    provider_error: Type.Optional(
      Type.Object({
        httpStatus: Type.Union([Type.Number(), Type.Null()]),
        provider: Type.String(),
        errorMessage: Type.String(),
        /** Provider-supplied `Retry-After` (ms). Forwarded to the daemon
         * via the pause_provider HandlerResult; absent → daemon falls
         * back to its own backoff. */
        retryAfterMs: Type.Optional(Type.Number()),
      }),
    ),
    /** Set by the llm agent boundary when the LLM exited the node
     * via the synthesised `route` tool (see
     * docs/proposals/llm-routing.md D2). The handler-bridge forwards
     * this onto `HandlerResult.transition.route`, which the daemon
     * persists into `fact.node_completed.payload.route`. Absent on
     * non-routing nodes. */
    route: Type.Optional(Type.String()),
    /** Set by the llm agent boundary when a routing-node turn ended
     * with no isolated `route` tool call (or the call was paired with
     * other tool calls). The handler-bridge converts this into a
     * `HandlerResult.halt` with this reason; the daemon emits
     * `fact.run_halted` verbatim. Never constructed by ordinary handlers
     * — use `failHalt()`. */
    halt_reason: Type.Optional(
      Type.Union([
        Type.Literal("budget"),
        Type.Literal("schema_drift"),
        Type.Literal("error"),
        Type.Literal("aborted_exit"),
        Type.Literal("occ_exhausted"),
        Type.Literal("timeout_exhausted"),
        Type.Literal("route_not_picked"),
        Type.Literal("route_call_not_isolated"),
        Type.Literal("edge_no_match"),
      ]),
    ),
  },
  { $id: "Outcome" },
);

export type Outcome = Static<typeof OutcomeSchema>;

/** Convenience factory for successful outcomes. */
export function ok(partial: Partial<Outcome> = {}): Outcome {
  return {
    status: "success",
    notes: "",
    ...partial,
  };
}

/** Convenience factory for failing outcomes. */
export function fail(failure_reason: string, partial: Partial<Outcome> = {}): Outcome {
  return {
    status: "fail",
    notes: "",
    failure_reason,
    ...partial,
  };
}

/**
 * Mark an outcome as a recoverable provider transport error. Handler-bridge
 * sees `provider_error` and converts the outcome into
 * `HandlerResult.kind = "pause_provider"` instead of routing fail through
 * the normal halt path. Status stays "fail" so any downstream code that
 * checks status alone still treats this as not-success.
 */
export function failProvider(
  errorMessage: string,
  detail: { httpStatus: number | null; provider: string; retryAfterMs?: number },
): Outcome {
  return {
    status: "fail",
    notes: errorMessage,
    failure_reason: errorMessage,
    non_retryable: true,
    provider_error: {
      httpStatus: detail.httpStatus,
      provider: detail.provider,
      errorMessage,
      ...(detail.retryAfterMs !== undefined ? { retryAfterMs: detail.retryAfterMs } : {}),
    },
  };
}

/**
 * Mark an outcome as a hard halt with a named HaltReason. The llm
 * agent boundary uses this for routing-node failure modes
 * (`route_not_picked`, `route_call_not_isolated`) so the handler-bridge
 * converts the outcome into `HandlerResult { kind: "halt", reason }`
 * instead of a transition. Status stays "fail" so any downstream code
 * that checks status alone still treats this as not-success;
 * `non_retryable: true` keeps the goal-gate retry machinery from
 * relaunching the run after a structural failure.
 */
export function failHalt(reason: HaltReason, message: string): Outcome {
  return {
    status: "fail",
    notes: message,
    failure_reason: message,
    non_retryable: true,
    halt_reason: reason,
  };
}
