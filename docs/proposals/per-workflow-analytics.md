---
title: Per-workflow analytics
status: proposed
maturity: sketch
last-reviewed: 2026-05-05
---

# Per-workflow analytics

> Add a workflow filter to `/analytics` so the same dashboard re-scopes
> to runs of one workflow, aggregating across all shas of that workflow.
> Workflow identity = `(scope, name)`, not sha — edits to a `.dot` don't
> fragment the view.

## Job-to-be-done

Post-mortem ("this workflow's runs got more expensive — when?") plus
workflow tuning ("I'm iterating on `research.dot`, show me just its
runs"). Per-individual-run analytics is already covered by the existing
drilldown drawer — this proposal is the workflow-level scope between
the global dashboard and the per-run drawer.

## Workflow identity

Workflows are content-addressed by `sha` (FK on `run_state.workflow_sha`),
but the user-facing identity is the name + scope the workflow resolved
through. Already on `run_state`:

- `workflow_name` — resolved bare name (NULL when caller passed a path)
- `workflow_scope` — `'global' | 'local' | 'path' | 'ephemeral'`
- `workflow_path` — diagnostic only
- `cwd` — project root

Selector identity:

- **Global** — `name` alone. `global:research` is the same
  `~/.swarm/workflows/research.dot` regardless of project.
- **Local** — `(cwd, name)`. `local:research` differs across projects.
- **Path / ephemeral** — excluded from the selector (no canonical
  identity). They still aggregate into "All workflows".

Filter predicates:

```sql
-- Global, all projects:
WHERE workflow_scope = 'global' AND workflow_name = ?

-- Local, scoped to a project:
WHERE workflow_scope = 'local' AND workflow_name = ? AND cwd = ?
```

No schema changes. The existing `idx_run_state_workflow` is on
`workflow_sha`; if the planner doesn't pick up `idx_run_state_cwd` for
the local case, add `idx_run_state_workflow_name` on
`(workflow_scope, workflow_name)`.

## UI shape

`Analytics.tsx` (`packages/web/src/routes/Analytics.tsx:91-96`) gains a
`WorkflowSelector` next to `ProjectSelector`. Combobox with search;
default "All workflows" preserves current behaviour.

Selector contents:

- **Global** group — distinct `workflow_name` where
  `workflow_scope = 'global'`, sorted by recent activity.
- **Local** group — distinct `(cwd, workflow_name)` where
  `workflow_scope = 'local'`. When a project is selected via
  `ProjectSelector`, filter to that project; otherwise label entries
  with the cwd basename.

`AnalyticsRequest` extension:

```ts
workflow?: { scope: 'global' | 'local'; name: string };
// cwd already exists; for scope='local' the predicate uses both
```

`DrillDownDrawer` inherits `workflow` the same way it inherits `cwd`
today (Analytics.tsx:87, 112).

`TopWorkflowsBar` (currently commented out at lines 174-186) is the
natural entry point — clicking a workflow there sets the selector.
Restore as part of this slice.

## Metric decomposition

Per-workflow analytics earns its keep when totals decompose to show
*where* one workflow's spend goes. Today the dashboard sums to single
totals.

| Card | Today | v1 |
|---|---|---|
| Tokens | input + output summed | stacked: input / output |
| Spend | total USD | stacked: input / output / cache-read / cache-write |
| Cache | hit rate | hit rate + raw read/write tokens in tooltip |

Per-direction cost reuses the pricing source already feeding
`run_state.total_cost_usd`. Don't duplicate the price table.

### Open call: cache tier split

Anthropic exposes 5m vs 1h ephemeral cache. Skip — rate is the
actionable signal, tier is noise unless someone's debugging cache TTL.

## Out of scope (v2)

- **Per-node breakdown within a workflow.** Once `(scope, name)` is
  selected, node topology is consistent across runs (modulo `.dot`
  edits, which is exactly what sha-stacking would surface). "Which
  node ate the budget across the last 30 runs of this workflow"
  becomes well-defined — high leverage for tuning. Separate proposal;
  `scripts/analyze` (commit `f11130a`) already produces the
  per-node × LLM/tool seconds + cache-tokens breakdown server-side, so
  it's mostly UI work.
- **Single-run vs single-run comparison.**
- **Sha-version stacking.** "How did cost shift when I edited
  `research.dot` from sha A to sha B?" Useful but doubles the chart
  surface; punt.

## Risks / sharp edges

- **Selector noise across many projects.** A user with 20 projects,
  each with a `local:research`, sees 20 entries. Mitigation: when
  `ProjectSelector = All projects`, collapse same-named locals into a
  single entry ("Local: research (20 projects)") that aggregates
  across them. When a project is selected, only that project's locals
  show.
- **Bare-name resolution misses.** A run launched as
  `swarm run /abs/path/research.dot` carries `workflow_scope = 'path'`
  and won't appear under the `research` filter even if it's the same
  file. Acceptable — path-launch is the escape hatch and rare in
  practice. A "fall back to sha equivalence" rule is possible later
  if it bites.
- **Workflow renames break continuity.** If `research.dot` becomes
  `triage.dot`, history is split across two identities. Same problem
  any name-keyed system has. Not a v1 problem.

## Follow-ups tied to this slice

- Restore `TopWorkflowsBar` and wire its click-through to the selector.
- Server route test for `GET /analytics?workflow=…` end-to-end (route
  + selector → SQL predicate → zero-fill, mirroring the `cwd` test in
  `analytics.md`'s follow-up list).
- If the planner needs help, add the
  `(workflow_scope, workflow_name)` index.
