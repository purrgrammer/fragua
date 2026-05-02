---
title: Bound the OCC retry loop
summary: "Bounded OCC retry loop with structured occ_exhausted halt"
status: shipped
maturity: specified
last-reviewed: 2026-05-02
---

# Bound the OCC retry loop

> `runOneInner` in `packages/daemon/src/executor.ts` retries on
> `ConcurrencyError` indefinitely (`if (!ok) continue` after every
> `tryAppendFact`). The `abort_loop_ceiling` (5 consecutive aborts)
> covers handler-level pathologies; an OCC-conflict storm has no
> analogous bound. A pathological feedback loop between supervisor
> trips and fact appends could spin without converging.

## Shape

A new bound, defaulting to **50 OCC conflicts per turn**. On exceedance:

1. `fact.run_halted { reason: "occ_exhausted", detail: "<N> consecutive OCC conflicts on node <id>" }` — additive halt reason.
2. An observability event `occ_conflict_warning` fires once at 80 % of the ceiling so the trend is visible before the halt lands.

Defaults are conservative: 50 is several orders of magnitude above any normal contention pattern (one daemon writes facts; web writes only intents). Hitting the ceiling means a real bug — supervisor wedged, unbounded fold, foreign-daemon attempt — and the halt is preferable to a silent wedge.

## Why this is load-bearing

Real bugs in concurrency-control machinery look like infinite loops in production. The current code can spin forever on a degenerate input; the leak budget catches handler-side wedges but not store-side ones. A small ceiling closes the gap.

The fix is < 30 lines: an integer counter, a comparison, an additive halt reason. The proposal is to land it before someone hits the bug rather than after.

## Resolved decisions (shipped 2026-05-02 in `fed248e`)

The 5 brainstorm questions all settled in implementation:

- **Counter scope:** per-attempt-batch — resets on the first successful `appendFact`, so "consecutive ConcurrencyError" means "this append is being held off right now," not "this run has ever seen contention."
- **Counter state:** in-memory in `runOneInner`'s closure. Daemon restart re-enters with a fresh count; matches the bug shape since a wedged supervisor doesn't survive a process restart.
- **`tryAppendFact` failure modes:** confirmed `ok=false` is exclusively `ConcurrencyError`. Every other failure throws and propagates to `runOne`'s safety net, which writes its own `fact.run_halted { reason: "error" }`. The OCC counter only attributes to OCC.
- **Halt detail:** structured. `fact.run_halted` gained an optional `occContext: { count, nodeId, iteration, lastVersion, attemptedFactType }` field, populated when `reason === "occ_exhausted"`.
- **Warning-event scope:** per-`(runId, nodeId, iteration)` via the in-memory `occWarned` flag. Reset alongside the counter on first success.

Tighter than the original 50: **ceiling=3, warn-at=2**, with exponential backoff (1ms → 2ms → cap 16ms) between retries. Real bugs halt in milliseconds; legit transient contention resolves on the first retry without firing the warn. Three new observability events fire on the path: `occ_conflict_warning` (at 80% of ceiling), `occ_conflict_resolved` (on success after retries — operators can `WHERE type='occ_conflict_resolved'` for near-miss analytics), and the structured `fact.run_halted { reason: "occ_exhausted" }` at the ceiling.

## What this does not commit to

- **Increasing the OCC retry rate or making the ceiling configurable per workflow.** Hard-coded; bumpable in source if real workloads brush against it.
- **Changing the OCC mechanism itself.** The version-counter + `appendFact` retry loop stays; only an inner counter is added.
- **Surfacing OCC metrics globally.** The store already records OCC conflicts in `Metrics`; this proposal is about run-level safety, not analytics.
