// Outcome: the result returned by every handler. See docs/SPEC.md §3.7.

import { type Static, Type } from "@sinclair/typebox";

export type OutcomeStatus = "success" | "partial_success" | "fail" | "retry" | "skipped";

export type ContextValue = string | number | boolean | null | ContextValue[] | { [k: string]: ContextValue };

/** Runtime schema kept for checkpoint validation; derived Outcome type matches. */
export const OutcomeSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("success"),
      Type.Literal("partial_success"),
      Type.Literal("fail"),
      Type.Literal("retry"),
      Type.Literal("skipped"),
    ]),
    context_updates: Type.Record(Type.String(), Type.Unsafe<ContextValue>(Type.Any())),
    preferred_label: Type.String(),
    suggested_next_ids: Type.Array(Type.String()),
    notes: Type.String(),
    failure_reason: Type.Optional(Type.String()),
    /** Bypass edge selection entirely; jump to this node next. */
    next_node_override: Type.Optional(Type.String()),
    /**
     * When true, an unrecovered failure must NOT trigger a goal-gate retry
     * via `graph.attrs.retry_target`. Used for intentional aborts (e.g. a
     * node can't proceed because the task target is missing) so we don't
     * burn tokens re-running the run after an explicit stop.
     */
    non_retryable: Type.Optional(Type.Boolean()),
    /**
     * Set by the codergen agent boundary when an LLM provider returns a
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
    /**
     * Ordered log of `context_set` tool calls the agent made this turn,
     * captured by the agent backend off `swarmContext.contextWrites`.
     * Each entry mirrors a single `routingDelta` write; handler-bridge
     * merges them into the result's `routingDelta` and forwards the log
     * as `HandlerResult.transition.contextWriteLog` so result-to-facts
     * can emit one `fact.context_written` per write. Last-write-wins
     * per key (the backend already collapses duplicates), so this list
     * is at most one entry per unique key per turn. See
     * docs/proposals/codergen-context-output-tools.md §2.1.
     */
    contextWrites: Type.Optional(
      Type.Array(
        Type.Object({
          key: Type.String(),
          value: Type.Unsafe<string | number | boolean | null>(Type.Any()),
          prevValue: Type.Optional(Type.Unsafe<string | number | boolean | null>(Type.Any())),
        }),
      ),
    ),
    /**
     * Last `emit_output` tool call's payload, captured by the agent
     * backend off `swarmContext.pendingOutput`. When set, handler-bridge
     * writes `JSON.stringify(data)` as the node's `output` artifact
     * (overriding the prose-fallback path) and flags
     * `HandlerResult.transition.outputEmitted` so result-to-facts can
     * emit `fact.output_emitted`. When unset AND the node declared
     * `output_schema`, the bridge downgrades the outcome to `fail`. See
     * docs/proposals/codergen-context-output-tools.md §2.2 / §3.
     */
    pendingOutput: Type.Optional(
      Type.Object({
        data: Type.Unknown(),
      }),
    ),
  },
  { $id: "Outcome" },
);

export type Outcome = Static<typeof OutcomeSchema>;

/** Convenience factory for successful outcomes. */
export function ok(partial: Partial<Outcome> = {}): Outcome {
  return {
    status: "success",
    context_updates: {},
    preferred_label: "",
    suggested_next_ids: [],
    notes: "",
    ...partial,
  };
}

/** Convenience factory for failing outcomes. */
export function fail(failure_reason: string, partial: Partial<Outcome> = {}): Outcome {
  return {
    status: "fail",
    context_updates: {},
    preferred_label: "",
    suggested_next_ids: [],
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
    context_updates: {},
    preferred_label: "",
    suggested_next_ids: [],
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
