# fragua — Assessment Survey

> Claim inventory for five verification lenses running on fresh context.
> All data read from disk; nothing here is a judgment — lenses draw their own conclusions.
> Focus: whole project.

---

## 1. Baseline

### 1.1 CI results (verbatim)

| Suite | Result | Exit code | Count |
|---|---|---|---|
| `bun run --filter='*' typecheck` | **PASS** | 0 | 10 packages, all exit 0 |
| `biome check .` | **PASS** | 0 | 857 files checked, no fixes applied |
| `bun run test:node` | **PASS** | 0 | **3583 pass / 1 skip / 0 fail**, 91 173 expect() calls, 302 files, 88.62 s |
| `bun run test:web` | **PASS** | 0 | **725 pass / 0 fail**, 93 test files, 10.95 s (vitest/jsdom) |

**Notable test-run output (not failures, but lens-relevant):**
- `[store] truncated oversized observability event` — 2 instances during `store.unit.test.ts` (types `llm.start`, sizes 8 048 and 16 163 bytes vs 4 096 cap); truncation path exercises correctly.
- `fragua: refusing to pass provider credential(s) through bash.env-passthrough` — 6 instances during `env-creds.test.ts`; credential-gate fires correctly for `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `GROQ_SECRET`, `ANTHROPIC_RATE_LIMIT_TOKEN`.
- `serve: binding :: exposes the unauthenticated API beyond this machine` — 1 instance in `serve.test.ts`; wide-bind warning path exercised.
- `[executor] handler leak #1 on …` — numerous instances across executor, fanout, fault-property, and reaper tests; leak-detection path fires as expected in tests.
- `[blob-gc] sweep failed: warn: simulated FS error` — 1 instance in `blob-gc.test.ts`; GC error-survival path exercised.
- `harness: daemon failed to acquire lock` / `daemon exited during boot` — multiple instances in `harness.test.ts`; supervisor restart backoff and failure scenarios covered.
- `skills: skill at … body 615 lines exceeds soft cap 500` — repeated for `graphify` skill in `ci.test.ts`; skills soft-cap warning path fires correctly (not a test failure).

### 1.2 Package sizes (lines: src vs test)

| Package | src (lines) | test (lines) | test/src ratio |
|---|---|---|---|
| `@fragua/agent` | 5 237 | 7 816 | 1.49 |
| `@fragua/cli` | 9 582 | 10 550 | 1.10 |
| `@fragua/core` | 12 848 | 12 669 | 0.99 |
| `@fragua/daemon` | 7 737 | 20 419 | **2.64** |
| `@fragua/server` | 4 234 | 7 073 | 1.67 |
| `@fragua/store` | 10 218 | 11 505 | 1.13 |
| `@fragua/test-utils` | 125 | 151 | 1.21 |
| `@fragua/types` | 1 762 | 90 | **0.05** |
| `@fragua/web` | 28 925 | 15 847 | **0.55** |
| `@fragua/workspace` | 5 804 | 5 076 | 0.87 |

**Largest single files (lines):**

| Lines | File |
|---|---|
| 2 577 | `packages/store/src/store.ts` |
| 2 280 | `packages/daemon/src/executor.ts` |
| 1 774 | `packages/core/src/engine/validator.ts` |
| 1 553 | `packages/agent/src/backend.ts` |
| 1 534 | `packages/web/src/components/RunConversation.tsx` |
| 1 450 | `packages/types/src/events.ts` |
| 1 358 | `packages/web/src/lib/api.ts` |
| 1 322 | `packages/cli/src/commands/operator.ts` |
| 1 308 | `packages/store/src/types.ts` |
| 1 220 | `packages/web/src/components/ai-elements/prompt-input.tsx` |
| 1 214 | `packages/daemon/src/transition-planner.ts` |

### 1.3 Documented vs measured dependency direction

**Documented** (AGENTS.md / ARCHITECTURE.md §11):
```
web → server → store ← daemon → core ← agent
```
with `workspace` feeding `daemon`, `server`, `agent`; `types` shared; `cli` as direct store-client.

**Measured import-edge counts** (from `import-edges.txt`):

| Package | Outbound edges (count by target) |
|---|---|
| `agent` | core(13), workspace(6), store(5), types(4) |
| `cli` | core(20), store(18), agent(9), types(6), workspace(5), **daemon(3)**, **server(2)** |
| `core` | types(17), **store(6)** |
| `daemon` | core(21), store(18), workspace(1), types(1) |
| `server` | store(15), core(12), workspace(4), types(2), agent(2) |
| `store` | types(12), **core(4)**, **store(1)** (self) |
| `web` | types(23), core(6) *(no `server` edge visible)* |
| `workspace` | core(10), types(4), workspace(1) (self) |

**Deviations from documented direction (for lenses to verify):**

1. **`web → server` not observed** — measured edges show `web → {types, core}` only; no `server` import count. Web talks to the server via HTTP (fetch), not module imports, which would explain the absence from static-edge counts, but lenses should confirm `@fragua/server` is not in `web/package.json`.
2. **`core → store(6)`** — AGENTS.md says `store ← daemon → core ← agent`; the documented direction implies `core` does not import `store`. Six measured edges in the reverse direction (core imports from store) warrant verification — could be type-only imports from `@fragua/store/src/types.ts` or legitimate seam-crossing.
3. **`store → core(4)`** — similarly the documented direction implies `store` does not import `core`; 4 measured edges.
4. **`agent → store(5)`** — agent importing store directly (not through core) is undocumented in the dependency direction table.
5. **`cli → daemon(3)` and `cli → server(2)`** — AGENTS.md calls CLI a "direct store-client" that never goes through the HTTP server; 2 server-imports and 3 daemon-imports may be type/constant re-exports or the `executor-deps.ts` sharing noted in AGENTS.md (CLI embeds the executor for `fragua ci`).

---

## 2. Claim Inventory

### Lens A — Store

#### A1 — I1: every write is one SQLite transaction; events + projection updated together
> "Every write is one SQLite transaction; events + projection updated together." — SPEC §4, ARCHITECTURE §0 / invariant table
- Enforced by: `packages/store/src/store.ts` (all `appendFact`, `appendIntent`, `appendObservabilityEvents`, `enqueueRun`, `claimNextRun` call sites wrap in `db.transaction()`).
- Structural lint: `packages/store/test/lint.test.ts` — AST rule banning `await`/`JSON.stringify`/`fetch` inside `.transaction()` bodies.
- ARCHITECTURE §0: "Store module API; lint rule: no `await`/`fetch`/`JSON.stringify` inside `db.transaction()` bodies."
- Checkable in: `packages/store/src/store.ts`, `packages/store/test/lint.test.ts`.

#### A2 — I2: no handler state outside the projection
> "No handler state outside the projection." — SPEC §4
- HandlerContext is reconstructed each turn from `run_state`; handlers return `HandlerResult` with no mutation of external state.
- Checkable in: `packages/core/src/handler/types.ts`, `packages/daemon/src/executor.ts` (HandlerContext construction).

#### A3 — I3: intents always-appendable; facts OCC-checked
> "Intents always-appendable; facts OCC-checked." — SPEC §4, ARCHITECTURE §0
- Two distinct store methods: `appendIntent` (no version check) and `appendFact` (OCC-checks `run_state.version`).
- `packages/store/src/store.ts` — `appendFact` reads then compares version; `appendIntent` does not.
- `packages/daemon/src/occ-append.ts` — `tryAppendFact` / `makeOccController`.
- Checkable in: `packages/store/src/store.ts`, `packages/store/src/types.ts`, `packages/daemon/src/occ-append.ts`, `packages/store/test/store.unit.test.ts` (P2).

#### A4 — OCC bounded retry: occ_exhausted halt
> "Bounded OCC retry loop with structured occ_exhausted halt… 1–16ms exponential backoff." — STATUS.md
- `packages/daemon/src/occ-append.ts` — `makeOccController`; warn at 2, halt with `occ_exhausted` at 3.
- `fact.run_terminated{status:"errored", reason:"occ_exhausted"}` carries `occContext { count, nodeId, iteration, lastVersion, attemptedFactType }`.
- Checkable in: `packages/daemon/src/occ-append.ts`, `packages/types/src/events.ts`.

#### A5 — I10: seq assignment O(1) via per-run counter
> "Seq assignment is O(1) via per-run counter on `run_state.next_seq`; never scanned." — SPEC §4, ARCHITECTURE §2
- `UPDATE run_state SET next_seq = next_seq + 1 RETURNING ...` inside append txn; no `MAX(seq)` scan.
- Checkable in: `packages/store/src/store.ts` (append methods), property test P1 in `packages/store/test/`.

#### A6 — I6: routing ≤ 8 KB with SQL CHECK
> "`run_state.routing` ≤ 8KB… `CHECK (length(routing) < 8192)` column constraint." — SPEC §4, ARCHITECTURE §2
- SQL CHECK in schema + `validatePayload`-equivalent pre-check before write.
- I6 is described as a "defense-in-depth tripwire, not a functional budget."
- Checkable in: `packages/store/src/schema.sql`, `packages/store/src/store.ts`.

#### A7 — I7: event payloads ≤ 4 KB
> "Event payloads ≤ 4KB. `store.ts::validatePayload` (binding 4 KiB-byte guard via `TextEncoder().byteLength`); the `CHECK (length(payload) < 4096)` column constraint is a coarse code-point backstop only." — SPEC §4, ARCHITECTURE §2
- Pre-check uses `TextEncoder().byteLength ≥ 4096` (bytes); SQL CHECK uses `length()` code points. Pre-check is the binding constraint for non-BMP content.
- Observability events that exceed the cap are **truncated** (not rejected) — confirmed in test output: `[store] truncated oversized observability event`.
- Checkable in: `packages/store/src/store.ts` (`validatePayload` / `appendObservabilityEvents`), `packages/store/src/schema.sql`.

#### A8 — I8: blobs CAS; artifacts scoped by (run, node, iteration, key)
> "Raw tool output addressed by sha256 in `blobs`; artifacts are named refs scoped by `(run, node, iteration, key)`." — SPEC §4, ARCHITECTURE §1.2, §2
- File-then-row commit ordering: "a crash can leave orphan files (GC sweeps), never dangling rows."
- `putArtifact` checks existing ref: identical content → no-op; differing content → `ArtifactCollisionError` unless `{ replace: true }`.
- Checkable in: `packages/store/src/store.ts` (`putArtifact`), `packages/store/src/schema.sql` (artifacts PK), property test P14/P15/P26.

#### A9 — I9: messages ≤ 1 MiB; preview distinct from raw
> "LLM-visible preview (`messages`) is distinct from system-recorded raw (`artifacts`); individual messages < 1,048,576 characters." — SPEC §4, ARCHITECTURE §2
- `CHECK (length(content) < 1048576)` + pre-check throws `MessageTooLargeError`.
- Checkable in: `packages/store/src/schema.sql`, `packages/store/src/store.ts` (`appendMessage`).

#### A10 — Startup sweep: crash-interrupted `running` rows requeued, quarantine applied
> "The startup sweep runs before the executor loop, in a single transaction: it requeues crash-interrupted `running` rows… while **preserving `current_node`**… it quarantines orphan side-effects." — ARCHITECTURE §1.4
- `packages/store/src/sweep.ts`; `fact.run_requeued_after_crash` + `fact.run_quarantined`.
- Property tests P5 / P6 cover crash recovery + orphan quarantine.
- Checkable in: `packages/store/src/sweep.ts`, `packages/store/test/` (P5/P6).

#### A11 — Schema migrations: forward-only automatic; `down` inverses for explicit `migrate --to`
> "The DB-migration counter… walks an existing DB forward through `SCHEMA_MIGRATIONS`… Each step is `{ up, down? }`: a schema downgrade is a first-class but explicit operator action via `fragua db migrate --to <lower>`." — ARCHITECTURE §1.11, §12
- Refusing to open a store newer than the binary (`checkVersion`).
- `migrateTo` / `planMigration` in `packages/store/src/migrations.ts`.
- Checkable in: `packages/store/src/migrations.ts`, `packages/store/src/pragmas.ts`.

#### A12 — Reducer purity: `deriveRunState` is a pure fold; fold-all-versions invariant
> "A daemon at contract version `V` folds-correctly every stream pinned in `[MIN_COMPATIBLE, V]`… a retired fact type kept as read-only, never-emitted member of the union with its fold path intact." — ARCHITECTURE §1.11, SPEC §5
- `packages/store/src/reducers.ts` — `applyFact`, `deriveRunState`.
- Contract-surface hash snapshot: `packages/store/test/contract-version.test.ts`.
- `scripts/check-contract-bump.sh` — touch-gate on `reducers.ts`.
- Property test P4: `getState` ≡ `events.reduce(reducer)`.
- Checkable in: `packages/store/src/reducers.ts`, `packages/store/test/contract-version.test.ts`, `scripts/check-contract-bump.sh`.

#### A13 — Enum-consumer lint tests for RunStatus, HaltReason
> "For `RunStatus` and `HaltReason` this is mechanized: the runtime tuples `RUN_STATUSES` / `HALT_REASONS` in `@fragua/types` are the source of truth… the `enum-consumers` lint tests (`store`, `core`, `cli`, `web`, plus the `?status=` round-trip in `server`) pin the non-derivable sites." — AGENTS.md
- `packages/store/test/enum-consumers.lint.test.ts` — SQL WHERE clauses and schema.sql CHECKs covered by source scan.
- Corresponding tests presumably exist in `core`, `cli`, `web` packages.
- Checkable in: `packages/store/test/enum-consumers.lint.test.ts`, `packages/cli/test/terminal-types.enum-consumers.test.ts` (confirmed in test output).

#### A14 — Blob GC roots: routing spill refs and artifact refs both treated as GC roots
> "gcBlobs treats every sha found in any `run_state.routing` column as a GC root (alongside artifact-referenced blobs), so spilled inputs are never collected while the run is live." — ARCHITECTURE §0
- `packages/store/src/store.ts` or a sibling GC module (`blob-gc.ts` referenced in daemon).
- Checkable in: `packages/store/src/store.ts` (`gcBlobs`), `packages/daemon/test/blob-gc.test.ts`.

#### A15 — Interface segregation: IEventWriter / IEventReader / IAnalyticsReader / IDaemonCoordinator
> "The store contract is segregated into four sub-interfaces along the fault lines that actually matter." — ARCHITECTURE §4
- All four implemented by `SqliteStore` today; `IEventStore = IEventWriter & IEventReader & IAnalyticsReader & IDaemonCoordinator`.
- Drift-lint checks the source interface files against their implementing class.
- Checkable in: `packages/store/src/types.ts`, `packages/store/src/store.ts`.

#### A16 — SQL placement: per-table query files; no SQL outside those files
> "SQL strings are split per-table across `event-queries.ts`, `run-state-queries.ts`, `message-queries.ts`, `artifact-queries.ts`, `workflow-queries.ts`, `daemon-queries.ts`, and `analytics-queries.ts` — each file owns its table's reads + writes." — ARCHITECTURE §4.5
- Discipline implied by AGENTS.md for `packages/store/src/`.
- Checkable in: `packages/store/src/` (verify no raw SQL strings in `store.ts` itself).

#### A17 — routing typed-read surface: accessor module is the single sanctioned indexer
> "A discipline lint bans raw `routing[…]` indexing outside the accessor module (the one sanctioned exception beyond the reducer's frontier write)." — ARCHITECTURE §2.1
- `packages/core/src/routing.ts` — eight accessors (`getInputs`, `getFrontier`, `getBudget`, `getRetry`, `getGoalGate`, `getLimits`, `getTimer`, `getContext`).
- Checkable in: `packages/core/src/routing.ts`, any routing-lint test in `packages/core/test/`.

---

### Lens B — Daemon

#### B1 — I12: decision/effect boundary — `planTransition` / `planAbort` are pure
> "The executor's decision core (`planTransition` → `TransitionPlan`, `planAbort` → `AbortPlan`) is pure: no store I/O, no clock (`now` is a parameter), no RNG (`random` is injected), no subprocess/network." — SPEC §4 / I12, §3.11
- `packages/daemon/src/transition-planner.ts` + `packages/daemon/src/abort-planner.ts`.
- Plan vocabulary: `facts: FactEvent[]`, `routingPatch?`, `advanceAppliedTo?`, `observability: PlannedObservability[]`, abort-arm `outcome`.
- Checkable in: `packages/daemon/src/transition-planner.ts`, `packages/daemon/src/abort-planner.ts`.

#### B2 — runOne turn loop: re-reads run_state each turn; returns on terminal/paused/quarantined
> "It re-reads `run_state` each turn and returns on any terminal/paused/quarantined status (it does not re-read `daemon_lock`)." — ARCHITECTURE §6
- Zombie fencing: a TTL-reclaimed zombie is fenced only when its next fact commit fails OCC.
- `packages/daemon/src/executor.ts` — `runOne` / `dispatchOne`.
- Checkable in: `packages/daemon/src/executor.ts`.

#### B3 — Contract-version gate in runOne
> "It then checks the contract-version gate — an out-of-`[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` pin pauses with `engine_incompatible` and returns." — ARCHITECTURE §6
- Property test P17: out-of-range pin → `RUN_PAUSED { reason: "engine_incompatible" }`.
- Checkable in: `packages/daemon/src/executor.ts`, `packages/store/src/reducers.ts`, property-test suite.

#### B4 — Intent fold: cancel wins; steer/pause coexist; human/priority last-wins
> "Cancel always wins if present; pause coexists with steer/human as `shouldPauseAfterDispatch`; multi-instance human/priority last-wins; every intent ends up applied or in `dropped`." — ARCHITECTURE §10 (P27), `docs/intent-fold.md`
- `packages/daemon/src/executor.ts` (intent fold path) or a dedicated `intent-fold.ts`.
- Property test P27.
- Checkable in: `packages/daemon/src/` (find intent-fold module), property test for P27.

#### B5 — Abort signal composition: AbortSignal.any([steer, timeout, shutdown])
> "Builds the node's abort signal as `AbortSignal.any` of the steer controller ∪ shutdown ∪ (when `maxMs` is set) a timeout." — ARCHITECTURE §6
- `packages/daemon/src/executor.ts` — signal construction per dispatch.
- Checkable in: `packages/daemon/src/executor.ts`.

#### B6 — Supervisor fiber: 50ms tick, heartbeat + intent detection + stuck-node watchdog
> "The supervisor fiber ticks every 50ms: `heartbeat()`, `detectNewIntents()`, `detectStuckNodes()`. Skipped for nodes whose `HandlerSpec.maxMs` is `undefined`." — ARCHITECTURE §1.3, §6
- `packages/daemon/src/supervisor.ts` (or equivalent).
- Checkable in: `packages/daemon/src/` (find supervisor module).

#### B7 — Recorder: pre-commit side_effect_intent before handler invocation
> "`fact.side_effect_intent` is committed in its own short SQLite transaction *before* the handler invokes `fn(idempotencyKey)`." — ARCHITECTURE §1.1, §5
- `packages/daemon/src/recorder.ts` — `CommittingRecorder`; advances `run_state.version` synchronously.
- Property test P25: intent fact in `events` before recorder returns; sweep quarantines orphan.
- Checkable in: `packages/daemon/src/recorder.ts`, property test P25.

#### B8 — Timeout/abort loop/provider retry policies
> - Watchdog: `DEFAULT_MAX_MS = 4h`; `DEFAULT_LEAK_GRACE_MS = 30s`; per-`(nodeId)` counter capped at 3; exhaustion halts `timeout_exhausted`. First timeout: 5s backoff, doubling to 60s ceiling. — STATUS.md
> - Abort-loop: K=5 consecutive aborts → `fact.run_paused{reason:"abort_loop"}`. — ARCHITECTURE §1.11, §9
> - Provider auto-retry: 408/429/5xx/529/network → `paused_auto` with full-jitter exponential; chain capped at 5 attempts / 5 cumulative minutes → `provider_exhausted`. — STATUS.md
- `packages/daemon/src/executor.ts` (timeout), `packages/daemon/src/executor-helpers.ts` (backoff), `packages/agent/src/backend.ts` (provider classification).
- Checkable in: `packages/daemon/src/executor.ts`, `packages/daemon/src/executor-helpers.ts`, `packages/agent/src/backend.ts`.

#### B9 — Wake-pending sweeper: auto-resumes runs at resumeAt
> "The wake-pending sweeper emits `fact.run_resumed { fromStatus: 'paused_auto' }` once `now >= resumeAt`." — SPEC §3.4
- `packages/daemon/src/wake-pending.ts` (or named `auto-dispatcher.ts` / `wake-sweeper.ts`).
- Concurrency slot released during `paused_auto`.
- Checkable in: `packages/daemon/src/` (find wake-pending module).

#### B10 — Fan-out: one writer, OCC intact; commitFanoutFact serializes branch commits
> "Every branch commits through the single daemon writer's serialized lane (`commitFanoutFact`), re-reading the live `version` per attempt and retrying the *append* (never re-executing the handler) on a sibling-moved-version conflict." — ARCHITECTURE §6.2
- `packages/daemon/src/executor.ts` (`runFanout`, `commitFanoutFact`).
- Property tests P28–P32.
- Checkable in: `packages/daemon/src/executor.ts`, `packages/daemon/test/executor.fanout.test.ts`.

#### B11 — Snapshots: per-step + HITL as observability event; terminal as OCC-checked fact
> "`snapshot.captured` is the executor-emitted per-step + HITL worktree snapshot… Delta-suppressed (no event when the tree is unchanged). The terminal snapshot is the OCC-checked `fact.snapshot_recorded`." — ARCHITECTURE §3 (Observability events)
- `packages/daemon/src/snapshot-service.ts` — `captureBoundarySnapshot`, `disposeTerminalWorktree`.
- Checkable in: `packages/daemon/src/snapshot-service.ts`.

#### B12 — Boot sequence: lock → sweep → supervisor → executor
> "The boot sequence: acquire `daemon_lock` — if stale, TTL-reclaim… Then, **before anything else**, run the startup sweep… Wire SIGTERM/SIGINT onto one shutdown `AbortController`, start the 50ms supervisor fiber… enter the executor loop." — ARCHITECTURE §6
- `packages/daemon/src/entrypoint.ts` (or `daemonMain`).
- Checkable in: `packages/daemon/src/entrypoint.ts`.

#### B13 — Observability buffer: 50ms flush timer or 64-event accumulation
> "The executor flushes the in-handler buffer to the store on a soft 50ms timer or when 64 events accumulate, whichever first." — ARCHITECTURE §3
- `packages/daemon/src/executor.ts` or `packages/agent/src/event-bridge.ts`.
- Checkable in: `packages/daemon/src/executor.ts`, `packages/agent/src/event-bridge.ts`.

#### B14 — Operator-action projection: processOperatorActions sweep folds accept/discard intents into facts
> "The daemon's `processOperatorActions` sweep then projects it into its `fact.run_*` (OCC lockstep with `inbox_status`) — no second git run." — ARCHITECTURE §3 (intent table, accept/discard entries)
- `packages/daemon/src/executor.ts` or a dedicated `auto-dispatcher.ts`.
- Checkable in: `packages/daemon/src/` (find processOperatorActions).

---

### Lens C — Core

#### C1 — Browser-safe main entry: no node:fs / node:child_process in core main
> "`core`'s main entry is browser-safe (no `node:fs` / `node:child_process`); its store-pulling sub-entries — `./handler`, `./intent-plane`, `./read-plane` — are server-side only." — AGENTS.md
- Checkable in: `packages/core/src/index.ts` (main export), `packages/core/package.json` (exports map).

#### C2 — Handler discipline lint: no bare fetch/fs/child_process in handlers/
> "Handlers may not import `node:fs`, `node:child_process`, or call bare `fetch` — enforced by lint." — SPEC §3.2
- `packages/core/test/handler/discipline.test.ts`.
- Also enforced via `no-restricted-imports` in biome/ESLint config.
- Checkable in: `packages/core/test/handler/discipline.test.ts`, `biome.json`.

#### C3 — Edge selection: two-case algorithm (route case vs outcome case)
> "After a node completes, the executor picks the next edge using a two-case algorithm… Route case: routing node + synthesised `route` tool… Outcome case: edge `outcome=` attribute." — SPEC §3.6
- `packages/core/src/engine/edge-selection.ts`.
- Unannotated edges default to `outcome=success`; absent fail-edge → halt `aborted_exit`; fail-edge to `exit` → `completed`.
- Checkable in: `packages/core/src/engine/edge-selection.ts`.

#### C4 — Substitution: lenient inputs (unresolvable → ""); fail-closed outputs (unpopulated → node failure)
> "`${{ inputs.… }}` dotted reads are lenient: an unresolvable path collapses to `""`… `${{ outputs.… }}` reads fail closed — referencing a field the producer never populated fails the consuming node." — SPEC §3.8
- `packages/core/src/engine/substitution.ts` (or equivalent).
- Injection wrap: "values interpolated into an `llm` prompt are wrapped in content-derived delimiters to prevent prompt injection." — STATUS.md
- Validator codes: E030 (undeclared input / dotted-into-scalar), E035 (broken output ref), W015 (producer not on every path), W016 (optional leaf read).
- Checkable in: `packages/core/src/engine/` (substitution module), `packages/core/src/engine/validator.ts`.

#### C5 — Validator codes: E028–E046, W013–W018 named in SPEC / workflows skill
> Full code table in `.agents/skills/workflows/references/validator-codes.md`.
> Codes mentioned in SPEC: E028 (`exit` type mismatch), E029 (`start` type mismatch), E030 (input ref), E031 (retry: without goal_gate + max_retries), E035 (broken output ref), E036–E045 (parallel well-formedness), E046 (run-level output projection).
> W013 (unknown attr), W014 (auto_status / loop_restart / unrecognised preset), W015 (producer not on every path), W016 (optional leaf), W018 (run-output producer not on every completing path).
- `packages/core/src/engine/validator.ts` (1 774 lines — the largest core file).
- Checkable in: `packages/core/src/engine/validator.ts`.

#### C6 — Intent plane: validates + constructs + commits every write; rejects E-coded graphs at save
> "The plane's workflow mint **rejects error-severity validator diagnostics at save** — an E-coded graph never reaches the executor through any client." — SPEC §2, AGENTS.md
- `packages/core/src/intent-plane/` — `buildEnqueue`, `commitEnqueue`, and workflow-mint logic.
- Checkable in: `packages/core/src/intent-plane/`.

#### C7 — Read plane: projects run summary/detail/steps/messages/events/snapshots/diff/streaming
> "The read plane (`@fragua/core/read-plane`) projects every run read." — AGENTS.md, SPEC §2
- `packages/core/src/read-plane/projections.ts` (666 lines).
- `packages/core/src/read-plane/` — all projection sub-modules.
- Checkable in: `packages/core/src/read-plane/`.

#### C8 — Routing accessors: validate-and-degrade; eight families; no raw routing[…] indexing outside module
> "Eight validate-and-degrade accessors (`getInputs`, `getFrontier`, `getBudget`, `getRetry`, `getGoalGate`, `getLimits`, `getTimer`, `getContext`)… degrade to the conservative authored default — never pausing." — ARCHITECTURE §2.1
- `packages/core/src/routing.ts` (600 lines).
- Lint rule banning raw `routing[…]` outside the module.
- Checkable in: `packages/core/src/routing.ts`, any routing-lint test.

#### C9 — Retry presets: five named presets; resolution order node → graph → "none"
> "Resolution order: node `retry-policy` → graph `default-retry-policy` → `"none"`." — SPEC §3.7
> Presets: `none` (1 attempt), `standard` (5, 200ms, ×2, jitter), `aggressive` (5, 500ms, ×2, jitter), `linear` (3, 500ms, ×1, no jitter), `patient` (3, 2000ms, ×3, jitter).
> W014 on unrecognised preset name; runtime falls back to `none`.
- `packages/core/src/engine/retry-policy.ts`.
- Checkable in: `packages/core/src/engine/retry-policy.ts`.

#### C10 — Parser: synthesises `start` node; rejects authored `start`/`exit` with wrong type
> "E028/E029: Declaring a step named `start` or `exit` with a mismatched type is rejected." — SPEC §3.1
- `packages/core/src/parser/yaml.ts` (925 lines).
- Checkable in: `packages/core/src/parser/yaml.ts`, `packages/core/src/engine/validator.ts`.

#### C11 — HandlerResult discriminated union: transition / yield_human / halt / pause_provider
> Four kinds. `pause_provider` carries `httpStatus`, `provider`, `errorMessage`, `retryAfterMs?`. `halt` reasons: subset is handler-constructible; some (occ_exhausted, aborted_exit, timeout_exhausted, worktree_error) are executor-only. Operator-recoverable arms (max_loops, goal_gate_unsatisfied, max_retries_exceeded) translate at result-to-facts into `fact.run_paused`. — SPEC §3.11, handler-contract.md §The four return kinds
- `packages/core/src/handler/types.ts`.
- Checkable in: `packages/core/src/handler/types.ts`, `packages/daemon/src/result-to-facts.ts`.

#### C12 — Judge handler: turn-less typed judgment; choice/score/noul; for-each; composite
> "A turn-less typed judgment: `state:` + `questions:` (`choice` / `score` / `noul`) asked of a System One model in one call; `for-each:` + `keep:`; `composite:` weighted means." — SPEC §3.1
- `packages/core/src/handler/handlers/judge.ts` (715 lines).
- Requires `typesafe` credential (STATUS.md: "experimental, needs the `typesafe` credential").
- Checkable in: `packages/core/src/handler/handlers/judge.ts`.

---

### Lens D — Agent + Workspace

#### D1 — Swap surface: PiLlmBackend implements LlmBackend; one file to replace the dependency
> "The swap surface is deliberately one file: `PiLlmBackend` (`packages/agent/src/backend.ts`) implements `@fragua/core`'s `LlmBackend` interface." — SPEC §1
- `packages/agent/src/backend.ts` (1 553 lines — the largest agent file).
- Checkable in: `packages/agent/src/backend.ts`, `packages/core/src/handler/types.ts` (`LlmBackend` interface).

#### D2 — Force-included tools: abort tool on every llm call; skill tool regardless of allowed/denied
> "The llm handler force-includes an `abort` tool on every call." — SPEC §3.2
> "The `skill` tool… force-included on every llm call regardless of `allowed-tools` / `denied-tools`." — STATUS.md
> "The tool is force-included by the llm backend even when a node's `allowed-tools` / `denied-tools` would exclude it." — AGENTS.md ground rule 12
- `packages/agent/src/backend.ts` (tool construction).
- Checkable in: `packages/agent/src/backend.ts`.

#### D3 — Read-only enforcement: three layers for read-only nodes
> "Three layers: (a) `ctx.tools` narrowed via `ToolRegistry.select` before HandlerContext; (b) llm backend re-applies `select(…)` on workspace registry before handing to pi-ai; (c) `ctx.env` wrapped in a read-only proxy when no mutating tool is visible, so `env.writeFile` / `env.exec` throw `ReadOnlyEnvError`." — ARCHITECTURE §12.1
> Parallel branches: `E042` validator enforces no write-class tools in branch nodes.
- `packages/agent/src/backend.ts`, `packages/workspace/src/` (env proxy), `packages/core/src/engine/validator.ts` (E042).
- Checkable in: `packages/agent/src/backend.ts`, `packages/workspace/src/local-env.ts` or equivalent, validator E042.

#### D4 — Provider error classification: auto-retry vs manual pause
> "408/429/5xx/529/network → auto-retry (`paused_auto`); 400/401/402/403/404/413/422 → manual pause. An Anthropic `overloaded_error` envelope normalised to 529 regardless of HTTP status." — ARCHITECTURE §1.10, STATUS.md
- `packages/agent/src/backend.ts` — `onResponse` captures status; `pause_provider` result.
- `packages/agent/src/handler-bridge.ts` — translates to `HandlerResult`.
- Checkable in: `packages/agent/src/backend.ts`, `packages/agent/src/handler-bridge.ts`.

#### D5 — Steering broadcast: mid-flight steer reaches every in-flight LLM branch
> "A steer is the one exception to the trip: it rides pi-agent-core's steering queue instead and **broadcasts to every in-flight LLM branch** of the run." — ARCHITECTURE §0
> `fact.steering_applied` records `disposition: 'delivered'|'buffered'` and `targets: {nodeId, iteration}[]`.
- Buffer cleared when the run's live-agent set empties, not when first drained.
- `intent.steering_requested` that arrives while nothing is dispatched stashed in `routing.internal.pending_steer`.
- Checkable in: `packages/agent/src/backend.ts`, `packages/daemon/src/executor.ts` (steering registry).

#### D6 — Credential storage: provider_credentials table; no !cmd/env resolution on main path
> "Credentials are stored verbatim — no `!cmd` / env-var resolution anywhere in the credential path." — ARCHITECTURE §6 (Credential storage)
- `packages/agent/src/credentials/` — `SqliteAuthStorageBackend`.
- `packages/cli/test/env-creds.test.ts` — credential-gate for env-passthrough (confirmed firing in test output).
- `packages/cli/src/env-creds.ts` (528 lines) — env-creds seeding for `fragua ci`.
- Checkable in: `packages/agent/src/credentials/`, `packages/store/src/schema.sql` (provider_credentials table), `packages/cli/test/env-creds.test.ts`.

#### D7 — Env path gate: bash tool refuses to pass provider credentials through env-passthrough
> "fragua: refusing to pass provider credential(s) through bash.env-passthrough" — confirmed in test output (env-creds.test.ts)
- Credential names blocked: `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `GROQ_SECRET`, `ANTHROPIC_RATE_LIMIT_TOKEN`.
- Checkable in: `packages/cli/src/env-creds.ts`, `packages/workspace/src/tools.ts` (bash tool, 671 lines).

#### D8 — Run-actions git: applyAccept / applyDiscard with state gate; called synchronously by both server route and CLI
> "The git executes via `@fragua/workspace`'s shared `applyAccept`/`applyDiscard` — the CLI runs it directly, the Web UI via the `POST /runs/:id/{accept,discard}` route — with the state gate folded in." — ARCHITECTURE §3 (intent table, post-terminal actions)
- `packages/workspace/src/run-actions.ts`.
- Checkable in: `packages/workspace/src/run-actions.ts`.

#### D9 — Skills discovery: two-layer (global ~/.agents + project .fragua); per-run filter by projectCwd
> "Skills discovery: `~/.agents/skills/` (global) and `<repo>/.agents/skills/` (project-internal)… daemon discovery is the same superset; the llm-time filter prunes per-run by `env.projectCwd()`." — AGENTS.md
> Skill body soft cap: 500 lines / 5 000 tokens; warn path confirmed in test output.
- `packages/workspace/src/skills/` — discovery + filter.
- `llm.start.skills[]` carries `SkillCatalogRecord` per skill seen.
- Re-anchoring to worktree: `reanchorSkillsToRunTree`.
- Checkable in: `packages/workspace/src/skills/`.

#### D10 — MCP lifecycle: stdio + HTTP transports; OAuth via store-backed provider; opt-in per node via mcp_servers:
> "MCP tools (experimental)… stdio and HTTP transports supported; OAuth token lifecycle managed via a store-backed provider (`fragua mcp login`/`logout`)." — STATUS.md
> "`mcp_oauth` table: PK `url`; `payload` is opaque JSON blob… excluded from run bundles exactly like `provider_credentials`." — ARCHITECTURE §2
- `packages/workspace/src/mcp/connector.ts` (519 lines), `packages/workspace/src/mcp/oauth.ts`, `packages/workspace/src/mcp/config.ts`.
- Checkable in: `packages/workspace/src/mcp/`.

#### D11 — Worktree provisioning: per-run git worktree under run's cwd; terminal snapshot captured before disposal
> "Per-run git worktree under the run's `cwd` (`<project>/.fragua/worktrees/<run_id>/`)… terminal tree captured into `refs/fragua/snapshots/<run_id>` + `refs/fragua/heads/<run_id>` before worktree disposal." — STATUS.md
- `packages/daemon/src/worktree-provisioner.ts`; `packages/daemon/src/snapshot-service.ts`.
- `daemon.worktree_provisioned` event records `ok: boolean, errorDetail?`.
- Checkable in: `packages/daemon/src/worktree-provisioner.ts`.

---

### Lens E — Surface (Server + CLI + Web)

#### E1 — Loopback bind by default; wide bind is deliberate operator choice
> "The listener binds **loopback by default** — the API carries no auth, so the local-first wager above is enforced at the socket; a wider bind (`--host` / `web.host`) is a deliberate operator choice." — SPEC §2
> `serve: binding :: exposes the unauthenticated API beyond this machine` — warning confirmed in test output.
- `packages/server/src/index.ts` or `packages/cli/src/commands/` (serve command).
- Checkable in: `packages/server/src/index.ts`, `packages/cli/src/commands/` (harness/serve commands).

#### E2 — Body validation: every POST validates body; rejects 4xx on schema violation before intent appended
> "Every endpoint validates its body and rejects 4xx on schema violation before any intent is appended." — SPEC §3.5
> Enqueue preflights: typed inputs validated against workflow `inputs:` block (400 `invalid_inputs`); provider-credential availability (400 `provider_unavailable`); queue backpressure (429 `queue_full` with `Retry-After`). — ARCHITECTURE §7
- `packages/server/src/schemas.ts` — route body schemas.
- `packages/server/src/store/routes.ts` (786 lines).
- Human route validates `route` against `fact.run_paused{reason:"human"}.routes` — 400 on off-list.
- Checkable in: `packages/server/src/schemas.ts`, `packages/server/src/store/routes.ts`.

#### E3 — Plane discipline: server and CLI both route writes through intent plane, reads through read plane
> "The two shared surfaces both the server and the CLI route through, so no two clients can disagree: the intent plane … validates + constructs + commits every write; the read plane … projects every run read." — SPEC §2, AGENTS.md
- `packages/server/src/store/routes.ts` — server; `packages/cli/src/store-client.ts` (`withStoreClient`).
- "adapters never call `store.enqueueRun` directly, since the plane is the single write surface." — ARCHITECTURE §7
- Checkable in: `packages/server/src/store/routes.ts`, `packages/cli/src/store-client.ts`.

#### E4 — SSE cursors: polls `events WHERE seq > cursor`; per-run + global feed; reconnect dedup
> "Web SSE streams poll `events WHERE seq > ?` every 100ms per subscribed run." — ARCHITECTURE §1.3
> "SSE gap-replay — dedup across a real reconnect > replaying an overlapping seq window after a reconnect folds each event exactly once." — test-web.txt (confirmed passing)
- `packages/server/src/store/sse.ts`.
- Global cursor is `(ts, run_id, seq)` tuple — per-run seq carries no global order.
- Property test `sse-stream.property.test.tsx` passes (confirmed).
- Checkable in: `packages/server/src/store/sse.ts`, `packages/web/test/lib/sse-stream.property.test.tsx`.

#### E5 — Endpoint discovery: server_endpoint row; SIGINT clears it; server row separate from daemon_lock
> "Server discovery lives in the store's `server_endpoint` row… written by whoever binds the HTTP listener… cleared on shutdown." — AGENTS.md, ARCHITECTURE §2
> "Separate from `daemon_lock` so 'is the daemon alive' and 'where is the server' stay distinct." — ARCHITECTURE §2
- `packages/store/src/schema.sql` (server_endpoint table), `packages/server/src/index.ts` (write/clear).
- Potential stale rendezvous: `fragua doctor` reads it for liveness; `run`/`runs` verbs don't need it (direct store-client). — AGENTS.md
- Checkable in: `packages/store/src/schema.sql`, `packages/server/src/index.ts`.

#### E6 — Inline-import lint: all imports at file top; no `await import()` inside functions
> "NO INLINE IMPORTS. All `import`s at file top — no `await import(…)` inside functions… Enforced by `packages/server/test/inline-import-discipline.test.ts`." — AGENTS.md ground rule 6
- Test confirmed in 3 583 passing node tests.
- Checkable in: `packages/server/test/inline-import-discipline.test.ts`.

#### E7 — CLI as direct store-client: no HTTP; opens fragua.db; writes via intent plane, reads via read plane
> "`@fragua/cli` is a direct store-client: it opens the store and writes/reads through the two planes — it never talks to the HTTP server." — AGENTS.md
> "`withStoreClient`: open `migrate:false` + build both planes." — AGENTS.md
- `packages/cli/src/store-client.ts`.
- Exception: `fragua ci` embeds the executor (`executor-deps.ts`).
- Checkable in: `packages/cli/src/store-client.ts`, `packages/cli/src/executor-deps.ts`.

#### E8 — executor-deps sharing: buildExecutorDeps is shared assembly behind daemon and ci
> "`executor-deps.ts` (`buildExecutorDeps`) is the shared executor assembly behind both `daemon` and `ci`; `ci` embeds the executor over an ephemeral store." — AGENTS.md
- `packages/cli/src/executor-deps.ts`.
- `fragua ci --export`: fail-closed on live-credential hit (exit 80). — STATUS.md
- Checkable in: `packages/cli/src/executor-deps.ts`.

#### E9 — Harness lifecycle: auto-builds web bundle; clickable OSC 8 hyperlink on ready; SIGINT cleanup
> "The harness auto-builds the web bundle when sources are newer than `dist/` and prints a clickable OSC 8 hyperlink on the `ready` line." — STATUS.md
> "`harness: daemon failed to acquire lock within 30ms — restarting in 1ms`" — exponential restart backoff confirmed in test output.
- `packages/cli/src/commands/` (harness command).
- Checkable in: `packages/cli/src/commands/` (find harness.ts).

#### E10 — Workflow resolution: bare-name resolves global then local; path-shaped resolves verbatim
> "Bare-name workflow resolution — global then local: `~/.fragua/workflows/<name>.yaml` first, then `<cwd>/.fragua/workflows/<name>.yaml`; anything path-shaped resolves verbatim." — STATUS.md
- `packages/cli/src/` or `packages/core/src/` (workflow resolution).
- Checkable in: `packages/cli/src/commands/` (run command).

#### E11 — Config cascade: global ~/.fragua/config.yaml overlaid by project .fragua/config.yaml; nested objects merge one level deep
> "Two-layer config cascade — global `~/.fragua/config.yaml` (defaults, …) overlaid by `<project>/.fragua/config.yaml` (project-specific bootstrap). Project keys win; nested objects merge one level deep. YAML only." — STATUS.md, SPEC §2
- Checkable in: `packages/cli/src/` or `packages/daemon/src/` (config loading module).

#### E12 — fragua db migrate --to: downgrade explicit, backed-up, refuses live daemon and irreversible steps
> "Each `SCHEMA_MIGRATIONS` step carries an optional `down` inverse… `fragua db migrate --to <lower>` walks them — backed up first, refusing an irreversible step, a data-losing step (without `--allow-data-loss`), or a live daemon. Run by the *newer* binary." — SPEC §5
- `packages/store/src/migrations.ts` (`migrateTo` / `planMigration`), `packages/cli/src/commands/db.ts` or equivalent.
- Checkable in: `packages/store/src/migrations.ts`, `packages/cli/src/commands/`.

#### E13 — Web stack: Tailwind v4 CSS-first; no tailwind.config.ts; @theme inline in globals.css
> "React 18 + Vite 5 + Tailwind 4 (CSS-first, `@theme inline`, no `tailwind.config.ts`)" — AGENTS.md
- `packages/web/src/` (globals.css / index.css for `@theme inline`).
- Checkable in: `packages/web/src/` (find CSS config file).

#### E14 — TanStack Query discipline: server state through query factories; mutations through useMutation with cache invalidation
> "Server state through @tanstack/react-query query factories (never useState + useEffect for fetches), mutations through useMutation with cache invalidation." — `.agents/skills/frontend/SKILL.md` (per AGENTS.md)
- `packages/web/src/lib/api.ts` (1 358 lines — primary API layer).
- Checkable in: `packages/web/src/lib/api.ts`, `packages/web/src/` (hook files).

#### E15 — DTO widening: RunDetail/RunSummary from read-plane schemas; optional widening for old-daemon payloads
> "Run-read DTOs (`RunSummary`/`RunDetail`) are the `@fragua/core/read-plane` schemas re-exported through `src/lib/api.ts` — where the shape validators soft-accept old-daemon payloads that omit a field, the re-export widens that field to optional so the type matches runtime and consumers are forced to guard." — AGENTS.md
- `packages/web/src/lib/api.ts`.
- Checkable in: `packages/web/src/lib/api.ts`, `packages/core/src/read-plane/`.

#### E16 — Web test runner: vitest/jsdom; separate from node suite
> `test:web` uses vitest (confirmed: "Test Files 93 passed (93)", "Start at 17:44:16", jsdom environment).
> `test:node` uses `bun test` (confirmed: "Ran 3584 tests across 302 files").
> Both required for `bun run test` (which runs `test:node` + `test:web`); bare `bun test` skips web suite. — AGENTS.md
- `packages/web/vite.config.ts` or `packages/web/vitest.config.ts`.
- Checkable in: `packages/web/package.json` (test:web script), `packages/web/vitest.config.ts`.

#### E17 — Web package boundary: web imports only types and core (no server, store, daemon, agent)
> AGENTS.md documents `web → types + core` only. Measured edges confirm `web → types(23), core(6)` with NO server/store/daemon/agent edges.
- Checkable in: `packages/web/package.json` (dependencies), measured import edges as confirmation.

---

## 3. Known-Gap Register

Everything already admitted as unbuilt or rough in STATUS.md / SPEC / ARCHITECTURE §12. Lenses should **not** re-report these as findings.

| # | Gap | Source |
|---|---|---|
| G1 | Multi-machine deployment — single SQLite coordination; `IEventStore` is synchronous; no Postgres/async backing | SPEC §5 "Not in scope", STATUS.md, ARCHITECTURE §12 |
| G2 | Token auth on the harness API — localhost-only, no auth in v0 | STATUS.md |
| G3 | Watchdog for stuck-but-alive daemons (fiber deadlock) — heartbeat metric planned, deferred | STATUS.md |
| G4 | Workflow hot-reload for in-flight runs — `workflow_sha` pinned at enqueue | SPEC §5, STATUS.md |
| G5 | Schema auto-migration across breaking bumps / blob encryption | SPEC §5, STATUS.md, ARCHITECTURE §12 |
| G6 | Per-project credential isolation, project extensions, file-server, rate-limit fairness — design-stage | STATUS.md |
| G7 | `max-loops` not authorable per workflow; plain back-edge cycle not capped by `max-retries` (only goal-gate form is) | SPEC §3.1 "Status: known gap" |
| G8 | `wait_any` / `race` / `quorum` joins excluded by design — break SESE | SPEC §3.1.1, §5 |
| G9 | Cross-run fan-in out of scope — composition across runs stays artifact-sharing | SPEC §5 |
| G10 | Dynamic (runtime-sized) fork excluded — branch set static per run | SPEC §3.1.1, §5 |
| G11 | No per-branch pause seam — pause is run-global; per-branch pause not built | ARCHITECTURE §6.2 |
| G12 | No max-branch validator bound (only E036's ≥2 minimum) — pathologically wide fan-out fails at seed loudly; latent gap | ARCHITECTURE §6.2 |
| G13 | Bundle export/import for spilled inputs (blob CAS spill) support pending — noted as "proposal §8, item B5" | ARCHITECTURE §0 |
| G14 | `direct read of an optional leaf has no fallback syntax yet` — W016 stays advisory | SPEC §3.8 |
| G15 | `signal` pause reason (external wait) not emitted yet — noted in fact taxonomy §6.2 | ARCHITECTURE §3 (fact.run_paused note) |
| G16 | Capability-gated auto-wake for the too-new engine_incompatible arm — deferred | SPEC §5, ARCHITECTURE §1.11 |
| G17 | Retention policies per workflow — manual `fragua prune` until demand | ARCHITECTURE §12 |
| G18 | Blob streaming for >16 MB — handler must chunk; revisit on real use case | ARCHITECTURE §12 |
| G19 | MCP connector contract and `.mcp.json` schema are not frozen (experimental) | STATUS.md |
| G20 | Bundle secret scrubbing: scrubber registry, marker format, and CI exit code not yet frozen (experimental) | STATUS.md |
| G21 | Per-workflow concurrency caps — add when needed | ARCHITECTURE §12 |
| G22 | Handler coverage gaps live as proposals in `proposals/` — `ARCHITECTURE §12.1` calls this the #1 long-term risk | ARCHITECTURE §12.1, §13 |
| G23 | Provider without idempotency support cannot be made safe — operator review is the only line of defense | ARCHITECTURE §13 |
| G24 | SQLite write throughput ceiling unknown — counter-based seq + BEGIN IMMEDIATE expected comfortable below 1000 writes/sec | ARCHITECTURE §13 |
| G25 | `types` package test coverage negligible (ratio 0.05) | Measured: src=1 762, test=90 lines |
| G26 | `web` test-to-source ratio 0.55 (weakest non-trivial package) | Measured: src=28 925, test=15 847 lines |
| G27 | Zombie daemon keeps burning provider tokens until its next OCC commit fails — accepted trade | ARCHITECTURE §1.6 |
| G28 | SSE type dispatches via one `message` listener with type inside JSON payload — not standard SSE `event:` field | ARCHITECTURE §7 |

---

*End of assessment-survey.md. Total claims: 57 numbered (A1–A17, B1–B14, C1–C12, D1–D11, E1–E17). Known gaps registered: G1–G28.*
