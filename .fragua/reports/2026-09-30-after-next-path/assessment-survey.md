# fragua — Assessment Survey

> Claim inventory for five verification lenses running on fresh context.
> Focus: whole project.
> Generated from: `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/handler-contract.md`, `STATUS.md`, `AGENTS.md`, `.fragua/scratch/assess/`.

---

## 1. Baseline: CI Evidence

### 1.1 Typecheck (exit 0)

All 10 packages pass `tsc --noEmit`. No errors.

```
@fragua/types       exit 0
@fragua/test-utils  exit 0
@fragua/core        exit 0
@fragua/workspace   exit 0
@fragua/store       exit 0
@fragua/web         exit 0
@fragua/agent       exit 0
@fragua/server      exit 0
@fragua/daemon      exit 0
@fragua/cli         exit 0
```

### 1.2 Lint (exit 0)

`biome check .` — 879 files, 0 fixes applied.

### 1.3 Test suite (exit 0 both runners)

| Runner | Files | Pass | Skip | Fail | expect() calls | Duration |
|---|---|---|---|---|---|---|
| `test:node` (bun) | 316 | 3685 | 1 | 0 | 95,442 | 93.62s |
| `test:web` (vitest) | 93 | 725 | 0 | 0 | — | 11.68s |

**One skipped test:** `executor — §3.7 fail-routing retarget > node fails with no fail-edge but retry_target set → retargets` (in `packages/daemon/test/executor.goal-gate.test.ts`).

Notable stderr that is expected/intentional: `[store] truncated oversized observability event` (2 occurrences, store unit test); `[executor] handler leak #1 on …` (property tests exercising leak detection); credential-deny messages from `env-creds.test.ts`; harness restart/backoff messages from `harness.test.ts`; `serve: binding :: exposes the unauthenticated API beyond this machine` (from `serve.test.ts`).

### 1.4 Package sizes (lines of source vs test)

| Package | src (lines) | test (lines) | test : src ratio |
|---|---|---|---|
| `@fragua/web` | 28,925 | 15,847 | 0.55 |
| `@fragua/cli` | 9,443 | 10,389 | **1.10** |
| `@fragua/core` | 13,142 | 12,951 | **0.99** |
| `@fragua/daemon` | 8,270 | 21,959 | **2.66** |
| `@fragua/server` | 4,358 | 7,438 | **1.71** |
| `@fragua/store` | 10,353 | 11,847 | **1.14** |
| `@fragua/agent` | 5,237 | 7,920 | **1.51** |
| `@fragua/workspace` | 5,795 | 5,014 | 0.87 |
| `@fragua/types` | 1,773 | 90 | 0.05 |
| `@fragua/test-utils` | 423 | 151 | 0.36 |

Total source lines: 87,719. web is by far the largest src package; daemon has the highest test-to-source ratio (2.66×).

### 1.5 Largest individual files (by line count)

| Lines | File |
|---|---|
| 2,638 | `packages/store/src/store.ts` |
| 1,793 | `packages/core/src/engine/validator.ts` |
| 1,553 | `packages/agent/src/backend.ts` |
| 1,534 | `packages/web/src/components/RunConversation.tsx` |
| 1,461 | `packages/types/src/events.ts` |
| 1,358 | `packages/web/src/lib/api.ts` |
| 1,338 | `packages/store/src/types.ts` |
| 1,322 | `packages/cli/src/commands/operator.ts` |
| 1,271 | `packages/daemon/src/transition-planner.ts` |
| 1,220 | `packages/web/src/components/ai-elements/prompt-input.tsx` |
| 1,186 | `packages/web/src/components/GraphView.tsx` |
| 1,078 | `packages/store/src/run-state-queries.ts` |
| 925 | `packages/core/src/parser/yaml.ts` |
| 785 | `packages/server/src/store/routes.ts` |
| 775 | `packages/agent/src/credentials/model-registry.ts` |

### 1.6 Documented dependency direction vs measured import edges

**Documented direction (AGENTS.md / ARCH §11):** `web → server → store ← daemon → core ← agent`. `core`'s main entry is browser-safe (no `node:fs`, `node:child_process`, `@fragua/store`); its server-side sub-entries (`./handler`, `./intent-plane`, `./read-plane`) are excluded from the browser bundle. `@fragua/cli` is a direct store-client; `@fragua/workspace` is reached by daemon and server.

**Measured import edges** (count = number of files in the source package that import from the target package):

| Source | Target (count) | Documented? |
|---|---|---|
| `agent` | core(13), workspace(6), store(5), types(4) | agent→core ✓; agent→store ⚠ (not in diagram; store is the coordination surface, but agent→store is not in the `core ← agent` arc) |
| `cli` | core(20), store(18), agent(9), types(6), workspace(5), daemon(3), server(2) | cli as store-client → store ✓; cli → daemon(3) ⚠ (via `executor-deps.ts` sharing per AGENTS.md); cli → server(2) ⚠ (not documented) |
| `core` | types(17), store(6) | core→types ✓; core→store(6) ⚠ (browser-safe main should be store-free; store imports are in sub-entries `intent-plane`/`read-plane`) |
| `daemon` | core(28), store(24), workspace(1), types(1) | daemon→core ✓; daemon→store ✓; daemon→workspace ✓ |
| `server` | store(15), core(14), workspace(4), types(2), agent(2) | server→store ✓; server→core ✓; server→workspace ✓; server→agent(2) ⚠ (not in diagram) |
| `store` | types(12), core(4), store(1) | store→types ✓; store→core(4) ⚠ (diagram shows `store ← core`, not store→core; likely store type imports) |
| `web` | types(23), core(6) | web→types ✓; web→core(6) — web imports core sub-entries (read-plane DTOs); diagram shows `web → server` only |
| `workspace` | core(10), types(4), workspace(1) | workspace→core ✓; self-import ⚠ |

**Summary of deviations from the documented arrow diagram:**
- `store → core(4)`: not in the documented direction (`store ← daemon → core` implies store does not import core)
- `core → store(6)`: ARCH §11 says core's main entry is browser-safe; these 6 are in the server-side sub-entries
- `agent → store(5)`: agent is documented as feeding core (`core ← agent`), not store directly
- `server → agent(2)`: server is documented to route through the planes, not agent
- `cli → daemon(3)`: documented only as store-client; AGENTS.md explains `executor-deps.ts` sharing
- `cli → server(2)`: not documented
- `web → core(6)`: web is documented as `web → server`, not directly to core

---

## 2. Claim Inventory

### 2.1 Lens: Store

**Invariants I1–I10** (ARCH §0 table; SPEC §4)

| # | Claim (quoted) | Location | Checkable files |
|---|---|---|---|
| S-1 | "Every write is one SQLite transaction; events + projection updated together" | ARCH §0 table I1; SPEC §4 | `packages/store/src/store.ts`; `packages/store/test/lint.test.ts` (AST lint enforcement) |
| S-2 | "No handler state outside the projection" | ARCH §0 table I2; SPEC §4 | `packages/core/src/handler/types.ts`; handler implementations |
| S-3 | "Intents always-appendable; facts OCC-checked" via two distinct store methods (`appendIntent`, `appendFact`) | ARCH §0 table I3; SPEC §4 | `packages/store/src/store.ts`; `packages/store/src/types.ts` (`IEventWriter`) |
| S-4 | "Seq assignment is O(1) via per-run counter on `run_state.next_seq`; never scanned" via `UPDATE run_state SET next_seq = next_seq + 1 RETURNING ...` inside append txn | ARCH §0 table I10; §1.5 | `packages/store/src/store.ts`; `packages/store/src/run-state-queries.ts` |
| S-5 | "Event payloads ≤ 4KB" — pre-check (`s.length >= N`) + `CHECK (length(payload) < 4096)` column constraint | ARCH §0 table I7; §9 | `packages/store/src/store.ts` (`validatePayload`); `packages/store/src/schema.sql` |
| S-6 | "`run_state.routing` ≤ 8KB" — `CHECK (length(routing) < 8192)` + pre-check | ARCH §0 table I6; §9 | `packages/store/src/schema.sql`; `packages/store/src/store.ts` |
| S-7 | "Raw tool output addressed by sha256 in `blobs`; artifacts are named refs scoped by `(run, node, iteration, key)`" | ARCH §0 table I8 | `packages/store/src/store.ts` (`putArtifact`); `packages/store/src/schema.sql` |
| S-8 | "LLM-visible preview (`messages`) is distinct from system-recorded raw (`artifacts`); individual messages < 1,048,576 characters" — `CHECK (length(content) < 1048576)` + pre-check throws `MessageTooLargeError` | ARCH §0 table I9; §9 | `packages/store/src/store.ts`; `packages/store/src/schema.sql` |

**OCC discipline**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| S-9 | OCC checked via `run_state.version`; `ConcurrencyError` on conflict; `appendFact` reads and increments version in single transaction | ARCH §0 I3; §1.3; §4.1 | `packages/store/src/store.ts`; `packages/store/test/projection-occ.test.ts`; `packages/store/test/store.property.test.ts` (P2) |
| S-10 | `claimNextRun` flips `queued → running` **without** appending a fact (one sanctioned eventless projection transition); `idx_run_state_queue (priority DESC, ready_at ASC)` is the queue | ARCH §2.1 | `packages/store/src/store.ts` (`claimNextRun`); `packages/store/src/run-state-queries.ts` |

**Seq counter**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| S-11 | `next_seq` is per-run, O(1) update inside every append txn; the per-run counter `bumpRunSeq` is shared by both facts and observability events so they land in the same `seq` space | ARCH §3; §1.5; §3 (observability) | `packages/store/src/store.ts`; `packages/store/test/store.property.test.ts` (P1) |

**Startup sweep**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| S-12 | Startup sweep requeues crash-interrupted `running` rows, quarantines orphan side-effects, preserves `paused`/`paused_human`/`quarantined` untouched; each run healed in its own `SAVEPOINT` so one corrupt row rolls back alone | ARCH §1.4; ARCH §6 | `packages/store/src/sweep.ts`; `packages/store/test/sweep.test.ts`; `packages/store/test/store.property.test.ts` (P5, P6) |
| S-13 | `fact.run_requeued_after_crash` **preserves `currentNode`** — the crash-recovery sweep leaves `current_node` untouched; `EVENT_CONTRACT_VERSION = 6` made the pure fold agree | ARCH §1.1.11; §2.1 | `packages/store/src/reducers.ts`; `packages/store/src/sweep.ts` |

**Migrations**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| S-14 | `migrate()` creates the baseline on fresh DB; walks an existing DB forward through `SCHEMA_MIGRATIONS` up to `CURRENT_SCHEMA_VERSION`; refuses a store newer than the binary (`checkVersion`) | ARCH §1.11; §12; SPEC §5 | `packages/store/src/migrations.ts`; `packages/store/test/migrations.test.ts` |
| S-15 | `migrateTo` (a.k.a. `fragua db migrate --to <lower>`) walks `down` inverses descending, backs up first, refuses irreversible step, refuses to race a live daemon | ARCH §1.11; §12; SPEC §5 | `packages/store/src/migrations.ts` (`migrateTo`/`planMigration`); `packages/store/test/migrate-to.test.ts` |
| S-16 | `CURRENT_SCHEMA_VERSION` (DB-migration counter) is DISTINCT from `EVENT_CONTRACT_VERSION` (run-resume gate); projection-only migrations do NOT bump the contract version | ARCH §1.11; SPEC §5 | `packages/store/src/migrations.ts`; `packages/store/src/store.ts`; `packages/store/test/contract-version.test.ts` |

**Reducer purity and fold-all-versions**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| S-17 | `deriveRunState` is a pure fold over the event log (`reducers.ts`) and must agree with the live projection; bundle import and `fragua show` depend on it | ARCH §2.1; §1.11 | `packages/store/src/reducers.ts`; `packages/store/test/genesis-derive.test.ts`; `packages/store/test/store.property.test.ts` (P4) |
| S-18 | A daemon at contract version V folds correctly every stream pinned in `[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]`; retired fact types stay as read-only, never-emitted members with fold paths intact | ARCH §1.11; SPEC §5; AGENTS.md ground rule 11 | `packages/store/src/reducers.ts`; `packages/store/test/reducer-legacy-fold.test.ts`; `packages/store/test/reducer-terminal-pause-collapse.test.ts` |
| S-19 | Contract-surface hash snapshot test + `reducers.ts` touch-gate script force a conscious bump-or-resnapshot on any fold-contract change | ARCH §1.11 | `packages/store/test/contract-version.test.ts`; `scripts/check-contract-bump.sh` |
| S-20 | `MIN_COMPATIBLE_CONTRACT_VERSION` ratchets only by deliberate act; currently at `1`; `EVENT_CONTRACT_VERSION` currently at `6` | ARCH §1.11; SPEC §5 | `packages/store/src/store.ts` or `packages/types/src/events.ts` |

**Interface segregation**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| S-21 | Store contract segregated into six sub-interfaces: `IEventWriter`, `IEventReader`, `IAnalyticsReader`, `IDaemonCoordinator`, `IProviderCredentialStore`, `IProviderConfigStore`; `IEventStore` is `& IEventWriter & IEventReader & …` type alias | ARCH §4; §4.5 | `packages/store/src/types.ts`; `packages/store/test/event-store-sub-interface.lint.test.ts` |
| S-22 | Sub-interface discipline lint fails the build if a param/property outside `packages/store` is typed as bare `: IEventStore`; only four assembly seams may hold the full composite | ARCH §4.5 | `packages/store/test/event-store-sub-interface.lint.test.ts` |

**SQL placement**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| S-23 | SQL strings are split per-table across `event-queries.ts`, `run-state-queries.ts`, `message-queries.ts`, `artifact-queries.ts`, `workflow-queries.ts`, `daemon-queries.ts`, `analytics-queries.ts`; a lint enforces no DML/DQL outside those files (named maintenance allowlist aside) | ARCH §4.5 | `packages/store/test/sql-location.lint.test.ts`; all `*-queries.ts` files |
| S-24 | Transaction purity lint: no `await`/`JSON.stringify`/`JSON.parse`/`fetch`/`Value.Check` inside `writeTxn`/`.transaction()` callbacks or same-file helpers reachable from one | ARCH §5; I1 enforcement | `packages/store/test/lint.test.ts` |

**Enum consumer lints**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| S-25 | `RUN_STATUSES` and `HALT_REASONS` runtime tuples in `@fragua/types` are the source of truth; SQL `WHERE status IN (…)` clauses and `schema.sql` CHECK are covered by source scan | AGENTS.md ground rule 1 | `packages/store/test/enum-consumers.lint.test.ts`; `packages/core/test/enum-consumers.lint.test.ts` |
| S-26 | `packages/store/test/run-fact-types.lint.test.ts` — fact-type enum consumer lint for store | inferred from test file listing | `packages/store/test/run-fact-types.lint.test.ts` |

**Blob GC roots**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| S-27 | `gcBlobs` treats every sha found in any `run_state.routing` column as a GC root (alongside artifact-referenced blobs), so spilled inputs are never collected while the run is live | ARCH §0 | `packages/store/src/store.ts` (`gcBlobs`); `packages/daemon/test/blob-gc.test.ts` |
| S-28 | File-then-row commit ordering: a crash can leave orphan files (GC sweeps), never dangling rows | ARCH §0; §2 | `packages/store/src/store.ts` (`putArtifact`); `packages/store/test/store.property.test.ts` (P16) |
| S-29 | `blobs` is a global CAS keyed by sha256; no `run_id` FK, no cascade on run deletion; `artifacts` FKs into it and cascades; orphan blob files are reclaimed by `gcBlobs` | ARCH §2 | `packages/store/src/schema.sql`; `packages/store/test/store.property.test.ts` (P14, P16) |

---

### 2.2 Lens: Daemon

**I12 decision/effect boundary**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-1 | Decision core (`planTransition`, `planAbort`, `planPreDispatch`, `planLeakHalt`, plus fan-out planner) is pure: no store I/O, no clock (injected `now`), no RNG (injected `random`), no subprocess/network | SPEC §3.11; ARCH §0 I12; §6.1 | `packages/daemon/src/transition-planner.ts`; `packages/daemon/src/abort-planner.ts`; `packages/daemon/src/predispatch-planner.ts`; `packages/daemon/src/fanout-planner.ts`; `packages/daemon/test/decision-core-discipline.test.ts` |
| D-2 | Driver (`runOne`/`runFanout`) owns all effects: OCC commit, worktree/subprocess/provider work, timers, `AbortSignal` | SPEC §3.11; ARCH §6.1 | `packages/daemon/src/executor.ts`; `packages/daemon/src/dispatch-turn.ts`; `packages/daemon/src/fanout.ts` |
| D-3 | Plan vocabulary is fixed: `facts: FactEvent[]`, `routingPatch?`, `advanceAppliedTo?`, `observability`, and (abort arm) `outcome` commit-strategy tag, and (pre-dispatch) `terminal` | SPEC §3.11 | `packages/daemon/src/transition-planner.ts`; `packages/daemon/src/abort-planner.ts`; `packages/daemon/src/predispatch-planner.ts` |

**`runOne` turn loop**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-4 | `runOne` re-reads `run_state` each turn; returns on any terminal/paused/quarantined status; does NOT re-read `daemon_lock` (zombie fenced only by next OCC commit fail) | ARCH §6; §1.6 | `packages/daemon/src/executor.ts`; `packages/daemon/src/dispatch-turn.ts` |
| D-5 | If a throw escapes the per-turn body (`runOne`'s outer safety-net catch), it commits a crash-terminal fact in-process; on a lost OCC race, retries with fresh `run_state` bounded by `HALT_APPEND_MAX_ATTEMPTS`, escalating to `occ_exhausted` | ARCH §6 | `packages/daemon/src/executor.ts`; `packages/daemon/src/occ-append.ts` |
| D-6 | Function-length lint keeps every function in `packages/daemon/src` ≤ 200 lines | ARCH §6.1 | `packages/daemon/test/function-length.lint.test.ts` |

**Contract gate**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-7 | `runOne` checks contract-version gate: a pin outside `[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` emits `fact.run_paused{reason:"engine_incompatible", pinnedVersion, supportedMin, supportedMax}` and returns | ARCH §6; SPEC §5 | `packages/daemon/src/predispatch-planner.ts`; `packages/daemon/src/dispatch-turn.ts`; `packages/daemon/test/predispatch-planner.test.ts`; `packages/store/test/store.property.test.ts` (P17) |

**Intent fold**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-8 | `cancel` wins over all other intents if present; pause coexists with steer/human as `shouldPauseAfterDispatch`; multi-instance human/priority is last-wins; every intent ends up applied or in `dropped` | ARCH §8; SPEC §3.5; `docs/intent-fold.md` | `packages/core/src/handler/intent-fold.ts` (or equivalent); `packages/core/test/handler/intent-fold.test.ts`; `packages/store/test/store.property.test.ts` (P27) |
| D-9 | A steer that arrives while nothing is dispatched is stashed in `routing.internal.pending_steer` and surfaced as `ctx.steering` on the next dispatch | ARCH §0; `docs/intent-fold.md` | `packages/daemon/src/dispatch-turn.ts`; `packages/daemon/test/steer-delivery.test.ts` |

**Abort signal composition**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-10 | Node abort signal is `AbortSignal.any([steer controller, shutdown, (when maxMs) timeout])`; steer trips on new intents detected by supervisor fiber | ARCH §6; SPEC §3.2; ARCH §1.3 | `packages/daemon/src/dispatch-wiring.ts`; `packages/daemon/src/supervisor.ts` |
| D-11 | `llm` nodes may opt out of wall-clock bounding via `max-ms: 0` — executor skips `AbortSignal.timeout` and the leak watchdog; cost/tokens/operator intents remain operative ceiling | STATUS.md | `packages/daemon/src/dispatch-wiring.ts`; `packages/daemon/test/executor.unbounded.test.ts` |

**Supervisor**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-12 | Supervisor fiber ticks every 50ms: heartbeat (`UPDATE daemon_lock.heartbeat_at`), intent detection (trip abort if unapplied intents), stuck-node detection (watchdog for `maxMs + LEAK_GRACE_MS` exceeded, skipped when `HandlerSpec.maxMs === undefined`) | ARCH §1.3; §6 | `packages/daemon/src/supervisor.ts`; `packages/daemon/test/supervisor.test.ts`; `packages/daemon/test/supervisor-executor.seam.test.ts` |

**Recorder**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-13 | `CommittingRecorder` commits `fact.side_effect_intent` in its own short SQLite transaction **before** handler invokes `fn(idempotencyKey)`; advances `run_state.version` synchronously; terminal `node_completed`/`node_aborted` append uses the recorder's evolved version | ARCH §1.1 | `packages/daemon/src/recorder.ts`; `packages/daemon/test/recorder.test.ts`; `packages/store/test/store.property.test.ts` (P25) |

**Timeout/abort-loop/provider-retry policies**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-14 | Watchdog timeout emits `fact.run_paused{reason:"timeout_retry"}` + paired `fact.node_aborted{cause:"timeout"}`; per-`(nodeId)` counter at `routing.internal.timeout_retries.<nodeId>` caps at 3; backoff starts at 5s, doubles to 60s ceiling; exhaustion halts with `timeout_exhausted` | STATUS.md; SPEC §3.4 paused_auto table | `packages/daemon/src/abort-planner.ts`; `packages/daemon/test/executor.timeout.test.ts`; `packages/daemon/test/executor.graduated-timeout.test.ts` |
| D-15 | Abort-loop ceiling: K>5 consecutive aborts without progress emit `fact.run_paused{reason:"abort_loop"}` (operator-resumable); watchdog timeouts do NOT bump `consecutiveAborts` | ARCH §9; SPEC §3.4; STATUS.md | `packages/daemon/src/abort-planner.ts`; `packages/daemon/test/abort-planner.test.ts`; `packages/daemon/test/abort-planner.property.test.ts` |
| D-16 | Provider-retry: 408/429/5xx/529/network → `paused_auto{reason:"provider_retry"}`; Anthropic `overloaded_error` normalised to 529 before classification; chain capped at 5 attempts / 5 cumulative minutes then `provider_exhausted` pause | STATUS.md; SPEC §3.4; ARCH §1.10 | `packages/daemon/src/abort-planner.ts`; `packages/daemon/test/executor.provider-retry.test.ts`; `packages/daemon/test/provider-retry-policy.test.ts` |
| D-17 | `handler_retry` backoff: retry preset (none/standard/aggressive/linear/patient) determines initial delay + factor + jitter; node-level override attrs (`retry-initial-delay-ms`, `retry-backoff-factor`, `retry-max-delay-ms`, `retry-jitter`) replace individual fields | SPEC §3.7; ARCH §1 | `packages/core/src/engine/retry-policy.ts`; `packages/daemon/src/executor-helpers.ts`; `packages/daemon/test/executor.retry-policy.test.ts`; `packages/daemon/test/executor.resolve-backoff.test.ts` |

**Wake sweeper**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-18 | Wake-pending sweeper emits `fact.run_resumed{fromStatus:"paused_auto"}` once `now >= resumeAt`; run goes back to `queued`; concurrency slot released during wait | SPEC §3.4 paused_auto table | `packages/daemon/src/wake-pending.ts`; `packages/daemon/test/wake-pending.test.ts` |

**Fan-out commit lane**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-19 | Every branch commits through the single daemon writer's serialized lane (`commitFanoutFact`), re-reading the live `version` per attempt; `fanout_joined` is the linearization point | ARCH §6.2; SPEC §3.1.1 | `packages/daemon/src/fanout.ts`; `packages/daemon/test/executor.fanout.test.ts`; `packages/daemon/test/executor.fanout.property.test.ts` (P28–P32) |
| D-20 | `fact.fanout_started` seeds the active set; `fact.fanout_joined` closes it; the live frontier and a from-scratch `deriveRunState` fold agree by construction | ARCH §6.2; SPEC §3.1.1 I11 | `packages/store/src/reducers.ts`; `packages/daemon/test/fanout-planner.test.ts`; `packages/store/test/store.property.test.ts` (P28) |

**Snapshots**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-21 | Per-step + HITL snapshots are `snapshot.captured` observability events (delta-suppressed when tree unchanged); terminal snapshot is OCC-checked `fact.snapshot_recorded`; worktree disposed after terminal snapshot lands | ARCH §3 (observability); ARCH §6.1 | `packages/daemon/src/snapshot-service.ts`; `packages/daemon/test/snapshotter.test.ts` |

**Boot sequence**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-22 | `daemonMain` boot: acquire `daemon_lock` (TTL-reclaim if stale) → startup sweep → wire SIGTERM/SIGINT → start 50ms supervisor fiber → enter executor loop; on exit, release lock + close store | ARCH §6 | `packages/daemon/src/entrypoint.ts`; `packages/daemon/test/daemon.property.test.ts` |

**Observability buffer**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-23 | In-handler buffer flushes on soft 50ms timer or 64 events, whichever first; tail drained synchronously before terminal `fact.node_*`; oversize payload truncated to routing-preserving marker, not rejected | ARCH §3 (observability) | `packages/daemon/src/executor.ts`; `packages/store/src/store.ts` (`appendObservabilityEvents`); `packages/store/test/store.unit.test.ts` |

**Operator-action projection**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| D-24 | Accept/discard intents written by caller (server route or CLI `applyAccept`/`applyDiscard`); daemon's `processOperatorActions` sweep **projects** them to `fact.run_accepted`/`fact.run_discarded` under OCC lockstep with `inbox_status` — no second git run | ARCH §3 intent table (accept_run, discard_run) | `packages/daemon/src/executor.ts`; `packages/daemon/test/operator-actions.test.ts` |

---

### 2.3 Lens: Core

**Browser-safe entry**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-1 | `packages/core/src/index.ts` main entry is browser-safe: no `node:`/`bun:`/`@fragua/store` value imports transitively reachable | AGENTS.md; ARCH §11 | `packages/core/src/index.ts`; `packages/core/test/lint.test.ts` (browser-safety lint) |
| C-2 | Sub-entries `./handler`, `./intent-plane`, `./read-plane` are server-side only and excluded from browser bundle | AGENTS.md | `packages/core/package.json` (exports map) |

**Handler discipline**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-3 | Handler discipline lint (AST scan): no `node:*`/`undici` import, `fetch`/`globalThis.fetch`, `Bun.*`, or `process.env` inside `handlers/`; biome `noRestrictedImports` bans `node:fs`/`node:child_process`/`undici` as pre-commit backstop | ARCH §5; SPEC §3.2; AGENTS.md | `packages/core/test/handler/discipline.test.ts`; `biome.json` |

**Edge selection**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-4 | Two-case edge selection: Route case (source node declares `routes:`, edge matched on `route=` attr) vs Outcome case (edge matched on `outcome=` attr; unannotated edges default to `outcome=success`); unmatched route halts with `edge_no_match` | SPEC §3.6 | `packages/core/src/engine/edge-selection.ts`; `packages/core/test/engine/edge-selection.test.ts`; `packages/core/test/engine/edge-selection.property.test.ts` |
| C-5 | A fail-edge to the `exit` sink is a graceful exception: run emits `fact.run_terminated{status:"completed"}` rather than halting with `aborted_exit` | SPEC §3.6 | `packages/core/src/engine/edge-selection.ts`; `packages/daemon/src/transition-planner.ts` |

**Substitution**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-6 | `${{ inputs.<name>[.<field>…] }}` reads are **lenient**: unresolvable path collapses to `""`; validator (E030) flags undeclared inputs and rejects dotted sub-reference into scalar input | SPEC §3.8 | `packages/core/src/engine/substitution.ts` (or equivalent); `packages/core/test/engine/substitution.test.ts`; `packages/core/test/engine/inputs.test.ts` |
| C-7 | `${{ outputs.<producer>.<field> }}` reads are **fail-closed**: referencing an unpopulated field fails the consuming node; a tool producer that exits 0 without leaving a parseable valid struct fails the node | SPEC §3.8 | `packages/core/src/engine/substitution.ts`; `packages/core/test/engine/outputs-substitution.test.ts` |
| C-8 | Output values interpolated into an `llm` prompt are wrapped in content-derived delimiters to prevent prompt injection | STATUS.md | `packages/core/src/engine/substitution.ts` |

**Validator codes named in SPEC and the workflows skill**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-9 | Error codes E028 (`exit` type mismatch), E029 (`start` name reserved), E030 (undeclared/scalar-dotted input), E031 (retry without max-retries), E035 (broken output ref), E036–E045 (parallel fan-out well-formedness), E046 (broken run-output projection), E057 (retry_target on non-gate), plus warning codes W013 (unknown attr), W014, W015 (output on off-path), W016 (optional leaf read), W018 (run-output off-path) | SPEC §3.1, §3.1.1, §3.8; validator-codes.md | `packages/core/src/engine/validator.ts`; `packages/core/test/engine/validator.test.ts`; `packages/core/test/engine/validator-outputs.test.ts`; `packages/core/test/engine/validator-judge.test.ts`; `packages/core/test/engine/validator-run-outputs.test.ts` |
| C-10 | Error-severity validator diagnostics (E-codes) rejected at workflow mint — an E-coded graph never reaches the executor | SPEC §2 | `packages/core/src/intent-plane/` (plane workflow mint); `packages/core/test/intent-plane/plane.test.ts` |

**Intent plane**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-11 | Intent plane (`@fragua/core/intent-plane`) is the single write surface: `buildEnqueue` → `commitEnqueue` coerces + folds `inputs` into `routing.inputs`; server, CLI, and schedule dispatcher all go through it; adapters never call `store.enqueueRun` directly | ARCH §7; SPEC §2 | `packages/core/src/intent-plane/`; `packages/server/test/intent-plane-discipline.test.ts` |
| C-12 | Intent plane validates typed `inputs` against the workflow's `inputs:` block at enqueue (400 on missing required or out-of-range choice) | ARCH §7 | `packages/core/src/intent-plane/`; `packages/core/test/intent-plane/plane.test.ts` |

**Read plane**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-13 | Read plane (`@fragua/core/read-plane`) projects run summary/detail/steps/messages/events/snapshots/diff/streaming; also fronts `pauseRoutes`, `controlState`, `projects`, `globalMetrics`/`globalModelBreakdown` | ARCH §4.2 | `packages/core/src/read-plane/projections.ts`; `packages/core/test/read-plane/` |
| C-14 | Read plane is pure: no `node:fs` sync calls (`existsSync`/`statSync`/`readFileSync`) inside `packages/core/src/read-plane/`; filesystem probe for `RunDetail.worktreePath` lives at the HTTP route boundary | ARCH §5 | `packages/core/test/read-plane/no-syscall.test.ts`; `packages/core/test/read-plane/discipline.test.ts` |

**Routing accessors and lint**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-15 | Routing lint bans raw `routing[…]` indexing / destructuring on routing-named or `RoutingDict`-typed bindings outside `packages/core/src/routing.ts`; eight typed accessor families | ARCH §2.1; §0 I6 | `packages/core/src/routing.ts`; `packages/daemon/test/routing-index-discipline.test.ts` |
| C-16 | Accessors degrade to conservative authored default on mis-folded key — never pause unexpectedly | ARCH §2.1 | `packages/core/src/routing.ts`; `packages/core/test/routing.test.ts` |

**Retry presets**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-17 | Five named presets: `none` (default, 1 attempt), `standard` (5, 200ms, 2.0, jitter), `aggressive` (5, 500ms, 2.0, jitter), `linear` (3, 500ms, 1.0, no jitter), `patient` (3, 2000ms, 3.0, jitter); unrecognised preset warns (W014) and silently falls back to `none` | SPEC §3.7 | `packages/core/src/engine/retry-policy.ts`; `packages/core/test/parser/retry-policy.test.ts`; `packages/core/test/engine/retry-policy.test.ts` |

**Parser**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-18 | YAML parser synthesizes `start` node (pointing at first declared step); `exit` is reserved sink; `start`/`exit` type conflicts are E029/E028 | SPEC §3.1 | `packages/core/src/parser/yaml.ts`; `packages/core/test/parser/yaml.test.ts` |
| C-19 | `ir_version` on `workflows` table is distinct from `schema_version`/`contract_version`; every workflow is parsed once at mint, IR stored with `loc` stripped | ARCH §2 | `packages/core/src/parser/yaml.ts`; `packages/store/src/schema.sql` |

**HandlerResult**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-20 | `HandlerResult` is a discriminated union over `kind`: `transition`, `yield_human`, `halt`, `pause_provider`; `failureReason` is canonical channel for quotable fail cause; `outcomeStatus="retry"` emits `fact.run_paused{reason:"handler_retry"}`, no `node_completed` | ARCH §5; handler-contract.md | `packages/core/src/handler/types.ts`; `packages/core/test/handler/handlers.test.ts` |

**Judge**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| C-21 | `judge` node: turn-less typed judgment (`choice`/`score`/`noul`) from a System One model; `for-each:` asks every question once per item in one call; `decide:` binds a choice to route-case or noul to success/fail; `composite:` declares weighted means | SPEC §3.1; STATUS.md (experimental, needs `typesafe` credential) | `packages/core/src/handler/handlers/judge.ts`; `packages/core/test/handler/judge.test.ts`; `packages/core/test/handler/judge-for-each.test.ts` |

---

### 2.4 Lens: Agent + Workspace

**Swap surface**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-1 | The swap surface for the pi-ai dependency is one file: `PiLlmBackend` in `packages/agent/src/backend.ts` implements `@fragua/core`'s `LlmBackend` interface | SPEC §1 | `packages/agent/src/backend.ts` |
| A-2 | Persisted transcript is pi-agent-core's `AgentMessage` (re-exported through `@fragua/types`); handlers never construct providers or drive the agent loop | SPEC §1 | `packages/types/src/events.ts`; `packages/agent/src/handler-bridge.ts` |

**Force-included tools**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-3 | `abort` tool force-included on every llm call; agent calling it produces `outcome.status="fail"` with `non_retryable=true` | SPEC §3.2 | `packages/agent/src/backend.ts`; `packages/agent/test/abort-tool.test.ts` |
| A-4 | `skill` tool force-included on every llm call regardless of `allowed-tools`/`denied-tools`; loads SKILL.md, parses frontmatter, substitutes `$ARGUMENTS` | STATUS.md; AGENTS.md ground rule 12 | `packages/agent/src/backend.ts`; `packages/agent/test/backend-skill-tool.test.ts` |
| A-5 | `emit_output` tool force-included on `llm` steps that declare `outputs:`; called in isolation (paired with other tool calls fails the node) | SPEC §3.8 | `packages/agent/src/backend.ts`; `packages/agent/test/emit-output.test.ts` |
| A-6 | `route` tool synthesized ephemerally per `llm` step declaring `routes=`; constrained to declared enum | SPEC §3.6 | `packages/agent/src/backend.ts`; `packages/agent/test/route-tool.test.ts` |

**Read-only enforcement layers**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-7 | Three-layer read-only enforcement for review/observer nodes: (a) `ctx.tools` narrowed via `ToolRegistry.select` before `HandlerContext` built; (b) llm backend re-applies `select(...)` on workspace registry; (c) `ctx.env` wrapped in read-only proxy when no mutating tool (`bash`/`write`/`edit`) visible — `env.writeFile`/`env.exec` throw `ReadOnlyEnvError` | ARCH §12.1 | `packages/core/src/handler/types.ts`; `packages/core/test/types/read-only-env.test.ts`; `packages/core/test/handler/context-allowed-tools.test.ts` |

**Provider error classification**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-8 | `PiLlmBackend` registers `StreamOptions.onResponse` to capture last `ProviderResponse.status` per call; on stream error, captured status (or `null`) paired with `errorMessage` and bubbled as `HandlerResult.kind="pause_provider"` | ARCH §1.10 | `packages/agent/src/backend.ts`; `packages/agent/test/extract-http-status.test.ts`; `packages/agent/test/unclassified-error-pause.test.ts` |
| A-9 | Anthropic `overloaded_error` envelope normalised to canonical 529 before classification (mid-stream 200 → 529) | ARCH §1.10 | `packages/agent/src/backend.ts`; `packages/agent/test/overloaded-error-retry.test.ts` |

**Steering broadcast**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-10 | Mid-flight steer broadcasts to **every** in-flight LLM branch of the run; delivery recorded as `fact.steering_applied{disposition:"delivered"|"buffered", targets[]}` | ARCH §0; §3 fact table | `packages/agent/src/steering-registry.ts` (or equivalent); `packages/daemon/test/steer-delivery.test.ts`; `packages/agent/test/steering-registry.test.ts`; `packages/agent/test/steering-shared-registry.test.ts` |
| A-11 | The buffer is cleared when the run's live-agent set empties, not when first drained (fan-out: holds N racing branches) | ARCH §3 (`fact.steering_applied`) | `packages/agent/src/steering-registry.ts` |

**Credential storage**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-12 | Provider credentials in `provider_credentials` table; `SqliteAuthStorageBackend` rebuilds in-memory blob on read, applies returned `next` blob by full-replace; no `!cmd`/env-var resolution in the credential path | ARCH §6 (credential storage); STATUS.md | `packages/agent/src/backend.ts`; `packages/agent/test/auth-storage-sqlite.test.ts` |
| A-13 | Custom-provider definitions in `provider_config` table; `ModelRegistry.loadCustomModels` Ajv-validates each row on read; one corrupt row skipped without poisoning siblings | ARCH §6; STATUS.md | `packages/agent/src/credentials/model-registry.ts`; `packages/agent/test/model-registry.test.ts`; `packages/store/test/provider-config.test.ts` |

**Env path gate and bash reach**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-14 | Bash subprocess inherits only baseline env (PATH/HOME/TMPDIR/TERM/SHELL/USER/LANG/LC_*/FRAGUA_*) plus operator's `bash.env-passthrough`/`--allow-env` names; provider credentials refused | SPEC §5 (not-in-scope); STATUS.md; handler-contract.md | `packages/workspace/src/local-env.ts`; `packages/cli/test/env-creds.test.ts`; `packages/cli/test/daemon-env-deny-wiring.test.ts` |
| A-15 | `bash` is arbitrary code execution on host filesystem and network — no sandbox; `cd`-escape backstop and coarse refuse-list blocklist are the only guardrails; `cwd` jail on `read`/`write`/`edit` does NOT extend to bash command body | SPEC §5 | `packages/workspace/src/local-env.ts`; handler-contract.md |
| A-16 | Skills re-anchored to worktree path when run executes in a worktree — advertised `<location>` passes the env path gate | ARCH §3 (observability, `llm.start.skills[]`) | `packages/workspace/src/skills/` (`reanchorSkillsToRunTree`); `packages/workspace/test/skills/` |

**Run-actions git**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-17 | `applyAccept`/`applyDiscard` in `@fragua/workspace/src/run-actions.ts` are shared by both the server route and the CLI — state gate (terminal/in-inbox/has-worktree) folded into one action | AGENTS.md; ARCH §3 intent table | `packages/workspace/src/run-actions.ts`; `packages/workspace/test/run-actions.test.ts` |

**Skills**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-18 | Skills discovered from `~/.agents/skills/` (global) and `<project>/.fragua/skills/` (or project root); daemon scans both at boot; llm-time filter prunes to globals ∪ run's own project | AGENTS.md; STATUS.md | `packages/workspace/src/skills/`; `packages/workspace/test/skills/discover.test.ts` |

**MCP lifecycle**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-19 | MCP tools (experimental): `llm` steps opt in via `mcp_servers:`; tools materialise as `mcp__<server>__<tool>`; stdio and HTTP transports; OAuth token lifecycle via store-backed provider; connector contract not frozen | STATUS.md (experimental) | `packages/workspace/src/mcp/`; `packages/workspace/test/mcp/`; `packages/cli/test/mcp-oauth-store.test.ts` |

**Worktree provisioning**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| A-20 | Per-run git worktree provisioned at `<project>/.fragua/worktrees/<run_id>/`; `git worktree add --detach <path> <sha>`; `--base <ref>` pinned at enqueue time carried as `baseGitSha`/`baseGitRef` on genesis event; without `--base` defaults to HEAD at provision time | SPEC §3.8; ARCH §0 | `packages/daemon/src/worktree-provisioner.ts`; `packages/daemon/test/worktree-provisioner.test.ts`; `packages/daemon/test/executor-worktree.test.ts` |
| A-21 | Terminal snapshot captured into `refs/fragua/snapshots/<run_id>` + `refs/fragua/heads/<run_id>`; worktree disposed after `fact.snapshot_recorded` commits | STATUS.md; ARCH §3 | `packages/daemon/src/snapshot-service.ts`; `packages/daemon/test/snapshotter.test.ts` |

---

### 2.5 Lens: Surface (server + cli + web)

**Loopback bind and origin gate**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-1 | HTTP server binds **loopback by default**; wider bind (`--host`/`web.host`) is deliberate operator choice; `serve: binding :: exposes …` warning emitted | SPEC §2 | `packages/server/src/index.ts`; `packages/cli/test/serve.test.ts` |
| X-2 | Same-origin gate before every route: request with `Origin` not matching bound origin → 403; `Host` neither loopback nor bound host → 403 (DNS rebinding block); bodied request without `content-type: application/json` → 415 | SPEC §2; STATUS.md | `packages/server/src/`; `packages/server/test/origin-gate.test.ts` |

**Body validation**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-3 | Every route validates its body and rejects 4xx on schema violation before any intent appended | SPEC §3.5 | `packages/server/src/schemas.ts`; `packages/server/src/store/routes.ts`; `packages/server/test/store/routes.test.ts` |
| X-4 | `POST /runs` validates typed `inputs` against workflow `inputs:` block (400 `invalid_inputs`); preflights provider-credential availability (400 `provider_unavailable`); queued-run backpressure (429 `queue_full` with `Retry-After`) | ARCH §7 | `packages/server/src/store/routes.ts`; `packages/server/test/store/runs-adapter.test.ts` |

**Plane discipline**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-5 | Run-read route handlers project through the read plane; `packages/server/test/read-plane-discipline.test.ts` fails on raw `deps.store.<reader>()` in a run-read route body without `read-discipline-allow:` marker | ARCH §4.2; §5 | `packages/server/test/read-plane-discipline.test.ts` |
| X-6 | Intent-plane discipline lint prevents adapters from calling `store.enqueueRun` directly | ARCH §7 | `packages/server/test/intent-plane-discipline.test.ts` |

**SSE cursors**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-7 | SSE polls `events WHERE seq > cursor` every 100ms per subscribed run; reconnect with `Last-Event-ID=N` receives `seq > N` in order | ARCH §1.3; §0 | `packages/server/src/store/sse.ts`; `packages/server/test/store/sse-feed-loop.test.ts`; `packages/server/test/store/sse-keepalive.test.ts`; `packages/store/test/store.property.test.ts` (P19) |

**Endpoint discovery and stale rendezvous**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-8 | `server_endpoint` row written by whoever binds the listener (harness in-process or standalone `fragua serve`); cleared on SIGINT; Web UI and remote clients discover URL via DB — no JSON rendezvous file | ARCH §0; SPEC §2 | `packages/store/src/schema.sql`; `packages/server/src/index.ts`; `packages/cli/src/commands/` |
| X-9 | `fragua run`/`runs` verbs are store-clients that open the DB directly; they do NOT need `server_endpoint` | AGENTS.md; SPEC §2 | `packages/cli/src/store-client.ts` |

**Inline-import lint**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-10 | No dynamic `import()`/`require()` in production source across `packages/*/src` + `cli/bin`; AST lint (not regex); `// inline-import-allow: <reason>` marker; test files exempt | AGENTS.md ground rule 6 | `packages/server/test/inline-import-discipline.test.ts` |

**CLI as store-client**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-11 | CLI opens `~/.fragua/fragua.db` (or `--db <path>`) directly; writes via intent plane; reads via read plane; no HTTP; works daemon-down | SPEC §2; AGENTS.md | `packages/cli/src/store-client.ts`; `packages/cli/test/` |
| X-12 | `fragua runs wait` blocks until a set of runs settles; exits 0 on all-completed, banded on halt/quarantine, 60 on blocked-for-input, 75 on timeout | STATUS.md | `packages/cli/src/commands/`; `packages/cli/test/runs-wait.test.ts` |

**Executor-deps sharing**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-13 | `executor-deps.ts` (`buildExecutorDeps`) is the shared executor assembly behind both `daemon` and `ci`; `ci` embeds the executor over an ephemeral store (`env-creds.ts` seeds creds from env) | AGENTS.md | `packages/cli/src/executor-deps.ts`; `packages/cli/test/executor-deps.test.ts`; `packages/cli/test/ci.test.ts` |

**Harness lifecycle**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-14 | `fragua harness` (default entry): foreground process supervising daemon subprocess + in-process HTTP server; auto-builds web bundle when sources newer than `dist/`; SIGINT clears `server_endpoint` row | SPEC §2; STATUS.md | `packages/cli/src/commands/`; `packages/cli/test/harness.test.ts`; `packages/cli/test/daemon-stop.test.ts` |

**Workflow resolution**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-15 | Bare-name resolution: `~/.fragua/workflows/<name>.yaml` first, then `<cwd>/.fragua/workflows/<name>.yaml`; path-shaped resolves verbatim | AGENTS.md; STATUS.md | `packages/cli/src/commands/`; `packages/cli/test/workflow-path.test.ts` |

**Config cascade**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-16 | Two-layer config cascade: `~/.fragua/config.yaml` (global) overlaid by `<cwd>/.fragua/config.yaml` (project); project keys win; nested objects merge one level deep; YAML only | AGENTS.md; STATUS.md | `packages/cli/src/`; `packages/cli/test/config.test.ts` |
| X-17 | Project identity is `project_id` — stable UUIDv7 committed in `.fragua/config.yaml`, denormalized NOT NULL onto `run_state.project_id`; CLI auto-inits one when missing | AGENTS.md; ARCH §2 | `packages/cli/src/commands/init.ts` (or equivalent); `packages/cli/test/init.test.ts` |

**`migrate --to`**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-18 | `fragua db migrate --to <lower>` walks `down` inverses descending; backs up first; refuses irreversible step, data-losing step (without `--allow-data-loss`), or live daemon | SPEC §5; ARCH §1.11 | `packages/store/src/migrations.ts`; `packages/cli/test/db.test.ts`; `packages/store/test/migrate-to.test.ts` |

**Web stack and query discipline**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-19 | React 18 + Vite 5 + Tailwind 4 (CSS-first, `@theme inline`, no `tailwind.config.ts`) + react-router v7; server state via `@tanstack/react-query` query factories | AGENTS.md | `packages/web/package.json`; `packages/web/src/` |
| X-20 | `@fragua/web` uses vitest for tests (not bun test); `bun run test:web` is required; bare `bun test` skips web suite | AGENTS.md | `packages/web/package.json`; `packages/cli/test/web-build.test.ts` |

**Web package boundary**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-21 | `web` imports only `types` and `core` (per import edges); does not import `store`, `daemon`, `agent`, `server`, or `cli` | AGENTS.md; ARCH §11 | `packages/web/src/`; import-edges.txt (`web → types(23), core(6)`) |

**DTO widening**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-22 | Run-read DTOs (`RunSummary`/`RunDetail`) are `@fragua/core/read-plane` schemas re-exported through `src/lib/api.ts`; where the shape validators soft-accept old-daemon payloads that omit a field, the re-export widens that field to `optional` so the type matches runtime | AGENTS.md | `packages/web/src/lib/api.ts` |

**Bundle export / import**

| # | Claim | Location | Checkable files |
|---|---|---|---|
| X-23 | `fragua runs export` runs Aho-Corasick credential scan over outgoing bundle; emits `[REDACTED:source]` markers; `liveLiteralHit` flag warns when live credential detected; `fragua ci --export` exits 80 on live-credential hit | STATUS.md (experimental) | `packages/store/src/`; `packages/store/test/scrub.test.ts`; `packages/store/test/scrub-e2e.property.test.ts`; `packages/cli/test/run-bundle.test.ts` |
| X-24 | Bundle import reconstructs `run_state` by `deriveRunState` over the event log (bundles carry no projection); imported runs marked inert via `imported_runs` table row (the AUTHORITATIVE inert gate) | ARCH §2 | `packages/store/src/store.ts`; `packages/store/test/portable-export.test.ts`; `packages/store/test/exclude-imported.test.ts` |

---

## 3. Known-Gap Register

Everything the docs explicitly admit is unbuilt, deferred, or rough. Lenses should not re-report these as findings.

### 3.1 From STATUS.md — "What fragua does not deliver today"

| Gap | Note |
|---|---|
| Multi-machine deployment | Single SQLite coordination surface; no story for multiple daemons across machines |
| Token auth on the harness API | Localhost-only, no token auth in v0; same-origin gate runs but residual exposure is a compromised same-host process |
| Watchdog for stuck-but-alive daemons | Resumability covers crash-restart but not fiber deadlock; planned heartbeat metric, deferred |
| Postgres or non-SQLite backing | `IEventStore` is synchronous; not a drop-in port |
| Workflow hot-reload for in-flight runs | `workflow_sha` is pinned at enqueue time |
| Schema auto-migration across breaking bumps | Runs pin `contract_version`; out-of-range pin → recoverable `fact.run_paused{reason:"engine_incompatible"}` |
| Per-project credential isolation, project extensions, file-server, rate-limit fairness | Design-stage only |

### 3.2 From SPEC §5 — "Out of scope by design"

| Gap | Note |
|---|---|
| Multi-machine deployment | `IEventStore` synchronous; shared/Postgres is structurally out of scope |
| Blob encryption | Single-user local tool; DB read = full read; deferred |
| Auto-migration of contract drift | Recoverable pause instead of auto-upgrade; by design |
| Schema downgrade automatic | Explicit operator action only (`fragua db migrate --to`) |
| Workflow hot-reload | `workflow_sha` pinned; by design |
| Shell / network sandboxing of `bash` | Not a sandbox; three coarse guardrails only (env allow-list, refuse-list, cd-escape backstop); by design under single-user threat model |
| `wait_any`/`race`/`quorum` joins | Excluded by design — breaks SESE invariant |
| Cross-run fan-in | Composition via artifact-sharing only |
| Dynamic fork (runtime-sized branches) | Branch set materialised at parse time; by design |
| Manager-loop / supervisor-stack primitive | Composition at workflow level via separate runs |
| Pre/post tool hooks as workflow attributes | Agent backend handles tool interception |
| Bundle secret scrubbing for binary blobs | Live credential in a binary blob is not scrubbed; export warns |

### 3.3 From ARCH §12 — "Deferred decisions"

| Gap | Note |
|---|---|
| Blob encryption | Deferred to optional encryption later |
| Cross-machine deployment | `IEventStore` synchronous binding constraint; §4 surface segregation removes one blocker, not the binding one |
| Retention policies per workflow | Manual `fragua prune` until demand |
| Blob streaming > 16 MB | Handler must chunk; revisit on real use case |
| Auto-migration across schema bumps | Explicit `migrate()` only; downgrade via `migrateTo` |
| Workflow hot-reload | Not planned |
| Per-workflow concurrency caps | Easy via partial-index counts; not needed yet |

### 3.4 From ARCH §1.11 / SPEC §5 — Contract version known constraints

| Gap | Note |
|---|---|
| Capability-gated auto-wake for too-new arm | `pinnedVersion > supportedMax` heals once a capable daemon runs; auto-wake deferred |
| `cross_run_signal` pause reason | The `signal` reason value (external wait) is listed in `fact.run_paused` docs as NOT emitted yet (ARCH §3 fact table note) |
| Spilled routing inputs in bundle export/import | Bundle export/import support for `$fragua_blob` routing spill refs is pending (ARCH §0, item B5) |

### 3.5 From ARCH §6.2 — Fan-out known gaps

| Gap | Note |
|---|---|
| Per-branch pause seam | No per-branch pause (pause is run-global); not built and won't be until demand |
| Max-branch validator bound | No upper bound on branch count (only E036's ≥2 minimum); a pathologically wide fan-out fails its seed loudly with `PayloadTooLargeError` |

### 3.6 From STATUS.md — Experimental / not frozen

| Gap | Note |
|---|---|
| MCP connector contract and `.mcp.json` schema | Not frozen |
| Bundle secret scrubbing: scrubber registry, marker format, CI exit code | Not yet frozen |
| `judge` step | Experimental; needs `typesafe` credential |

### 3.7 One skipped test

| Gap | Note |
|---|---|
| `executor — §3.7 fail-routing retarget > node fails with no fail-edge but retry_target set → retargets` | Marked `(skip)` in `packages/daemon/test/executor.goal-gate.test.ts`; scenario: a non-goal-gate node with `retry_target` set (should be rejected by E057) — skipped, not a known-broken case |

### 3.8 Import edge deviations (documented above, not findings yet)

Lenses should investigate whether the five deviating import edges (`store → core(4)`, `agent → store(5)`, `cli → daemon(3)`, `cli → server(2)`, `server → agent(2)`) violate the documented architectural constraint or are benign sub-entry/type-only imports before classifying them as findings.
