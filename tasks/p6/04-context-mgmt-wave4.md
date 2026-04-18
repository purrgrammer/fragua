# P6.04 — Context-management hardening: Wave 4 (budgets)

## Goal

Turn cost tracking from an after-the-fact audit into a real ceiling
the pipeline respects. Workflow authors can cap spending per node
(`max_cost_usd`, `max_tokens`) and per run (`budget_usd`,
`budget_tokens`); breaches emit structured events and — under the
default `"stop"` policy — halt subsequent codergen calls with a
non-retryable failure. Also replaces the Wave-1 placeholder zeros on
`llm.start.budget` with real cumulative values from the ledger.

## Scope

Files created:

- `packages/core/src/engine/budget.ts` *(new)* — `BudgetLedger` pure
  reducer: `record()` applies a `CostDelta` + returns a
  `BudgetVerdict` (`ok | warn | stop` with latched flags per scope ×
  metric so each threshold fires once); `preflight()` checks without
  mutating; `query(nodeId, limits)` returns the `BudgetQuery` shape
  consumed by `CodergenInput.budget`; `costDeltaFromEvent()` extracts
  the relevant fields from a `cost.recorded` event.
- `packages/core/test/engine/budget.test.ts` *(10 cases)* — unit
  coverage for the reducer: limit resolution, warn/stop latching,
  cross-metric independence, preflight idempotence, run × node scope
  precedence, query shape.
- `packages/core/test/executor/budget-enforcement.test.ts` *(5 cases)* —
  executor-level integration via a mock backend that synthesises
  cost.recorded events: warn fires at 80 %, stop + non-retryable fail
  at 100 %, `policy="warn"` keeps the pipeline alive, real cumulative
  on `llm.start.budget`, per-node ceilings enforce independently.

Files extended:

- `packages/core/src/types/graph.ts` — `NodeAttrs.max_cost_usd` +
  `max_tokens`; `GraphAttrs.budget_usd` + `budget_tokens` +
  `budget_policy`.
- `packages/core/src/types/events.ts` — new event types `budget.warn` +
  `budget.stop` + `BudgetBreachData` interface.
- `packages/core/src/types/event-schemas.ts` — matching TypeBox
  schemas, wired into `PAYLOAD_SCHEMAS` so Wave-1's `validateEvent`
  payload check covers them.
- `packages/core/src/parser/parser.ts` — `NUMBER_KEYS` gains
  `max_cost_usd`, `max_tokens`, `budget_usd`, `budget_tokens` so DOT
  authors can write them unquoted.
- `packages/core/src/engine/index.ts` — re-exports the budget module.
- `packages/core/src/executor/execute.ts` — instantiates `BudgetLedger`
  only when a budget is configured; wraps the event sink so every
  `cost.recorded` feeds the ledger and any verdict fires a
  corresponding `budget.warn` / `budget.stop` event under the
  synthetic `__budget` node; populates `CodergenInput.budget` +
  `.budget_stopped` on every codergen + loop call.
- `packages/agent/src/backend.ts` — pre-flight: when
  `input.budget_stopped === true`, return `fail(reason, {
  non_retryable: true })` before `agent.prompt()`. Populates
  `llm.start.budget` from the executor-supplied snapshot (real
  cumulative values) instead of the Wave-1 zero placeholder.
- `packages/agent/test/llm-start-capture.test.ts` — existing "budget
  snapshot only emitted when max_cost_usd is set" case updated for
  Wave-4 behaviour (+1 new case: no-budget runs still omit the
  field).

## Design notes

- **Policy default**: `"stop"` is the default *when any ceiling is
  set*. Runs without budgets don't stand up the ledger at all (saves
  book-keeping on the common path).
- **Synthetic summariser nodes**: `__summary.*` cost flows through the
  ledger for the run-level cap but is not charged against the caller's
  per-node `max_cost_usd`. Keeps workflow authors free to configure a
  tight per-node cap without worrying that a summariser call they
  didn't ask for will breach it.
- **Node scope wins over run scope** on simultaneous breaches — the
  more-specific verdict is the more actionable one for the UI.
- **Warn latches**: each (scope, metric, node_id-or-__run__) pair
  fires `budget.warn` exactly once. `budget.stop` similarly, and the
  `stopped` ref flips at most once so concurrent handlers don't emit
  duplicate stops.

## Not in scope

- Redaction of captured prompts (still deferred per user direction).
- Token-pricing deviation (we trust `cost.recorded` as source of
  truth; pipelines with broken cost adapters will under-count).
- Soft-warn configurability (hard-coded at 80 %; if a user asks for
  configurable thresholds later it's a small follow-up).

## Verification

- `bun run ci` → 731 pass, 0 fail (baseline 716).
- `bun run packages/cli/bin/swarm.ts validate workflows/*.dot examples/*.dot`
  — unchanged, no regressions.
- Manual: write a workflow with `graph [budget_usd=0.10]`, run it, and
  observe `budget.warn` at ~80 % spend, `budget.stop` at 100 %, and
  the run failing non-retryably with reason containing
  `"budget ceiling exceeded"`.
