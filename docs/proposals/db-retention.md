---
title: Per-project DB retention
status: in-progress
maturity: specified
last-reviewed: 2026-05-01
---

# Per-project DB retention

> Maintenance and archival CLIs for a long-running swarm DB. Vacuum,
> blob GC, and full-DB backup ship; the namesake `prune` retention
> CLI is the outstanding piece. Useful in single-project mode today;
> the `--project` filter is a no-op until multi-project lands.

## What landed

- `swarm db vacuum` — SQLite fragmentation reclaim.
- `swarm db gc-blobs` — sweep unreferenced artifact blobs.
- `swarm db backup --to <path>` — full-DB snapshot.
- `swarm gc --snapshots [--older-than <dur>] [--dry-run]` — reclaim worktree
  snapshot refs (`refs/swarm/{snapshots,heads}/<runId>`) for settled runs
  older than the window that aren't awaiting an operator decision
  (`inbox_status != 'pending'`), then `git pack-refs --all`. Operator-invoked,
  same model as the prune CLIs below. Decouples ref-GC (the bulky git
  objects) from `run_state` row deletion — the row + event log stay
  queryable; only the reclaimable git objects go. See
  [`worktrees.md`](worktrees.md) §GC.

## Outstanding

```
swarm db prune --project <id> [--older-than <duration>] [--keep <n>]
swarm db prune --project <id> --dry-run
swarm db backup --project <id> --to <path>
```

Prune deletes `run_state` rows scoped to `<id>`; the existing FK
`ON DELETE CASCADE` removes events, messages, and artifacts. Blob GC
sweeps unreferenced files afterward, same as `swarm db gc-blobs` today.

Backup is the read-side mirror — filtered SQLite export so a finished
project can be archived before pruning. Belongs in the same CLI surface
as `swarm migrate --from` (deferred).

## Why now

The auto-titler runs forever. Long-running swarm projects accumulate
events in the millions. Today the only retention tool is
`bun run swarm db vacuum` — useful for fragmentation, useless for
deleting old runs. People hand-write SQL.

Project filter works once [schema additions](./schema-additions.md)
land. Pre-schema, fall back to `--all` (acts on the whole DB).

## What this does not commit to

- Cross-project retention policy in the config file. v0 is a CLI knob.
- Automatic GC fibers. Manual only.
