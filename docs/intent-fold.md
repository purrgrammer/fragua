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
| `intent.pause_requested` | `queued` / `running` | `shouldPause = true` (or defers, see R3) | `paused_hitl` → drop `already_paused`; `quarantined` / terminal → drop `wrong_state` |
| `intent.steering_requested` | `queued` / `running` / `paused_hitl` | concat `text` into `steering` (commit-order, `\n`-separated) | `quarantined` / terminal → drop `wrong_state` |
| `intent.hitl_input` | `queued` / `running` (post-wake) / `paused_hitl` | set `hitlInput` (last-wins on multiple) | `quarantined` / terminal → drop `wrong_state` |
| `intent.priority_adjusted` | non-terminal | merge `newPriority` into `routingDelta` (last-wins) | n/a |
| `intent.unquarantine` | `quarantined` | (handled outside the fold — currently unwired, see "Known gaps") | non-quarantined → drop `wrong_state` |

---

## Combination precedence

| Rule | When it fires | Outcome |
|---|---|---|
| **R1** | any `intent.cancel_requested` in the batch | terminal cancel; every other intent in the batch (and any later cancels) → `dropped` with `superseded_by_cancel` (or `later_input_won` for the later cancels) |
| **R2** | multiple cancels | first-seq cancel wins for the recorded `reason`; the others drop with `later_input_won` |
| **R3** | pause + (steer OR hitl) on a dispatching run | **specific wins, pause defers.** Steer and/or hitl apply to this turn's handler dispatch; on success the executor commits `fact.run_paused_hitl` instead of selecting the next edge. The pause IS effected (just on a different boundary), so it does NOT appear in `dropped` |
| **R4** | pause-only (no specific intent) on a dispatching run | `shouldPause` this turn — executor commits `fact.run_paused_hitl` immediately, skips dispatch |
| **R5** | N steers (deduplicated within batch) | concat in seq-ascending order with `\n` separators; empty-text steers are a benign no-op (applied, not dropped) |
| **R6** | multiple `hitl_input` | last-seq's `input` wins; earlier inputs drop with `later_input_won` |
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

## Known gaps

### `intent.unquarantine` is currently unwired
The HTTP endpoint persists the intent (`packages/server/src/store/routes.ts`) but no daemon code consumes it. Quarantined runs sit forever. The fold drops `intent.unquarantine` with `wrong_state` on non-quarantined runs (correct), but for actually-quarantined runs the dispatch loop never enters the fold (the executor skips quarantined status before reading intents).

### `intent.cancel_requested` on `paused_hitl`
Same root cause as the above. `wakePendingHitl` only checks for `intent.hitl_input`; cancel intents on a paused run don't transition the run to `cancelled`.

Both gaps will be addressed by a "pending-intent driver" that handles state-changing intents on non-running runs.

---

## Property test

`P27` (in `packages/daemon/test/matrix.property.test.ts`) generates random batches of intents under all four `RunStatus` values and asserts the rules R1–R7 plus per-intent preconditions. 200 random runs per CI execution.
