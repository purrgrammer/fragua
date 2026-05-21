---
title: "Executor decomposition for fault-injecting property-based testing"
summary: "Finish modularizing packages/daemon/src/executor.ts so the per-run turn loop becomes a pure planner + named effect seams + single-step driver — the shape a fast-check harness needs to inject faults before/after every step and prove the SPEC invariants under adversarial schedules"
status: proposed
maturity: designed
last-reviewed: 2026-05-21
---

# Executor decomposition for PBT

> **North star, not scheduled.** The forcing function is the ability to
> stress-test the executor in a property-based harness that injects faults
> (crash, OCC conflict, abort, hang, store/snapshot/provision failure, clock
> skew) before and after every step and proves the invariants hold. We are NOT
> building that harness yet. We ARE shaping the decomposition so it's possible
> without rewriting the executor again.

## 1. What PBT-with-fault-injection demands from the code

A harness that "injects a fault before/after every step and proves invariants"
needs three properties the executor doesn't fully expose today:

1. **Pure step planning.** The decision of "given this turn's inputs, what
   facts + routing patch + observability come out" must be a pure function —
   no store reads, no `Date.now`, no `Math.random`, no I/O. Then invariants
   become `fast-check` properties over generated inputs, checked millions of
   times with zero setup. Today that logic is ~500 lines inlined in
   `dispatchOne`, interleaved with effects.

2. **Named effect seams.** Every side effect — handler invocation, fact commit,
   snapshot, worktree provision, store read — must be a single, wrappable
   boundary so the harness can deterministically make it fail, hang, or
   reorder. Some seams already exist (`tryAppendFact` → boolean,
   `makeOccController`, `snapshot-service`); others (handler invocation, run
   start/provision) are still inline.

3. **Single-step granularity + injectable determinism.** The harness drives one
   turn at a time, inspects state between turns, injects a fault, and asserts.
   That means (a) a `RunSession.step()` that executes exactly one turn and
   returns control, and (b) `clock` and RNG injected everywhere in step logic
   (today `opts.clock` exists and provider-retry takes `random`, but backoff
   jitter and `sleep` still read wall-clock / real timers).

## 2. Done so far (shipped, behaviour-preserving)

- `executor-helpers.ts` — pure leaf helpers (abort classification, routing
  readers, backoff/max-retries resolution, substitution args, resume-of, edge
  observability, sleep). Unit-tested.
- `occ-append.ts` — `tryAppendFact` + `makeOccController` (the per-`runOne`
  conflict/backoff/exhaustion controller). Unit-tested.
- `snapshot-service.ts` — `captureBoundarySnapshot` + `disposeTerminalWorktree`.
- `invoke-handler.ts` (Phase 3a) — the handler-invocation **fault seam**:
  abort-registry + leak-watchdog wrapper around `spec.handler(ctx)`, returning
  a structured `HandlerInvocation` (`result | leak | thrown{abortByName}`).
  Unit-tested. The harness substitutes this to model handler throw/hang/abort.
- **Determinism (§4) cleared** — `clock` was already threaded; `random` is now
  injectable too (`ExecutorOpts.random`, forwarded into `retryStep` +
  `decideProviderRetry`; `RetryStepInput.random` reaches `delayForAttempt`).
  The per-turn step path is now fully deterministic given `(clock, random)`.

`executor.ts` stays the orchestration entry point + public facade
(~1.78k lines, down from 2.17k).

**Resume here →** Phase 4 (the pure transition planner) is the next and
highest-leverage step. It's also the riskiest extraction (the coupled
post-handler policy block), so it's worth a design pass before the surgery.
All work to date is committed on `main` locally and not yet pushed.

## 3. Remaining phases (ordered by PBT value × tractability)

### Phase 4 — Transition planner (pure). *Highest PBT value.*

Extract the post-handler policy block (edge selection → goal gates → retry
policy → provider retry → budget pause/halt → fact-list rewrites → routing
patch) into a pure function:

```
planTransition(input: TransitionInput): TransitionPlan
//   input:  { state, foldDecision, graph, handlerResult, accounting,
//             effectiveRouting, now }     // `now` is a value, not a clock
//   output: { facts, routingPatch?, advanceAppliedTo?, observability,
//             terminalKind }              // no store, no I/O, no timers
```

The executor keeps the commit (`tryAppendFact`) and the `result` mutation goes
away (planner is referentially transparent). This is the single biggest
unlock: every fact-list-rewrite invariant (exactly-one-terminal, node_completed
preserved under budget halt, retry pause swaps node_started, etc.) becomes a
property over generated `TransitionInput`.

### Phase 3 — Handler-turn services. *Key fault seam.*

- ✅ `invokeHandler(...)` → structured `HandlerInvocation`
  (`result | leak | thrown{abortByName}`). Shipped. The deterministic seam for
  "handler throws / hangs (leak) / aborts" — the harness picks the outcome.
- ☐ `buildDispatchContext(...)` → `{ ctx, recorder, flushObservability, accountingSnapshot }`
  (the remaining half — still inline in `runOneInner`).

### Phase 5 — RunSession / RunDriver. *Single-step granularity.*

Own per-run loop state (turns, dispatches, consecutiveAborts, graph cache,
runEnv, OCC controller) behind `session.step(): StepResult`. This is the object
the PBT harness drives one step at a time; `runOne` becomes "loop `step()` to
terminal".

### Phase 6 — Executor loop module. *Scheduler/driver split.*

`runExecutor`'s poll / claim / drain / inflight tracking + `runOneSafe` move
out, so the scheduler is separable from the per-run driver.

### Phase 7 — The PBT harness itself. *North star, later.*

`fast-check` model that generates `(graph shape, handler-result stream, fault
schedule)` and drives `RunSession.step()` against a virtual store + virtual
clock, asserting invariants after every step and every injected fault.

## 4. Determinism debt to clear along the way

- ✅ Route all step-logic time through `opts.clock` — done; the remaining
  `Date.now()` calls in the daemon are lifecycle/observability only, off the
  fact-producing step path.
- ✅ Thread an injectable RNG for retry backoff jitter — done
  (`ExecutorOpts.random` → `retryStep` + `decideProviderRetry`).
- ☐ Make `sleep` virtualizable — open, but Phase 4 already keeps `sleep`
  strictly outside pure planning, so it's no longer on the step's decision path.

## 5. Invariants the harness will prove (tie to SPEC §4 I1–I10)

- **OCC / I1:** every fact append is version-checked; a concurrent advance →
  retry, never silent loss; version strictly increases.
- **Terminal absorbing:** exactly one terminal fact per run; no facts after it.
- **Causal node order:** `node_completed` precedes the next `node_started`;
  per-node iteration is non-decreasing within a pass.
- **Pause mapping:** pause reason ↔ status (`paused` vs `paused_auto`) is 1:1.
- **No orphan side effects:** crash-before-commit and crash-after-commit both
  recover (recorder durability + sweep requeue, which clears `currentNode`).
- **Spend conservation:** budget/retry/goal-gate fact-list rewrites preserve
  `node_completed` accounting — spend is never lost or double-counted.
- **activeMs:** monotonic and bounded by wall-clock across pause/crash cycles.
