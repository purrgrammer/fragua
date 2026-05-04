---
title: Payload-cap pressure signal
status: proposed
maturity: sketch
last-reviewed: 2026-05-04
rationale: Introspect run 01kqrz3n81vnss9knx flagged 227 events (~0.44% of 7d traffic) within 20% of the 4 KB events.payload cap; max observed was 4,091 B — 5 B from the hard CHECK limit. One slightly-larger payload halts a run. We have no visibility into this until the wall is hit.
---

# Payload-cap pressure signal

> Status: sketch. Open questions below need answers before this is implementable.

## Problem

The `events` table has a CHECK constraint capping `payload` at 4 KB
(`length(payload) <= 4096`). A single oversize fact halts the run that
emits it — no graceful degradation, no warning. Today the pressure is
only visible by hand-querying the store. Introspect 2026-05-04 found
0.44% of last-week's traffic within 20% of the cap and a max payload
**5 bytes** below the hard limit. The next slightly-larger payload
will halt a run with no diagnostic context beyond the SQLite error.

The same family of pressure exists for `run_state.routing` (8 KB cap)
and would benefit from the same signal.

## Goal

Surface payload-cap pressure as a first-class operational signal so
operators see the wall coming instead of hitting it. Specifically:

1. **A daemon-emitted signal** when payload sizes cross a threshold
   percentile of the cap, captured in the `daemon_events` table so it
   participates in the same supervisor-trace surface as
   `daemon.sweep_completed`.
2. **An analytics tile** that surfaces the signal: max payload size,
   near-cap event count, and recent runs implicated. Threshold lives
   alongside the existing `daemon.sweep_completed` pane.
3. **A run-detail affordance** when a specific run produced near-cap
   events, so a user landing on a halted run sees "this run sat at
   X% of the payload cap" without having to grep events.

Non-goal: auto-truncate or refuse oversize writes. That's a different
proposal (graceful-degradation) and conflicts with the event-store
invariant "events are truth" — silent truncation would lie.

## Shape (sketch)

### Daemon side

Two designs on the table; pick one in resolution:

**A. New event type `daemon.payload_pressure`**

```ts
type DaemonEvent =
  | …existing…
  | {
      type: "daemon.payload_pressure";
      payload: {
        windowMs: number;            // sweep window covered
        capBytes: number;            // 4096 (events) or 8192 (routing)
        kind: "events" | "routing";
        peakBytes: number;
        nearMissCount: number;       // events >= 0.8 * cap
        topRunIds: string[];         // up to 5 runs implicated
      };
    };
```

Emitted by the existing supervisor sweep tick when the window's max
payload crosses a threshold (default 80% of cap). Independent of
`daemon.sweep_completed` so the two can be filtered separately.

**B. Extend `daemon.sweep_completed.payload`**

Add `payloadPressure: { eventsPeak, eventsNearMiss, routingPeak,
routingNearMiss }` to the existing sweep-completed payload. No new
event type; pressure is part of the regular sweep telemetry.

Trade-off: (A) is louder and easier to filter; (B) is one less type
to maintain. (A) follows the convention of "important things get
their own event"; (B) follows "extend before adding."

### Web side

Analytics page grows a "Payload pressure" tile:

```
┌─ Payload pressure (7d) ──────────────────┐
│ events:   max 4,091 B / 4,096 B  (99.9%) │
│           227 near-cap events            │
│ routing:  max 4,465 B / 8,192 B  (54%)   │
│           0 near-cap rows                │
│ Top runs: 01kqr31fc4qbrv5z, …            │
└──────────────────────────────────────────┘
```

RunDetail grows a small inline warning above the conversation when
the run produced any near-cap event:

```
⚠ This run produced 3 events within 20% of the payload cap (peak
  4,012 B / 4,096 B). One larger payload would halt the run.
```

### Threshold

Default 80% of cap (3,277 B for events, 6,554 B for routing). Tunable
via daemon config (`payloadPressure.thresholdPct`) so noisy projects
can dial it down.

## What this gives

- **Forewarning**: operators see drift toward the cap weeks before
  the first hit instead of finding out via a halt.
- **Cause attribution**: `topRunIds` ties pressure back to the
  workflow shape responsible (long messages, large artifact refs).
- **Calibration data**: tells us whether the cap is set right. If
  pressure is chronic, the cap is too tight; if pressure is rare,
  the cap is doing its job.

## Open questions

- **(A) vs (B)**: separate `daemon.payload_pressure` event vs
  extending `daemon.sweep_completed`? AGENTS.md's same-PR rule grows
  with (A) — every analyst surface that lists daemon-event types
  needs an update.
- **Threshold trigger**: instantaneous (every oversize event emits a
  pressure signal) vs aggregated (sweep emits per-window summary)?
  Aggregated is cheaper but loses precision; instantaneous is
  precise but spammy. Sketch above assumes aggregated.
- **What counts as "near-cap" for routing?** Routing isn't event-
  per-write — it's overwritten on each `run_state` projection. A
  near-miss there means the *current* state is dangerous, not that
  *one write* was. The signal needs to mean "this run's routing is
  within X% of cap right now," not "this run wrote a near-cap
  routing N times."
- **Today's behaviour when the cap is hit**: verify experimentally.
  Does the run abort with a clear `fact.run_halted{reason: …}`, or
  does the SQLite error bubble up as a generic
  `aborted_exit`? If the latter, this proposal becomes more urgent
  — the user-visible failure mode is bad even before pressure
  signaling.
- **Retention recursion**: `daemon.payload_pressure` events themselves
  cost payload bytes. Is the signal small enough that it can't
  contribute to its own near-miss? Sketch above is well under 1 KB
  even with 5 `topRunIds`, so probably yes — but worth pinning down
  as a budget rule.
- **UI surface placement**: tile on `/analytics`, banner on a run
  page, both, or new dedicated `/operations` view? Existing analytics
  page is the path of least resistance; a dedicated page is the
  scalable answer once the family of operational signals grows.
- **Action when pressure is acute**: warn-only is the safe answer.
  But should the supervisor refuse to dispatch new nodes for a
  pressured run? The deterministic-execution invariant probably
  rules that out — pressure is an emergent property; the run can't
  know it's about to overflow until it does. Warn-only it is.

## What this depends on

- The existing `daemon_events` table (already schema-stable per
  ARCHITECTURE.md §3).
- The `/analytics` page and its query factory pattern (already
  shipped).
- Nothing in the contract layer changes — this is observability,
  not capability.

## What this enables

- A future graceful-degradation proposal (auto-summarise, split
  payload across N events, …) becomes evaluable: "do we see X% of
  runs hitting pressure?" answers the prioritisation question.
- A drift-lint rule that asserts `daemon.payload_pressure` is wired
  into the analytics surface — caught in the same family of
  same-PR-discipline this audit kept finding gaps in.
