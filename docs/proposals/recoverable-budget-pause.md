---
title: Recoverable pause unification
status: shipped
maturity: specified
last-reviewed: 2026-05-04
---

# Recoverable pause unification

> **Shipped (commit `a2d3a6e [*] unify operator-resumable pauses behind paused + fact.run_paused`).** The operator-resumable family
> collapsed to a single non-terminal status `paused` and a single
> reason-discriminated fact `fact.run_paused{reason: "operator" |
> "provider_error" | "payment_required" | "budget"}`. Budget overruns
> are now recoverable by default: a cap hit emits
> `fact.run_paused{reason: "budget", scope, metric, limit, actual}`
> instead of terminal `fact.run_halted{reason: "budget"}`, and the
> operator raises the cap via `intent.budget_adjusted` (stored at
> `routing.budget_override.<scope>.<metric>`) before resuming. The
> `paused_provider_error` status was retired (status set + table-rebuild
> migration in the same commit); 402 routes to
> `reason: "payment_required"`, all other manual-class HTTP failures
> route to `reason: "provider_error"`. `budget_policy` parser enum
> gained `"pause"`; the default flipped from `"stop"` → `"pause"`,
> with `"stop"` and `"warn"` retained for CI gates that want
> terminal-on-overspend.
>
> The original motivation: a budget cap hit emitted
> `fact.run_halted{reason:"budget"}` (terminal — abandoned all
> upstream work) while a 402 emitted
> `fact.run_paused_provider_error{httpStatus:402,...}` (non-terminal,
> resumable). Two operator-fixable "out of money" conditions with
> opposite fates. Empirical pain that drove this: introspect's
> `drift` node hit a $2.00 cap at $2.41 (run `01kqjv5k9jfx0ez86k`),
> then $4.00 cap at $4.21 (run `01kqjwgsxgzxpew320`); each halt threw
> away ~$0.50 of upstream `collect` work and left no synthesised
> review. The shape below records the design as it landed; sections
> on shipped surfaces (operator endpoints, web UI, intent-fold
> integration) match current code. Sibling halts
> (`max_retries`/`max_loops`/`goal_gate`) remain
> follow-up scope and have not yet shipped.

## Shape

One non-terminal status:

```
paused — operator must act (resume, possibly after adjusting routing)
```

One fact, reason-discriminated:

```ts
type PauseReason =
  | "operator"          // intent.pause from the operator
  | "provider_error"    // 400 / 401 / 403 / 404 / 413 / 422
  | "payment_required"  // 402 — top-up off-ledger, then resume
  | "budget";           // local cap hit; raise via intent.budget_adjusted

interface FactRunPaused {
  type: "fact.run_paused";
  payload:
    | { reason: "operator"; nodeId: string }
    | { reason: "provider_error"; nodeId: string; httpStatus: number | null;
        provider: string; errorMessage: string }
    | { reason: "payment_required"; nodeId: string; provider: string;
        errorMessage: string }
    | { reason: "budget"; nodeId: string; scope: "node" | "run";
        metric: "cost" | "tokens"; limit: number; actual: number };
}
```

Optional intent for budget-reason adjustments:

```ts
interface IntentBudgetAdjusted {
  type: "intent.budget_adjusted";
  payload: { scope: "node" | "run"; metric: "cost" | "tokens"; newLimit: number };
}
```

Recorded in `routing.budget_override.<scope>.<metric>`. Subsequent
turn-boundary checks see the new ceiling. Resume is unchanged: the
existing naked `intent.resume` re-dispatches `(nodeId, iteration)`.

`budget_policy` parser enum gains `"pause"`. Default flips from
`"stop"` → `"pause"`. `"stop"` and `"warn"` remain available for CI
gates that want terminal-on-overspend.

## What collapses

| Before | After |
|---|---|
| `paused_provider_error` (status) | `paused` (status) |
| `paused_hitl` w/ no options (operator-driven via `intent.pause`) | `paused` with `reason: "operator"` |
| `fact.run_paused_provider_error` | `fact.run_paused{reason: "provider_error"}` (or `"payment_required"` for 402) |
| `fact.run_halted{reason:"budget"}` (terminal) | `fact.run_paused{reason:"budget"}` (recoverable), unless `budget_policy="stop"` |

**Untouched:**

- `paused_hitl` (workflow-authored question; resume action is *answer*, not *resume*)
- `paused_provider_retry`, `paused_retry` (auto-wake; daemon owes a clock tick)
- `quarantined` (code-contract failure; separate operator surface)

## Why `payment_required` earns its own reason

402 is operationally distinct from generic provider errors:

| Reason | Operator action | Will resume succeed? |
|---|---|---|
| `provider_error` (401/403/422/...) | rotate creds / fix request | sometimes — depends on the reason text |
| `payment_required` (402) | top up at provider's console | yes, deterministically |
| `budget` (local cap) | `intent.budget_adjusted` then `intent.resume` | yes |

UI surfaces differ (top-up reminder vs. "Raise & Resume" form), so
the discriminator earns its place. Daemon classifier in
`result-to-facts.ts` routes `httpStatus === 402` →
`reason: "payment_required"`; everything else in the manual class
stays `reason: "provider_error"`.

## Migration

Pre-release; in-flight runs preserved (option (a) in the
brainstorm). Single migration at boot:

```sql
-- Status rename
UPDATE run_state SET status = 'paused' WHERE status = 'paused_provider_error';

-- Schema CHECK gains 'paused', drops 'paused_provider_error'
-- (handled by ALTER + table-rebuild dance in @swarm/store migrations)

-- Fact-type rewrite (I3 immutability waived per AGENTS.md rule #11 —
-- pre-release, no prior-state compat). 402 routes to payment_required;
-- everything else to provider_error.
UPDATE events
SET type = 'fact.run_paused',
    payload = json_object(
      'reason',
      CASE WHEN json_extract(payload, '$.httpStatus') = 402
           THEN 'payment_required' ELSE 'provider_error' END,
      'nodeId',       json_extract(payload, '$.nodeId'),
      'httpStatus',   json_extract(payload, '$.httpStatus'),
      'provider',     json_extract(payload, '$.provider'),
      'errorMessage', json_extract(payload, '$.errorMessage')
    )
WHERE type = 'fact.run_paused_provider_error';
```

The 37-run dev DB survives. The taxonomy in the log matches the
taxonomy in the code; no reducer-alias dead weight.

## Surfaces touched

Per AGENTS.md rule #1's enum-literal-consumer warning, every place
that names the old status / fact:

- `packages/store/src/schema.sql` — CHECK constraint
- `packages/store/src/reducers.ts` — reducer case rename + reason switch
- `packages/store/src/message-queries.ts:184,194` — SQL `status IN (...)` strings
- `packages/store/src/sweep.ts` — comment + status set
- `packages/store/src/analytics-queries.ts` — `paused_provider_error` column → `paused` (broader meaning; per-reason drill-down is a follow-up)
- `packages/types/src/swarm-events.ts` — `RunStatus` union, `FactEvent` union, intent union (`IntentBudgetAdjusted`), `HaltReason` (drop `"budget"` if pause is the only path; keep if `budget_policy="stop"` retains it — it does)
- `packages/core/src/parser/parser.ts:420` — `ENUM_KEYS` for `budget_policy` gains `"pause"`
- `packages/core/src/engine/budget-policy.ts` — `evaluateBudget` returns a pause decision when `policy === "pause"` (new `BudgetDecision.shouldPause` + reason payload)
- `packages/core/src/handler/intent-fold.ts:112` — operator-resumable status set
- `packages/daemon/src/executor.ts` — emit `fact.run_paused` instead of halt when budget breach + policy=pause; rename existing `paused_provider_error` references
- `packages/daemon/src/result-to-facts.ts:132` — 402 classifier branch
- `packages/daemon/src/wake-pending.ts:58,118` — sweep set
- `packages/server/src/schemas.ts` — `RawRunStatus` literal set
- `packages/server/src/store/runs-routes.ts:165` — `VALID_STATUSES`
- `packages/server/src/store/runs-adapter.ts:25` — status mapping + new `intent.budget_adjusted` endpoint (`POST /runs/:id/budget`)
- `packages/web/src/components/RunPausedNotice.tsx` — generalise (see UI section)
- `packages/web/src/components/RunControls.tsx:106-115` — resume-gate condition
- `packages/web/src/components/Inbox.tsx:36` — filter set
- `packages/web/src/lib/humanize.ts` — labels

Doc obligations (AGENTS.md rule #1):

- `docs/ARCHITECTURE.md` §2 (schema), §3 (event taxonomy + status enum)
- `docs/SPEC.md` §3.4 (status enum)
- `.agents/skills/swarm-run/SKILL.md` cheat sheet (new `POST /runs/:id/budget` shape; `paused` status replaces `paused_provider_error`)
- `.agents/skills/swarm-debug/SKILL.md` §3 (status fold), §8 (pause-reason taxonomy)

## UI

Generalise `RunPausedNotice`. Today it dispatches via
`findActiveProviderError`; replace with `findLatestPauseFact(events)`
returning `{reason, payload}`. Body branches on `reason`:

| `reason` | Body | Buttons |
|---|---|---|
| `operator` | "Run paused by operator." | Resume / Cancel |
| `provider_error` | `<provider> returned <status> (<reason text>)` (today's `formatProviderError`) | Resume / Cancel |
| `payment_required` | "<provider> reports payment required. Top up at the provider's console, then resume." | Resume / Cancel |
| `budget` | "Budget reached: <metric> <actual> ≥ <limit> (<scope>)." + numeric input pre-filled to `limit` | Raise & Resume / Resume / Cancel |

"Raise & Resume" sends `intent.budget_adjusted` then `intent.resume`
(web bundles the two; intents stay separate at the protocol level —
preserves naked-`intent.resume` symmetry across all pause reasons).

`RunControls.tsx`: drop the `paused_provider_error` carve-out, add
the same carve-out for `paused`. The notice owns the surface.
`paused_hitl`-with-options keeps its `HitlChoice` carve-out.

## Open questions

- **Default flip surprise.** Workflows leaving `budget_policy` unset
  inherit `"pause"`. CI runs that relied on terminal-on-overspend
  need to opt into `"stop"` explicitly. Mitigation: changelog entry;
  the opt-in is one attr. Lean: ship the flip — interactive use is
  the loud majority.

- **`reason` as enum-literal consumer.** `PauseReason` adds another
  union to grep when extended (max_retries, max_loops, goal_gate
  later). Acceptable — far less surface than adding a status.

- **402 auto-retry.** Stays manual per the provider-retry table.
  This proposal only changes where 402 lives in the status taxonomy
  (now `paused{reason:"payment_required"}`), not its policy.

## Sibling halts (out of scope)

The unified shape makes these one-line additions to `PauseReason`,
each in its own focused proposal:

- `paused{reason:"max_retries"}` — currently `fact.run_halted{reason:"max_retries_exceeded"}`. Operator may want to grant N more retries.
- `paused{reason:"max_loops"}` — currently halt. Often signals a bug, but a workflow author might raise the ceiling.
- `paused{reason:"goal_gate"}` — currently halt after `max_goal_gate_retries`.

Each needs its own UX call (which lever does the operator pull?). A
follow-up proposal "Recoverable terminal-class halts" can fold them
in once the budget pattern soaks.

## What this does not commit to

- **Folding `paused_hitl` into `paused`.** Action shape genuinely
  differs (input vs. resume).
- **Folding `paused_provider_retry` / `paused_retry` into `paused_auto`.**
  Cosmetic; separate proposal.
- **Auto-raising any cap.** Operator decides every adjustment.
- **Retroactive resume of pre-rename halted runs.** Once
  `halted{reason:"budget"}`, stays halted; the new policy applies to
  runs enqueued after this lands.
- **Cumulative-spend reset on resume.** Cost continues accumulating
  against the (possibly raised) ceiling. Audit trail distinguishes
  "limit was raised from X to Y at seq N" via `intent.budget_adjusted`.
- **Inline budget adjustment in `intent.resume`.** Keeping
  `intent.resume` naked across all pause reasons preserves the
  symmetry; web bundles the two-call sequence in one operator click.
