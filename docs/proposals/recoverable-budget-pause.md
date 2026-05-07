---
title: Recoverable pause unification
status: shipped
maturity: specified
last-reviewed: 2026-05-07
---

# Recoverable pause unification

> **Multi-stage proposal.** Stage 1 (operator-resumable family)
> shipped in commit `a2d3a6e` (2026-05-04). Stages 2–3 below extend
> the taxonomy to the auto-wake family and convert
> operator-recoverable terminal halts into pause reasons. Each stage
> is independently shippable; staging exists to keep PR-2's enum
> rename atomic without coupling it to the sibling-halt UX work.

## Status partition (target end-state)

Three non-terminal pause statuses, mapped 1:1 to the three operator-
attention categories. Adding a new pause case lands as a `PauseReason`
literal — no new status, no schema migration, no enum-literal-consumer
grep across packages.

| Status | Who acts | When | Color |
|---|---|---|---|
| `paused` | Operator | After fixing root cause; optional cap raise | yellow |
| `paused_auto` | Daemon (timer); operator may short-circuit | When `auto_resume_at` elapses, or on `intent.resume` | blue |
| `paused_hitl` | Operator answers via `intent.hitl_input` | Workflow `wait.human` node yielded | orange |

Token assignment lands in PR 3 — today's palette uses gray for every
paused-family status and blue for HITL. The new partition re-stripes
the existing palette (or adds tokens) to match the operator-attention
distinction.

## `PauseReason` is the exhaustiveness anchor

`PauseReason` lives in `@swarm/types/swarm-events.ts` and partitions
1:1 to projecting status. Reducer rule: status follows reason. No
sub-policy field needed.

```ts
type PauseReason =
  // → paused (operator must act)
  | "operator"
  | "provider_error"      // manual class (400/401/403/404/413/422)
  | "payment_required"    // 402
  | "budget"              // local cap; intent.budget_adjusted
  | "max_retries"         // sibling-halt — Stage 3
  | "goal_gate"           // sibling-halt — Stage 3
  | "max_loops"           // sibling-halt — Stage 3
  | "abort_loop"          // sibling-halt — Stage 3
  | "provider_exhausted"  // sibling-halt — Stage 3
  // → paused_auto (carries auto_resume_at)
  | "provider_retry"      // was: paused_provider_retry
  | "handler_retry"       // was: paused_retry
  | "timeout_retry";      // was: fact.node_aborted{cause:"timeout"}
```

UI contract: `RunPausedNotice` (run-detail) takes a
`Record<PauseReason, ReasonRenderer>` so adding a literal forces a
TypeScript exhaustiveness error in the renderer until a body branch
ships. Global feed renders coarse status only (`paused` /
`paused_auto` / `paused_hitl`); per-reason knobs live in run-detail.

---

## Stage 1: operator-resumable family (shipped a2d3a6e)

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
> review.

### Shape

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

### What collapsed in Stage 1

| Before | After |
|---|---|
| `paused_provider_error` (status) | `paused` (status) |
| `paused_hitl` w/ no options (operator-driven via `intent.pause`) | `paused` with `reason: "operator"` |
| `fact.run_paused_provider_error` | `fact.run_paused{reason: "provider_error"}` (or `"payment_required"` for 402) |
| `fact.run_halted{reason:"budget"}` (terminal) | `fact.run_paused{reason:"budget"}` (recoverable), unless `budget_policy="stop"` |

**Preserved (addressed in Stage 2 / Stage 3):**

- `paused_hitl` (workflow-authored question; resume action is *answer*, not *resume*) — kept distinct
- `paused_provider_retry`, `paused_retry` (auto-wake; daemon owes a clock tick) — collapsed to `paused_auto` in Stage 2
- `quarantined` (code-contract failure; separate operator surface) — out of scope; orthogonal to pause taxonomy

### Why `payment_required` earns its own reason

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

### Migration (Stage 1 — shipped)

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

---

## Stage 2: auto-wake family

> Status: ready to ship — taxonomy completion. Stage 1 scoped the
> unification to the operator-resumable family;
> `paused_provider_retry` and `paused_retry` were preserved
> ("Untouched"). Stage 2 collapses them under one reason-discriminated
> shape and fixes a real bug: `intent.resume` short-circuits
> `paused_provider_retry` but not `paused_retry` (a `wakeResume`
> sweep gap with no caller-side workaround).

### What collapses in Stage 2

| Before | After |
|---|---|
| `paused_provider_retry` (status) | `paused_auto` (status); reason `"provider_retry"` |
| `paused_retry` (status) | `paused_auto` (status); reason `"handler_retry"` |
| `fact.run_paused_retry` | `fact.run_paused{reason:"handler_retry", nodeId, attempt, delayMs, resumeAt, maxRetries}` |
| `fact.run_paused{reason:"provider_error", policy:"auto-retry"}` | `fact.run_paused{reason:"provider_retry", attempt, resumeAt, ...}` (status follows reason 1:1; `policy` field retired) |
| `wakeResume` sweep set: `paused | paused_hitl | paused_provider_retry` | `paused | paused_hitl | paused_auto` (closes the `paused_retry` gap) |

`provider_error` keeps its arm for the manual class
(400/401/403/404/413/422); 402 stays under `payment_required`. The
`policy` field on the `provider_error` arm becomes unused (auto-retry
moves under `provider_retry`); drop it.

### Fact shape additions

```ts
interface FactRunPaused {
  type: "fact.run_paused";
  payload:
    | /* Stage 1 arms unchanged */
    | { reason: "provider_retry"; nodeId: string; httpStatus: number | null;
        provider: string; errorMessage: string;
        attempt: number; resumeAt: number }
    | { reason: "handler_retry"; nodeId: string;
        attempt: number; delayMs: number; resumeAt: number; maxRetries: number };
}
```

`fact.run_paused_retry` retires from `FactEvent`. Per-attempt
observability: `fact.provider_retry_attempted` keeps its current
shape; mirror `fact.handler_retry_attempted` for symmetry (decide at
PR time — cheap to add, defaults are handler-side).

### Reducer rule

`fact.run_paused` projects status from reason — no `policy` field,
no special case per fact type:

```ts
const AUTO_WAKE_REASONS = new Set<PauseReason>([
  "provider_retry", "handler_retry", "timeout_retry",
]);
const projectedStatus = AUTO_WAKE_REASONS.has(payload.reason)
  ? "paused_auto"
  : "paused";
```

`auto_resume_at` is set on `routing.internal.auto_resume_at` for
auto-wake reasons (existing key; no schema churn). `wakeAutoResume`
reads it as today.

### Wake-pending changes

```diff
 wakeResume:    statuses = ["paused", "paused_hitl",
-                           "paused_provider_retry"]
+                           "paused_auto"]
 wakeAutoResume: statuses =
-  ["paused_retry", "paused_provider_retry"]
+  ["paused_auto"]
 wakeCancel:    statuses = ["paused", "paused_hitl",
-                           "quarantined"]
+                           "paused_auto", "quarantined"]
```

The `wakeCancel` extension is incidental: today an operator can't
cancel a `paused_retry` run via `intent.cancel_requested` (the sweep
doesn't include it). After Stage 2 every paused-class status accepts
cancel.

### Migration (Stage 2)

The reducer change for `fact.run_paused_retry` would require a
fact-type rewrite; the reason-only-projection change for provider
auto-retry would require a payload rewrite. We instead **delete
legacy-status runs at boot** (per AGENTS.md ground rule #11 —
pre-release, no prior-state compat).

```sql
-- v8 migration:
-- 1. Status enum table rebuild: drop paused_provider_retry / paused_retry,
--    add paused_auto.
-- 2. Drop in-flight runs in the legacy auto-wake states.
DELETE FROM run_state
  WHERE status IN ('paused_provider_retry', 'paused_retry');
DELETE FROM events     WHERE run_id NOT IN (SELECT id FROM run_state);
DELETE FROM messages   WHERE run_id NOT IN (SELECT id FROM run_state);
DELETE FROM artifacts  WHERE run_id NOT IN (SELECT id FROM run_state);
DELETE FROM blobs      WHERE id NOT IN (SELECT blob_id FROM artifacts);
-- (cascade explicit since events has no FK to run_state)
```

Dev-DB run count takes a hit (typically <10 runs in legacy auto-wake
states at any given moment).

---

## Stage 3: sibling halts

> Status: design ready, implementation bundled. Five `HaltReason`
> literals are conceptually "the system gave up because some integer
> was reached." Each is operator-recoverable and today throws away
> upstream work. Convert each to a `PauseReason`. Bundled into a
> single PR (rather than five small ones) since the changes are
> mechanically similar and share one code-review pass.

### Conversions

| Before | After | Cap-adjustment intent | Action shape |
|---|---|---|---|
| `fact.run_halted{reason:"max_retries_exceeded"}` | `paused{reason:"max_retries"}` | `intent.max_retries_adjusted { nodeId, newLimit }` | Raise & Resume / Resume / Cancel |
| `fact.run_halted{reason:"goal_gate_unsatisfied"}` | `paused{reason:"goal_gate"}` | `intent.goal_gate_adjusted { newLimit }` | Raise & Resume / Resume / Cancel |
| `fact.run_halted{reason:"max_loops"}` | `paused{reason:"max_loops"}` | `intent.max_loops_adjusted { newLimit }` | Raise & Resume / Resume / Cancel |
| `fact.run_halted{reason:"abort_loop"}` | `paused{reason:"abort_loop"}` | — (ceiling is config, not per-run) | Resume / Cancel |
| `fact.run_halted{reason:"provider_exhausted"}` | `paused{reason:"provider_exhausted"}` | — (chain config is global) | Resume / Cancel |

Naked `intent.resume` always works (= "one more attempt"); the
cap-adjustment intents are operator UX sugar that prevents immediate
re-pause. New intents fold the same way as `intent.budget_adjusted`
(write to `routing.<key>` so the next turn-boundary check reads the
new ceiling).

### What stays terminal

| Reason | Why terminal |
|---|---|
| `schema_drift` | Run pinned to incompatible schema; redeploy required, not resume |
| `error` | Engine bug class; no operator fix |
| `occ_exhausted` | Concurrency conflict storm; engine bug |
| `aborted_exit` | Workflow author asserted "stop" via `<abort>`; resume contradicts intent |
| `budget` (when `budget_policy="stop"`) | Workflow author opt-in for terminal-on-overspend (CI gates) |

After Stage 3: `HaltReason` shrinks to `{ schema_drift, error,
occ_exhausted, aborted_exit, budget }` — the genuinely
terminal-class halts.

### Fact shape additions

```ts
interface FactRunPaused {
  type: "fact.run_paused";
  payload:
    | /* Stage 1 + Stage 2 arms unchanged */
    | { reason: "max_retries"; nodeId: string; currentLimit: number; attempts: number }
    | { reason: "goal_gate"; gateNodeId: string; currentLimit: number }
    | { reason: "max_loops"; currentLimit: number; dispatches: number }
    | { reason: "abort_loop"; nodeId: string; consecutiveAborts: number }
    | { reason: "provider_exhausted"; nodeId: string; attempts: number;
        cumulativeMs: number };
}
```

### Migration (Stage 3)

Per-reason, no migration needed. Old runs already terminal stay
terminal; new runs land on the new shape. Stage 3 is pure
forward-only behaviour change — converting a halt site to a pause
site doesn't affect the historical event log.

## Surfaces touched (cumulative)

Per AGENTS.md rule #1's enum-literal-consumer warning. Stage 1 sites
already shipped in `a2d3a6e`; Stage 2 + 3 surfaces below.

### Stage 2

- `packages/types/src/swarm-events.ts` — `RunStatus` (drop `paused_provider_retry` / `paused_retry`, add `paused_auto`); `PauseReason` (`provider_retry`, `handler_retry`); `FactEvent` (retire `fact.run_paused_retry`; extend `fact.run_paused` arms; drop `policy` field on `provider_error` arm)
- `packages/store/src/schema.sql` — CHECK constraint table-rebuild; `CURRENT_SCHEMA_VERSION = 8`
- `packages/store/src/migrations.ts` — v8 delete-legacy delta
- `packages/store/src/reducers.ts` — reason-driven projection; drop `fact.run_paused_retry` case
- `packages/store/src/message-queries.ts` — `status IN (...)` strings
- `packages/store/src/sweep.ts` — status set
- `packages/store/src/analytics-queries.ts` — paused-status columns
- `packages/core/src/handler/intent-fold.ts` — `isPaused` set
- `packages/daemon/src/wake-pending.ts` — three sweep sets (see diff in Stage 2 above)
- `packages/daemon/src/executor.ts` — emit `fact.run_paused{reason:"handler_retry"}` instead of `fact.run_paused_retry`; provider auto-retry branch sets `reason:"provider_retry"`
- `packages/daemon/src/result-to-facts.ts` — provider classifier branches on `httpStatus` → `provider_error` / `payment_required` / `provider_retry`
- `packages/server/src/schemas.ts` — `RawRunStatus`
- `packages/server/src/store/runs-routes.ts` — `VALID_STATUSES`
- `packages/server/src/store/runs-adapter.ts` — status mapping
- `packages/web/src/components/RunPausedNotice.tsx` — exhaustive `Record<PauseReason, ReasonRenderer>` + auto-wake renderers
- `packages/web/src/components/RunControls.tsx` — `canResume` set
- `packages/web/src/components/RunStatusBadge.tsx` — color tokens (re-stripe palette per partition)
- `packages/web/src/components/Inbox.tsx` — filter set
- `packages/web/src/lib/humanize.ts` — labels
- `packages/web/src/styles/theme.css` — palette token assignments if existing tokens are repurposed

### Stage 3 (per-conversion in one PR)

Each of the five sibling-halt conversions touches:

- `packages/types/src/swarm-events.ts` — `HaltReason` -1 literal, `PauseReason` +1 literal; new intent type (3 of 5 conversions)
- `packages/daemon/src/executor.ts` — halt → pause emission swap at the relevant call site
- `packages/core/src/handler/intent-fold.ts` — fold rule for the new intent (3 of 5)
- `packages/server/src/store/routes.ts` — POST endpoint for the new intent (3 of 5)
- `packages/server/src/store/runs-adapter.ts` — adapter fn (3 of 5)
- `packages/web/src/components/RunPausedNotice.tsx` — body branch + Raise & Resume flow (3 of 5)
- `packages/web/src/lib/humanize.ts` — label

### Doc obligations (cumulative — AGENTS.md rule #1)

- `docs/ARCHITECTURE.md` §2 (schema), §3 (event taxonomy + status enum)
- `docs/SPEC.md` §3.4 (status enum)
- `STATUS.md` "What swarm delivers today" — pause-status partition + recoverable terminal-class halts
- `.agents/skills/swarm-run/SKILL.md` cheat sheet (new intent endpoints; status set)
- `.agents/skills/swarm-debug/SKILL.md` §3 (status fold), §8 (pause-reason taxonomy)

## UI (extension)

`RunPausedNotice` (run-detail) takes a
`Record<PauseReason, ReasonRenderer>` so adding a `PauseReason`
literal forces a TypeScript exhaustiveness error until the renderer
ships. Each renderer returns `{ title, body, actions }`.

| Reason | Title | Body | Actions |
|---|---|---|---|
| `operator` | Paused by operator | "Run paused by operator." | Resume / Cancel |
| `provider_error` | Provider error — paused | `<provider> returned <status> (<text>)` | Resume / Cancel |
| `payment_required` | Payment required — paused | `<provider> reports payment required. Top up at the provider's console, then resume.` | Resume / Cancel |
| `budget` | Budget reached — paused | `Budget reached: <scope> <metric> <actual> ≥ <limit>` + numeric input | Raise & Resume / Resume / Cancel |
| `provider_retry` | Provider retry — auto | `<provider> returned <status>; retrying in <Xs> (attempt <n>/<cap>)` + countdown | Resume (short-circuit) / Cancel |
| `handler_retry` | Retrying — auto | `Node <X> retrying in <Xs> (attempt <n>/<max>)` + countdown | Resume (short-circuit) / Cancel |
| `timeout_retry` | Watchdog — retrying | `Node <X> hit max_ms; retrying in <Xs> (attempt <n>/3)` + countdown | Resume (short-circuit) / Cancel |
| `max_retries` | Retries exhausted — paused | `Node <X> exhausted <N> retries.` + numeric input | Raise & Resume / Resume / Cancel |
| `goal_gate` | Goal gate unsatisfied — paused | `Gate <X> failed after <N> cycles.` + numeric input | Raise & Resume / Resume / Cancel |
| `max_loops` | Dispatch ceiling — paused | `Run exceeded <N> dispatches.` + numeric input | Raise & Resume / Resume / Cancel |
| `abort_loop` | Abort loop — paused | `Node <X> aborted <N> consecutive times.` | Resume / Cancel |
| `provider_exhausted` | Provider chain exhausted — paused | `Provider chain exhausted after <N> attempts (<reason>).` | Resume / Cancel |

"Raise & Resume" sends `intent.<X>_adjusted` then `intent.resume`
(web bundles; intents stay separate at the protocol level — preserves
naked-`intent.resume` symmetry across all pause reasons).

`RunControls.tsx`: paused-status carve-out unchanged from Stage 1
(notice owns the per-reason surface). `paused_hitl`-with-options
keeps its `HitlChoice` carve-out. Auto-wake reasons render through
`RunPausedNotice` like operator-resumable reasons; the auto-wake
distinction surfaces via the countdown + "short-circuit" Resume
verbiage rather than a separate banner.

### Global feed

Coarse-status only. `paused`, `paused_auto`, `paused_hitl` each
render as a status pill; reason is not surfaced in list views.
Operators drill into run-detail for per-reason knobs.

## Open questions

### Locked-in (recorded for audit)

- **Stage-2 PR atomicity** → single atomic PR. The taxonomy rename
  couples ~30 files via TypeScript exhaustiveness; the
  add-then-remove split adds an intermediate state without reducing
  diff risk.
- **`paused_auto` name** → kept. Alternatives considered:
  `paused_pending`, `paused_waiting`, `paused_timer`.
- **Provider auto-retry literal** → distinct `reason:"provider_retry"`
  rather than `reason:"provider_error", policy:"auto-retry"`.
  Symmetry with `handler_retry` and `timeout_retry`; status follows
  reason 1:1, no projection field.
- **Cap-adjustment intent shape** → typed-per-cap
  (`intent.max_retries_adjusted`, etc.) rather than polymorphic
  `intent.routing_overridden`. Matches `intent.budget_adjusted`;
  validation + audit + UI dispatch are local.
- **Stage-2 migration** → delete legacy-status runs at boot
  (`paused_provider_retry`, `paused_retry`). Pre-release; AGENTS.md
  ground rule #11.
- **Sibling-halt PR shape** → all five conversions in one PR (PR 5
  in the staging plan). Mechanically similar; one code-review pass.

### Still open

- **Per-attempt observability for `handler_retry`.** Today
  `fact.provider_retry_attempted` lands one fact per provider
  auto-retry attempt. Mirror with `fact.handler_retry_attempted`?
  Lean: yes — symmetry is cheap. Decide at PR-2 time.
- **Token assignment for the new palette.** Today
  `sw-accent-warn` (orange) is described as "resource pressure";
  `sw-accent-human` (blue) is HITL; everything paused is
  `sw-accent-idle` (gray). The new partition (paused yellow /
  paused_auto blue / paused_hitl orange) either repurposes existing
  tokens (rewriting their semantic descriptions) or adds new ones.
  Decide at PR-3 time.
- **Default flip surprise (carried from Stage 1).** Workflows
  leaving `budget_policy` unset inherit `"pause"`. CI runs that
  relied on terminal-on-overspend need to opt into `"stop"`
  explicitly. Shipped Stage 1 took the flip; revisit if a CI gate
  surfaces silent recoverability.

## What this does not commit to

- **Folding `paused_hitl` into `paused`.** Action shape genuinely
  differs (input vs. resume); status carries useful operator
  distinction.
- **Auto-raising any cap.** Operator decides every adjustment.
- **Retroactive resume of pre-conversion halted runs.** Once
  `halted{reason:"max_retries_exceeded"}` (etc.), stays halted; the
  new policy applies to runs that hit the boundary after the
  relevant Stage 3 conversion lands.
- **Cumulative-spend / cumulative-retry reset on resume.** Counters
  continue accumulating against the (possibly raised) ceiling. Audit
  trail distinguishes "limit was raised from X to Y at seq N" via
  the cap-adjustment intent.
- **Inline budget / cap adjustment in `intent.resume`.** Keeping
  `intent.resume` naked across all pause reasons preserves the
  symmetry; web bundles the two-call sequence in one operator click.
- **Generic `intent.routing_overridden { key, value }` in place of
  typed-per-cap intents.** Polymorphic payloads are harder to
  validate, audit, and route to UI body branches. N small typed
  intents > one polymorphic intent.
- **Lifting `aborted_exit` / `schema_drift` / `error` /
  `occ_exhausted` / `budget` (when `budget_policy="stop"`) into
  paused reasons.** All five stay terminal — see Stage 3 "What
  stays terminal."
