---
title: "Executor decomposition for fault-injecting property-based testing"
summary: "Finish modularizing packages/daemon/src/executor.ts so the per-run turn loop becomes a pure planner + named effect seams + single-step driver — the shape a fast-check harness needs to inject faults before/after every step and prove the SPEC invariants under adversarial schedules"
status: shipped
maturity: designed
last-reviewed: 2026-05-25
---

# Executor decomposition for PBT

> **Status (2026-05-25): goal met + fault injection complete.** The property-based
> harness is built, the SPEC §4 / §5 invariants are turned into properties **and
> tracked** (`packages/daemon/test/invariant-coverage.test.ts`), and the
> fault-injection layer is in: the whole post-handler policy is now pure +
> tier-1-tested (`planTransition` **and** `planAbort`), and
> `daemon/test/executor-faults.property.test.ts` sweeps OCC / handler-hang /
> orphan-side-effect / provision / store-commit faults at the effect seams over
> generated graphs. **The fault sweep already paid off** — it found a real P4
> divergence (the quarantine projection vs the `run_quarantined` fold), now fixed
> (`c4a9ff69`). Faults are injected at effect *boundaries* (where they can
> actually happen) × turn boundaries (`runOne({maxTurnsForTesting:1})` is the
> single-step primitive) — so the literal "before/after every step" stress test
> is realized **without** the `RunSession.step()` class refactor (Phase 5), which
> is retired along with 3b/6 (no fault payoff). Phase 8 (assembly factory) shipped
> for `fragua ci`. See §2. The original framing follows.
>
> **North star.** The forcing function is the ability to stress-test the executor
> in a property-based harness that injects faults (crash, OCC conflict, abort,
> hang, store/snapshot/provision failure, clock skew) before and after every step
> and proves the invariants hold. We ARE shaping the decomposition so it's
> possible without rewriting the executor again.

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

4. **Injectable assembly (dependencies, not just step logic).** `runOne`/
   `runExecutor` already take their dependencies via `ExecutorOpts` (`store`,
   `dispatcher`, `registry`, `tools`, `llmCall`, `provisioner`) — so the
   executor *itself* is injectable. The gap is that the **assembly** of those
   dependencies is ~400 lines inlined in `daemonCommand`
   (`packages/cli/src/commands/daemon.ts:128–~520`): provider-credential
   resolution → backend → tool registry → dispatcher → provisioner → `llmCall`.
   The harness wants to substitute a virtual store + a fake **tool registry** +
   a fake **credentials registry**; `fragua ci` wants the same seam with
   CI-appropriate adapters (env-sourced creds, no worktree, JSONL tailer). Both
   need that assembly extracted into a factory with the registries injectable —
   see Phase 8. **The `fragua ci` story (`docs/proposals/fragua-ci.md`) builds
   directly on this untangled executor.**

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
- `transition-planner.ts` (Phase 4) — `planTransition`: the **pure**
  success/transition-path policy (edge selection → budget → goal gates → retry
  → provider retry → `resultToFacts` → fact-list rewrites → routing patch). No
  store, clock, RNG, or I/O — a function of `(state, decision, graph,
  handlerResult, accounting, effectiveRouting, currentNode, iteration, now,
  random)`. The executor keeps the commit, OCC retry, and snapshot. Closure
  audit confirmed the cut clean; the full suite (incl. `matrix.property`) is
  green unchanged.

`executor.ts` stays the orchestration entry point + public facade
(~1.2k lines, down from 2.17k).

**The harness + the invariant properties (Phase 7, built pragmatically):**

- **Graph arbitrary** (`daemon/test/arbitraries/graph.ts`) — `makeArbGraph(kinds)`
  generates the Graph IR directly, spine-first / back-edges-last, bounded-index
  targets for shrink-safety. Covers llm / tool / routing / human, goal gates,
  budget ceilings, threads/summary, inputs. Self-checking: a **bootstrap
  property** runs the real `validate()` on every generated graph and asserts zero
  diagnostics (`daemon/test/graph-arbitrary.property.test.ts`).
- **Tier-1 — pure planner properties** (`daemon/test/transition-planner.property.test.ts`)
  — A–H over generated `TransitionInput`: purity/no-mutation, ≤1 terminal,
  node_started⊕pause/terminal, spend conservation, advanceAppliedTo, HITL pause
  (yield_human → run_paused_human), HITL answer (route-case selection), budget
  breach (stop halts / pause pauses, both keep node_completed).
- **Tier-2 — driven-executor harness** (`daemon/test/driven-executor.property.test.ts`)
  — `drive(graph, specFor, {crashTurns?})` runs the **real `runOne`** over a
  generated graph against an **on-disk WAL store** + an injected advancing clock,
  with a wake loop (paused_auto), HITL answering (paused_human →
  `intent.human_input`), and a simulated crash (cut the pass short → leave
  `running` → `startupSweep` requeues). Slices: all-success, fail+auto-wake,
  HITL, crash-recovery.
- **Shared invariant checker** (`daemon/test/invariants.ts`) — `checkRunInvariants`,
  one predicate per log-derivable invariant (P4 projection=fold, terminal
  absorbing, seq↑, causal order, pause↔status, activeMs); every driven slice
  calls it, so **P4 is proven over happy / wake / HITL / crash**.
- **Coverage map** (`daemon/test/invariant-coverage.test.ts`) — the tracked
  invariant→owner map (SPEC §4 I1–I10, the ARCH §10 P1–P27 matrix — all already
  owned — and the §5 set), asserted well-formed. Plus the exhaustive
  pause-mapping reducer property (`daemon/test/pause-mapping.test.ts`).

**Fault injection (SHIPPED 2026-05-25).** The §1 north-star fault list, realized
at the effect seams over generated graphs (`daemon/test/executor-faults.property.test.ts`,
`daemon/test/fault-store.ts`):

- **Abort-arm extraction** (Phase 4 remainder) — DONE. `planAbort`
  (`daemon/src/abort-planner.ts`) is the pure post-handler abort policy
  (reactive-budget halt/pause, watchdog timeout-retry/exhausted, plain abort);
  the executor keeps the commit / OCC re-drive / `consecutiveAborts` ceiling.
  Tier-1 properties A–G in `abort-planner.property.test.ts`. So the **whole**
  post-handler policy (success + abort) is now pure + property-tested.
- **OCC conflict** — `fault-store.ts` throws `ConcurrencyError` on a scheduled
  commit (the exact real-conflict signal). Swept: a transient conflict is
  absorbed (retry → same terminal); a persistent one halts bounded
  (`occ_exhausted`). Terminal-commit conflicts are scoped out (that's P18).
- **Handler hang** — a node that ignores its signal is leaked by the watchdog →
  `handler_timeout_leaked` + halt, never a wedge.
- **Orphan side-effect** — a lone `side_effect_intent` (recorder-durable, no
  `_done`) → `startupSweep` quarantines. **This sweep found the P4 bug above.**
- **Provision / store failure** — a throwing provisioner halts with
  `worktree_provision_failed`; a non-OCC commit error is fatal-but-clean (halt,
  never a wedge — only OCC retries).
- **Run-count scaling** — every property's `numRuns` goes through
  `pbtRuns(base)`, scaled by `FRAGUA_PBT_RUNS` (`FRAGUA_PBT_RUNS=20 bun test
  packages/daemon` is a deep adversarial pass).

**Retired (assessed 2026-05-25 — no fault-injection payoff):**

- **Phase 3b** (`buildDispatchContext`) — its only fault, "ctx-build throws," is
  already covered (`executor.abort-registry-leak.test.ts`) without it.
- **Phase 5** (`RunSession.step()`) **+ Phase 6** (loop module) — the *capability*
  ("inject before/after every step") is delivered by single-stepping via
  `runOne({maxTurnsForTesting:1})` + the faultable effect seams; faults are only
  meaningful at effect boundaries (pure sub-steps can't fail), so a class refactor
  of the hot loop to expose pure-step boundaries buys no coverage. Revisit only if
  a future fault needs sub-seam placement.
- **Phase 8** (assembly factory) — **SHIPPED** as a CLI-level extraction:
  `buildExecutorDeps` (`packages/cli/src/executor-deps.ts`) lets `fragua daemon`
  and `fragua ci` share the assembly. Credentials stayed store-backed (the
  env→creds bridge seeds the rows), so the sketched "injectable credentials
  registry" was dropped — the driven harness builds its deps directly.

## 3. Remaining phases (ordered by PBT value × tractability)

### Phase 4 — Transition planner (pure). *Highest PBT value.* — DONE (transition-path scope)

Extracted the post-handler **success/transition-path** policy (edge selection →
budget → goal gates → retry policy → provider retry → `resultToFacts` →
fact-list rewrites → routing patch) into `transition-planner.ts`:

```
planTransition(input: TransitionInput): TransitionPlan
//   input:  { state, decision, graph, handlerResult, accounting,
//             effectiveRouting, currentNode, iteration, now, random }
//             // `now` is a value, not a clock
//   output: { facts, routingPatch?, advanceAppliedTo?, observability }
//             // no store, no I/O, no timers
```

The executor keeps the commit (`tryAppendFact`), OCC retry, and snapshot; the
planner never mutates its `handlerResult` input (clones the transition variant).
This is the single biggest unlock: every fact-list-rewrite invariant
(exactly-one-terminal, node_completed preserved under budget halt, retry pause
swaps node_started, etc.) is now a property over generated `TransitionInput` —
the `matrix.property` suite stayed green through the extraction; dedicated
properties over `TransitionInput` are the follow-up.

Two deltas from the sketch above: `terminalKind` proved unnecessary (the success
arm always commits and returns `continue`; the loop self-terminates on the next
pass's status check), and the **abort arm** stays inline (its two-phase commit +
`consecutiveAborts`/`leakBudget` mutation make it a separate phase — see
"Resume here").

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

### Phase 7 — The PBT harness itself. *Built (pragmatic) — see §2.*

Built on the **current** executor rather than waiting for Phases 5/6: the graph
arbitrary + tier-1 planner properties + the tier-2 driven harness + the shared
`checkRunInvariants` + the coverage map (all in §2). It generates `(graph,
handler-result script, crash point)` and drives the real `runOne` over an on-disk
WAL store + an injected advancing clock, asserting the invariants on the
resulting event log. Coarser than the sketched `RunSession.step()` model — the
crash is `maxTurns`-grained, not injected before/after *every* step — but it
turns the SPEC §4 / §5 invariants into properties and tracks them today. Finer
per-step fault placement (and OCC/hang/orphan generative faults) ride Phase 5
when there's a reason to.

### Phase 8 — Assembly factory. *Unblocks `fragua ci`.* — DONE (2026-05-25)

Extracted the ~200-line executor assembly out of `daemonCommand` into
`buildExecutorDeps(input): ExecutorDeps` (`packages/cli/src/executor-deps.ts`):
dispatcher + auto-dispatcher resolver (real llm path — tool registry, backend
opts, per-node codergen factory), graph loader, credential/model registries,
summariser, and skills discovery, from a `(store, cwd, config, timeouts,
provider?, model?, homeDir?)` input. `daemonCommand` now calls it and keeps only
what differs (provisioner, auto-titler, `startDaemon` loop); `ciCommand` calls
it and drives `runOne`. Behaviour-preserving for the daemon (typecheck clean,
startup output identical; the harness inherits it by spawning `fragua daemon`).

Two deltas from the sketch: (1) the **tool/credentials registries did not
become injected ports** — credentials stayed store-backed
(`AuthStorage.fromStore`), and `fragua ci` seeds the store's
`provider_credentials` rows from env (`env-creds.ts`) *before* calling the
factory, so resolution is unchanged and the cred *source* is the store rows, not
a port; (2) `homeDir` *did* become injectable (skills discovery), for CI/test
control. The PBT harness never needed the injected-registry seam — it builds its
deps directly — so that idea is dropped rather than deferred.

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

**Now proven + tracked.** Each invariant has an owner in
`packages/daemon/test/invariant-coverage.test.ts` (SPEC §4 I1–I10, the ARCH §10
P1–P27 matrix — all already owned across store/daemon/matrix.property + server
routes — and this §5 set). Terminal-absorbing, causal order, projection = fold
(P4), spend conservation, pause↔status, and activeMs are checked on **every**
driven run via `checkRunInvariants`; OCC (P2), orphan-quarantine (P6), and
crash-recovery (P5) are store/matrix-owned and exercised generatively by the
harness. Pause↔status is also proven exhaustively over every `PauseReason`
(`pause-mapping.test.ts`).
