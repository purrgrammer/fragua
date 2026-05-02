---
title: Bound the OCC retry loop
status: proposed
maturity: designed
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

## Open questions

These surfaced in the 2026-05-02 brainstorm and are unresolved.

- **What counts as "a turn" for the counter?** The Shape section says "50 OCC conflicts per turn" but `runOneInner`'s `if (!ok) continue` re-runs the whole inner block on every conflict. Three candidates: (a) reset on successful append (per-attempt-batch — matches the bug shape "the inner loop is spinning on the same fact append"), (b) reset on new node entry (per-node-iteration), or (c) cumulative across the run. Pick before implementation.

- **Counter state — in-memory or in `routing`?** In-memory (executor closure) keeps the contention surface clean and the bug shape ("supervisor wedged this turn") doesn't survive a daemon restart anyway. Persisting in `routing.internal.occ_count.<nodeId>` would survive restart but adds a write to the surface that's already broken. Lean in-memory; pin it.

- **Audit `tryAppendFact` failure modes.** The proposal assumes `ok=false` is exclusively `ConcurrencyError` (version-mismatch). Need to verify that `SQLITE_BUSY`, CHECK-constraint trips, and schema-drift errors don't also surface as `ok=false` — otherwise we'd halt non-OCC failures with `reason:"occ_exhausted"`, mis-attributing the cause. Plan-time audit, before implementation.

- **Halt detail shape.** `detail: "<N> consecutive OCC conflicts on node <id>"` is a string. For post-mortem we want at least `{ count, nodeId, iteration, lastVersion, attemptedFactType }` — structured and queryable. Mirror the shape `fact.run_quarantined { orphanedIntents }` already uses for structured halt-detail.

- **Warning-event scope.** `occ_conflict_warning` fires once at 80% of the ceiling (40 conflicts). Per what scope key — `(runId, nodeId, iteration)`? If a turn flirts with 40, succeeds, then a later turn conflicts again — fire twice (per-iteration) or once-per-run? Per-`(runId, nodeId, iteration)` is the only sane key but worth pinning.

## What this does not commit to

- **Increasing the OCC retry rate or making the ceiling configurable per workflow.** Hard-coded; bumpable in source if real workloads brush against it.
- **Changing the OCC mechanism itself.** The version-counter + `appendFact` retry loop stays; only an inner counter is added.
- **Surfacing OCC metrics globally.** The store already records OCC conflicts in `Metrics`; this proposal is about run-level safety, not analytics.
