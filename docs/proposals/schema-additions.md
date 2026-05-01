---
title: Schema additions for project-aware runs
status: in-progress
maturity: specified
last-reviewed: 2026-05-01
---

# Schema additions for project-aware runs

> **Status:** READY. Pure additive migration; existing code unaffected.
> Foundation for every other globalization subproject.
>
> Partially landed: `run_state.{project_id, base_git_sha, branch}` are in
> `schema.sql`. Outstanding columns from this proposal: `workflow_name`,
> `workflow_scope`, `workflow_path`, `project_context_sha`,
> `parent_run_id`, plus `events.project_id`.

## What lands

`run_state` gains the columns below. All NULL-able to keep existing
rows valid; backfill is one-shot at migration time.

```sql
ALTER TABLE run_state ADD COLUMN project_id TEXT;
ALTER TABLE run_state ADD COLUMN workflow_name TEXT;
ALTER TABLE run_state ADD COLUMN workflow_scope TEXT
  CHECK (workflow_scope IN ('global','local','path','ephemeral'));
ALTER TABLE run_state ADD COLUMN workflow_path TEXT;
ALTER TABLE run_state ADD COLUMN base_git_sha TEXT;
ALTER TABLE run_state ADD COLUMN project_context_sha TEXT;
ALTER TABLE run_state ADD COLUMN parent_run_id TEXT;
ALTER TABLE run_state ADD COLUMN worktree_branch TEXT;

CREATE INDEX IF NOT EXISTS idx_run_state_project ON run_state(project_id);
CREATE INDEX IF NOT EXISTS idx_run_state_parent  ON run_state(parent_run_id);
```

`events` gains a denormalized `project_id` column (populated from
`run_state.project_id` on append, indexed) so cross-project queries
do not require a join through `run_state`:

```sql
ALTER TABLE events ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project_id, ts);
```

## Why now

`project_context_sha` is the load-bearing column. Once project tools
exist ([project extensions](./project-extensions.md)), `workflow_sha`
alone no longer makes replay deterministic — the project's
tools+hooks+skills tree must be hashed at run start. That column is
**impossible to retrofit** for runs already recorded; cheap to add now
and populate as NULL until the writers exist.

`parent_run_id` is reserved for multi-project parent/child runs
(deferred non-goal). Always NULL today; declaring it now means no
second migration when it lands.

`project_id` on `events` is denormalized intentionally. Cross-project
queries are the obvious shape (`WHERE project_id = ? ORDER BY ts`); a
join through `run_state` for every event read is not.

## Invariants preserved

I1 (transactional writes): all column additions are written in the same
transaction as the event append, same as today. Nothing else changes.

## What this does not commit to

Writing project IDs, capturing base SHAs, populating context shas — none
of those land here. This subproject is the *space* for them.
