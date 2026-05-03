---
title: Workflow resolution by name
status: accepted
maturity: specified
last-reviewed: 2026-05-03
---

# Workflow resolution by name

> Bare-name resolution checks `~/.swarm/workflows/` first, then falls
> back to `<cwd>/.swarm/workflows/`. There's no `@local` / `@global`
> syntax — the file's location encodes the scope.

## What lands

CLI/API boundary resolves a workflow argument to a `.dot` file. The
daemon contract is unchanged: it still receives `workflow_sha`.

```
swarm run build-feature                # ~/.swarm/workflows/build-feature.dot,
                                       # else <cwd>/.swarm/workflows/build-feature.dot
swarm run ./path/to/foo.dot            # path (anonymous)
swarm run /abs/path/to/foo.dot         # path (anonymous)
```

Resolution order for a bare name (no `/`, no `.dot` suffix):

1. `~/.swarm/workflows/<name>.dot` → scope `global`. Generic workflows
   (plan-implement-review, fix-bug, merge, …) live here so they're
   reachable from any cwd.
2. `<cwd>/.swarm/workflows/<name>.dot` → scope `local`. Project-internal
   workflows (this repo's `introspect`, `ci-gate`, …) stay near the
   codebase that owns them.

Anything containing `/` or ending in `.dot` resolves as a path → scope
`path`. A miss surfaces as `workflow not found`, listing both
candidate paths and the path-form fallback.

`@local` / `@global` syntax is not parsed. The directory the file
lives in IS the scope.

## Silent-shadow concern

Local and global names can collide. `swarm run foo` resolves the
global one when both exist; the local one is shadowed without warning.
Until `swarm workflows ls` ships (showing both scopes side by side),
the rule is: name your local-only workflows distinctly (this repo
prefixes most with the subsystem, e.g., `introspect`, `ci-gate`,
`abort-test`, `analyze`, `showcase`).

## Run metadata

Every run records how the workflow was resolved:

| Run column | Source | Notes |
|---|---|---|
| `workflow_sha` | content hash | what executes; replay key |
| `workflow_name` | resolved logical name | NULL for path runs |
| `workflow_scope` | `'global' \| 'local' \| 'path' \| 'ephemeral'` | enum |
| `workflow_path` | filesystem path at resolution time | for debug |

Columns ship with [schema additions](./schema-additions.md); writers
land here.

## What this does not commit to

- `pinned_global` / `pinned_local` policy (forcing the resolver to
  one scope). Document if shadow accidents become common.
- Search across multiple global directories
  (`~/.swarm/workflows/<scope>/<name>.dot`). One flat directory until
  a real use case forces hierarchy.
- `swarm workflows ls` listing both scopes side-by-side. Useful when
  the user has many of each; not blocking for v0.
