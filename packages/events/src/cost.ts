// Cost aggregation for the `cost.recorded` event family.
//
// The canonical shape of a `cost.recorded` event's `data` payload is:
//   { cost_usd: number, input_tokens: number, output_tokens: number,
//     provider?: string, model?: string }
// (see the LLM adapter + ConsoleSink for emitters/consumers).
//
// Both the CLI (ConsoleSink.totals) and the REST server (deriveSummary /
// deriveDetail in `@swarm/server`) need to fold a stream of these events
// into a single running total. We factor the arithmetic into one tiny
// pure module so neither side reinvents it — and so a future change to
// the payload shape has exactly one update site.

import type { Event } from "@swarm/core";

/** Accumulated totals across some set of `cost.recorded` events. */
export interface CostTotals {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  /** Number of `cost.recorded` events folded in. */
  calls: number;
}

/** Zero value for a fresh totals accumulator. */
export function emptyCostTotals(): CostTotals {
  return { cost_usd: 0, input_tokens: 0, output_tokens: 0, calls: 0 };
}

/**
 * Fold a single event into the given totals **in place**. Non-cost events
 * are a no-op. Missing numeric fields coerce to 0 — the event writers
 * occasionally omit a field when the underlying provider doesn't report
 * it, and we'd rather keep summing than throw.
 *
 * Returns the same totals object for fluent call chains.
 */
export function accumulateCost(totals: CostTotals, event: Event): CostTotals {
  if (event.type !== "cost.recorded") return totals;
  const d = event.data as {
    cost_usd?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  totals.cost_usd += Number(d.cost_usd ?? 0);
  totals.input_tokens += Number(d.input_tokens ?? 0);
  totals.output_tokens += Number(d.output_tokens ?? 0);
  totals.calls += 1;
  return totals;
}

/** Pure convenience: fold an event iterable into a fresh totals value. */
export function aggregateCost(events: Iterable<Event>): CostTotals {
  const totals = emptyCostTotals();
  for (const ev of events) accumulateCost(totals, ev);
  return totals;
}
