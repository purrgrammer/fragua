---
title: Workflow resolution by name
status: accepted
maturity: specified
last-reviewed: 2026-05-03
---

# Workflow resolution by name

> Bare-name resolution targets the global workflows directory.
> Per-project workflows (`<project>/.swarm/workflows/`) are deferred
> behind [project-config extensions](./project-config-extensions.md);
> there's no `@local` / `@global` syntax until then.

## What lands

CLI/API boundary resolves a workflow argument to a `.dot` file. The
daemon contract is unchanged: it still receives `workflow_sha`.

```
swarm run build-feature                # ~/.swarm/workflows/build-feature.dot
swarm run ./path/to/foo.dot            # path (anonymous)
swarm run /abs/path/to/foo.dot         # path (anonymous)
```

Resolution order:

```
<name>          → ~/.swarm/workflows/<name>.dot   (no `/`, no `.dot` suffix)
<path>          → <path>                          (contains `/` or ends in `.dot`)
```

A bare-name miss surfaces as `workflow not found in
~/.swarm/workflows/<name>.dot`, with a hint to either drop a file
there or pass a path explicitly.

`@local` / `@global` syntax is not parsed today. When per-project
workflows return, the resolver gains a project layer that wins by
name; until then, the bare name is global.

## Run metadata

Every run records how the workflow was resolved:

| Run column | Source | Notes |
|---|---|---|
| `workflow_sha` | content hash | what executes; replay key |
| `workflow_name` | resolved logical name | NULL for path runs |
| `workflow_scope` | `'global' \| 'path' \| 'ephemeral'` | enum |
| `workflow_path` | filesystem path at resolution time | for debug |

Columns ship with [schema additions](./schema-additions.md); writers
land here.

## What this does not commit to

- `<project>/.swarm/workflows/` (per-project workflows). Returns with
  [project-config extensions](./project-config-extensions.md).
- `pinned_global` policy. Document the rule when a second scope ships.
- Search across multiple global directories
  (`~/.swarm/workflows/<scope>/<name>.dot`). One flat directory until
  a real use case forces hierarchy.
