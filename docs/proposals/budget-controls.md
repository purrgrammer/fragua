# Budget controls

> **Status:** READY for per-project cost cap and auto-titler bound.
> Multi-project [rate-limit fairness](./rate-limit-fairness.md) is a
> separate, harder subproject.

## What lands

[Project config](./project-config.md) gains:

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

The auto-titler block is its own sub-budget so titling cannot consume
the whole project budget — degrading to "untitled run" is strictly
better than degrading the user's actual workflows.

## Why now

The auto-titler is a fiber that polls runs and fires LLM calls
regardless of whether anyone's watching. Long-running projects rack up
spend silently. `autoTitler.enabled: false` is a five-line config check
on the supervisor's admission path; ship it standalone.

`costUsdPerDay` in single-project mode is just a cost cap. No fairness,
no admission ordering across projects, no per-key bucket layering. That
heavier work waits for [rate-limit
fairness](./rate-limit-fairness.md).

## What this does not commit to

- Per-project shares of a per-key rate limit bucket. Single-project
  mode means "you have one budget; don't exceed it."
- Per-provider budget breakdown. Total cost only.
- Automatic budget recovery. Pause requires manual resume.
