---
title: Analytics — follow-up roadmap
status: proposed
maturity: sketch
last-reviewed: 2026-05-01
---

# Analytics — follow-up roadmap

> A catalogue of stats/charts cut from v1, each sized to a small
> follow-up slice. Not a single decided spec; pick from the menu when
> the appetite arrives.

Stats / charts intentionally cut from v1. Each one fits the existing
`/analytics` endpoint shape (one more `getXByBucket` query + one more
chart card) so they should land in small slices.

## Operational health (highest leverage)

### Duration p50 / p95 trend
Line or stacked-bar over time. p50 + p95 per bucket via SQL window
function on `(updated_at - enqueued_at)` for terminal runs. Cost
without latency is half the picture; this surfaces "spend looks the
same but runs are 3× slower" regressions.

### Retry rate
Per-bucket count of `fact.node_started` events where the same `nodeId`
appears more than once in a run. Correlates with provider flakiness;
cheap proxy for "the daemon is fighting itself."

### Quarantine rate
KPI tile (5th tile in the strip, or replace cache hit rate when
quarantine is non-zero). `COUNT(*) WHERE status = 'quarantined' /
COUNT(*)`. Spikes ⇒ schema drift / handler bugs / loop budget exhaust.

### Concurrency over time
Peak concurrent `running` runs per bucket. Already derivable from
`run_state` history if we keep the `started_at`/`updated_at` deltas;
otherwise needs a dedicated `fact.run_started` / terminal-fact pair
scan with a sweep-line algorithm. Capacity planning + "did I get
throttled" answer.

### HITL stats
Two numbers: count of pauses (`COUNT(*) WHERE status = 'paused_hitl'`
in window) and median time-to-resume (`fact.run_resumed.ts -
fact.run_paused_hitl.ts`). Only worth surfacing if HITL is actually
used in this install.

## Cost-side

### Cost per run trend
`SUM(total_cost_usd) / COUNT(*)` per bucket. Controls for volume so
"each run is getting more expensive" jumps out even when total spend
is flat. Could replace one of the bar charts or live as a tile.

### Provider breakdown
Same shape as model donut, but grouped by `metrics.models.<key>` →
provider mapping (the model id has a stable provider prefix in most
cases, or look it up via the registry). Pricing differs across
providers so this is a different decision-making angle than model.

## Filters

**Per-project filter — shipped.** A project `<Select>` sits next to the
window selector and threads `cwd` through `/analytics` and
`/analytics/runs` (and the drill-down drawer) so every chart + slice
stays scoped to one project root. Empty selection ("All projects")
aggregates across every cwd, matching the historical behaviour.

### Workflow / provider / model filter
Still cut. The original "filters or drill-down" call went drill-down
and that's held up. Revisit per-dimension filters only if a clear need
shows up; the wire shape on `/analytics/runs` already accepts
`workflow` / `halt` / `model` so the work would be UI-side.

## Open design call

### Chart update easing
Recharts uses one easing for both entry and data-update. We picked
`ease-out` because first-paint is more visible than the 30s tick.
If the tick animation feels wrong once we're using the page daily,
revisit — `ease-in-out` is technically right for "morph in place."

## Performance backstop (probably not needed)

If `All time` over millions of rows ever feels slow:

- Materialized rollup table (`run_rollup_daily`) refreshed by a
  daemon timer, indexed on `(bucket_day)`. Routes hit the rollup
  for `last30+` and the live `run_state` for `today / last7`.
- Don't add request-time caching — the cache miss + invalidation
  story is worse than just running the query.

## Follow-up tied to v1

- Make sure `swarm serve` restart picks up the routes (it doesn't
  hot-reload; `.swarm/serve.json` was 404'ing on `/api/analytics`
  during testing).
- Add a server route test for `GET /analytics` end-to-end (unit
  tests cover the SQL queries, but the route shape + zero-fill
  isn't tested directly).
