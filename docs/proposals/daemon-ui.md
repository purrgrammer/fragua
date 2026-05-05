---
title: Daemon UI — stats + feed
status: accepted
maturity: specified
last-reviewed: 2026-05-05
---

# Daemon UI — stats + feed

> Read-only operator surface backed by `daemon_events` (committed,
> populated on every daemon entrypoint / sweep / blob GC / leak /
> worktree provision) and the `daemon_lock` row. The data is on disk;
> this is purely a presentation surface.

## Nav context

A new `SYSTEM` section anchors infrastructure surfaces away from the
day-to-day operating + authoring flows. Final sidebar shape:

```
OPERATE   Watchtower · Runs · Schedules · Analytics
BUILD     Projects · Workflows · Skills · Agents
SYSTEM    Providers · Daemon ●  · Settings
```

Two enclosing changes ride alongside the Daemon page and are tracked
here for context:

- **Watchtower absorbs Inbox.** HITL items become a Watchtower lane /
  filter; the dedicated Inbox route retires. (Migration is light —
  same data, one fewer route.)
- **Settings** is a separate page tracked under its own work. The
  SYSTEM slot is reserved here so the section reads coherently.

The bottom-of-sidebar "● connected" pill retires once the Daemon row
carries the dot — same information, one fewer competing zone.

### Nav-row status dot

```tsx
<NavLink to="/daemon" className="flex items-center gap-2 …">
  <ServerIcon className="size-4 text-sw-muted" />
  <span className="flex-1">Daemon</span>
  <span aria-hidden className={cn(
    "size-1.5 rounded-full",
    status === "alive"    && "bg-sw-accent-success",
    status === "stale"    && "bg-sw-accent-thinking sw-pulse",
    status === "absent"   && "bg-sw-accent-error",
  )} />
</NavLink>
```

Dot derives from `daemon_lock` heartbeat age, same classification as the
stats card. Tooltip carries the verbose label (URL, last-seen).

## Page — `/daemon`

Single read-only page polling `/api/daemon/stats` every 5s. Layout:

```
┌─ Stats (3×2 bento) ────────────────────────────────┐
│ Running    Queued     Errored                      │
│ Uptime     DB size    Quarantined                  │
├─ Metadata (key/value) ─────────────────────────────┤
│ status / version / db path / concurrency / lock    │
├─ Activity chart        │ DB growth chart           │
│ events/bucket          │ db bytes/bucket           │
├─ System event log ─────────────────────────────────┤
│ DaemonFeed (system-only subset)                    │
└────────────────────────────────────────────────────┘
```

### Stats — six raw numbers, animated

| Cell | Source |
|---|---|
| **Running** | `runStateCounts.running` |
| **Queued** | `runStateCounts.queued` |
| **Errored** | sum of `failed` + all `paused_*` variants — "needs attention now" |
| **Uptime** | `now − daemon_lock.startedAt` |
| **DB size** | latest `daemon.db_size_sampled.bytes` (see below) |
| **Quarantined** | runs in `quarantined` status |

Numbers animate via numeric crossfade on update (≤200ms,
`ease-in-out`). Live counters that update faster than 5×/sec batch to
~200ms ticks before animating — the polling cadence keeps this safe by
default.

### Metadata block

Hairline-separated key/value rows (label `text-sw-xs uppercase
tracking-[0.06em] text-sw-muted`, value `text-sw-sm`):

- `status` — ● connected / ◌ stale / ✕ absent + URL (`http://…:6767`)
- `version` — harness X.Y.Z · schema N
- `db` — path · WAL · last vacuum
- `concurrency` — `max N · auto-dispatch on/off · auto-title on/off`
- `pid / lock` — `pid · acquired <ts>`

### Charts — reuse Analytics primitives

No sparklines. Both charts reuse the same bucketed-bar + total-header
shape as `RunsChart` / `TokensChart` / `SpendChart` in
`packages/web/src/routes/Analytics.tsx`:

- **Activity** — `events/bucket` from `daemon_events`. Single-series.
- **DB growth** — `bytes/bucket` from a new periodic sample (below).

Both honour the `(fromMs, toMs, bucket)` shape already wired through
`AnalyticsRequest`; the daemon page exposes a window selector reusing
`<WindowSelector>` with sensible defaults (last 24h).

### DB size — real periodic sample

The daemon emits `daemon.db_size_sampled` every 5 min carrying
`{ bytes, page_count, page_size }`. Cheap (`PRAGMA page_count` +
`PRAGMA page_size`) and lands as just another `daemon_events` row, so
the Activity chart and DB growth chart share the same query path.

5 min × 24h = 288 samples/day; the table cost is negligible, well
inside whatever retention `daemon_events` settles on.

### System event log — GlobalFeed pattern

A new `<DaemonFeed>` reuses the
`packages/web/src/components/GlobalFeed.tsx` machinery verbatim
(jotai atom + SSE stream + `AnimatePresence` + memo'd row + 1Hz time
leaf via `useNowSeconds`) but filtered to **system-only** event types:

- `fact.daemon_takeover`
- `fact.handler_timeout_leaked`
- `fact.provider_retry_attempted`
- `fact.run_quarantined`
- `fact.run_requeued_after_crash`
- `daemon.*` (started / stopped / sweep_completed / leak_detected /
  worktree_provisioned / blob_gc_completed / db_size_sampled)

Watchtower keeps the operator-action lifecycle (started / completed /
paused / awaiting input). The two surfaces stay distinct — Daemon
answers "is the executor healthy", Watchtower answers "what needs my
attention".

`KIND_META` for daemon-only types is added alongside the existing map;
the row layout (subgrid, mobile collapse, attention border) is reused
unchanged.

## Server surface

Two new endpoints under `/api/daemon`:

```
GET /api/daemon/stats
  → {
      daemon: { pid, hostname, startedAt, heartbeatAt,
                status: "alive" | "stale" | "absent",
                version: string, schemaVersion: number,
                httpUrl: string } | null,
      runs: { running: number, queued: number,
              errored: number, quarantined: number },
      db: { path: string, sizeBytes: number, lastVacuumTs: number | null,
            walMode: boolean },
      concurrency: { max: number, autoDispatch: boolean, autoTitle: boolean },
      window: { fromTs: number, toTs: number },          // last 24h default
      activityByBucket: Array<{ bucketTs: number, count: number }>,
      dbSizeByBucket: Array<{ bucketTs: number, bytes: number }>,
      // counters/latest preserved from earlier spec for the metadata block
      counts: { …, sweeps: { … }, leaks: number, worktree: { ok, fail },
                blob_gc: { sweeps, deleted } },
      latest: { leak, reaperTakeover, sweep },
    }

GET /api/daemon/events?sinceSeq=N&limit=200&type=…
  → { events: DaemonEventEnvelope[], nextSeq: number | null }
```

All read-only. SQL aggregations live in
`packages/server/src/store/analytics-queries.ts` (or a sibling
`daemon-queries.ts` if it grows) — same SQL-aggregation discipline as
the existing run analytics, no in-memory folding.

### SSE for live updates

`GET /api/daemon/events/stream` mirroring the GlobalFeed SSE pattern.
`daemon_events.seq` is monotonic so SSE cursoring is trivial. Land
this with the feed (not deferred) since DaemonFeed reuses the
existing SSE plumbing — adding a typed channel is cheaper than the
disclosure-toggle dance.

## Why now

The data is already on disk for everything except DB size, and
`daemon.db_size_sampled` is a five-line addition. Operators currently
have no visibility into "did the daemon crash overnight?" without
reading SQLite by hand.

## What this does not commit to

- Editing daemon state from the UI. Read-only. Restart / stop / kill is out of scope; operators use the CLI.
- Multi-daemon visibility. Single-daemon assumption — `daemon_lock` enforces it.
- Per-event drill-down beyond the JSON payload. No "explain" endpoints.
- Historical retention beyond what `daemon_events` keeps.
- Settings page content. Sidebar slot is reserved; the page itself is separate work.
- Inbox-into-Watchtower migration logic. Sidebar removes the entry; Watchtower lane work is its own commit.

## Open questions

- **Window length default.** 24h for the charts; expose `?window=` later if operators want 1h / 7d.
- **Alert thresholds.** Hard-coded sensible defaults (leak rate > 5/h, worktree failure > 10%) ship first; config-driven once operators have opinions.
- **DB size sample cadence.** 5 min default. Tune down to 1 min if the chart looks too coarse on a busy day; up to 15 min if `daemon_events` retention pressure shows up.

## Implementation sketch

Four commits, in order — each independently shippable:

1. **`[daemon,store]` `db_size_sampled` event** — periodic sampler in the supervisor; event type + payload schema; tests.
2. **`[server,store]` daemon stats query + `/api/daemon/stats` route** — `daemon-queries.ts` gains `getDaemonStats(window)`; route plumbs it through. Reuses `currentDaemonLock` + `runStateCounts`.
3. **`[web]` sidebar reorg + Daemon route + stats / metadata / charts** — SYSTEM section, Inbox→Watchtower nav-only stub, Daemon nav entry with status dot, route polling the stats endpoint. No feed yet; placeholder section.
4. **`[server,store,web]` daemon event feed (+ SSE)** — `/api/daemon/events` paginated route + SSE stream + `<DaemonFeed>` reusing GlobalFeed machinery.

#3 alone gives operators ~80% of the value of the full plan.
