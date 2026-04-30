# Migration tool

> **Status:** DESIGN. Depends on the [harness](./harness.md) and the
> global DB existing.

## Shape

```
swarm migrate --from <cwd>/.swarm
```

**Copy, not move.** The source remains as a backup until the user
explicitly removes it.

Flow:

1. Read events and `run_state` from the source DB.
2. Synthesize a project ID — prompt for a UUID or generate one and
   write it to `<cwd>/.swarm/swarm.jsonc`.
3. Backfill `project_id` on the imported rows.
4. Resolve workflow names retroactively where possible
   (`workflow_scope = 'path'` for any unresolvable rows).
5. Write to `~/.swarm/swarm.db`. Source DB remains untouched.

Idempotent: running the migration twice on the same source produces a
warning and a no-op.

## Why defer

The migration target — `~/.swarm/swarm.db` — does not exist until the
[harness](./harness.md) lands. Designing the tool before the target's
schema is settled means rewriting it.

The READY subprojects ([schema additions](./schema-additions.md),
[project config](./project-config.md), [workflow
resolution](./workflow-resolution.md), etc.) all run on the existing
per-cwd DB. No migration needed for any of them; they compose forward.

## Open questions

- **Conflict policy**: two source DBs migrating into one global DB
  with the same project ID (e.g., user ran `swarm init` twice in
  different clones before committing). Refuse? Prompt? Last-write-wins?
- **Run-state-only vs. full**: do we copy event histories or just the
  current `run_state` projections? Replay deterministic on copied
  events requires the source's blobs too.
- **Blob handling**: copy, hardlink, or leave-in-place with a path
  rewrite? Hardlink only works on the same volume.
- **Cleanup**: when does the source DB get deleted? Manual only, or
  prompt after N successful runs against the target?
