---
title: Workflow resolution by name
status: accepted
maturity: specified
last-reviewed: 2026-05-01
---

# Workflow resolution by name

> **Status:** READY for local resolution. Global resolution
> (`@global/<name>`) is part of the [harness](./harness.md) subproject.

## What lands

CLI/API boundary resolves a workflow argument to a `.dot` file. Daemon
contract is unchanged: it still receives `workflow_sha`.

```
swarm run build-feature                # @local/build-feature
swarm run @local/build-feature         # explicit local (error if missing)
swarm run ./path/to/foo.dot            # path (anonymous)
```

Resolution order:

```
@local/<name>   → <project>/.swarm/workflows/<name>.dot
<name>          → @local first, else error
<path>          → <path>
```

Reserved prefixes: `@global`, `@local`. Anything else with `@` parses
as an error today, reserved for future scopes.

## Run metadata

Every run records how the workflow was resolved:

| Run column | Source | Notes |
|---|---|---|
| `workflow_sha` | content hash | what executes; replay key |
| `workflow_name` | resolved logical name | NULL for path/ephemeral |
| `workflow_scope` | `'local' \| 'path' \| 'ephemeral'` | enum; `'global'` lands with the harness |
| `workflow_path` | filesystem path at resolution time | for debug |

Columns ship with [schema additions](./schema-additions.md); writers
land here.

## Silent-shadow concern

When global resolution lands, `swarm run foo` will resolve `@local/foo`
before `@global/foo`. This is the npm-resolution bug class: a project
that accidentally creates `.swarm/workflows/foo.dot` shadows the global
one without warning.

`swarm workflows ls` (ships with this subproject) shows scopes
side-by-side once global exists. **Additionally**: log a warning at
resolution time when a local entry shadows a global one of the same
name. Silent-wins is too easy to miss.

This concern only manifests after global resolution lands. Flagging
here so it doesn't drift.

## What this does not commit to

- `~/.swarm/workflows/` (global workflows directory).
- `pinned_global` policy. Document the rule; enforcement comes when a
  third scope ships.
