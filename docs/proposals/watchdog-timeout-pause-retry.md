---
title: Watchdog timeout should pause + auto-resume, not abort
status: proposed
maturity: designed
last-reviewed: 2026-05-06
rationale: Run 01kqwzpt0hyfws0a0j burned ~$17 across 4 dispatches because every watchdog `cause:"timeout"` abort threw away the orchestrator's accumulated transcript. Watchdog timeout is system-initiated and involuntary — closer to "supervisor pause" than to operator-intentional "abort" — but today it follows the same wipe-thread / fresh-dispatch path.
---

# Watchdog timeout should pause + auto-resume, not abort

> A handler that hits `maxMs` is currently classified as
> `fact.node_aborted{cause:"timeout"}` and the next dispatch starts
> with an empty `initialState.messages`. Operator cancel/steer
> (`cause:"aborted"`) deserves that wipe — the user said stop. A
> watchdog firing is the system saying "you've been at it too long";
> involuntary, no user intent. Treating both the same throws away
> minutes-to-hours of recoverable LLM work on every retry.

## Evidence

Run `01kqwzpt0hyfws0a0j` (`orchestrate` workflow):

- 4 dispatches over 2h19m, 7 sub-agents spawned, $16.79 spent.
- Dispatch 1 ended at 23:41:38 with `fact.node_aborted{cause:"timeout"}` after the 30-min default `maxMs` fired.
- Dispatches 2–3 followed the same shape and ended `cause:"aborted"` at 00:14:01 and 00:49:22 (system AbortSignal, non-Timeout — supervisor / executor decision, not operator intent — confirmed: zero `intent.*` writes from web in the run's window).
- Dispatch 4 added `fact.handler_timeout_leaked` on top because the codergen handler didn't honour `ctx.signal` within the +10s grace (separate proposal `docs/proposals/handler-ctx-signal.md` — TBD).
- Each redispatch used `resumeOf:"fresh"` and started with empty `initialState.messages` — even though the prior dispatch's 617 messages (including 5 sub-agent toolResults summing 90KB) sat on disk under `node_id="orchestrate"`. The data was preserved; the load path was gated on `thread_id` which the workflow didn't declare.

The operator's experience: the orchestrator re-asked Opus "decompose this task" four times in a row, each time spawning fresh sub-agents from scratch. The first dispatch had useful results in hand at 23:28:38; they were thrown away at 23:41:38. Three subsequent dispatches independently re-derived overlapping work.

## Surfaces involved

| File:line | What it does today |
| --- | --- |
| `packages/daemon/src/executor.ts:724` | `let abortCause: "timeout" \| "aborted"` — the union literal. |
| `packages/daemon/src/executor.ts:782-794` | On `wasAborted`, calls `abortResultToFacts(...)` regardless of `abortCause`. Always emits `fact.node_aborted` followed by re-dispatch. |
| `packages/daemon/src/executor.ts:1425-1430` | `classifyAbortCause` — maps `signal.reason instanceof TimeoutError` → `"timeout"`, anything else → `"aborted"`. |
| `packages/agent/src/handler-bridge.ts:116-123` | On every dispatch, `priorMessages = threadId ? loadPriorMessagesForThread(...) : undefined`. Without `thread_id` the new dispatch is hermetic. |
| `packages/types/src/swarm-events.ts:216-235` | `fact.node_aborted` schema — `cause: string` is loosely typed. |
| `packages/store/src/reducers.ts` | Folds `fact.run_paused` / `fact.run_resumed` / `routing.internal.auto_resume_at` for the existing `paused_retry` shape. |

The `paused_retry` machinery already exists — node-emitted `outcome: "retry"` flows through `fact.run_paused_retry { auto_resume_at }`, the wake-pending sweeper re-dispatches at the configured time, and **`thread_id` is honoured on resume**. Same plumbing, different categorisation.

## Proposed change

Re-categorise watchdog timeout as a system-initiated pause-retry instead of a node abort.

### Event shape

Today (timeout):

```
fact.node_aborted { cause: "timeout", partialTokens, partialCostUsd }
→ next dispatch:  resumeOf:"fresh", initialState.messages = []
```

Proposed (timeout):

```
fact.run_paused { reason: "timeout_retry", partialTokens, partialCostUsd, attemptedMs }
+ routing.internal.auto_resume_at = now + backoff
+ run_state.status = "paused_retry"
→ next dispatch:  resumeOf:"paused_retry", thread restored from messages table
```

Operator-initiated abort (`cause:"aborted"`) is unchanged — that path is correct as-is.

### Defaults & limits

- **Auto-resume delay:** 5s on first timeout, doubling to a 60s ceiling. Identical to the existing `paused_provider_retry` backoff curve.
- **Retry ceiling:** 3 timeouts on the same `(nodeId, iteration)` before escalating. On exhaustion, emit `fact.run_halted{reason:"timeout_exhausted",detail:"3 watchdog timeouts; thread continuity preserved but progress stalled"}` so the operator sees a clear escalation rather than another silent retry. Equivalent to the existing `provider_exhausted` shape.
- **Cost is preserved:** `partialTokens` / `partialCostUsd` carry forward into `run_state.metrics` exactly as on the current abort path (now correct after merge `b9d5cc3`).
- **Operator can override:** `intent.cancel` always wins; an operator pausing or cancelling a `paused_retry` run flows through the existing R1/R4 fold rules.

### Why "pause" not "abort"

Three reasons, in priority order:

1. **Thread continuity falls out for free.** The pause/resume code path already restores `initialState.messages` from the persisted transcript via the same handler-bridge load that HITL and provider-retry resumes use. No new code in the agent backend.
2. **The semantic matches user intuition.** A timeout is "we ran out of clock," not "the work was wrong." Resuming with prior context lets the agent pick up where it stalled — close a tool loop, finish a synthesis — instead of starting over.
3. **Status code becomes useful.** `paused_retry` is observable in the UI as "currently waiting to retry"; today's `running` (mid-redispatch after timeout) is indistinguishable from a healthy live run.

### Why not just default `thread_id` to `node.id` (option 1 from the post-mortem)

That fixes the symptom — orchestrate's transcript would be continuous — but leaves the abort taxonomy lying. A run that hit 4 watchdog timeouts would still report `4 × fact.node_aborted` in its event log, the UI would still show the run as "running" mid-retry, and the metrics tile would still be silent on retry counts. The transcript-restore is the most visible benefit but the categorical distinction has further dividends: surfacing retry counts in the UI, separating "the workflow chose to fail" from "the system gave up," and making `budget_usd` evaluation see a `paused` state to reason about.

Layer 2 of `docs/proposals/codergen-maxms-tuning.md` — separate ceilings for codergen vs verify-shaped work — composes orthogonally. If verify gets 90 min and the LLM still doesn't finish, this proposal still wants the next dispatch to resume from the prior transcript, not start from scratch.

## Migration

- One schema-version-touching change: `fact.run_paused.reason` adds the literal `"timeout_retry"` (existing union covers `"operator" | "provider_error" | "payment_required" | "budget"`). Bump per AGENTS.md table.
- One reducer change: `routing.internal.auto_resume_at` is already populated for `paused_provider_retry` / `paused_retry`; reuse without modification.
- One executor change: in `executor.ts:782-794`, branch on `abortCause === "timeout"` to emit the pause shape instead of the abort shape. Bound by per-`(nodeId,iteration)` retry counter (carried in `routing.internal.timeout_retries.<nodeId>`, mirroring `goal_gates.__retries`).
- README.md "What swarm delivers today" / "What swarm does not deliver today" — not currently load-bearing; no update needed unless a paragraph already calls out abort-on-timeout behaviour.
- `.agents/skills/swarm-debug/SKILL.md` §8 failure-mode playbook — add `paused_retry{reason:"timeout_retry"}` row, drop or annotate the `fact.node_aborted{cause:"timeout"}` row.

## What this does not propose

- **Retry budgets at workflow scope** are out of scope; the per-`(nodeId,iteration)` cap is sufficient. A future proposal can stack a cumulative-retry ceiling on top.
- **Replaying tool effects on resume** is unchanged — the existing pre-commit recorder + side-effect quarantine invariants apply. A timeout fires after `message_end` and after side-effect facts have already landed; the resumed call sees them as toolResults.
- **The leak path** (`fact.handler_timeout_leaked`) is unaffected. A handler that ignores `ctx.signal` past `maxMs + 10s` is still a bug; this proposal addresses the well-behaved case.

## Smoke test

A repro after the change:

1. Workflow with one codergen node, `max_ms = 60000` (1 min), no `thread_id` declared.
2. Prompt: "Use the bash tool to run `sleep 90` once, then summarise the output." Sleep blocks past `max_ms`; AbortSignal raised at 1 min.
3. Pre-change: `fact.node_aborted{cause:"timeout"}`, next dispatch starts fresh, infinite loop until operator intervenes.
4. Post-change: `fact.run_paused{reason:"timeout_retry"}`, `auto_resume_at` set, run resumes with the bash toolResult ("Command was aborted") in the transcript, and the model can choose to summarise the partial output rather than re-running the sleep.

Bonus: re-run the orchestrate workflow from the original failing input. With this proposal + the `thread_id` hotfix already landed (`92a29ab`), a single 30-min watchdog timeout no longer wastes the prior dispatch's sub-agent results.
