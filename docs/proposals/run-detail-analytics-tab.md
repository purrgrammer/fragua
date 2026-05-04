---
title: Run-detail analytics tab
status: proposed
maturity: sketch
last-reviewed: 2026-05-05
---

# Run-detail analytics tab

> Add an **Analytics** tab to `/runs/:id` rendering a per-node summary
> of the run: where time went, where money went, where retries
> happened, where the cache helped. The existing **Cost** tab (per-LLM-step)
> stays as the drill-in; the new tab is the per-node aggregate above
> it.

## Job-to-be-done

Post-mortem one run. "This took 11 minutes and \$3.40 — which node ate
that?" The current `Cost` tab is per-LLM-step, so a node with 8 LLM
calls renders as 8 rows; understanding the *node*'s share requires the
reader to add them up by hand. For long runs (parallel branches,
retries, fan-in) that's hostile.

Distinct from the per-workflow analytics that just shipped:

- **Per-workflow** (`/analytics?workflowScope=…`): aggregates across
  many runs of one workflow. "Is `research.dot` getting more
  expensive?"
- **Per-run analytics** (this proposal, `/runs/:id/analytics`): one
  run's per-node breakdown. "Why did *this* run cost \$3.40?"

The two compose: per-workflow shows you `research.dot` is up 30%
this week → click into one slow run → per-run shows the slowdown is
in the `summarise` node.

## UI shape

New tab on `/runs/:id` (`RunDetail.tsx:188-200`):

```
[ Conversation | Graph | Cost | Analytics | Files ]
```

Tab name `Analytics` (not `Per-node` or `Summary`) to mirror the
`/analytics` page voice. Sits between `Cost` and `Files`.

Body: a single dense table, one row per node, one footer row for the
run total.

| node | wall | LLM s / tool s | tokens (in / out / cache) | $ | retries |
|---|---|---|---|---|---|

Click a row → highlights or scrolls the corresponding `Cost` tab
section (cross-tab nav via the existing `:view` param + an anchor
node id). No drilldown drawer — `Cost` is already the drill-in.

Details:

- **Branch handling.** Parallel branches collapse into the parent
  component row by default (sums child cost/tokens), with an expander
  per branch — same shape `CostInspector` uses today
  (`StepSnapshot.parentNodeId` + `aggregateBranchCost`). Reuse that
  helper instead of re-implementing.
- **Sort.** Default by `cost desc` (the question is "where did money
  go"). Secondary sort by `wall desc`.
- **Retries.** Count = how many `fact.node_started` for this nodeId
  fired (>1 means retried). Surface only when retries>0; otherwise
  show `—`.
- **Cache hit rate per row.** `cacheRead / (input + cacheRead +
  cacheWrite)` for that node's LLM steps; same denominator as
  `formatCacheHitRate` in `lib/format.ts`.

## Data source

The endpoint already exists. `GET /runs/:id/steps` returns
`StepSnapshot[]` (`packages/server/src/store/steps.ts:51`) which
already carries:

- `nodeId`
- `parentNodeId` (for branches)
- `costUsd` (server-aggregated)
- `inputTokens` / `outputTokens` / `cacheReadTokens` /
  `cacheWriteTokens` / `billedTokens`
- timing (start/end → wall)

Per-node aggregation is a client-side `groupBy(nodeId)` reduce. No new
server route, no new SQL.

What's missing: **LLM seconds vs tool seconds** split per node. The
`scripts/analyze` server-side analyzer (commit `f11130a`) already
distinguishes these — port that logic into the steps reducer or fold
it onto the rows the existing endpoint returns. One new field on
`StepSnapshot` (`toolSeconds: number`?) is the cheap path; the
existing `wall` is implicitly `llmSeconds + toolSeconds + idle`.

If the split is more work than it's worth in v1, drop the column and
ship "wall" alone. The retry / cost / token columns are the actual
leverage.

## Implementation sketch

1. **Backend.** Decide LLM/tool split source — reuse `scripts/analyze`
   logic in the steps reducer, or punt the column. (Probably reuse.)
2. **Client.** New `RunAnalyticsTab` component
   (`packages/web/src/components/run-detail/RunAnalyticsTab.tsx` or
   sibling to `CostInspector`). Reuses `queries.runs.steps(runId)` and
   `aggregateBranchCost`. One reduce + one render — a few hundred
   lines including formatting + the empty/loading/error states.
3. **Wiring.** New `TabsTrigger value="analytics"` in `RunDetail.tsx`;
   route param `:view` already drives this so URL deep-links work for
   free.
4. **Tests.** RunDetail tab renders; reduce yields expected
   per-node sums on a fixture; branch parents aggregate child rows.

## Out of scope

- **Run-vs-baseline strip.** "This run cost 1.4× the median for
  `research.dot`." Needs the per-workflow data we just shipped. Sits
  naturally as a header on this tab once it lands but doesn't block
  v1.
- **Timeline / Gantt of nodes.** Different visual idiom (positional,
  not tabular). Worth its own proposal.
- **Compare two runs side-by-side.** Proposed for the per-workflow
  analytics v2; same baseline-picker UI fits here.

## Risks

- **Tab proliferation.** Five tabs is the soft ceiling for a
  detail page. Adding "Analytics" puts us at 5. If we add a sixth
  later (Timeline?), revisit collapsing Conversation+Graph or
  Analytics+Cost. Not a v1 problem.
- **Branch/parent aggregation drift.** `CostInspector` already does
  this and the rules are subtle (parents show themselves+children;
  branches show themselves; sums must reconcile). Reuse
  `aggregateBranchCost`, don't reimplement.
- **`scripts/analyze` is not source of truth for the live UI.** It's
  a workflow that ad-hoc analyses runs. The LLM/tool seconds split
  needs to land in production code (the steps reducer) for the tab to
  use it. Don't import the workflow.

## Follow-up

- Once shipped, the per-workflow analytics page should deep-link into
  this tab when the user clicks an individual run from the drill-down
  drawer — closing the "is it getting worse" → "why this run" loop.
