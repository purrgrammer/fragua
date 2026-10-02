# assessment-survey.md — Fragua claim inventory for verification lenses

> Generated from `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/handler-contract.md`, `STATUS.md`, `AGENTS.md`, and `.fragua/scratch/assess/` CI evidence. All data read from disk and treated as untrusted facts. Focus: whole project.

---

## 1. Baseline — CI evidence

### 1.1 Typecheck

All 10 workspace packages pass `tsc --noEmit`. **Exit 0.**

| Package | Result |
|---|---|
| @fragua/types | pass |
| @fragua/test-utils | pass |
| @fragua/core | pass |
| @fragua/workspace | pass |
| @fragua/store | pass |
| @fragua/web | pass |
| @fragua/agent | pass |
| @fragua/server | pass |
| @fragua/daemon | pass |
| @fragua/cli | pass |

### 1.2 Lint

`biome check .` — 874 files checked in 264 ms. No fixes applied. **Exit 0.**

### 1.3 test:node

Runner: `bun test`. **Exit 0.**

| Metric | Count |
|---|---|
| Tests pass | 3645 |
| Tests skip | 1 |
| Tests fail | 0 |
| `expect()` calls | 94034 |
| Files | 312 |
| Wall time | 87.11 s |

Stderr noise (expected by tests, not failures): blob-gc simulated FS error, handler-leak lines from property suites, oversized-observability-event truncation, env-creds refusal messages, harness daemon lock contention retries, terminal-type legacy enum printing.

### 1.4 test:web

Runner: vitest (jsdom). **Exit 0.**

| Metric | Count |
|---|---|
| Test files | 93 |
| Tests pass | 725 |
| Tests fail | 0 |
| Duration | 10.00 s |

One `ExperimentalWarning: localStorage is not available` from node (expected, not a failure).

### 1.5 Package sizes — source and test lines

| Package | src (lines) | test (lines) | test:src ratio |
|---|---|---|---|
| agent | 5237 | 7920 | 1.51× |
| cli | 9545 | 10550 | 1.10× |
| core | 13062 | 12771 | 0.98× |
| daemon | 8037 | 21478 | 2.67× |
| server | 4321 | 7248 | 1.68× |
| store | 10315 | 11707 | 1.13× |
| test-utils | 423 | 151 | 0.36× |
| types | 1773 | 90 | 0.05× |
| web | 28925 | 15847 | 0.55× |
| workspace | 5804 | 5076 | 0.87× |

**Total measured source lines:** 87442 (from `largest-files.txt` total).

Largest individual files (lines): `store/src/store.ts` 2632, `core/src/engine/validator.ts` 1793, `agent/src/backend.ts` 1553, `web/src/components/RunConversation.tsx` 1534, `types/src/events.ts` 1461, `web/src/lib/api.ts` 1358, `store/src/types.ts` 1330, `cli/src/commands/operator.ts` 1322, `daemon/src/transition-planner.ts` 1271.

### 1.6 Documented dependency direction vs measured import edges

Documented (AGENTS.md / ARCH §11): `web → server → store ← daemon → core ← agent`

Measured (import-edges.txt — import counts by package):

| Package | Imports from |
|---|---|
| agent | core(13), workspace(6), store(5), types(4) |
| cli | core(20), store(18), agent(9), types(6), workspace(5), daemon(3), server(2) |
| core | types(17), store(6) |
| daemon | core(27), store(24), workspace(1), types(1) |
| server | store(15), core(14), workspace(4), types(2), agent(2) |
| store | types(12), core(4), store(1) |
| web | types(23), core(6) |
| workspace | core(10), types(4), workspace(1) |
| test-utils | — |
| types | — |

**Edges present in the measured graph that are not explicitly listed in the documented chain:**
- `agent → store` (5 edges) — doc does not list this; agent is described as depending on core + workspace; the store import is not in the high-level chain.
- `agent → workspace` (6 edges) — not in the documented chain (chain shows `core ← agent`).
- `server → agent` (2 edges) — chain shows `server → store` but not `server → agent`.
- `daemon → workspace` (1 edge) — chain shows `daemon → core` but not `daemon → workspace`.
- `core → store` (6 edges) — chain shows `store ← daemon` but does not explicitly list `core → store`; AGENTS.md notes core's store-pulling sub-entries (`./handler`, `./intent-plane`, `./read-plane`) are server-side only, suggesting core does import store for those entry points.
- `store → core` (4 edges) — introduces a cycle in the stated chain; not explained in the documented direction.
- `web → core` (6 edges) — chain says `web → server`; web does not list `server` as a measured import (web is an HTTP client, communicating via HTTP not import), but it does import core directly.
- `cli → daemon` (3 edges), `cli → server` (2 edges) — CLI is described as a direct store-client, but it also imports from daemon and server packages.

---

## 2. Claim inventory

### 2.1 Lens: store

#### I1 — Every write is one SQLite transaction; events + projection updated together

**Quote** (ARCH §0 invariants table): *"Every write is one SQLite transaction; events + projection updated together — Store module API; AST lint (`packages/store/test/lint.test.ts`): no `await` / `JSON.stringify` / `JSON.parse` / `fetch` / TypeBox `Value.Check` inside a `writeTxn`/`db.transaction()` callback or a same-file helper it calls"*

**Files to check:** `packages/store/src/store.ts` (transaction wrapping of every mutation), `packages/store/test/lint.test.ts` (AST rule enforcement), `packages/store/src/schema.sql` (table definitions confirming run_state updated alongside events).

---

#### I2 — No handler state outside the projection

**Quote** (SPEC §4): *"No handler state outside the projection"*

**Files to check:** `packages/core/src/handler/types.ts` (HandlerContext shape — all cross-turn state is via `ctx.routing`), handler implementations under `packages/core/src/handler/handlers/`.

---

#### I3 — Intents always-appendable; facts OCC-checked

**Quote** (ARCH §0): *"Two distinct store methods (`appendIntent`, `appendFact`)"*

**Files to check:** `packages/store/src/store.ts` (`appendIntent` and `appendFact` implementations), `packages/store/src/types.ts` (IEventWriter interface showing the two methods), `packages/store/test/store.unit.test.ts` (OCC concurrency tests).

---

#### I4 — Handlers receive `AbortSignal`; respecting it is contract

**Quote** (SPEC §4): *"Handlers receive `AbortSignal`; respecting it is contract"*

**Files to check:** `packages/core/src/handler/types.ts` (`HandlerContext.signal` field declaration), `packages/daemon/src/dispatch-wiring.ts` (`AbortSignal.any` composition), `packages/agent/src/backend.ts` (signal threading into llm calls).

---

#### I5 — External side effects carry idempotency key; orphan `INTENT` quarantines on crash-replay

**Quote** (ARCH §1.1): *"`SideEffectEnvelope.idempotencyKey`; startup sweep emits `fact.run_quarantined`"*

**Files to check:** `packages/daemon/src/recorder.ts` (CommittingRecorder — pre-commit `fact.side_effect_intent` before handler invocation), `packages/store/src/sweep.ts` (startup scan for orphan side effects → quarantine), `packages/core/src/handler/types.ts` (`externalCall` signature and idempotency key derivation).

---

#### I6 — `run_state.routing` ≤ 8KB; typed accessors

**Quote** (ARCH §0): *"`CHECK (length(routing) < 8192)` column constraint; AST routing-index lint (`packages/daemon/test/routing-index-discipline.test.ts`) flags element access / destructuring on any routing-named or `RoutingDict`-typed binding outside the accessor module"*

**Files to check:** `packages/store/src/schema.sql` (CHECK constraint), `packages/core/src/routing.ts` (eight accessor functions: `getInputs`, `getFrontier`, `getBudget`, `getRetry`, `getGoalGate`, `getLimits`, `getTimer`, `getContext`), `packages/daemon/test/routing-index-discipline.test.ts` (AST lint).

---

#### I7 — Event payloads ≤ 4KB

**Quote** (ARCH §9): *"`store.ts::validatePayload` (binding 4 KiB-byte guard via `utf8ByteLength` = `Buffer.byteLength(s, "utf8")`); the `CHECK (length(payload) < 4096)` column constraint is a coarse code-point backstop only"*

**Files to check:** `packages/store/src/store.ts` (`validatePayload` or equivalent pre-check), `packages/store/src/schema.sql` (CHECK constraint on events.payload).

---

#### I8 — Raw tool output addressed by sha256 in `blobs`; artifact scoped by `(run, node, iteration, key)`

**Quote** (ARCH §1.2 + §0): *"Store API writes file→row in that order so orphans are always files, never dangling rows; `putArtifact` checks existing ref and either matches sha (no-op), throws collision, or overwrites with explicit replace"*

**Files to check:** `packages/store/src/store.ts` (`putArtifact` — file-then-row ordering, collision detection), `packages/store/src/schema.sql` (artifacts PK `(run_id, node_id, iteration, key)`, blobs PK `sha256`), `packages/store/src/artifact-queries.ts`.

---

#### I9 — LLM-visible preview (`messages`) distinct from system-recorded raw (`artifacts`); messages < 1 MiB

**Quote** (ARCH §0): *"`CHECK (length(content) < 1048576)` + pre-check throws `MessageTooLargeError`"*

**Files to check:** `packages/store/src/schema.sql` (messages table CHECK), `packages/store/src/store.ts` (`appendMessage` pre-check / `MessageTooLargeError`), `packages/core/src/handler/types.ts` (separate `messages` and `artifacts` APIs on HandlerContext).

---

#### I10 — Seq assignment O(1) via per-run counter; never scanned

**Quote** (ARCH §0): *"`UPDATE run_state SET next_seq = next_seq + 1 RETURNING ...` inside append txn"*

**Files to check:** `packages/store/src/store.ts` (seq bump pattern in `appendFact`/`appendIntent`/`appendObservabilityEvents`), `packages/store/src/schema.sql` (`next_seq` column on `run_state`).

---

#### OCC implementation and `occ_exhausted` escalation

**Quote** (ARCH §1.6): *"K concurrent branches are OCC-contention-free because only one writer ever commits; ... a lost OCC race re-drives the turn or escalates to `occ_exhausted`"*

**Files to check:** `packages/store/src/store.ts` (`appendFact` OCC version check), `packages/daemon/src/occ-append.ts` (`tryAppendFact`, `makeOccController`, `commitParkOrTerminal`), property test P2 in `packages/store/test/`.

---

#### Startup sweep (I4/I5 — crash-recovery requeue and orphan quarantine)

**Quote** (ARCH §1.4): *"Each affected run is healed in its own `SAVEPOINT`, so a single corrupt or missing `run_state` row rolls back that run alone... `fact.run_requeued_after_crash`... preserving `current_node`"*

**Files to check:** `packages/store/src/sweep.ts` (full sweep implementation — SAVEPOINT per run, `run_requeued_after_crash`, orphan quarantine, `paused`/`paused_human`/`quarantined` untouched), `packages/store/test/` (property tests P5, P6).

---

#### Migrations — `migrate()`, `migrateTo`, `planMigration`, `checkVersion`

**Quote** (ARCH §1.11): *"Each `SCHEMA_MIGRATIONS` step carries an optional `down` inverse, and `fragua db migrate --to <lower>` walks them — backed up first, refusing an irreversible step, a data-losing step (without `--allow-data-loss`), or a live daemon"*

**Files to check:** `packages/store/src/migrations.ts` (`migrate`, `migrateTo`, `planMigration` functions, SCHEMA_MIGRATIONS step-delta map), `packages/store/src/pragmas.ts` (`checkVersion` — refuses store newer than binary).

---

#### Reducer purity and fold-all-versions contract

**Quote** (ARCH §1.11, AGENTS.md ground rule 11): *"The reducer + read-plane MUST fold the full range `[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` forever... `MIN_COMPATIBLE_CONTRACT_VERSION` stays `1`... contract-surface hash test + `reducers.ts` touch-gate force a conscious bump-or-resnapshot"*

**Files to check:** `packages/store/src/reducers.ts` (`deriveRunState` and per-fact fold cases; legacy `fact.run_completed/halted/cancelled/paused_human` fold paths retained), `packages/store/test/contract-version.test.ts` (hash snapshot), `scripts/check-contract-bump.sh` (touch-gate), `packages/types/src/events.ts` (`EVENT_CONTRACT_VERSION = 6`, `MIN_COMPATIBLE_CONTRACT_VERSION = 1`).

---

#### Interface segregation (`IEventStore` sub-interfaces)

**Quote** (ARCH §4): *"A sub-interface discipline lint (`packages/store/test/event-store-sub-interface.lint.test.ts`) source-scans every `packages/*/src` OUTSIDE `packages/store` and fails the build if a parameter or property is annotated with the bare composite `: IEventStore`"*

**Files to check:** `packages/store/src/types.ts` (six sub-interfaces: `IEventWriter`, `IEventReader`, `IAnalyticsReader`, `IDaemonCoordinator`, `IProviderCredentialStore`, `IProviderConfigStore`), `packages/store/test/event-store-sub-interface.lint.test.ts` (lint enforcement).

---

#### SQL placement — DML/DQL only in `*-queries.ts`

**Quote** (ARCH §5, AGENTS.md ground rule 10): *"SQL strings are split per-table across `event-queries.ts`, `run-state-queries.ts`, `message-queries.ts`, `artifact-queries.ts`, `workflow-queries.ts`, `daemon-queries.ts`, and `analytics-queries.ts`"*

**Files to check:** `packages/store/src/event-queries.ts`, `packages/store/src/run-state-queries.ts`, `packages/store/src/message-queries.ts`, `packages/store/src/artifact-queries.ts`, `packages/store/src/workflow-queries.ts`, `packages/store/src/daemon-queries.ts`, `packages/store/src/analytics-queries.ts`, `packages/store/test/sql-location.lint.test.ts` (enforcement).

---

#### Enum-consumer lints — `RunStatus`, `HaltReason`, SQL CHECK, `?status=` round-trip

**Quote** (AGENTS.md §Spec-first): *"For `RunStatus` and `HaltReason` this is mechanized: the runtime tuples `RUN_STATUSES` / `HALT_REASONS` in `@fragua/types` are the source of truth... the `enum-consumers` lint tests (`store`, `core`, `cli`, `web`, plus the `?status=` round-trip in `server`) pin the non-derivable sites"*

**Files to check:** `packages/types/src/events.ts` (runtime tuples `RUN_STATUSES`, `HALT_REASONS`), `packages/store/test/enum-consumers.lint.test.ts`, `packages/cli/test/terminal-types.enum-consumers.test.ts`, corresponding lint tests in `core`, `web`, `server`.

---

#### Blob GC roots — spilled inputs and artifact-referenced blobs

**Quote** (ARCH §0): *"`gcBlobs` treats every sha found in any `run_state.routing` column as a GC root (alongside artifact-referenced blobs), so spilled inputs are never collected while the run is live"*

**Files to check:** `packages/store/src/store.ts` (`gcBlobs` implementation — routing-column scan for spilled-input shas, `idx_artifacts_blob` for artifact-referenced blobs), `packages/daemon/test/blob-gc.test.ts`.

---

### 2.2 Lens: daemon

#### I12 — Decision core pure (no store I/O, no clock, no RNG, no subprocess/network)

**Quote** (SPEC §3.11 / SPEC §4): *"It performs no I/O: no store reads or writes, no clock (`now` / `leakedAt` is a parameter, not a `Date.now()` call), no randomness (`random` is an injected `() => number`), no subprocess, no network."*

**Files to check:** `packages/daemon/src/transition-planner.ts` (`planTransition`), `packages/daemon/src/abort-planner.ts` (`planAbort`, `planAbortLoop`), `packages/daemon/src/predispatch-planner.ts` (`planPreDispatch`, `planLeakHalt`), `packages/daemon/src/fanout-planner.ts` (`planFanoutStep`, `noteDisposition`, `planBranchTerminal`, `planBranchAbortLoop`), `packages/daemon/test/decision-core-discipline.test.ts` (purity enforcement).

---

#### `runOne` turn loop — contract-version gate, intent fold, OCC retry

**Quote** (ARCH §6): *"`runOne` is the per-run turn loop. It re-reads `run_state` each turn and returns on any terminal/paused/quarantined status... checks the contract-version gate... folds unapplied intents (`cancel` wins)... builds the node's abort signal... dispatches the handler... appends them under OCC — retrying the turn on `ConcurrencyError`"*

**Files to check:** `packages/daemon/src/executor.ts` (`runOne`, `runExecutor`, `dispatchOne` orchestration), `packages/daemon/src/dispatch-turn.ts` (the linear turn — cancel/pause commits, run-start emit, dispatch-started marker, max_loops gate, handler dispatch, leak/abort/transition commits).

---

#### Contract-version gate (engine_incompatible pause)

**Quote** (ARCH §1.11): *"out-of-`[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` pin pauses with `engine_incompatible` and returns"*

**Files to check:** `packages/daemon/src/predispatch-planner.ts` (gate logic), `packages/daemon/src/dispatch-turn.ts` (gate invocation), `packages/store/test/` (property test P17).

---

#### Intent fold — R1–R7 rules, cancel-wins, routing patch

**Quote** (ARCH §8 + SPEC §3.5): *"Cancel always wins if present; pause coexists with steer/human as `shouldPauseAfterDispatch`; multi-instance human/priority last-wins; every intent ends up applied or in `dropped`"* (P27 assertion)

**Files to check:** `packages/daemon/src/executor.ts` (intent fold invocation), `packages/core/src/intent-plane/` (fold logic), `docs/intent-fold.md` (R1–R7 rules), property test P27.

---

#### Abort signal composition — `AbortSignal.any([steer, timeout, shutdown])`

**Quote** (handler-contract.md §Hard rules): *"`ctx.signal`... composes the steer controller + `AbortSignal.timeout(maxMs)` + shutdown"*

**Files to check:** `packages/daemon/src/dispatch-wiring.ts` (`buildDispatchContext` — abort signal composition, steer controller wiring, timeout signal).

---

#### Supervisor fiber — 50ms tick, heartbeat, intent detection, watchdog

**Quote** (ARCH §1.3): *"Daemon supervisor fiber ticks every 50ms, inside one short transaction: `heartbeat()` — UPDATE `daemon_lock.heartbeat_at`; `detectNewIntents()` — for every registered abort controller, check if there are unapplied intents; `detectStuckNodes()` — watchdog for handlers that exceeded `maxMs + LEAK_GRACE_MS`"*

**Files to check:** `packages/daemon/src/supervisor.ts` (or equivalent in `packages/daemon/src/entrypoint.ts`), `packages/daemon/src/executor.ts` (supervisor fiber wiring).

---

#### Recorder (`CommittingRecorder`) — pre-commit `fact.side_effect_intent`

**Quote** (ARCH §1.1): *"`fact.side_effect_intent` is committed in its own short SQLite transaction before the handler invokes `fn(idempotencyKey)`... The recorder (`packages/daemon/src/recorder.ts` — `CommittingRecorder`) advances `run_state.version` synchronously on each commit"*

**Files to check:** `packages/daemon/src/recorder.ts` (CommittingRecorder class, ACCEPTED TRADE note), property test P25.

---

#### Timeout / abort-loop / provider-retry policies

**Quote** (SPEC §3.4 paused_auto): *"`provider_retry` — Auto-retryable transport error... `handler_retry` — Node returned `outcomeStatus="retry"`... `timeout_retry` — Handler watchdog tripped"* and STATUS.md: *"backoff is 5s on first timeout, doubling to 60s ceiling; per-(nodeId) counter caps at 3, exhaustion halts with `timeout_exhausted`"*

**Files to check:** `packages/daemon/src/transition-planner.ts` (retry / abort-loop plans), `packages/daemon/src/executor-helpers.ts` (`resolveBackoff`, retry-count reader), `packages/daemon/src/abort-planner.ts` (`planAbortLoop` for abort-loop ceiling), `packages/agent/src/backend.ts` (provider error classification → `pause_provider` result).

---

#### Wake-pending sweeper

**Quote** (SPEC §3.4): *"The wake-pending sweeper emits `fact.run_resumed { fromStatus: 'paused_auto' }` once `now >= resumeAt`; the run goes back to `queued` and re-dispatches"*

**Files to check:** `packages/daemon/src/wake-pending.ts` (sweeper logic — `getWakeCandidates`, resumeAt comparison, `fact.run_resumed` emission).

---

#### Fan-out commit lane — single writer, OCC intact

**Quote** (ARCH §6.2): *"Every branch commits through the single daemon writer's serialized lane (`commitFanoutFact`), re-reading the live `version` per attempt and retrying the append... on a sibling-moved-version conflict"*

**Files to check:** `packages/daemon/src/fanout.ts` (`runFanout`, `commitFanoutFact` serialization lane, Promise.race pool), property tests P28–P32.

---

#### Snapshots — per-step/HITL and terminal

**Quote** (ARCH §3 observability): *"`snapshot.captured`... executor-emitted per-step + HITL worktree snapshot, feeding the Diff scrubber. Delta-suppressed... The terminal snapshot is the OCC-checked `fact.snapshot_recorded`, not this"*

**Files to check:** `packages/daemon/src/snapshot-service.ts` (`captureBoundarySnapshot`, `disposeTerminalWorktree`), `packages/store/src/store.ts` (`fact.snapshot_recorded` append).

---

#### Boot sequence (`daemonMain`) — lock acquire, sweep, supervisor, executor loop

**Quote** (ARCH §6): *"acquire the `daemon_lock`... if heartbeat older than `LOCK_TTL_MS`, TTL-reclaim it... run the startup sweep to heal crash damage... start the 50ms supervisor fiber... enter the executor loop"*

**Files to check:** `packages/daemon/src/entrypoint.ts` (`daemonMain`), `packages/daemon/src/auto-dispatcher.ts` (schedule dispatch fiber), `packages/store/src/store.ts` (`acquire`, `forceAcquireDaemonLock`).

---

#### Observability event buffer — 50ms/64-event flush, truncation-not-rejection

**Quote** (ARCH §3): *"The executor flushes the in-handler buffer to the store on a soft 50ms timer or when 64 events accumulate... An event whose payload exceeds the 4 KB cap is truncated to a routing-preserving marker... not rejected"*

**Files to check:** `packages/daemon/src/executor.ts` or `packages/daemon/src/dispatch-wiring.ts` (flush timer and event-count threshold), `packages/store/src/store.ts` (`appendObservabilityEvents` — truncation path).

---

#### Operator-action projection (`processOperatorActions`) — accept/discard daemon fold

**Quote** (ARCH §3 intent table): *"Daemon's `processOperatorActions` sweep then projects it into its `fact.run_*` (OCC lockstep with `inbox_status`) — no second git run"*

**Files to check:** `packages/daemon/src/executor.ts` or `packages/daemon/src/auto-dispatcher.ts` (`processOperatorActions`), `packages/workspace/src/run-actions.ts` (`applyAccept`, `applyDiscard`).

---

### 2.3 Lens: core

#### Browser-safe main entry — no `node:*`/`bun:*`/`@fragua/store` imports transitively reachable

**Quote** (ARCH §5): *"Browser safety (same file): no `node:`/`bun:`/`@fragua/store` value import transitively reachable from `packages/core/src/index.ts`"*

**Files to check:** `packages/core/src/index.ts` (main entry), `packages/store/test/lint.test.ts` (browser-safety AST lint), `packages/core/package.json` (entry point map for sub-entries `./handler`, `./intent-plane`, `./read-plane`).

---

#### Handler discipline lint — no `node:*`/`undici`/`fetch`/`Bun.*`/`process.env` in handlers

**Quote** (ARCH §5): *"Handler discipline (`packages/core/test/handler/discipline.test.ts`): no `node:*`/`undici` import, `fetch`/`globalThis.fetch`, `Bun.*`, or `process.env` inside `handlers/`"*

**Files to check:** `packages/core/test/handler/discipline.test.ts` (AST scan), `packages/core/src/handler/handlers/` (the scanned directory), `biome.json` (`noRestrictedImports` rule for pre-commit backstop).

---

#### Edge selection — route case vs outcome case, `abort_exit` and `edge_no_match` halts

**Quote** (SPEC §3.6): *"Route case — when the source node declares `routes:`, edge selection picks the edge whose `route=a` attribute matches the chosen value. An unmatched route halts with `edge_no_match`. Outcome case — for all other nodes, edge selection picks the edge whose `outcome=` attribute matches... Unannotated edges default to `outcome=success`"*

**Files to check:** `packages/core/src/engine/edge-selection.ts` (two-case algorithm implementation), property tests for edge selection.

---

#### Substitution — lenient `inputs.` reads, fail-closed `outputs.` reads, injection wrapping

**Quote** (SPEC §3.8): *"Dotted reads are lenient: an unresolvable path collapses to `""`... Reads fail closed — referencing a field the producer never populated on the taken path fails the consuming node"* and STATUS.md: *"Values interpolated into an `llm` prompt are wrapped in content-derived delimiters to prevent prompt injection"*

**Files to check:** `packages/core/src/engine/substitution.ts` or the substitution module (lenient vs. fail-closed path distinction, delimiter wrapping for injection prevention), property tests for substitution behavior.

---

#### Validator codes named in SPEC and workflows skill

**Quote** (SPEC §3.1 / §3.8): Named codes: E028, E029, E030, E031, E035, E036–E045, E046, E057, W013, W014, W015, W016, W018.

**Files to check:** `packages/core/src/engine/validator.ts` (all E/W codes implemented), `.agents/skills/workflows/references/validator-codes.md` (lookup table matching SPEC).

---

#### Intent plane — validate/construct/commit writes; error-severity rejection at save

**Quote** (SPEC §2): *"The plane's workflow mint rejects error-severity validator diagnostics at save — an E-coded graph never reaches the executor through any client"*

**Files to check:** `packages/core/src/intent-plane/` (all files — `buildEnqueue`, `commitEnqueue`, validator invocation and error-severity check), `packages/core/src/parser/yaml.ts` (Graph IR construction).

---

#### Read plane — run summary/detail/steps/messages/events/snapshots/diff/streaming

**Quote** (ARCH §4.2 / AGENTS.md): *"Read plane (`@fragua/core/read-plane`) projects every run read (summary / detail / steps / messages / events / snapshots / diff / streaming)"*

**Files to check:** `packages/core/src/read-plane/` (all files — projection functions), `packages/core/src/read-plane/projections.ts` (666 lines — run summary/detail shapes).

---

#### Routing accessors and discipline lint

**Quote** (ARCH §2.1): *"A single accessor module (`packages/core/src/routing.ts`) is the source of truth for the dotted-key vocabulary... A discipline lint bans raw `routing[…]` indexing outside the accessor module"*

**Files to check:** `packages/core/src/routing.ts` (eight accessor functions), `packages/daemon/test/routing-index-discipline.test.ts` (AST lint banning raw indexing).

---

#### Retry presets — `none`, `standard`, `aggressive`, `linear`, `patient`

**Quote** (SPEC §3.7): Five named presets with documented max-attempts/initial-delay/factor/jitter values.

**Files to check:** `packages/core/src/engine/retry-policy.ts` (preset definitions and `retryStep` function returning `advance`/`retry`/`fail`/`halt`).

---

#### YAML parser — `start` synthesis, `exit` reservation, IR construction

**Quote** (SPEC §3.1): *"`start` is synthesized by the parser (the entry node pointing at the first declared step) and is never authored; `exit` is the reserved sink. Declaring a step named `start` or `exit` with a mismatched type is rejected (E029 / E028)"*

**Files to check:** `packages/core/src/parser/yaml.ts` (925 lines — parser implementation including `start` synthesis, `exit` reservation, E028/E029 enforcement).

---

#### `HandlerResult` discriminated union — `transition`, `yield_human`, `halt`, `pause_provider`

**Quote** (ARCH §5): *"`HandlerResult` is a discriminated union over `kind`: `transition` / `yield_human` / `halt` / `pause_provider`"*

**Files to check:** `packages/core/src/handler/types.ts` (full union definition, `transition` arm with all optional fields including `outputs?`, `operatorNote?`).

---

#### Judge handler — `choice`/`score`/`noul`, `decide:`, `for-each:`, `composite:`

**Quote** (SPEC §3.1): *"`judge` — turn-less typed judgment: `state:` + `questions:` (`choice` / `score` / `noul`) asked of a System One model in one call"*

**Files to check:** `packages/core/src/handler/handlers/judge.ts` (723 lines — full judge implementation, `for-each:`, `composite:`, `decide:` binding).

---

### 2.4 Lens: agent + workspace

#### Swap surface — `PiLlmBackend` implements `LlmBackend`

**Quote** (SPEC §1): *"The swap surface is deliberately one file: `PiLlmBackend` (`packages/agent/src/backend.ts`) implements `@fragua/core`'s `LlmBackend` interface, so replacing the dependency means rewriting that backend"*

**Files to check:** `packages/agent/src/backend.ts` (1553 lines — `PiLlmBackend` class and `LlmBackend` interface implementation).

---

#### Force-included tools — `abort`, `emit_output` (when `outputs:` declared), `route` (routing nodes), `skill` (when catalogue non-empty)

**Quote** (handler-contract.md §LLM self-abort): *"The `abort` tool is force-included on every llm node — even when the node pins `allowed_tools` or lists `abort` under `denied_tools`. The `skill` tool is force-included on the same terms, but only when the node's effective skill catalogue is non-empty"*

**Files to check:** `packages/agent/src/backend.ts` (force-include logic for `abort`, `emit_output`, `route`, `skill`), AGENTS.md ground rule 12.

---

#### Read-only enforcement — three layers

**Quote** (ARCH §12.1): *"(a) `ctx.tools` is narrowed via `ToolRegistry.select` before the `HandlerContext` is built; (b) the llm backend re-applies `select(...)` on its workspace registry before handing tools to pi-ai; (c) `ctx.env` is wrapped in a read-only proxy when no mutating tool (`bash` / `write` / `edit`) is visible, so `env.writeFile` / `env.exec` throw `ReadOnlyEnvError`"*

**Files to check:** `packages/daemon/src/dispatch-wiring.ts` or `packages/core/src/handler/context.ts` (layer a — `ToolRegistry.select` before HandlerContext build), `packages/agent/src/backend.ts` (layer b — re-apply select on workspace registry), `packages/workspace/src/worktree-env.ts` or `packages/workspace/src/local-env.ts` (layer c — `ReadOnlyEnvError` proxy wrapping).

---

#### Provider error classification — auto-retry vs manual classes

**Quote** (ARCH §1.10): *"408 / 429 / 5xx / 529 / network errors emit `fact.run_paused{reason:'provider_retry'}` (with `attempt`, `resumeAt`) and project to `paused_auto`... 400 / 401 / 402 / 403 / 404 / 413 / 422 stay manual"*

**Files to check:** `packages/agent/src/backend.ts` (HTTP status capture via `onResponse`, `AssistantMessageEvent` error handling), `packages/agent/src/handler-bridge.ts` (translation to `HandlerResult.kind = "pause_provider"`), `packages/daemon/src/transition-planner.ts` (classification into pause reasons).

---

#### Steering broadcast — `fact.steering_applied`, buffer-clearing rule

**Quote** (ARCH §0): *"A steer is the one exception to the trip: it rides pi-agent-core's steering queue instead and broadcasts to every in-flight LLM branch"*; ARCH §3: *"the buffer is therefore cleared when the run's live-agent set EMPTIES, not when it is first drained"*

**Files to check:** `packages/agent/src/backend.ts` (steering queue registration, broadcast delivery), `packages/agent/src/event-bridge.ts` (if separate), `packages/daemon/src/executor.ts` (steer detection in supervisor, `fact.steering_applied` emission).

---

#### Credential storage — `provider_credentials` table, no `!cmd`/env resolution

**Quote** (ARCH §Credential storage): *"Keys are stored verbatim — no `!cmd` / env-var resolution anywhere in the credential path"*; STATUS.md: *"Custom-provider config in the store — Deletes resolve-config-value.ts and the !cmd/env credential machinery in its last corner"*

**Files to check:** `packages/store/src/schema.sql` (`provider_credentials` table), `packages/agent/src/credentials/model-registry.ts` (`SqliteAuthStorageBackend`, Ajv-validation on read, corrupt-row skip), `packages/store/src/schema.sql` (`provider_config` table, `json_valid` CHECK on `mcp_oauth`).

---

#### Env path gate and bash reach — blocklist, detached process group, tree kill

**Quote** (handler-contract.md §Agent tools): *"`bash` — Run a shell command. Detached process group + tree kill on timeout/abort... Blocklist refuses dangerous commands before spawn"*

**Files to check:** `packages/workspace/src/tools.ts` (671 lines — bash tool implementation, blocklist, detached process group, tree kill, rolling buffer + temp-file spill), `packages/cli/src/env-creds.ts` (528 lines — provider credential env-passthrough refusal, seen in test output).

---

#### Run-actions git — `applyAccept`, `applyDiscard`, `gitDiff`, state gate

**Quote** (ARCH §3 intent table / AGENTS.md): *"The CLI runs it directly (store-client), the Web UI via the `POST /runs/:id/{accept,discard}` route — with the state gate (terminal / in-inbox / has-worktree) folded into that one action"*

**Files to check:** `packages/workspace/src/run-actions.ts` (`applyAccept`, `applyDiscard` with state gate, `gitDiff`).

---

#### Skills — discovery, body size soft cap, SKILL.md frontmatter, `$ARGUMENTS` substitution

**Quote** (STATUS.md): *"built-in `skill({ name, arguments? })` LLM-callable tool... loads a SKILL.md from the discovered catalogue, parses frontmatter, substitutes `$ARGUMENTS`"*; test output shows: *"skill body 615 lines exceeds soft cap 500"*

**Files to check:** `packages/workspace/src/skills/` (discovery across `~/.agents`, `~/.claude`, project cwd), `packages/agent/src/backend.ts` or skill-tool handler (body size check, frontmatter parse, `$ARGUMENTS` substitution, `<invocation>` block append), `packages/types/src/skills.ts` (`SkillCatalogRecord` shape).

---

#### MCP lifecycle — `.mcp.json` load, `${VAR}` resolve, stdio/HTTP connector, OAuth via `mcp_oauth` table

**Quote** (ARCH §2 table, `mcp_oauth`): *"Written and read by `@fragua/workspace/src/mcp/oauth.ts` via the store-backed OAuth provider bridge... Secret-bearing and excluded from run bundles"*

**Files to check:** `packages/workspace/src/mcp/config.ts` (`.mcp.json` load + `${VAR}` resolve), `packages/workspace/src/mcp/connector.ts` (stdio/HTTP transport + tool materialisation), `packages/workspace/src/mcp/oauth.ts` (store-backed OAuth provider, `mcp_oauth` table reads/writes).

---

#### Worktree provisioning — `git worktree add --detach`, `baseGitSha` pin, `fact.worktree_provisioned`

**Quote** (SPEC §3.8): *"The provisioner reads the pinned sha and runs `git worktree add --detach <path> <sha>`"*

**Files to check:** `packages/daemon/src/worktree-provisioner.ts` (`git worktree add`, `baseGitSha` resolution, `daemon.worktree_provisioned` event emission).

---

### 2.5 Lens: surface (server + CLI + web)

#### Loopback bind and API guards — same-origin gate (Origin + Host), JSON-only content-type

**Quote** (SPEC §2): *"The listener binds loopback by default... A same-origin gate runs before every route: a request whose `Origin` is not the bound origin... is refused 403, a request whose `Host` is neither loopback nor the bound host is refused 403 (blocking DNS rebinding), and a bodied request without `content-type: application/json` is refused 415"*

**Files to check:** `packages/server/src/index.ts` (loopback bind, same-origin middleware), `packages/cli/test/serve.test.ts` (test output shows `"serve: binding :: exposes the unauthenticated API beyond this machine"` warning on non-loopback).

---

#### Body validation — 400 on schema violations before any intent is appended

**Quote** (SPEC §3.5): *"Every endpoint validates its body and rejects 4xx on schema violation before any intent is appended"*

**Files to check:** `packages/server/src/schemas.ts` (body schemas), `packages/server/src/store/routes.ts` (791 lines — validation before intent write), `packages/server/src/store/runs-routes.ts`.

---

#### Plane discipline — writes through intent plane, reads through read plane

**Quote** (SPEC §2): *"Planes — the two shared surfaces both the server and the CLI route through, so no two clients can disagree: the intent plane... the read plane"*

**Files to check:** `packages/server/src/store/routes.ts` (writes via `plane.buildEnqueue`/`commitEnqueue`, reads via read plane), `packages/cli/src/store-client.ts` (`withStoreClient` — opens store and builds both planes).

---

#### Enqueue preflights — typed inputs validation, provider-credential check, queue backpressure

**Quote** (ARCH §7): *"Enqueue is `POST /runs`: it validates the body's typed `inputs` against the workflow's `inputs:` block (400 `invalid_inputs` on a missing required input or out-of-range choice), preflights provider-credential availability (400 `provider_unavailable`) and queued-run backpressure (429 `queue_full` with `Retry-After`)"*

**Files to check:** `packages/server/src/store/routes.ts` (enqueue route — three preflight checks), `packages/core/src/intent-plane/` (`buildEnqueue` with inputs coercion and validation).

---

#### SSE cursors — `events WHERE seq > cursor`, per-run + global feeds

**Quote** (ARCH §0): *"Web SSE streams poll `events WHERE seq > ?` every 100ms per subscribed run"*

**Files to check:** `packages/server/src/store/sse.ts` (SSE polling implementation, cursor parameter, `Last-Event-ID` handling), property test P19.

---

#### Endpoint discovery and stale rendezvous references

**Quote** (ARCH §0): *"Server discovery lives in the store's `server_endpoint` row... written by whoever binds the HTTP listener... cleared on shutdown; separate from `daemon_lock`"*

**Files to check:** `packages/store/src/schema.sql` (`server_endpoint` table — `url`, `port`, `pid` columns), `packages/daemon/src/entrypoint.ts` or `packages/cli/src/commands/` (harness server writes endpoint, clears on SIGINT), `packages/cli/src/commands/` (CLI reads endpoint row for web-dependent ops, not for run/runs).

---

#### Inline-import discipline lint — no dynamic `import()`/`require()` in production source

**Quote** (AGENTS.md ground rule 6): *"Enforced by an AST lint (`packages/server/test/inline-import-discipline.test.ts`) that catches dynamic `import()`, `import().then()`, and `require()` across `packages/*/src` + `cli/bin`"*

**Files to check:** `packages/server/test/inline-import-discipline.test.ts` (AST scan scope and exemptions — test files exempt, `// inline-import-allow:` marker).

---

#### CLI as direct store-client — `withStoreClient`, `--db` flag, no HTTP dependency

**Quote** (SPEC §2 / AGENTS.md): *"CLI is a direct store-client: it opens `~/.fragua/fragua.db` and writes intents through the intent plane and reads through the read plane — no HTTP, works daemon-down"*

**Files to check:** `packages/cli/src/store-client.ts` (`withStoreClient` — `migrate:false` open + both planes), `packages/cli/src/commands/run.ts` (uses intent plane, not HTTP), `packages/cli/src/commands/runs.ts`.

---

#### Executor-deps sharing — `buildExecutorDeps` shared by `daemon` and `ci`

**Quote** (AGENTS.md §Codebase map, cli entry): *"`executor-deps.ts` (`buildExecutorDeps`) is the shared executor assembly behind both `daemon` and `ci`; `ci` embeds the executor over an ephemeral store"*

**Files to check:** `packages/cli/src/executor-deps.ts` (`buildExecutorDeps` function shared by `fragua daemon` and `fragua ci`), `packages/cli/src/commands/ci.ts` (ephemeral store path, direct executor embedding).

---

#### Harness lifecycle — daemon supervision, in-process server, SIGINT cleanup

**Quote** (SPEC §2): *"Harness (`fragua harness`) is the default entry point: foreground process that spawns the daemon as a subprocess and runs the HTTP server in-process... SIGINT clears that row on the way out"*

**Files to check:** `packages/cli/src/commands/` (harness command — daemon subprocess supervision, SIGINT handler clearing `server_endpoint` row), test output from `packages/cli/test/harness.test.ts` (lock contention restart retries visible in stderr).

---

#### Workflow resolution — bare name → global then local; path-shaped verbatim

**Quote** (AGENTS.md): *"bare names resolve against `~/.fragua/workflows/`, then `<cwd>/.fragua/workflows/`... anything path-shaped resolves verbatim"*

**Files to check:** `packages/cli/src/commands/run.ts` (workflow ref resolution logic — `route-picker.ts` or inline).

---

#### Config cascade — global `~/.fragua/config.yaml` overlaid by `<cwd>/.fragua/config.yaml`

**Quote** (AGENTS.md): *"Config cascade: `~/.fragua/config.yaml` (global — defaults, auto-title, blocklist, concurrency, …) overlaid by `<cwd>/.fragua/config.yaml` (project — bootstrap and any project-specific overrides). Project keys win; nested objects merge one level deep. YAML only."*

**Files to check:** `packages/cli/src/` (config loading and cascade merge logic — likely in a config module or inline in harness/daemon commands).

---

#### `migrate --to` — `migrateTo`/`planMigration`, backup-first, live-daemon refusal

**Quote** (ARCH §1.11): *"`fragua db migrate --to <lower>` walks the `down` inverses (descending), backs up first, and refuses to cross an irreversible step or to race a live daemon"*

**Files to check:** `packages/store/src/migrations.ts` (`migrateTo`, `planMigration` — down-step traversal, irreversibility check), `packages/cli/src/commands/` (db migrate command — backup step, live-daemon check).

---

#### Web stack — React 18, Vite 5, Tailwind 4 CSS-first, `@tanstack/react-query` query factories

**Quote** (AGENTS.md §Stack + frontend skill): *"React 18 + Vite 5 + Tailwind 4 (CSS-first, `@theme inline`, no `tailwind.config.ts`) + react-router v7"*; *"server state through @tanstack/react-query query factories (never useState + useEffect for fetches)"*

**Files to check:** `packages/web/package.json` (dependency pins), `packages/web/src/lib/api.ts` (1358 lines — query factories, mutation patterns), `packages/web/` (absence of `tailwind.config.ts`; `globals.css` with `@theme inline` block).

---

#### Web package boundary — `web` does not import `server`, uses HTTP only; `web → types`, `web → core`

**Quote** (AGENTS.md §Codebase map): *"web... The only HTTP client"*; measured import edges show `web → types(23), core(6)` — no server import.

**Files to check:** `packages/web/src/lib/api.ts` (HTTP fetch calls to server, no `@fragua/server` import), `packages/web/package.json` (dependencies — verify `@fragua/server` absent).

---

#### DTO widening — `RunSummary`/`RunDetail` optional field widening for old-daemon payloads

**Quote** (AGENTS.md §Codebase map, web): *"where the shape validators soft-accept old-daemon payloads that omit a field, the re-export widens that field to optional so the type matches runtime and consumers are forced to guard"*

**Files to check:** `packages/web/src/lib/api.ts` (DTO re-exports from `@fragua/core/read-plane`, optional field widening pattern).

---

#### Test runner split — `bun test` for node packages, vitest for `@fragua/web`

**Quote** (AGENTS.md §Commands): *"`bun run test:node` — node packages only, via `bun test`; `bun run test:web` — @fragua/web only, via vitest (jsdom)"*

**Files to check:** Root `package.json` (`test:node` and `test:web` scripts), `packages/web/package.json` (vitest config or `vite.config.ts` with test config).

---

## 3. Known-gap register

These items are explicitly admitted as unbuilt or rough by STATUS.md, SPEC §5, or ARCH §12. Verification lenses should **not** report them as findings.

### 3.1 Out of scope by design (SPEC §5 / STATUS.md)

1. **Multi-machine deployment** — single SQLite is the only coordination surface; `IEventStore` is synchronous; a shared/Postgres backing would require async-ifying the interface and every callsite. Structural foreclosure, not a roadmap gap.
2. **Token auth on harness API** — localhost-only, no token auth in v0. Same-origin gate (Origin + Host allow-list + JSON-only content-type) is the implemented guard. Residual exposure is a compromised process on the same host, not a browser tab.
3. **Blob encryption** — single-user local tool; DB read = full read anyway. Deferred.
4. **Workflow hot-reload for in-flight runs** — `workflow_sha` is pinned at enqueue time. Not planned.
5. **Auto-migration of contract drift** — an out-of-range `contract_version` pin produces a recoverable `fact.run_paused{reason:"engine_incompatible"}`, never auto-upgrade. Both arms project to `paused` (operator-resumable); capability-gated auto-wake for the too-new arm is explicitly deferred.
6. **Schema downgrade is explicit only** — `fragua db migrate --to <lower>` is a first-class but explicit operator action (newer binary, backed up, live-daemon refused). Never automatic.
7. **`wait_any`/`race`/`quorum` joins** — excluded by design (would break SESE; breaks dominance for budget/goal-gate scoping).
8. **Dynamic forks (runtime-sized `parallel`)** — branch set is materialised at parse time; a runtime-sized variant would still require plan-time materialisation; excluded by design.
9. **Cross-run fan-in** — composition across runs is artifact-sharing, not a graph join. Out of scope.
10. **Manager-loop/supervisor-stack primitive** — composition is at the workflow level via separate runs sharing artifacts.
11. **Pre/post tool hooks as workflow attributes** — handled by agent backend tool interception, not authored.
12. **Blocking interviewer interface** — `human` nodes + `intent.human_input` is the model; executor parks the run, never blocks on a person.

### 3.2 Deferred / design-stage (ARCH §12 / STATUS.md)

13. **Retention policies per workflow** — manual `fragua prune` until demand.
14. **Blob streaming for >16 MB** — handler must chunk; revisit on real use case.
15. **Per-workflow concurrency caps** — add when needed via partial-index counts.
16. **Watchdog for stuck-but-alive daemons** (fiber deadlock) — resumability covers crash-restart but not fiber deadlock; heartbeat metric deferred until foreground harness UX has soaked.
17. **Per-project credential isolation, project extensions, file-server, rate-limit fairness** — design-stage.
18. **No max-branch validator upper bound** (ARCH §6.2) — only E036's `≥2` minimum enforced; a pathologically wide fan-out fails at seed with `PayloadTooLargeError` rather than a validator error. Latent gap explicitly named in docs.
19. **`fact.run_paused{reason:"signal"}` cross-engine signal wait** — ARCH §3 notes the value is NOT emitted yet (`fact.run_paused` reason field, cross-engine signal arm).
20. **Spilled input support in export/import bundles** — ARCH §0 notes bundle export/import support for spilled routing inputs is pending (proposal §8, item B5).
21. **Capability-gated auto-wake for engine_incompatible too-new arm** — deferred; both arms project to `paused` (operator-resumable).

### 3.3 Experimental / not frozen (STATUS.md)

22. **Judge step** — experimental; needs the `typesafe` credential; not frozen.
23. **MCP tools** — experimental; `.mcp.json` schema and connector contract not frozen.
24. **Bundle secret scrubbing** — experimental; scrubber registry, marker format, and CI exit code not yet frozen.
