---
title: Harness
status: proposed
maturity: designed
last-reviewed: 2026-05-03
---

# Harness

> Architectural commitment point. After this lands, the harness is the
> canonical entry point and the per-cwd `swarm daemon` mode becomes a
> CI/power-user primitive. Downstream proposals
> ([migration](./migration.md), [token auth](./token-auth.md),
> [project-config extensions](./project-config-extensions.md),
> [project tools, hooks, skills](./project-extensions.md),
> [file server](./file-server.md)) all depend on this.

## Shape

`swarm harness` supervises the daemon and HTTP server as a single
foreground process. `swarm daemon --db <path>` and `swarm serve --db
<path>` remain as primitives for CI and power users.

Discovery is via the DB itself. `~/.swarm/swarm.db` is the only
filesystem rendezvous; everything else lives in rows.

`daemon_lock` (singleton, CHECK id=1) gains URL columns:

```sql
ALTER TABLE daemon_lock ADD COLUMN http_url TEXT;
ALTER TABLE daemon_lock ADD COLUMN http_port INTEGER;
ALTER TABLE daemon_lock ADD COLUMN harness_version TEXT;
```

The harness writes its URL on startup. CLIs (`swarm run`, `swarm
projects ls`, ...) open `~/.swarm/swarm.db` read-only and read the
lock row. Concurrent SQLite readers are fine; the cost is one
`open()` + one `SELECT` per CLI invocation.

CI primitives write their own DB's `daemon_lock` and discover
through that same DB.

No JSON discovery files. The only filesystem state outside the DB
is the DB itself, the blobs directory, and per-run worktrees.

## Open questions

### Lifecycle

Foreground process is the v0 starting point: cross-platform,
debuggable, ctrl-c works. `swarm harness install` for launchd /
systemd is out of scope until the foreground UX has soaked.

What does `swarm run` do when the harness is not running? Hard-fail
with a tip; no magic auto-start.

### Watchdog

Resumability covers daemon crash-restart. It does not cover **alive
but stuck** — a poison message in `supervisor.ts` that deadlocks one
project's runs deadlocks every project's runs, because there's one
fiber. Resumability tests cover crash-restart, not "alive but won't
make progress."

Need: heartbeat from daemon to harness. If the daemon hasn't made
progress in N minutes (no fact event written, no tick observed),
the harness signals restart. The metric for "progress" is open —
last fact-event timestamp is the obvious candidate; supervisor-tick
counter is more accurate.

### Threat model

V0 is localhost-only, no auth. Single-user machines, browser tabs
on the same origin, single-tenant. The trust boundary is filesystem
permissions on `~/.swarm/swarm.db` (0600) — anything that can read
the DB already has the keys to the kingdom; an additional token in
the same DB adds no boundary.

When the threat model widens (shared dev box, hostile browser tab,
multi-tenant, remote dev environment), token auth lands as a
separate proposal. See [token auth](./token-auth.md).

### Per-cwd is a CI primitive, not a default

`swarm daemon --db <path>` and `swarm serve --db <path>` remain
available for CI / tests / power users — they never appear on the
default install path. New users start on `~/.swarm/swarm.db` from
the first `swarm harness` invocation. There's no per-cwd path to
retire; the flagged form is a primitive that always existed and
always will.

The only one-off migration is for the swarm repo itself, which has
months of pre-harness run history; see [migration](./migration.md).

## What this enables

- Cross-project visibility (UI listing every cwd swarm has run from)
- `~/.swarm/swarm.db` (one DB for every project)
- `~/.swarm/workflows/` (workflow lookup by name)
- [One-off migration](./migration.md) (lifts this repo's pre-harness
  DB into the global DB)

## What does not change

The intent/fact split, projection-in-transaction, content-addressed
blobs, hard-abort semantics, the handler contract, the event taxonomy,
the ten invariants in [`SPEC.md`](../SPEC.md) §4.

## Past v0

Pinned explicitly so they don't drift:

- [Token auth](./token-auth.md) on the API.
- [Project config extensions](./project-config-extensions.md)
  (per-project bootstrap, defaults, summariser, blocklist, ...).
- Whether `~/.swarm/` should ever be sync-able across machines.
  Current answer: no; SQLite WAL is hostile to that. If multi-machine
  becomes a goal, it lands as a Postgres `IEventStore` impl, not as
  file sync.
- Whether the resumability test suite should grow a per-release
  contract (assert specific resume properties before tagging).
  Currently five integration tests; could become a gate.
- `swarm harness install` (launchd / systemd). Foreground first;
  service later.
- Tray app / native UI shell / notifier. Harness contract leaves
  room.
