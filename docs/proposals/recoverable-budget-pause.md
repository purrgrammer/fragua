---
title: Recoverable budget pause
status: proposed
maturity: designed
last-reviewed: 2026-05-02
---

# Recoverable budget pause

> Today, hitting `budget_usd` / `max_cost_usd` / `budget_tokens` /
> `max_tokens` with `budget_policy="stop"` (the default) emits
> `fact.run_halted { reason: "budget" }` — terminal. The whole run's
> work is abandoned. The only alternative is `budget_policy="warn"`
> which emits `budget.warn` / `budget.stop` events but never halts —
> equally extreme, just on the other side.
>
> Empirically a problem this session: introspect's `drift` node hit a
> $2.00 cap at $2.41 (run `01kqjv5k9jfx0ez86k`), then $4.00 cap at
> $4.21 (run `01kqjwgsxgzxpew320`). Each halt threw away ~$0.50 of
> upstream `collect` work and left no synthesised review. The
> recovery path was "bump caps, re-fire from scratch" — paying for
> `collect` again every time.

## Shape

Add a third value: `budget_policy="pause"`. Symmetric to
`paused_provider_error` and `paused_retry`:

1. New run status: `paused_budget`
2. New fact: `fact.run_paused_budget { scope: "node"|"run", metric: "cost"|"tokens", limit: number, actual: number, nodeId? }`
3. New optional intent: `intent.budget_adjusted { scope, metric, newLimit }` — operator raises the offending cap before resuming. Recorded in `routing.budget_override.<scope>.<metric>` so subsequent turn-boundary checks see the new ceiling.
4. Resume via existing `intent.resume`: re-dispatches the same `(nodeId, iteration)`. If the operator didn't adjust, the next turn boundary trips again immediately — symmetric to `paused_provider_error` resuming into the same broken provider.

Default `budget_policy` flips from `"stop"` to `"pause"`. `"stop"` and `"warn"` remain available for workflows that genuinely want terminal-on-overspend (CI gates, anonymous untrusted runs).

## Why this is load-bearing

The current `stop` policy treats "ran $0.41 over the cap" the same as a halt-on-error. That's a category error: a budget cap is an operator's *limit*, not a *contract violation*. Limits should pause for review; contract violations halt.

Concretely: the introspect workflow accumulates costs by adding more files and proposals to scan over time. Caps will keep getting brushed past as the project grows. Without `paused_budget`, every overrun nukes the run's accumulated work; with it, the operator gets to choose between "raise the limit" and "actually that's enough, cancel."

This also closes a UX gap with the existing pause states. `paused_provider_error` and `paused_retry` already exist for recoverable suspensive states; `paused_budget` slots in beside them with the same shape (operator intent + resume).

## Compatibility

- Workflows pinning `budget_policy="stop"` keep their behavior — opt-out is explicit.
- Workflows pinning `budget_policy="warn"` unchanged.
- Workflows with no `budget_policy` get the new default (pause). Migration is a no-op for runs that don't hit caps; runs that hit caps now suspend instead of dying — the UX improvement is opt-in by virtue of the better default.
- Schema bump for the new status enum value (`paused_budget`); mirror in `swarm-events.ts` `RunStatus` union and ARCH §2 schema CHECK.
- Reducer (`packages/store/src/reducers.ts`) handles `fact.run_paused_budget` analogously to `fact.run_paused_provider_error`.
- `wakePending` (`packages/daemon/src/wake-pending.ts`) gains a `paused_budget` sweep that wakes on `intent.resume` (mirrors the existing `paused_hitl` / `paused_provider_error` sweeps).

## Open questions

- **Should `intent.resume` carry the override inline?** I.e. `intent.resume { budgetAdjustments: [{ scope, metric, newLimit }] }` instead of separate intents. Cleaner one-shot UX (no race between adjusting and resuming). Argues against the symmetry with `paused_provider_error` (which is resumed without payload). Probably worth doing — operator workflow is "look at the run, decide new caps, resume" as one action.
- **Should `paused_budget` count against the daemon's concurrency cap?** `paused_retry` releases its slot during backoff so other queued runs can claim. `paused_hitl` likewise. `paused_budget` should follow the same pattern — release the slot, the run is effectively waiting on a human just like HITL.
- **What about `max_loops` exhaustion?** That's also a cap; should it also become paused_loops? Argument: yes, same pattern — the workflow author can raise `max_loops` if appropriate. Argument: no, `max_loops` exhaustion usually signals an infinite loop bug, not a bumpable resource. Leave as halt for now; revisit if real workloads brush against it.
- **How does `paused_budget` interact with cumulative spend?** If the budget was `run_max_cost_usd=5`, the run paused at $5.41, the operator raises to $10. The run resumes and continues; cost continues accumulating. Does `total_cost_usd` reset or continue? Continue — the metric is honest, the operator chose to spend more. The fact payload should distinguish "limit was raised from X to Y at seq N" so the audit trail shows the decision.

## Sibling: other "recoverable halt" classes

The user surfaced this in the broader frame of "for runs that halt due to budget and *some other recoverable errors*". This proposal scopes to budget. Other candidates worth considering once this lands:

- **`paused_max_loops`** — `max_loops` exhaustion. Discussed above; defer.
- **`paused_max_retries`** — `max_retries` exhaustion. Currently `fact.run_halted { reason: "max_retries_exceeded" }`. Same argument for pause: an operator might want to grant another N retries.
- **`paused_goal_gate`** — `goal_gate_unsatisfied` after `max_goal_gate_retries`. Similar shape.

These are out of scope for this proposal but share its UX rationale. A follow-up proposal "Recoverable terminal-class halts" could fold them all in once the budget pattern soaks.

## What this does not commit to

- **Auto-raising caps.** The operator must decide. The system does not silently extend a budget after a halt — that defeats the purpose of having one.
- **Cumulative budget across pauses.** Budget = total spent on the run. Resuming after `paused_budget` continues accumulating against the (possibly raised) ceiling.
- **`budget_policy="pause"` for individual `max_cost_usd` per node.** Same policy applies at both scopes; the fact payload distinguishes.
- **Retroactive resume.** Once a run is `halted` with `reason="budget"`, it stays halted — no migration path. The new policy applies to runs enqueued after it lands.
