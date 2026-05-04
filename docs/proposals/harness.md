---
title: Harness
summary: "Foreground harness — daemon + HTTP under one supervisor"
status: shipped
maturity: specified
last-reviewed: 2026-05-04
---

# Harness

> Shipped. `swarm harness` is the canonical entry point; the per-cwd
> `swarm daemon` / `swarm serve` mode is a CI/power-user primitive.
> Downstream proposals ([token auth](./token-auth.md),
> [project-config extensions](./project-config-extensions.md),
> [project tools, hooks, skills](./project-extensions.md),
> [file server](./file-server.md)) build on it. The one-off
> [migration](./migration.md) script ran on this repo on 2026-05-04.

## Shape

`swarm harness` supervises the daemon (subprocess) and HTTP server
(in-process via `startServer`) as a single foreground process. Default
DB `~/.swarm/swarm.db`; default port 6767, configurable via `web.port`
in `~/.swarm/config.jsonc` or `--port` (collisions auto-bump to
6768/6769/… on the default path; `--port` hard-fails). The web bundle
auto-rebuilds when sources are newer than `dist/`. The `ready` line
prints an OSC 8 hyperlink so modern terminals render the URL clickable.

`swarm daemon --db <path>` and `swarm serve --db <path>` remain as
primitives for CI and power users — they never appear on the default
install path.

Discovery is via the DB itself. `~/.swarm/swarm.db` is the only
filesystem rendezvous; everything else lives in rows.

`daemon_lock` (singleton, CHECK id=1) carries URL columns:

```sql
http_url        TEXT,        -- harness/serve listener URL; NULL for `swarm daemon` only
http_port       INTEGER,
harness_version TEXT
```

The harness writes its URL on startup and clears it on SIGINT. CLIs
(`swarm run`, …) open `~/.swarm/swarm.db` read-only and read the lock
row. Concurrent SQLite readers are fine; the cost is one `open()` +
one `SELECT` per CLI invocation.

`swarm run`'s discovery cascade: `--url` flag → `<cwd>/.swarm/serve.json`
(CI primitive) → `~/.swarm/swarm.db` `daemon_lock.http_url` (harness)
→ `http://localhost:3000` last-resort default.

CI primitives write their own DB's `daemon_lock` and discover through
that same DB. No JSON discovery files in the default install path. The
only filesystem state outside the DB is the DB itself, the blobs
directory, and per-run worktrees.

## Open questions (post-ship)

### Lifecycle

Foreground process is v0: cross-platform, debuggable, ctrl-c works.
`swarm harness install` for launchd / systemd is out of scope until the
foreground UX has soaked.

`swarm run` against an absent harness: hard-fail with a tip pointing
at `bun run swarm harness`; no magic auto-start.

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
counter is more accurate. Deferred until the foreground UX has soaked.

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

The only one-off migration was for the swarm repo itself, which had
months of pre-harness run history; see [migration](./migration.md).
The script ran on 2026-05-04.

## What this enables (now live)

- Cross-project visibility — `/projects` page lists every cwd swarm
  has run from with run rollups; `/projects/:cwdEnc` adds a
  `.gitignore`-honored file tree + blob viewer; `/analytics` carries
  a per-project filter
- `~/.swarm/swarm.db` — one DB for every project
- `~/.swarm/workflows/` — workflow lookup by bare name, with
  `<cwd>/.swarm/workflows/` as the local fallback (see
  [workflow-resolution](./workflow-resolution.md))
- Workflow listing aggregates global + every project cwd's
  `.swarm/workflows/` (cross-source name collisions disambiguate by
  `cwd`)
- Two-layer config cascade — `~/.swarm/config.jsonc` overlaid by
  `<cwd>/.swarm/config.jsonc`

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
