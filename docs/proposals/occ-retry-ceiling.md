---
title: Bound the OCC retry loop
status: proposed
maturity: specified
last-reviewed: 2026-05-01
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

## What this does not commit to

- **Increasing the OCC retry rate or making the ceiling configurable per workflow.** Hard-coded; bumpable in source if real workloads brush against it.
- **Changing the OCC mechanism itself.** The version-counter + `appendFact` retry loop stays; only an inner counter is added.
- **Surfacing OCC metrics globally.** The store already records OCC conflicts in `Metrics`; this proposal is about run-level safety, not analytics.
