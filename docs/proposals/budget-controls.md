---
title: Budget controls
status: in-progress
maturity: specified
last-reviewed: 2026-05-01
---

# Budget controls

> Single-project cost ceilings: per-node and per-run caps already
> ship; the outstanding piece is a per-project cap that cascades from
> project config so a long-running project can't silently rack up
> spend across many runs. Multi-project
> [rate-limit fairness](./rate-limit-fairness.md) is a separate,
> harder subproject.

## What landed

- Per-node and per-run `budget_usd` / `max_cost_usd` / `budget_policy`
  enforcement at every turn boundary
  (`packages/core/src/engine/budget-policy.ts`).
- Auto-titler fiber with a bounded cost ceiling, so background
  titling can't eat a project's budget.

## Outstanding

Per-project cost cap cascading from project config. The shape below
is the proposed extension to [project config](./project-config.md):

```jsonc
"budgets": {
  "tokensPerHour": 100000,        // optional; null = unbounded
  "costUsdPerDay": 5.00           // optional; null = unbounded
},
"autoTitler": {
  "enabled": true,
  "maxCostUsdPerDay": 0.50
}
```

The supervisor checks the bucket before dispatching a node that would
issue an LLM call. Over-budget runs transition to
`paused_provider_error` with `reason: "project_budget_exhausted"`,
resumable via `intent.resume` (typically after raising the cap or
waiting out the window).

The auto-titler block stays distinct from the project bucket so the
already-landed titler ceiling continues to apply independently —
degrading to "untitled run" is strictly better than degrading the
user's actual workflows.

## Why now

Long-running projects rack up spend silently. The per-node and
per-run caps stop a single runaway run, but nothing today caps the
sum across runs in a project. `costUsdPerDay` in single-project mode
is just a cost cap — no fairness, no admission ordering across
projects, no per-key bucket layering. That heavier work waits for
[rate-limit fairness](./rate-limit-fairness.md).

## What this does not commit to

- Per-project shares of a per-key rate limit bucket. Single-project
  mode means "you have one budget; don't exceed it."
- Per-provider budget breakdown. Total cost only.
- Automatic budget recovery. Pause requires manual resume.
