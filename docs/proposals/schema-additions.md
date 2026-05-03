---
title: Schema additions for project-aware runs
status: in-progress
maturity: specified
last-reviewed: 2026-05-03
---

# Schema additions for project-aware runs

> Pure additive migration; foundation for the harness-by-default
> globalization plan.
>
> **Staying:** `run_state.{base_git_sha, branch}` are shipped and
> load-bearing — note that the proposal's `worktree_branch` shipped
> as `branch` (the `worktree_` prefix was redundant; the column
> always refers to the run's worktree).
>
> **Outstanding:** `run_state.cwd`, `run_state.workflow_name` /
> `_scope` / `_path`, plus the `daemon_lock` URL columns the
> harness uses for discovery.
>
> **Removing:** `run_state.project_id` and the `projects` table.
> Projects are emergent paths in the harness-by-default model; see
> [project-config extensions](./project-config-extensions.md).

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
