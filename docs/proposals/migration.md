---
title: One-off migration
summary: "One-off migration script for the swarm repo's pre-harness DB"
status: shipped
maturity: specified
last-reviewed: 2026-05-04
---

# One-off migration

> Shipped. Ran on this repo on 2026-05-04: 37 runs / 36 155 events /
> 2 449 messages / 133 blobs / 136 artifacts lifted from
> `<repo>/.swarm/swarm.db` into `~/.swarm/swarm.db`. Source renamed to
> `<repo>/.swarm/swarm.db.pre-harness.2026-05-04`. Script
> (`scripts/migrate-pre-harness.ts`) is idempotent (re-running bails
> on the first runId collision) and deletable once this repo has soaked
> on the global DB. New installs start on the harness from day one —
> they never touch a per-cwd `.swarm/swarm.db` and don't need migrating.

## Shape

`scripts/migrate-pre-harness.ts` — single source, single target,
hard-coded paths (this repo, `~/.swarm/swarm.db`). Run once, delete
after.

```sh
bun run scripts/migrate-pre-harness.ts
```

Flow:

1. Source DB at `<repo>/.swarm/swarm.db` already has
   `run_state.project_id` populated (project-config is already shipped).
2. Target `~/.swarm/swarm.db` is the empty schema written by the first
   `swarm harness` invocation.
3. Copy `events` and `run_state` rows. Skip `daemon_lock`
   (singleton; freshly minted on the target) and the source's
   `projects` table (the harness model doesn't have one — `cwd` on
   `run_state` is the only project identifier). Use the source's
   `projects.project_root` (joined on `project_id`) to populate
   `run_state.cwd` on the target before the join is no longer
   possible.
4. Blobs: hardlink `<repo>/.swarm/blobs/` → `~/.swarm/blobs/`
   (same-volume, no copy cost). Cross-volume case doesn't apply here.
5. Rename source to `<repo>/.swarm/swarm.db.pre-harness.2026-05-03` so
   it's out of the way but recoverable. Don't delete.

The harness API doesn't need to be running. The script writes directly
through `SqliteStore` against the global DB path.

## Why this isn't a CLI command

One operator, one source path, one target path. A `swarm migrate`
subcommand would carry baggage ("why does swarm have a migrate command
if nobody needs it?") long after the migration is done. Script lives
in `scripts/`, deletable when the repo is on the global DB.

## What new installs do instead

`swarm harness` boots `~/.swarm/swarm.db` (schema-only on first run).
The first `swarm run` from any directory writes events into the
global DB; the run's `cwd` is captured as the project identifier.
No migration step appears in the new-user flow.

## Open questions

- **Cleanup of the renamed source.** Manual; no auto-delete after N
  successful global-DB runs (too easy to regret). Delete after the
  harness has soaked for a couple of weeks.
- **`.gitignore` line for `.swarm/swarm.db*`.** Stays during the
  transition so the renamed `.pre-harness` file can't be committed.
  Drop when the source is finally deleted.
