# Intent fold semantics

> **Authoritative.** What `foldIntents` does and why. Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) §6 and [`handler-contract.md`](./handler-contract.md).

The daemon collects all unapplied intents (`seq > run_state.last_applied_seq`, `type LIKE 'intent.%'`) between dispatches and reduces them to a single decision via `foldIntents(intents, runStatus)`. The fold is a deterministic pure function: same inputs → same decision, no I/O, no clock dependence. The executor wires the decision into the next dispatch.

The fold has three jobs:

1. **Decide what happens this turn.** `cancel`, `proceed { shouldPause | shouldPauseAfterDispatch | dispatch }`, etc.
2. **Audit dropped intents** so an operator can debug "why didn't my pause take effect?". Every dropped intent ships out as an `intent.dropped` observability event.
3. **Advance `last_applied_seq`** past every intent in the batch so dropped + applied intents alike don't refire next turn.

---

## Per-intent table

Each intent has a *required state* (a precondition) and an *effect*. If the precondition fails the intent is dropped with a typed reason — never silently discarded.

| Intent | Required state | Effect | If precondition fails |
|---|---|---|---|
| `intent.run_enqueued` | n/a | none — already projected at enqueue | n/a (never reaches the fold) |
| `intent.cancel_requested` | non-terminal | terminal cancel; short-circuits the fold | n/a (terminal runs have no fold turn) |
| `intent.pause_requested` | `queued` / `running` | `shouldPause = true` (or defers, see R3) | `paused_human` / `paused` / `paused_auto` → drop `already_paused`; `quarantined` / terminal → drop `wrong_state` |
| `intent.steering_requested` | `queued` / `running` / `paused_human` / `paused` / `paused_auto` | concat `text` into `steering` (commit-order, `\n`-separated); empty-text steers on a valid state are silently consumed (advance `last_applied_seq`) with no effect — no `steering` output, no `intent.dropped` event | `quarantined` / terminal → drop `wrong_state` |
| `intent.human_input` | `queued` / `running` (post-wake) / `paused_human` / `paused` / `paused_auto` | set `humanInput` (last-wins on multiple) | `quarantined` / terminal → drop `wrong_state` |
| `intent.priority_adjusted` | fold: any (accepted unconditionally — the fold only runs while the executor dispatches a turn, so terminal runs never reach it; no explicit per-state filter) | merge `newPriority` into `routingDelta` (last-wins) | n/a |
| `intent.budget_adjusted` | fold: any (accepted unconditionally) | merge `routing.budget_override.<scope>.<metric> = newLimit` into `routingDelta`; the next turn-boundary budget check reads this before the graph/node attr | malformed payload (bad `scope`/`metric` or `newLimit ≤ 0`) → drop `wrong_state` |
| `intent.unquarantine` | `quarantined` | handled outside the fold by `wakeUnquarantine` (`packages/daemon/src/wake-pending.ts`); resolves `cancel` / `retry` / `treat_as_done` (see *Pending-intent driver* below) | non-quarantined → drop `wrong_state` |
| `intent.resume` | `paused` / `paused_auto` / `paused_human` / `quarantined` | handled outside the fold by `wakePending`; emits `fact.run_resumed` and re-queues the run — no-op if it reaches the fold | terminal → no fold turn |
| `intent.max_retries_adjusted` | fold: any (accepted unconditionally) | merge `routing.max_retries_override.<nodeId> = newLimit` into `routingDelta`; the next retry-policy check reads this before the node attr | malformed payload (bad `nodeId` or `newLimit ≤ 0`) → drop `wrong_state` |
| `intent.goal_gate_adjusted` | fold: any (accepted unconditionally) | merge `routing.max_goal_gate_retries_override = newLimit` into `routingDelta` | malformed payload (`newLimit ≤ 0`) → drop `wrong_state` |
| `intent.max_loops_adjusted` | fold: any (accepted unconditionally) | merge `routing.max_loops_override = newLimit` into `routingDelta` | malformed payload (`newLimit ≤ 0`) → drop `wrong_state` |
| `intent.accept_run` / `intent.discard_run` | terminal + `inbox_status='pending'` | handled outside the fold by `processOperatorActions` sweep — no-op if it reaches the fold | n/a |

---

## Combination precedence

| Rule | When it fires | Outcome |
|---|---|---|
| **R1** | any `intent.cancel_requested` in the batch | terminal cancel; every other intent in the batch (and any later cancels) → `dropped` with `superseded_by_cancel` (or `later_input_won` for the later cancels) |
| **R2** | multiple cancels | first-seq cancel wins for the recorded `reason`; the others drop with `later_input_won` |
| **R3** | pause + (steer OR human) on a dispatching run | **specific wins, pause defers.** Steer and/or human apply to this turn's handler dispatch; on success the executor commits `fact.run_paused{reason:"operator"}` instead of selecting the next edge. The pause IS effected (just on a different boundary), so it does NOT appear in `dropped` |
| **R4** | pause-only (no specific intent) on a dispatching run | `shouldPause` this turn — executor commits `fact.run_paused{reason:"operator"}` immediately, skips dispatch |
| **R5** | N steers (deduplicated within batch) | concat in seq-ascending order with `\n` separators; empty-text steers are a benign no-op (applied, not dropped) |
| **R6** | multiple `human_input` | last-seq's `input` wins; earlier inputs drop with `later_input_won` |
| **R7** | multiple `priority_adjusted` | last-seq's `newPriority` wins; earlier drop with `later_input_won` |

`shouldPause` and `shouldPauseAfterDispatch` are mutually exclusive — at most one is true on any decision.

---

## `intent.dropped` observability event

When the fold decides not to effect an intent (other than R3's *deferred-but-applied* case), it emits an audit trail entry:

```ts
{
  type: "intent.dropped",
  payload: {
    originalSeq: number,
    originalType: string,
    reason: "wrong_state" | "superseded_by_cancel" | "later_input_won" | "already_paused",
  }
}
```

The executor batches these via `appendObservabilityEvents` so they ride alongside facts in the same `seq` space. Consumers tailing `/runs/:id/events` see them interleaved in causal order.

---

## Pending-intent driver

The fold runs only while the executor is dispatching a queued / running run. State-changing intents on `paused_human` and `quarantined` runs (cancel, unquarantine, human_input) reach the daemon via `wakePending` (`packages/daemon/src/wake-pending.ts`), called at the top of every executor loop tick.

`wakePending` runs three sweeps in order:

1. **cancel** — any `paused_human` / `quarantined` run with an unapplied `intent.cancel_requested` → `fact.run_terminated{status:"aborted"}`. First, so cancel always wins (matches fold rule R1).
2. **human** — any `paused_human` run with an unapplied `intent.human_input` → `fact.run_resumed`. Intent stays unapplied so the next dispatch's fold consumes it as `decision.humanInput`.
3. **unquarantine** — quarantined runs with `intent.unquarantine`:
   - `cancel` → `fact.run_terminated{status:"aborted"}`
   - `retry` → `fact.run_resumed` (handler re-dispatches at the same iteration; provider dedups on the stable `idempotencyKey`)
   - `treat_as_done` → synthesise `fact.side_effect_done` for each orphan + `fact.run_resumed`. The synthetic dones match the orphans by `idempotencyKey`, so subsequent startup sweeps no longer flag them. This is the operator's safe escape hatch for providers without idempotency support.

Tests live at `packages/daemon/test/wake-pending.test.ts`.

---

## Property test

`P27` (in `packages/daemon/test/matrix.property.test.ts`) generates random batches of intents under all four `RunStatus` values and asserts the rules R1–R7 plus per-intent preconditions. 200 random runs per CI execution.
