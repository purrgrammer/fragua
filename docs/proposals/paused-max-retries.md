---
title: "paused{reason:\"max_retries\"} — Stage 3 / max_retries slice"
status: in-progress
maturity: design
last-reviewed: 2026-05-17
---

# `paused{reason:"max_retries"}` — Stage 3 / max_retries slice

> **Scope note.** This proposal implements the `max_retries` row of the
> Stage 3 conversions table in
> [`docs/proposals/recoverable-budget-pause.md`](./recoverable-budget-pause.md)
> (see "Conversions" table at §Stage 3). Sibling rows (`goal_gate`,
> `max_loops`, `abort_loop`, `provider_exhausted`) are out of scope
> here; they may land in a follow-up bundle. This slice is cut first
> because retry exhaustion is the most frequent operator-visible halt
> today.

> **Design-divergence note (read before implementing).** The task that
> commissioned this proposal described the target status as
> `paused_max_retries`, "parallel to `paused_budget`". Both names are
> wrong relative to the shipped design. Stage 1 of
> `recoverable-budget-pause.md` (commit `a2d3a6e`) renamed
> `paused_budget` to `paused{reason:"budget"}`, and the type surface
> for `max_retries` is already fully declared in tree (see §2 below).
> This proposal follows the shipped Stage 3 shape: no new `RunStatus`
> literal, no schema migration, no new intent type. The prompt's §5
> ("Halt path retained for post-resume exhaustion via
> `max_retries_pause_count`") is addressed in §6 as an
> explicitly-rejected alternative.

---

## 1. Motivation

Retry exhaustion is handled at `packages/daemon/src/executor.ts:1488–1498`:

```ts
} else if (action.kind === "halt") {
  observability.push({
    type: "node.retry_exhausted",
    payload: { nodeId: currentNode, attempts: priorRetries + 1, maxRetries },
  });
  result = {
    kind: "halt",
    reason: "max_retries_exceeded",
    detail: `node "${currentNode}" exhausted ${maxRetries} retries`,
    pauseContext: { currentLimit: maxRetries, attempts: priorRetries + 1 },
  };
}
```

This is **terminal**: the run moves to `halted` and accumulated work is
discarded. Yet the full infrastructure for operator-adjustable caps —
types, intent fold, server route, UI renderer — has already landed in
tree (Stage 1 of `recoverable-budget-pause.md`). The only missing piece
is wiring the executor halt-site to emit a pause instead of a halt.

Already-shipped operator infrastructure:

- **Intent fold** — `packages/core/src/handler/intent-fold.ts:193–201`
  handles `intent.max_retries_adjusted`, writing
  `routing.max_retries_override.<nodeId>`. Comment already reads
  "Stage 3 of docs/proposals/recoverable-budget-pause.md".
- **Server route** — `packages/server/src/store/routes.ts:517–538`
  exposes `POST /runs/:id/max_retries` accepting `{ nodeId, newLimit }`.
- **Executor override read** — `packages/daemon/src/executor.ts:1449–1451`
  reads `maxRetriesOverride` from routing before consulting the static
  node attr:
  ```ts
  const maxRetriesOverride = readNumber(state.routing[maxRetriesOverrideKey(currentNode)]);
  const maxRetries =
    maxRetriesOverride > 0 ? maxRetriesOverride : resolveMaxRetries(completedNode.attrs, graph.attrs);
  ```
- **`FactEvent` union arm** — `packages/types/src/swarm-events.ts:451–462`
  already declares `{ reason: "max_retries"; nodeId: string; currentLimit: number; attempts: number }`.
- **`RunPausedNotice` renderer** — `packages/web/src/components/RunPausedNotice.tsx:466–484`
  already handles `max_retries` with "Retries exhausted — paused" title,
  body text, and Raise & Resume / Resume / Cancel actions.

The gap: the executor at line 1488 still emits
`result = { kind: "halt", reason: "max_retries_exceeded" }` so the run
terminates. The override at line 1449 is in place, but it is unreachable
on a dead run — `intent.max_retries_adjusted` on a halted run is a
no-op.

The budget path is the precise parallel: `budget_policy="pause"` emits
`fact.run_paused{reason:"budget"}` instead of a halt, pauses the run,
and resumes after `intent.budget_adjusted` + `intent.resume`
(`packages/daemon/src/executor.ts:1653–1709`,
`packages/core/src/engine/budget-policy.ts:19`). This proposal
completes the identical pattern for `max_retries`.

---

## 2. What does not change

The entire type and UI surface for this conversion is already in tree.
The implementation PR touches **only** `packages/daemon/src/executor.ts`.

| Item | Status |
|---|---|
| `PauseReason "max_retries"` | Declared — `packages/types/src/swarm-events.ts:72` |
| `HaltReason` without `"max_retries_exceeded"` | Already absent — `swarm-events.ts:102` |
| `RunStatus` partition (no `paused_max_retries`) | Unchanged — `paused` covers operator-recoverable cases |
| `FactEvent` union arm `{ reason:"max_retries"; nodeId; currentLimit; attempts }` | Declared — `swarm-events.ts:451–462` |
| `RunPausedNotice` renderer for `max_retries` | Declared — `RunPausedNotice.tsx:466–484` |
| Schema CHECK constraint | Unchanged — v9 (`migrations.ts:942–944`) already permits `'paused'` |
| `intent.max_retries_adjusted` fold | Unchanged — `intent-fold.ts:193–201` |
| `POST /runs/:id/max_retries` route | Unchanged — `routes.ts:517–538` |
| `wake-pending.ts` sweep | Unchanged — `max_retries` not in `AUTO_WAKE_PAUSE_REASONS` (`swarm-events.ts:84–88`); operator-resume only |

---

## 3. What changes

### 3.1 `packages/daemon/src/executor.ts` — halt-site swap

**Halt-site swap (lines 1488–1498).** Replace the `result = { kind:
"halt", reason: "max_retries_exceeded", … }` assignment with a local
sentinel, parallel to the `budgetPause` pattern at lines 1653–1709:

```ts
// Before
} else if (action.kind === "halt") {
  observability.push({
    type: "node.retry_exhausted",
    payload: { nodeId: currentNode, attempts: priorRetries + 1, maxRetries },
  });
  result = {
    kind: "halt",
    reason: "max_retries_exceeded",
    detail: `node "${currentNode}" exhausted ${maxRetries} retries`,
    pauseContext: { currentLimit: maxRetries, attempts: priorRetries + 1 },
  };
}
```

```ts
// After
} else if (action.kind === "halt") {
  observability.push({
    type: "node.retry_exhausted",
    payload: { nodeId: currentNode, attempts: priorRetries + 1, maxRetries },
  });
  retriesExhaustedPause = {
    nodeId: currentNode,
    currentLimit: maxRetries,
    attempts: priorRetries + 1,
  };
}
```

**Fact-swap arm.** After the per-node result block and before the atomic
commit, add a `retriesExhaustedPause` check modelled exactly on the
`budgetPause` arm (executor.ts:1653–1709):

```ts
// max_retries pause: strip fact.node_started, emit fact.run_paused{reason:"max_retries"}.
// Mirrors the budgetPause arm. Counter is NOT reset; cumulative attempts
// continue accumulating on resume per the shipped Stage 3 non-goal.
if (retriesExhaustedPause !== undefined) {
  facts = facts.filter((f) => f.type !== "fact.node_started");
  facts.push({
    type: "fact.run_paused",
    payload: {
      reason: "max_retries",
      nodeId: retriesExhaustedPause.nodeId,
      currentLimit: retriesExhaustedPause.currentLimit,
      attempts: retriesExhaustedPause.attempts,
    },
  });
}
```

The reducer already handles `fact.run_paused` by reading
`payload.reason` and projecting `run_state.status`. Reason `"max_retries"`
is not in `AUTO_WAKE_PAUSE_REASONS`, so the reducer projects `status =
"paused"` (operator must act). No reducer change needed.

**Reuse note.** The `pauseContext: { currentLimit, attempts }` already
built at executor.ts:1497 is the payload verbatim — field names are
identical. This struct was clearly anticipating this change.

---

## 4. Counter semantics on resume

Per the shipped Stage 3 non-goal (`recoverable-budget-pause.md:519–522`):

> **Cumulative-spend / cumulative-retry reset on resume.** Counters
> continue accumulating against the (possibly raised) ceiling.

The per-node retry counter lives at `internal.retry_count.<nodeId>`
(`packages/core/src/types/context.ts:18–20`). It is zeroed only on
success (`packages/daemon/src/executor.ts:1424–1429`).

On resume, the executor re-dispatches the same `(nodeId, iteration)`.
The counter is `N` (= the old cap). With a raised cap of `M > N`, the
node gets `M - N` more attempts before exhausting again. On re-exhaust,
`retriesExhaustedPause` fires again with `attempts = M`, and the run
pauses a second time. The operator either raises again or cancels.

This is the simplest correct shape. It requires no new routing keys and
no new graph attrs. An operator who wants to "give up after one resume"
clicks Cancel.

---

## 5. Backward compatibility

Existing `run_state` rows with `status = "halted"` and an event-log
entry `fact.run_halted{reason:"max_retries_exceeded"}` stay terminal.
The schema CHECK and the TypeScript types are consistent with this
(the CHECK still includes `'halted'`; the historical payload is opaque
JSON in the event store and never round-tripped through the now-narrowed
`HaltReason` union at the read path — the reducer projects on
`event.type`, not `payload.reason`).

The implementation PR should add a regression fixture: load a synthetic
event log containing a legacy `fact.run_halted{reason:"max_retries_exceeded"}`
payload and confirm `run_state.status` projects as `"halted"`.

---

## 6. Alternative considered and rejected: pause-then-halt via `max_retries_pause_count`

The original task description proposed keeping
`halt{reason:"max_retries_exceeded"}` as a *post-resume exhaust* case:
the first exhaust pauses; if the operator resumes and the node exhausts
again, halt. Tracking would require a new routing key
(`max_retries_pause_count.<nodeId>`) incremented on each pause and
compared against a configurable per-node attr (default N = 1).

**Why rejected:**

1. **Contradicts the shipped Stage 3 design.** The shipped proposal
   explicitly takes the opposite position:
   - "Naked `intent.resume` always works (= one more attempt)"
     (`recoverable-budget-pause.md:322`).
   - "Cumulative-spend / cumulative-retry reset on resume" is listed as
     a **non-goal** (`recoverable-budget-pause.md:519–522`).
   - The UI action row for `max_retries` is "Raise & Resume / Resume /
     Cancel" — Cancel is the operator's "give up" action, not a forced
     halt after N pauses (`recoverable-budget-pause.md:444`).
   Introducing a pause-count halt for `max_retries` alone, when the
   four sibling conversions (`goal_gate`, `max_loops`, `abort_loop`,
   `provider_exhausted`) don't have it, creates an inconsistent
   operator experience.

2. **Contract surface for marginal gain.** A new routing key, a new
   graph attr with defaulting logic, a new test path for the
   second-exhaust transition, and a new UI affordance — all for a UX
   that Cancel already covers.

3. **Per AGENTS.md rule #1, docs win.** The right way to introduce
   pause-count semantics is a follow-up proposal amending Stage 3's
   design *across all five sibling halts uniformly*, not a one-off
   divergence on `max_retries`.

**If this pattern is later desired,** the correct design is a graph
attr `max_pause_count` (integer, default ∞) shared by all
operator-resumable pause reasons, with routing key
`internal.pause_count.<nodeId>`. That is a separate proposal.

---

## 7. Migration

None. `recoverable-budget-pause.md:373–378`:

> Per-reason, no migration needed. Old runs already terminal stay
> terminal; new runs land on the new shape. Stage 3 is pure
> forward-only behaviour change.

Schema v9 already permits `'paused'` in the status CHECK
(`packages/store/src/migrations.ts:942–944`).

---

## 8. Same-PR doc obligations when the implementation lands

Per AGENTS.md rule #1. The type and UI surface are already in tree;
only the doc sweep remains alongside the executor change.

| Changed | Must update in same PR |
|---|---|
| `packages/daemon/src/executor.ts` — halt-site conversion | `docs/ARCHITECTURE.md` §3 — add `fact.run_paused{reason:"max_retries"}` to the event taxonomy narrative; remove `max_retries_exceeded` from the halt-reason narrative if still present |
| (above) | `docs/SPEC.md` §3.4 — refresh the status table; `paused` row should enumerate `max_retries` among operator-recoverable reasons |
| (above) | `STATUS.md` — move "max-retries exhaustion halts the run" out of "What swarm delivers today" if claimed there; add operator-recovery entry |
| (above) | `recoverable-budget-pause.md` — append "Implemented (max_retries slice — PR #N, commit sha)" under the Stage 3 `max_retries` row. Proposal stays `shipped` overall. |
| Skill update (`.agents/skills/swarm-debug/SKILL.md` §8 paused-reasons table) | **Deferred** to the final sibling-halt sweep when all five Stage 3 conversions land. |

---

## 9. Test plan

Two integration tests in the implementation PR. Suggested file:
`packages/daemon/test/executor.max-retries-pause.test.ts` (or folded
into `executor.retry-reset.test.ts` for layout consistency).

### Test 1 — Operator-recovery path

**Suite:** `describe("executor — max_retries pause + operator resume")`

```
test("retries to exhaustion → paused{reason:max_retries} → cap raise + resume → succeeds")
```

Steps:
1. Build a graph with a `work` codergen node, `max_retries = 1`.
2. Drive `runOne` with a handler stub that fails twice (`outcomeStatus`
   `"retry"` then `"retry"`).
3. Assert `state.status === "paused"`.
4. Assert the latest `fact.run_paused` payload matches
   `{ reason: "max_retries", nodeId: "work", currentLimit: 1, attempts: 2 }`.
5. Append `intent.max_retries_adjusted { nodeId: "work", newLimit: 3 }`.
6. Append `intent.resume`.
7. Drive `runOne` again with a handler stub that succeeds.
8. Assert `state.status === "completed"`.
9. Assert no `fact.run_halted` event anywhere in the log.

### Test 2 — Naked resume re-pauses with incremented counter; no halt

**Suite:** same `describe`

```
test("naked intent.resume (no cap raise) re-pauses with attempts incremented — no halt")
```

Steps:
1. Same graph, `max_retries = 1`.
2. Drive to exhaustion → paused (steps 1–4 of Test 1).
3. Append `intent.resume` only (no cap raise).
4. Drive `runOne` with a handler stub that fails twice more.
5. Assert `state.status === "paused"` (not `"halted"`).
6. Assert the second `fact.run_paused` payload has `attempts` strictly
   greater than the first pause's `attempts`.
7. Assert no `fact.run_halted` event between the two pause events.

This test encodes the shipped Stage 3 semantic ("cumulative counter,
no auto-halt") and is the explicit regression guard against the rejected
alternative in §6.

### Test 3 — Intent fold + executor override read

**Suite:** `describe("intent.max_retries_adjusted — override read")`

```
test("max_retries_override.<nodeId> lands in routing and is preferred by the executor over the static attr")
```

Steps:
1. Graph with `max_retries = 1`. Fold `intent.max_retries_adjusted
   { nodeId: "work", newLimit: 5 }` into a `RunState`.
2. Assert `state.routing["max_retries_override.work"] === 5`
   (fold at `packages/core/src/handler/intent-fold.ts:193–201`).
3. Drive a retry sequence; assert the executor uses `maxRetries = 5`
   (not 1) — verifiable by confirming the run can survive 4 failures
   without pausing.

---

## 10. Open questions

1. **`runs-adapter.ts` status mapping.** Confirm `"paused"` is already
   handled generically (should be since Stage 1; worth a grep before the
   PR lands). No new adapter entry is expected.

2. **`VALID_STATUSES` in `runs-routes.ts`.** Confirm the server-side
   filter for `?status=` queries already includes `"paused"` for the
   `max_retries` pause path (same status literal, different reason in the
   event payload). No change expected.
