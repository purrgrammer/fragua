---
title: Schema additions for project-aware runs
summary: "Project-aware run schema (cwd + workflow metadata + harness URL columns)"
status: shipped
maturity: specified
last-reviewed: 2026-05-04
---

# Schema additions for project-aware runs

> Shipped. The harness-by-default globalization plan's schema
> foundation is in place at `CURRENT_SCHEMA_VERSION = 4`.
>
> **Live now:** `run_state.{base_git_sha, branch}`,
> `run_state.{cwd, workflow_name, workflow_scope, workflow_path}`,
> `daemon_lock.{http_url, http_port, harness_version}`. `idx_run_state_cwd`
> backs the emergent-paths project listing. `workflow_scope` CHECK
> covers `'global' | 'local' | 'path' | 'ephemeral'`.
>
> **Removed:** `run_state.project_id` and the `projects` table —
> projects are emergent paths in the harness-by-default model
> (`SELECT DISTINCT cwd FROM run_state`); see
> [project-config extensions](./project-config-extensions.md).
>
> **Still deferred:** `project_context_sha` (lands with
> [project-extensions](./project-extensions.md)) and `parent_run_id`
> (no sub-run support in v0).

## What lands

`run_state` gains the columns below. All NULL-able to keep existing
rows valid; new writes populate them. No backfill — pre-globalization
runs stay NULL on the new columns.

```sql
ALTER TABLE run_state ADD COLUMN cwd TEXT;
ALTER TABLE run_state ADD COLUMN workflow_name TEXT;
ALTER TABLE run_state ADD COLUMN workflow_scope TEXT
  CHECK (workflow_scope IN ('global','local','path','ephemeral'));
ALTER TABLE run_state ADD COLUMN workflow_path TEXT;

CREATE INDEX IF NOT EXISTS idx_run_state_cwd ON run_state(cwd);
```

`cwd` is the absolute project root the run was enqueued from — the
only project identifier in the harness-by-default model. See
[project-config extensions](./project-config-extensions.md) for the
emergent-paths reasoning.

`run_state.project_id` and the `projects` display cache are
removed in the same migration:

```sql
ALTER TABLE run_state DROP COLUMN project_id;
DROP TABLE projects;
```

UI / CLI surfaces that previously listed projects via the
`projects` table compute the listing as `SELECT DISTINCT cwd FROM
run_state` (cheap, indexed via `idx_run_state_cwd`). The display
name for a project is `basename(cwd)`.

`daemon_lock` gains URL columns so CLIs can discover the harness's
HTTP without a JSON file:

```sql
ALTER TABLE daemon_lock ADD COLUMN http_url TEXT;
ALTER TABLE daemon_lock ADD COLUMN http_port INTEGER;
ALTER TABLE daemon_lock ADD COLUMN harness_version TEXT;
```

See [harness](./harness.md) for the discovery flow.

## Why no `events.project_id`

Cross-project queries (`WHERE cwd = ?`) join through `run_state` —
two indexed steps instead of one. The earlier shape of this proposal
denormalised `project_id` onto `events`; the harness-by-default
model uses paths, which are longer strings, and the join is fast
enough that denormalising costs more than it saves. If the join
shows up as a real bottleneck, denormalise then.

## What this does not commit to

`project_context_sha` and `parent_run_id` are out of this round.

- `project_context_sha` lands when
  [project-extensions](./project-extensions.md) ships and project
  tools / hooks / skills become a real determinism input. Pre-tools
  runs replay against zero project tools; the column is opt-in by
  definition.
- `parent_run_id` was reserved for multi-project parent/child runs;
  not happening for v0. Add when sub-run support shows up.

## Invariants preserved

I1 (transactional writes): all column additions are written in the
same transaction as the event append, same as today. Nothing else
changes.
