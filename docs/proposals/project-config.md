# Project config file

> **Status:** READY. Project-scoped only. Cascading global config is
> part of the [harness](./harness.md) subproject.

## What lands

`<project>/.swarm/swarm.jsonc` — the single config + identity file:

```jsonc
{
  "$schema": "https://swarm.dev/schemas/project-v1.json",
  "version": 1,
  "id": "01J7Q9X8K2N3M4P5R6S7T8V9W0",
  "name": "swarm",
  "concurrency": { "perProject": 4 },
  "providers": { /* model preferences */ }
}
```

- **Format**: JSONC (JSON with comments) via `jsonc-parser`. Pinned dep.
- **Validation**: TypeBox schemas in `@swarm/types` derive both runtime
  validators and JSON Schema files for editor integration.
- **Versioning**: `"$schema"` + `"version"`. Migration functions live
  next to the schema definition; read path applies migrations to
  current, write path always writes current.

`swarm init` writes the file, generates the ID if absent, and refuses
to regenerate if the file is reachable from `HEAD`. Two clones of the
same repo see the same ID because the file is committed.

`swarm config show --origin` lists every effective key with its source
file (project-scoped only today; `--origin` is forward-compatible with
the global cascade).

## Init policy

`swarm init` on a non-git directory: interactive prompt to `git init`,
then write `.gitignore` template and the project file. Hard-fail if the
user declines — magic init breaks reproducibility.

`.gitignore` template:

```
.swarm/runs/
.swarm/worktrees/
.swarm/swarm.db*
.swarm/daemon/
.swarm/credentials.jsonc

!.swarm/swarm.jsonc
!.swarm/workflows/
!.swarm/skills/
!.swarm/tools/
!.swarm/hooks/
```

## Why now, project-scoped only

Cascading global → project introduces merge semantics, override rules,
`--origin` ambiguity, and the global file's lifecycle. None of that is
needed for the per-project win. Get the JSONC + TypeBox + versioned
schema infrastructure battle-tested on one file before doubling it.

The schema is forward-compatible: adding a global file later means
deep-merging *into* this schema, not changing it.

## What this does not commit to

- `~/.swarm/swarm.jsonc` (global file).
- Credentials block (separate subproject; not in JSONC at all).
- Cascading semantics. `swarm config show` reads one file in v0.
