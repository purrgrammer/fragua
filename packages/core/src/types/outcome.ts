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
