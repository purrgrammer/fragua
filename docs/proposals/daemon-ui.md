---
title: Daemon UI — stats + feed
status: accepted
maturity: specified
last-reviewed: 2026-05-01
---

# Daemon UI — stats + feed

> **Status:** READY for stats. Feed is a follow-up once stats land.
> Backed by `daemon_events` table (committed, fully populated by the
> daemon today) and the existing `daemon_lock` row.

## What lands

### Stats card on a new `/infrastructure` route

A single page summarising daemon health. Read-only. Polls `/api/daemon/stats` every 5s.

**Live state** (`daemon_lock` + `runStateCounts`):
- Daemon status: ✅ running (pid, hostname, started\_at, age) / ⚠️ stale heartbeat (last seen Xs ago) / ❌ no daemon
- Heartbeat age (seconds since last update)
- In-flight runs (`status='running'` count) and queue depth (`status='queued'` count)

**Recent activity** (aggregations over `daemon_events`, last 24h):
- Process restarts: count of `daemon.started` events; each with reason of the *prior* `daemon.stopped` event
- Reaper takeovers: count of `daemon.reaper_took_over`; sparkline by hour
- Sweep summary: total `requeued` / `quarantined` across all `daemon.sweep_completed` events
- Leak detections: count + most recent `(runId, nodeId)` from `daemon.leak_detected`
- Worktree provisioning: success rate (`ok=true` / total) from `daemon.worktree_provisioned`
- Blob GC: total deleted across `daemon.blob_gc_completed`; last sweep timestamp

**Right column — alerts** (computed in the route handler, cheap):
- 🔴 No `daemon.started` in last 24h → "daemon hasn't run today"
- 🔴 Reaper takeover in last 5m → "recent crash"
- 🟡 Leak rate above N/h → "handlers are leaking"
- 🟡 Worktree failure rate > 10% → "provisioning unhealthy"

### Feed (follow-up)

Chronological list of `daemon_events`, virtualised, with a type filter. Reuses the timeline component from `Home.tsx` with a different event source. Click a run-scoped event (leak, worktree) to jump to the run's detail page.

## Server surface

Two new endpoints, both under `/api/daemon`:

```
GET /api/daemon/stats
  → {
      daemon: { pid, hostname, startedAt, heartbeatAt, status: "alive" | "stale" | "absent" } | null,
      runs: { running: number, queued: number },
      window: { fromTs: number, toTs: number },          // last 24h
      counts: {
        starts: number,
        stops_by_reason: Record<"clean"|"leak_limit"|"signal"|"error", number>,
        reaper_takeovers: number,
        sweeps: { total: number, requeued: number, quarantined: number },
        leaks: number,
        worktree: { ok: number, fail: number },
        blob_gc: { sweeps: number, deleted: number },
      },
      latest: {
        leak: { runId, nodeId, ts } | null,
        reaperTakeover: { priorPid, priorHostname, ts, staleForMs } | null,
        sweep: { ts, requeued, quarantined } | null,
      },
    }

GET /api/daemon/events?sinceSeq=N&limit=200&type=daemon.leak_detected
  → { events: DaemonEventEnvelope[], nextSeq: number | null }
  // Sense as the existing per-run /events endpoints.
```

All read-only. Aggregations go in `packages/server/src/store/analytics-queries.ts` next to the existing run analytics — same SQL-aggregation discipline (no in-memory folding).

### SSE for live updates (deferred)

`GET /api/daemon/events/stream` mirroring the home-feed SSE pattern. Defer until the polling page proves the data shape is right. The `daemon_events.seq` is already monotonic so SSE cursoring is trivial when we want it.

## UI surface

`packages/web/src/routes/Infrastructure.tsx`. Top-level nav entry next to `/analytics`.

**Layout:** stats card on top (3-column grid: live state | counts | alerts). Feed below as a separate section, initially hidden behind a "View daemon event log" disclosure (until the feed lands as its own pane).

**Tokens:** plain Swarm tokens — `bg-sw-surface`, `text-sw-muted`, hairline borders, no decoration. Status uses semantic colour (`text-sw-success` / `text-sw-warning` / `text-sw-error`) sparingly, reserved for the alerts column. Numbers in monospace.

## Why now

The data is already on disk. Five commits landed `daemon_events` and the events fire on every entrypoint, sweep, blob GC, leak, and worktree provision. Right now the only consumer is tests — operators have no visibility into "did the daemon crash overnight?" without reading SQLite by hand.

Stats first (no SSE, no virtualisation, no run-jump nav) is a one-day surface. Feed is real engineering effort — virtualisation, filter UI, run-jump, SSE — and worth deferring until we know which event types operators actually look at.

## What this does not commit to

- Editing daemon state from the UI. Read-only. Restart / stop / kill is out of scope; operators use the CLI.
- Multi-daemon visibility. Single-daemon assumption — `daemon_lock` enforces it. If we later allow multi-daemon, this page becomes per-daemon.
- Per-event drill-down beyond what the payload already carries. The detail view is just the JSON payload formatted for readability; no new endpoints to "explain" an event.
- Historical retention beyond what `daemon_events` keeps. If we add retention/GC for `daemon_events` later, this page will reflect whatever's queryable.

## Open questions

- **Window length for stats.** 24h is arbitrary. 1h is finer-grained for "is something going wrong RIGHT NOW"; 7d is more useful for "are we trending bad." Could expose as a query param (`?window=1h|24h|7d`). Default 24h, expose param later.
- **Alert thresholds.** Hard-coded numerical limits (leak rate > 5/h, worktree failure > 10%) are placeholders. Likely needs to be config-driven once operators have opinions; ship with hard-coded sensible defaults first.
- **Feed pagination cursor.** `seq`-based forward cursor matches the existing `/events` pattern; no decision needed unless we want timestamp-based filtering ("show me everything after 2026-04-01"), which is a separate query path.

## Implementation sketch

Three commits, in order:

1. **`[server,store]` daemon stats query + `/api/daemon/stats` route** — analytics-queries.ts gains `getDaemonStats(window)`; route plumbs it through. Reuses existing `currentDaemonLock` + `runStateCounts`.
2. **`[web]` Infrastructure route + stats card** — new route, polling, layout. Nav entry.
3. **`[server,store,web]` daemon event feed** — `/api/daemon/events` paginated route + Infrastructure feed pane. SSE optional, defer if not needed.

Each commit is independently shippable; #2 alone gives operators 80% of the value of the full plan.
