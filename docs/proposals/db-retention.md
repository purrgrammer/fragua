# Per-project DB retention

> **Status:** READY. Useful in single-project mode today; project filter
> is a no-op until multi-project.

## What lands

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
