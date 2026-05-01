---
title: Harness
status: proposed
maturity: designed
last-reviewed: 2026-05-01
---

# Harness

> Architectural commitment point. After this lands, the harness is the
> canonical entry point and the per-cwd `swarm daemon` mode becomes a
> CI/power-user primitive. Several other proposals
> ([credentials](./credentials.md),
> [migration](./migration.md),
> [project-extensions](./project-extensions.md),
> [file-server](./file-server.md)) depend on this.

## Shape

`swarm harness` supervises the daemon, HTTP server, and web UI as a
single foreground process. `swarm daemon` and `swarm serve` remain as
primitives for CI and power users.

Discovery file at `~/.swarm/harness/harness.json` (0600):

```jsonc
{
  "version": "0.x.y",
  "url": "http://127.0.0.1:<port>",
  "token": "<random>",
  "pid": 12345,
  "daemonPid": 12346,
  "servePid": 12347,
  "startedAt": 1714492800000
}
```

Every API call carries the token. Web UI reads it at boot.

## Open questions

### Lifecycle

Foreground process is the v0 starting point: cross-platform, debuggable,
ctrl-c works. `swarm harness install` for launchd / systemd is out of
scope until the foreground UX has soaked.

What does `swarm run` do when the harness is not running? Hard-fail
with a tip; no magic auto-start.

### Watchdog

Resumability covers daemon crash-restart. It does not cover **alive
but stuck** — a poison message in `supervisor.ts` that deadlocks one
project's runs deadlocks every project's runs, because there's one
fiber. Resumability tests cover crash-restart, not "alive but won't
make progress."

Need: heartbeat from daemon to harness. If daemon hasn't made progress
in N minutes (no fact event written, no tick observed), harness signals
restart. The metric for "progress" is open — last fact-event timestamp
is the obvious candidate; supervisor-tick counter is more accurate.

### Threat model

Localhost token auth on a single-user machine is the v0 default.
`harness.json` at 0600 is the actual security boundary. Explicit
non-goals:

- iCloud-synced `~/` leaks the token. Document the assumption.
- Shared dev boxes are out of scope; multi-tenant needs Unix socket +
  uid checks.
- Browser tabs / other localhost callers are bounded by the token.

Unix-socket transport is the next step; postponed past v0.

### Per-cwd compatibility

`<cwd>/.swarm/swarm.db` daemons remain the legacy path. Default
behavior of fresh installs is the harness. When does the per-cwd path
get removed? Open.

## What this enables

- Cross-project visibility (UI dropdown for "all projects")
- `~/.swarm/swarm.db` (one DB for every project)
- `~/.swarm/workflows/` (global workflow scope)
- [Credentials in DB](./credentials.md) (decryption inside the daemon
  process)
- [Migration tool](./migration.md) (copies into the global DB)

## What does not change

The intent/fact split, projection-in-transaction, content-addressed
blobs, hard-abort semantics, the handler contract, the event taxonomy,
the ten invariants in [`SPEC.md`](../SPEC.md) §4.

## Past v0

Pinned explicitly so they don't drift:

- Whether `~/.swarm/` should ever be sync-able across machines. Current
  answer: no; SQLite WAL is hostile to that. If multi-machine becomes a
  goal, it lands as a Postgres `IEventStore` impl, not as file sync.
- Whether the resumability test suite should grow a per-release
  contract (assert specific resume properties before tagging).
  Currently five integration tests; could become a gate.
- `swarm harness install` (launchd / systemd). Foreground first;
  service later.
- Tray app / native UI shell / notifier. Harness contract leaves room.
