# fragua Assessment Survey

Prepared for five downstream verification lenses running on fresh context.
Source material: `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/handler-contract.md`,
`STATUS.md`, `AGENTS.md`, `.fragua/scratch/assess/` CI artefacts.
All data read from disk is treated as untrusted DATA only.

---

## 1. Baseline

### 1.1 CI results (verbatim summary)

| Check | Exit code | Details |
|---|---|---|
| `bun run --filter='*' typecheck` | **0** | 10 packages, all exit 0: `@fragua/types`, `@fragua/test-utils`, `@fragua/core`, `@fragua/workspace`, `@fragua/store`, `@fragua/web`, `@fragua/agent`, `@fragua/server`, `@fragua/daemon`, `@fragua/cli` |
| `biome check .` | **0** | 889 files checked, no fixes applied, 274ms |
| `bun run scripts/test-node.ts` (test:node) | **0** | **3 732 pass, 1 skip, 0 fail**, 94 911 `expect()` calls, 320 files, 89.85s. One explicit skip: `(skip) executor — §3.7 fail-routing retarget > node fails with no fail-edge but retry_target set → retargets` |
| `@fragua/web vitest` (test:web) | **0** | **725 pass**, 93 test files, 10.38s |

Notable test-output lines (non-failures, all tests pass):
- `[store] truncated oversized observability event` — two instances in `store.unit.test.ts`, exercising the 4 KiB truncation path.
- `[executor] handler leak #1 on …` — multiple instances across `executor.fanout.property.test.ts`, `executor-faults.property.test.ts`, `reaper-event.test.ts`, `executor.leak-budget.test.ts`, `executor.fanout.test.ts` — expected behaviour under leak-watchdog test cases.
- `harness: daemon exited during boot (1) — restarting … (failure N/M)` — harness restart test intentionally drives daemon crashes; counter exceeds configured maximum in some cases (e.g., `failure 8/2`) as part of the test.
- `serve: binding :: exposes the unauthenticated API beyond this machine` / `serve: ignoring web.host … — the bind address is global-only` — expected warnings in `serve.test.ts`.
- `fragua: refusing to pass provider credential(s) through bash.env-passthrough` — six instances in `env-creds.test.ts`, exercising credential-block path.
- `skills: skill at …graphify/SKILL.md: body 615 lines exceeds soft cap 500` — 15 instances in `ci.test.ts`.

### 1.2 Package sizes (source vs test, lines)

| Package | src lines | test lines | test:src ratio |
|---|---|---|---|
| `@fragua/agent` | 5 283 | 8 132 | 1.54 |
| `@fragua/cli` | 9 464 | 10 477 | 1.11 |
| `@fragua/core` | 13 188 | 13 094 | 0.99 |
| `@fragua/daemon` | 8 342 | 22 074 | 2.65 |
| `@fragua/server` | 4 391 | 7 707 | 1.76 |
| `@fragua/store` | 10 421 | 11 942 | 1.15 |
| `@fragua/test-utils` | 489 | 151 | 0.31 |
| `@fragua/types` | 1 773 | 90 | 0.05 |
| `@fragua/web` | 28 925 | 15 847 | 0.55 |
| `@fragua/workspace` | 5 801 | 5 028 | 0.87 |

Largest source files (lines): `store/src/store.ts` (2 610), `core/src/engine/validator.ts` (1 793), `agent/src/backend.ts` (1 599), `web/src/components/RunConversation.tsx` (1 534), `types/src/events.ts` (1 461), `store/src/types.ts` (1 435), `web/src/lib/api.ts` (1 358), `cli/src/commands/operator.ts` (1 322), `daemon/src/transition-planner.ts` (1 271).

### 1.3 Documented dependency direction vs measured import edges

**Documented** (`AGENTS.md`, `ARCH §11`): `web → server → store ← daemon → core ← agent`
Note: `core`'s browser-safe main entry excludes store; sub-entries (`./handler`, `./intent-plane`, `./read-plane`) are server-side and do import `store`.

**Measured** (cross-package import edge counts from `import-edges.txt`):

| Package | Measured outgoing imports |
|---|---|
| `agent` | core(13), workspace(6), **store(5)**, types(4) |
| `cli` | core(20), store(18), agent(11), types(6), workspace(5), **daemon(3)**, **server(2)** |
| `core` | types(17), **store(6)** |
| `daemon` | core(28), store(25), workspace(1), types(1) |
| `server` | core(17), store(13), workspace(4), types(2), **agent(2)** |
| `store` | types(12), **core(4)**, store(1) |
| `web` | types(23), core(6) |
| `workspace` | core(10), types(4), workspace(1) |

**Discrepancies vs documented direction:**

| Edge | Status |
|---|---|
| `web → server` (documented) | **Not present** in measured edges — web imports only `types` and `core`; the dependency on server is a runtime HTTP relationship, not a compile-time import |
| `core → store(6)` | Expected: ARCH §11 explicitly notes that `core`'s sub-entries (`./intent-plane`, `./read-plane`) do import store |
| `store → core(4)` | **Undocumented reverse edge** — store imports from core; direction diagram does not list this |
| `agent → store(5)` | **Undocumented** — agent imports store directly; diagram shows only `core ← agent` |
| `server → agent(2)` | **Undocumented** — server imports agent; diagram shows server stops at store |
| `cli → daemon(3)` | Expected: AGENTS.md documents `buildExecutorDeps` shared between `daemon` and `ci` via `executor-deps.ts` |
| `cli → server(2)` | Partially expected: AGENTS.md mentions CLI is a "direct store-client" but also lists server as an import |

---

## 2. Claim Inventory

### 2.1 Lens: Store

**S1** — I1: "Every write is one SQLite transaction; events + projection updated together."
Doc: `SPEC.md §4`, `ARCH §2` invariants table, `ARCH §4.1`.
Check: `packages/store/src/store.ts` (transaction wrappers), `packages/store/test/lint.test.ts` (AST lint: no `await`/`JSON.stringify`/`JSON.parse`/`fetch`/`Value.Check` inside `writeTxn`/`db.transaction()` or any helper reachable transitively).

**S2** — I2: "No handler state outside the projection."
Doc: `SPEC.md §4`, `ARCH §2`.
Check: `packages/core/src/handler/types.ts` (`HandlerContext` API surfaces only `ctx.routing` for cross-turn state), `packages/store/src/store.ts`.

**S3** — I3: "Intents always-appendable; facts OCC-checked against `run_state.version`."
Doc: `SPEC.md §4`, `ARCH §2`, `ARCH §4.1`.
Check: `packages/store/src/store.ts` (`appendIntent`, `appendFact`), `packages/store/test/projection-occ.test.ts`, `packages/store/test/store.property.test.ts`.

**S4** — I4: "Handlers receive `AbortSignal`; respecting it is contract."
Doc: `SPEC.md §4`, `ARCH §2`.
Check: `packages/core/src/handler/types.ts` (`HandlerContext.signal`), `packages/daemon/src/dispatch-wiring.ts` (signal composition).

**S5** — I5: "External side effects carry a provider idempotency key; orphan `INTENT` quarantines the run on crash-replay."
Doc: `SPEC.md §4`, `ARCH §1.1`, `ARCH §2`.
Check: `packages/daemon/src/recorder.ts` (`CommittingRecorder`), `packages/store/src/sweep.ts` (`findOrphanSideEffects`), `packages/store/test/store.unit.test.ts`.

**S6** — I6: "`run_state.routing` ≤ 8KB; payload lives in messages/artifacts; every dispatch-driving read/write routes through the typed `@fragua/core` routing.ts accessors."
Doc: `SPEC.md §4`, `ARCH §2`, `ARCH §2.1`.
Check: `packages/store/src/schema.sql` (`CHECK (length(routing) < 8192)`), `packages/core/src/routing.ts` (8 validate-and-degrade accessors), `packages/daemon/test/routing-index-discipline.test.ts` (AST lint banning raw `routing[…]` indexing).

**S7** — I7: "Event payloads ≤ 4KB; `validatePayload` uses `utf8ByteLength` = `Buffer.byteLength(s, 'utf8')`; `CHECK (length(payload) < 4096)` is coarse code-point backstop."
Doc: `SPEC.md §4`, `ARCH §2`, `ARCH §9`.
Check: `packages/store/src/store.ts` (`validatePayload`), `packages/store/src/schema.sql`, `packages/store/test/store.unit.test.ts` (truncation test exercised).

**S8** — I8: "Raw tool output addressed by sha256 in `blobs`; artifacts are named refs scoped by `(run, node, iteration, key)`; file-then-row commit ordering."
Doc: `SPEC.md §4`, `ARCH §1.2`, `ARCH §2`.
Check: `packages/store/src/store.ts` (`putArtifact`, blob write ordering), `packages/store/src/schema.sql` (`artifacts` PK), `packages/store/test/store.unit.test.ts`, `packages/store/test/routing-blobs.test.ts`.

**S9** — I9: "LLM-visible preview (`messages`) is distinct from system-recorded raw (`artifacts`); individual messages < 1,048,576 characters."
Doc: `SPEC.md §4`, `ARCH §2`.
Check: `packages/store/src/schema.sql` (`CHECK (length(content) < 1048576)`), `packages/store/src/store.ts` (`appendMessage`, `MessageTooLargeError`).

**S10** — I10: "Seq assignment is O(1) via per-run counter `run_state.next_seq`; `UPDATE run_state SET next_seq = next_seq + 1 RETURNING ...` inside append txn."
Doc: `SPEC.md §4`, `ARCH §1.5`, `ARCH §2`.
Check: `packages/store/src/store.ts` (seq counter update), `packages/store/src/schema.sql` (`next_seq` column), `packages/store/test/store.property.test.ts` (P1).

**S11** — OCC mechanics: `appendFact` checks `run_state.version`, throws `ConcurrencyError` on conflict; `appendIntent` is version-unchecked. One sanctioned eventless projection transition: `claimNextRun` flips `status queued→running` and bumps `version` in one OCC-guarded UPDATE **without** appending a fact.
Doc: `ARCH §2.1`, `ARCH §4.1`.
Check: `packages/store/src/store.ts` (`appendFact`, `claimNextRun`), `packages/store/test/projection-occ.test.ts`, `packages/daemon/test/occ-append.test.ts`, `packages/daemon/test/executor.occ-ceiling.test.ts`.

**S12** — Seq monotonicity and contiguity guaranteed per run (P1); seq space disjoint between `events` and `daemon_events` (daemon_events uses `INTEGER PRIMARY KEY AUTOINCREMENT`).
Doc: `ARCH §2` (`daemon_events` table entry), `ARCH §10` (P1).
Check: `packages/store/src/schema.sql`, `packages/store/test/store.property.test.ts`, `packages/store/test/run-id.test.ts`.

**S13** — Startup sweep: reads `running` rows, requeues them with `fact.run_requeued_after_crash` (preserving `currentNode`), quarantines orphan side-effects, runs each in its own `SAVEPOINT` so one corrupt row rolls back alone and emits `daemon.sweep_run_failed` rather than aborting the sweep.
Doc: `ARCH §1.4`, `ARCH §6`.
Check: `packages/store/src/sweep.ts`, `packages/store/test/sweep.test.ts`, `packages/daemon/test/e2e.test.ts`.

**S14** — Migrations: `migrate()` creates baseline, walks `SCHEMA_MIGRATIONS` forward; `checkVersion` refuses a store newer than the binary; `migrateTo` walks `down` inverses for explicit downgrade, backs up first, refuses irreversible steps, refuses concurrent daemon.
Doc: `ARCH §1.11`, `ARCH §12`, `SPEC §5`.
Check: `packages/store/src/migrations.ts`, `packages/store/test/migrations.test.ts`, `packages/store/test/migrate-to.test.ts`, `packages/store/test/store-open-mode.test.ts`.

**S15** — Reducer purity: `deriveRunState` (`reducers.ts`) is a pure fold over the raw event log; bundle import and `fragua show` use it exclusively (no live projection carried in a bundle).
Doc: `ARCH §2.1`, `ARCH §1.11`.
Check: `packages/store/src/reducers.ts`, `packages/store/test/reducer-legacy-fold.test.ts`, `packages/store/test/reducer-terminal-pause-collapse.test.ts`, `packages/store/test/genesis-derive.test.ts`.

**S16** — Fold-all-versions: reducer MUST fold `[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` forever; retired fact types (`fact.run_completed`, `fact.run_halted`, `fact.run_cancelled`, `fact.run_paused_human`) remain read-only LEGACY union members with fold paths intact; `MIN_COMPATIBLE_CONTRACT_VERSION` stays at `1` while `EVENT_CONTRACT_VERSION` is `6`.
Doc: `ARCH §1.11`, `SPEC §5`, AGENTS.md ground rule 11.
Check: `packages/store/src/reducers.ts`, `packages/store/test/reducer-legacy-fold.test.ts`, `packages/store/test/contract-version.test.ts` (surface hash snapshot), `scripts/check-contract-bump.sh` (touch-gate).

**S17** — Interface segregation: `IEventStore` is a composite of 10 sub-interfaces (`IEventWriter`, `IEventReader`, `IAnalyticsReader`, `IDaemonCoordinator`, `IProviderCredentialStore`, `IProviderConfigStore`, `IMcpOAuthStore`, `IBundleStore`, `IMetricsReader`, `IJudgeReader`). Bare composite annotation outside the 4 assembly seams fails the build.
Doc: `ARCH §4`, `ARCH §4.6`.
Check: `packages/store/src/types.ts`, `packages/store/test/event-store-sub-interface.lint.test.ts`.

**S18** — SQL placement: table DML/DQL lives only in `*-queries.ts` files (named maintenance allowlist aside).
Doc: `ARCH §4.6`, AGENTS.md ground rule 10.
Check: `packages/store/test/sql-location.lint.test.ts`, `packages/store/src/event-queries.ts`, `packages/store/src/run-state-queries.ts`, `packages/store/src/message-queries.ts`, `packages/store/src/artifact-queries.ts`, `packages/store/src/workflow-queries.ts`, `packages/store/src/daemon-queries.ts`, `packages/store/src/analytics-queries.ts`.

**S19** — Enum-consumer lints: `RunStatus` and `HaltReason` literals are pinned by source-scan tests in both `store` and `core`; `run_fact_types.lint.test.ts` covers fact type consumers.
Doc: AGENTS.md ("Enum-literal consumers" section), `ARCH §2` (`run_state.status CHECK`).
Check: `packages/store/test/enum-consumers.lint.test.ts`, `packages/store/test/run-fact-types.lint.test.ts`, `packages/core/test/enum-consumers.lint.test.ts`, `packages/cli/test/terminal-types.enum-consumers.test.ts`.

**S20** — Blob GC roots: `gcBlobs` treats every sha256 found in any `run_state.routing` column as a GC root (alongside artifact-referenced blobs), so spilled inputs are never collected while the run is live.
Doc: `ARCH §0` (content-addressed blobs decision), `ARCH §2.1` (spilled run inputs).
Check: `packages/store/src/store.ts` (`gcBlobs`), `packages/daemon/test/blob-gc.test.ts`, `packages/store/test/routing-blobs.test.ts`.

---

### 2.2 Lens: Daemon

**D1** — I12 / decision/effect boundary: `planTransition` (`transition-planner.ts`), `planAbort` (`abort-planner.ts`), `planPreDispatch` / `planLeakHalt` (`predispatch-planner.ts`), and `planFanoutStep` / `noteDisposition` / `planBranchTerminal` / `planBranchAbortLoop` (`fanout-planner.ts`) perform no I/O, no clock (`now` is a parameter), no RNG (`random` is injected), no store reads or writes. Driver (`runOne`/`runFanout`) owns all effects.
Doc: `SPEC §3.11`, `SPEC §4 I12`, `ARCH §6`, `ARCH §6.1`.
Check: `packages/daemon/test/decision-core-discipline.test.ts`, `packages/daemon/test/transition-stages.test.ts`, `packages/daemon/test/executor.test.ts`, `packages/daemon/src/transition-planner.ts`, `packages/daemon/src/abort-planner.ts`, `packages/daemon/src/predispatch-planner.ts`, `packages/daemon/src/fanout-planner.ts`.

**D2** — `runOne` turn loop: re-reads `run_state` each turn; returns on terminal/paused/quarantined status; does NOT re-read `daemon_lock` inside the loop (zombie fenced only by OCC failure); checks contract-version gate; folds unapplied intents (cancel wins); builds abort signal; dispatches handler; maps result to facts; appends under OCC, retrying on `ConcurrencyError`. Outer safety-net catch terminates run in-process rather than leaving it stranded `running`.
Doc: `ARCH §6`, `ARCH §1.6`.
Check: `packages/daemon/src/executor.ts` (`runOne`, `runOneInner`), `packages/daemon/src/dispatch-turn.ts`, `packages/daemon/test/executor.test.ts`, `packages/daemon/test/driven-executor.property.test.ts`, `packages/daemon/test/executor.occ-honesty.test.ts`.

**D3** — Contract-version gate: out-of-`[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` pin emits `fact.run_paused{reason:"engine_incompatible", pinnedVersion, supportedMin, supportedMax}` → `paused` (recoverable); `pinnedVersion > supportedMax` = too-new; `pinnedVersion < supportedMin` = too-old; neither is terminal.
Doc: `ARCH §1.11`, `SPEC §5`, `ARCH §6`.
Check: `packages/daemon/src/predispatch-planner.ts`, `packages/store/test/contract-version.test.ts`, `packages/daemon/test/executor.test.ts` (engine-incompatible case), P17 in `ARCH §10`.

**D4** — Intent fold: cancel wins — if both cancel and any other intent are present, run becomes cancelled regardless of order. `fact.intents_folded` records the applied watermark. `intent.dropped` observability event emitted for intents the executor could not apply.
Doc: `ARCH §1.11`, `ARCH §8`, `SPEC §3.5`, `docs/intent-fold.md`.
Check: `packages/daemon/src/executor.ts` (intent fold logic), `packages/core/test/handler/intent-fold.test.ts`, `packages/daemon/test/steer-delivery.test.ts`.

**D5** — Abort signal composition: `AbortSignal.any([steer controller, shutdown, AbortSignal.timeout(maxMs)])`. When `maxMs` is undefined (llm opt-out via `max-ms: 0`), timeout signal is omitted and leak watchdog is skipped; steer/cancel/shutdown still propagate.
Doc: `ARCH §5`, `ARCH §6`, `handler-contract.md §Timeouts`.
Check: `packages/daemon/src/dispatch-wiring.ts`, `packages/daemon/test/cancel-signal.test.ts` (in agent), `packages/daemon/test/abort-registry.test.ts`.

**D6** — Supervisor fiber: 50ms tick inside one short transaction. Three tasks: `heartbeat()` (UPDATE `daemon_lock.heartbeat_at`), `detectNewIntents()` (check unapplied intents per registered abort controller, trip abort if yes), `detectStuckNodes()` (watchdog for handlers exceeding `maxMs + LEAK_GRACE_MS`; skipped when `HandlerSpec.maxMs === undefined`).
Doc: `ARCH §1.3`, `ARCH §6`, `ARCH §9` (`SUPERVISOR_TICK_MS=50`, `HEARTBEAT_INTERVAL_MS=5000`, `LEAK_GRACE_MS=30000`).
Check: `packages/daemon/src/supervisor.ts`, `packages/daemon/test/supervisor.test.ts`, `packages/daemon/test/supervisor-executor.seam.test.ts`.

**D7** — Pre-commit recorder (`CommittingRecorder`): `fact.side_effect_intent` committed in its own short SQLite transaction BEFORE `fn(idempotencyKey)` is called. Advances `run_state.version` synchronously on each commit. This makes the intent durable even under SIGKILL.
Doc: `ARCH §1.1`, `ARCH §5`.
Check: `packages/daemon/src/recorder.ts`, `packages/daemon/test/recorder.test.ts`, `packages/store/test/store.property.test.ts` (P25).

**D8** — Timeout policy: handler hitting `maxMs` emits `fact.run_paused{reason:"timeout_retry", attempt, delayMs, resumeAt, maxAttempts, attemptedMs}` paired with `fact.node_aborted{cause:"timeout"}`. Backoff: 5s on first timeout, doubling to 60s ceiling; per-`(nodeId)` counter at `routing.internal.timeout_retries.<nodeId>` caps at 3; exhaustion halts with `timeout_exhausted`. `consecutiveAborts` is NOT bumped by watchdog timeouts.
Doc: `STATUS.md` (Watchdog timeout), `SPEC §3.4` (paused_auto table), `ARCH §9`.
Check: `packages/daemon/test/executor.timeout.test.ts`, `packages/daemon/test/executor.graduated-timeout.test.ts`.

**D9** — Abort-loop policy: K=5 consecutive aborts without progress emits `fact.run_paused{reason:"abort_loop", nodeId, consecutiveAborts}` → `paused` (operator-resumable). Process-local counter resets on progress.
Doc: `ARCH §1.11` ("retry-storm ceiling"), `SPEC §3.4`, `ARCH §9` (`ABORT_LOOP_CEILING=5`).
Check: `packages/daemon/src/abort-planner.ts` (`planAbortLoop`), `packages/daemon/test/executor.test.ts`, `packages/store/test/store.property.test.ts` (P20).

**D10** — Provider-retry policy: 408/429/5xx/529/network → `fact.run_paused{reason:"provider_retry", attempt, resumeAt}` → `paused_auto`; equal-jitter exponential backoff or honoured `Retry-After`; chain capped at 5 attempts / 5 cumulative minutes → `paused{reason:"provider_exhausted"}`. Overloaded-error normalised to 529 regardless of HTTP status 200. 400/401/402/403/404/413/422 → manual pause.
Doc: `ARCH §1.10`, `SPEC §3.4`.
Check: `packages/daemon/src/executor.ts` (provider-retry handling), `packages/daemon/test/executor.provider-retry.test.ts`, `packages/daemon/test/provider-retry-policy.test.ts`, `packages/agent/test/overloaded-error-retry.test.ts`.

**D11** — Wake sweeper: polls `getWakeCandidates` for `paused_auto` runs where `now >= resumeAt`; emits `fact.run_resumed{fromStatus:"paused_auto"}`; run goes back to `queued`.
Doc: `SPEC §3.4` (paused_auto table), `ARCH §4.2`.
Check: `packages/daemon/src/wake-pending.ts`, `packages/daemon/test/wake-pending.test.ts`.

**D12** — Fan-out commit lane: every branch commits through single daemon writer's serialized `commitFanoutFact` lane, re-reading live `version` per attempt and retrying the append (not re-executing the handler) on sibling-moved-version conflict. A commit that fails because the run left `running` is classified as `status`, not OCC.
Doc: `ARCH §6.2`, `SPEC §3.1.1 I11`.
Check: `packages/daemon/src/fanout.ts` (`commitFanoutFact`), `packages/daemon/test/executor.fanout.test.ts`, `packages/daemon/test/executor.fanout.property.test.ts`, `packages/store/test/store.property.test.ts` (P28–P32).

**D13** — Snapshots: `captureBoundarySnapshot` for per-step / HITL snapshots (observability `snapshot.captured`, delta-suppressed); `disposeTerminalWorktree` for the OCC-checked terminal `fact.snapshot_recorded`. Tree is captured into `refs/fragua/snapshots/<run_id>` + `refs/fragua/heads/<run_id>` before worktree disposal. `worktreePath` on `RunDetail` resolved at `GET /runs/:id` HTTP boundary (filesystem probe), not in the read plane.
Doc: `ARCH §3` (observability events: `snapshot.captured`), `ARCH §4.2`.
Check: `packages/daemon/src/snapshot-service.ts`, `packages/daemon/test/snapshotter.test.ts`, `packages/daemon/test/executor-worktree.test.ts`.

**D14** — Boot sequence (`daemonMain`): acquire `daemon_lock` (TTL-reclaim if stale via `forceAcquireDaemonLock`; exit non-zero if held by live daemon) → run startup sweep → wire SIGTERM/SIGINT shutdown controller → start 50ms supervisor fiber → enter executor loop. On exit: release lock, close store.
Doc: `ARCH §6`.
Check: `packages/daemon/src/entrypoint.ts`, `packages/daemon/test/daemon.property.test.ts`, `packages/cli/test/daemon-stop.test.ts`.

**D15** — Observability buffer: handler buffer flushed on soft 50ms timer or when 64 events accumulate (whichever first). Handler tail (`edge.selected`, post-handler budget warnings) drained synchronously before the terminal `fact.node_*`. Oversize event (>4KB) is truncated to a routing-preserving marker and logged, not rejected — one bad event never tanks the batch.
Doc: `ARCH §3` (observability events section), `SPEC §3.3`.
Check: `packages/store/src/store.ts` (`appendObservabilityEvents`), `packages/daemon/src/executor.ts` (flush logic), `packages/store/test/store.unit.test.ts` (truncation exercised).

**D16** — Operator-action projection: `processOperatorActions` sweep folds `intent.accept_run` / `intent.discard_run` into `fact.run_accepted` / `fact.run_discarded` (OCC lockstep with `inbox_status`). The git work (`applyAccept`/`applyDiscard`) runs synchronously in the caller (CLI or server route) BEFORE the intent is written; the daemon's sweep only projects the result — no second git run.
Doc: `ARCH §3` (intent events table, post-terminal operator actions), `ARCH §4.2`.
Check: `packages/daemon/src/auto-dispatcher.ts` or similar operator-action sweep, `packages/daemon/test/operator-actions.test.ts`, `packages/cli/test/operator-diff-drain.test.ts`, `packages/cli/test/operator-command.test.ts`.

---

### 2.3 Lens: Core

**C1** — Browser-safe entry: `packages/core/src/index.ts` must not transitively import `node:*`, `bun:*`, or `@fragua/store`. Sub-entries `./handler`, `./intent-plane`, `./read-plane` are server-side only and excluded from the browser bundle.
Doc: AGENTS.md (codebase map, `@fragua/core` entry), `ARCH §11`.
Check: `packages/core/test/store-import-discipline.test.ts`, `packages/core/test/smoke.test.ts`.

**C2** — Handler discipline lint: no `node:*`/`undici` import, `fetch`/`globalThis.fetch`, `Bun.*`, or `process.env` inside `packages/core/src/handler/handlers/`. AST-based scan follows transitive relative imports. `sideEffect:"external"` → `ctx.externalCall` check is also AST-based.
Doc: `SPEC §3.2`, `ARCH §5` ("Enforced at review"), AGENTS.md ground rule 9.
Check: `packages/core/test/handler/discipline.test.ts`.

**C3** — Edge selection two-case algorithm: Route case — source declares `routes:`, llm exits via ephemeral `route` tool or judge `decide.route`; edge selected by `route=` attribute. Outcome case — edge selected by `outcome=` attribute (defaults to `outcome=success`); no fall-through from fail to success edges.
Doc: `SPEC §3.6`.
Check: `packages/core/src/engine/edge-selection.ts`, `packages/core/test/engine/edge-selection.test.ts`, `packages/core/test/engine/edge-selection.property.test.ts`.

**C4** — Substitution: `${{ inputs.<name>[.<field>…] }}` reads are lenient — unresolvable path collapses to `""`. `${{ outputs.<producer>.<field>[.<sub>] }}` reads are fail-closed — referencing an unpopulated field fails the consuming node (`UnpopulatedOutputError`), never a silent `""`.
Doc: `SPEC §3.8`.
Check: `packages/core/src/engine/substitution.ts`, `packages/core/test/engine/substitution.test.ts`, `packages/core/test/engine/inputs.test.ts`, `packages/core/test/engine/outputs-substitution.test.ts`.

**C5** — Injection wrap: output values interpolated into an llm prompt are wrapped in content-derived delimiters to prevent prompt injection.
Doc: `STATUS.md` ("Typed `outputs:` on `llm` steps").
Check: `packages/core/src/engine/substitution.ts` (injection delimiter logic).

**C6** — Validator codes: SPEC names E028 (exit step type mismatch), E029 (start step type mismatch), E030 (undeclared input reference / dotted sub-ref into scalar), E031 (missing `max-retries` on retry: step), E035 (broken output reference), E036–E045 (parallel well-formedness), E046 (broken run-output projection), E057 (invalid `retry_target` on non-goal-gate step). Warnings: W014 (unrecognised preset / auto_status / loop_restart), W015 (producer may not run on all paths), W016 (optional leaf read), W018 (producer may not run on all completing paths).
Doc: `SPEC §3.1`, `SPEC §3.6`, `SPEC §3.7`, `SPEC §3.8`, `ARCH §6.2`.
Check: `packages/core/src/engine/validator.ts`, `packages/core/test/engine/validator.test.ts`, `packages/core/test/engine/validator-outputs.test.ts`, `packages/core/test/engine/validator-judge.test.ts`, `packages/core/test/engine/validator-judge-for-each.test.ts`, `packages/core/test/engine/validator-run-outputs.test.ts`.

**C7** — Intent plane: validates + constructs + commits every write (`buildEnqueue` → `commitEnqueue`; `saveWorkflow`, schedule CRUD). Server routes and CLI both write through this plane; adapters never call `store.enqueueRun` directly. Workflow mint rejects error-severity (E-coded) diagnostics at save.
Doc: `ARCH §4.1`, `ARCH §7`, AGENTS.md.
Check: `packages/core/src/intent-plane/`, `packages/core/test/intent-plane/plane.test.ts`, `packages/server/test/intent-plane-discipline.test.ts` (AST lint: plane-owned store writes never appear in an adapter).

**C8** — Read plane: projects run summary / detail / steps / messages / events / snapshots / diff / streaming. Three bounded reads: `pauseRoutes(runId)` (HITL route enum), `controlState(runId)` (status/inboxStatus/cwd/baseGitSha), `projects()`. `worktreePath` on `RunDetail` resolved at HTTP boundary (filesystem probe), not in projection.
Doc: `ARCH §4.2`.
Check: `packages/core/src/read-plane/projections.ts`, `packages/core/test/read-plane/`, `packages/server/test/read-plane-discipline.test.ts` (AST lint: run-read routes must use read plane), `packages/core/test/read-plane/discipline.test.ts` (no `node:fs` sync / raw `fetch` / `Bun.*` inside read-plane).

**C9** — Routing accessors and lint: `packages/core/src/routing.ts` defines 8 validate-and-degrade accessors (`getInputs`, `getFrontier`, `getBudget`, `getRetry`, `getGoalGate`, `getLimits`, `getTimer`, `getContext`). Each degrades to a conservative authored default on a mis-folded key (never pauses on missing data). Lint bans raw `routing[…]` indexing outside the accessor module.
Doc: `ARCH §2.1`, `ARCH §2` I6.
Check: `packages/core/src/routing.ts`, `packages/core/test/routing.test.ts`, `packages/daemon/test/routing-index-discipline.test.ts`.

**C10** — Retry presets: `none` (1 attempt, no delay), `standard` (5 attempts, 200ms, ×2, jitter), `aggressive` (5 attempts, 500ms, ×2, jitter), `linear` (3 attempts, 500ms, ×1, no jitter), `patient` (3 attempts, 2000ms, ×3, jitter). Unrecognised preset name → W014 at validate-time, falls back to `none` at runtime.
Doc: `SPEC §3.7`.
Check: `packages/core/src/engine/retry-policy.ts`, `packages/core/test/engine/retry-policy.test.ts`, `packages/core/test/parser/retry-policy.test.ts`.

**C11** — YAML parser: `packages/core/src/parser/yaml.ts` parses workflow YAML into the IR (`Graph`), attaches `loc` for validator error reporting (stripped before DB storage), synthesises `start` node, validates well-formedness.
Doc: AGENTS.md (codebase map).
Check: `packages/core/src/parser/yaml.ts`, `packages/core/test/parser/yaml.test.ts`, `packages/core/test/parser/yaml-judge.test.ts`, `packages/core/test/parser/yaml-outputs.test.ts`, `packages/core/test/parser/yaml-run-outputs.test.ts`, `packages/core/test/parser/yaml-judge-for-each.test.ts`.

**C12** — `HandlerResult` discriminated union: `kind` over `transition` (nextNode, outcomeStatus, route, failureReason, token/cost fields, outputs), `yield_human` (text, routes, routeLabels), `halt` (reason, detail), `pause_provider` (httpStatus, provider, errorMessage, retryAfterMs). `failureReason` is the canonical channel for quotable failure causes on `outcomeStatus="fail"`.
Doc: `ARCH §5`, `handler-contract.md §The four return kinds`.
Check: `packages/core/src/handler/types.ts`, `packages/core/test/handler/handlers.test.ts`, `packages/core/test/handler/context.test.ts`.

**C13** — Judge handler: turn-less typed judgment (`choice` / `score` / `noul`), optional `decide:` binds a choice to route-case edge selection or a noul to success/fail, `for-each:` + `keep:`, `composite:` declares weighted means. Judge step may carry both `route?` and `outputs?` in `fact.node_completed`.
Doc: `SPEC §3.1` (type: judge).
Check: `packages/core/src/handler/handlers/judge.ts`, `packages/core/test/handler/judge.test.ts`, `packages/core/test/handler/judge-client.test.ts`, `packages/core/test/handler/judge-for-each.test.ts`.

---

### 2.4 Lens: Agent + Workspace

**A1** — Swap surface: `PiLlmBackend` (`packages/agent/src/backend.ts`) implements `@fragua/core`'s `LlmBackend` interface. Replacing the `pi-ai`/`pi-agent-core` dependency means rewriting that one file (plus migrating `AgentMessage` shapes); handlers call `ctx.llm` and return `HandlerResult`, never constructing providers.
Doc: `SPEC §1` ("Dependency posture").
Check: `packages/agent/src/backend.ts` (1 599 lines), `packages/core/src/handler/types.ts` (`LlmBackend` interface).

**A2** — Force-included tools: `abort` tool force-included on every llm node even when listed under `denied_tools` or `allowed_tools` pins it out; `skill` tool force-included when the node's effective skill catalogue is non-empty (omitted when `skills_disabled: true`, empty `skills:` intersection, or no skills in scope).
Doc: `SPEC §3.2`, `handler-contract.md §LLM self-abort`, AGENTS.md ground rule 12.
Check: `packages/agent/src/backend.ts`, `packages/agent/test/abort-tool.test.ts`, `packages/agent/test/backend-skill-tool.test.ts`.

**A3** — Read-only enforcement: three structural layers. (a) `ctx.tools` narrowed via `ToolRegistry.select({allow, deny})` before `HandlerContext` is built. (b) llm backend re-applies `select(...)` on workspace registry before passing tools to pi-ai — LLM does not see disallowed tools in its menu. (c) `ctx.env` wrapped in read-only proxy when no mutating tool (`bash`/`write`/`edit`) is visible; `env.writeFile`/`env.exec` throw `ReadOnlyEnvError`.
Doc: `ARCH §12.1`, `handler-contract.md §Agent tools`.
Check: `packages/core/src/handler/context.ts`, `packages/core/test/handler/context-allowed-tools.test.ts`, `packages/core/test/handler/context-env-scoping.test.ts`, `packages/core/test/types/read-only-env.test.ts`, `packages/workspace/test/worktree-isolation.test.ts`.

**A4** — Provider error classification: 408/429/5xx/529/network → auto-retry (`paused_auto`, `provider_retry`). Anthropic `overloaded_error` normalised to 529 even when HTTP status is 200 (`unclassified-error-pause.test.ts`). 400/401/402/403/404/413/422 → manual pause. Chain cap: 5 attempts / 5 cumulative minutes → `provider_exhausted` pause.
Doc: `ARCH §1.10`, `SPEC §3.4`.
Check: `packages/agent/src/backend.ts`, `packages/agent/test/overloaded-error-retry.test.ts`, `packages/agent/test/unclassified-error-pause.test.ts`, `packages/agent/test/extract-http-status.test.ts`, `packages/daemon/test/executor.provider-retry.test.ts`.

**A5** — Steering broadcast: a mid-flight steer is broadcast to every in-flight LLM branch of the run (not just whichever branch registered last). `fact.steering_applied{disposition:"delivered"|"buffered", targets}` records delivery. Under fan-out the in-process buffer is cleared when the live-agent set empties, not when first drained.
Doc: `ARCH §0`, `ARCH §3` (`fact.steering_applied`).
Check: `packages/agent/src/steering-registry.ts`, `packages/agent/test/steering-registry.test.ts`, `packages/agent/test/steering-registry.property.test.ts`, `packages/agent/test/steering-shared-registry.test.ts`, `packages/daemon/test/steer-delivery.test.ts`.

**A6** — Credential storage: built-in provider credentials stored verbatim in `provider_credentials` table on global store (no `!cmd`/env-var resolution); `SqliteAuthStorageBackend` rebuilds in-memory blob on read, full-replaces on write. Custom-provider config in `provider_config` table (per-provider JSON blob, `apiKey` field absent — credentials always from `provider_credentials`). Per-row Ajv validation on read; one corrupt row skipped without poisoning siblings.
Doc: `ARCH §Credential storage`, `ARCH §Custom-provider config storage`, `STATUS.md`.
Check: `packages/agent/src/credentials/`, `packages/agent/test/auth-storage-sqlite.test.ts`, `packages/agent/test/legacy-oauth-config-row.test.ts`, `packages/store/src/provider-config.ts` (or similar), `packages/store/test/provider-credentials.test.ts`, `packages/store/test/provider-config.test.ts`.

**A7** — Env path gate: `resolvePath` enforces cwd jail on `read`/`write`/`edit` tool calls; paths resolving outside the run cwd are refused. Bash tool does NOT have this jail — `cat ~/.ssh/id_rsa` runs.
Doc: `handler-contract.md §Agent tools §bash is not a containment boundary`, `SPEC §5` ("Shell / network sandboxing").
Check: `packages/workspace/src/tools.ts`, `packages/workspace/src/local-env.ts`, `packages/workspace/test/worktree-env.test.ts`, `packages/workspace/test/tools.test.ts`.

**A8** — Bash env deny-by-default: subprocess inherits only baseline (`PATH`/`HOME`/`TMPDIR`/`TERM`/`SHELL`/`USER`/`LANG`/`LC_*`) plus `bash.env-passthrough`/`--allow-env` names; provider credential env var names are refused from the allow-list outright; engine vars (`FRAGUA_OUTPUT`) injected per-step via `opts.env`, not ambient prefix.
Doc: `SPEC §5`, `STATUS.md` ("Deny-by-default bash env floor").
Check: `packages/workspace/src/local-env.ts`, `packages/cli/test/env-creds.test.ts`, `packages/cli/test/daemon-env-deny-unknown-provider.test.ts`, `packages/cli/test/daemon-env-deny-wiring.test.ts`.

**A9** — Run-actions git (`applyAccept`/`applyDiscard`/`gitDiff`): shared between server route and CLI in `packages/workspace/src/run-actions.ts`. State gate (terminal / in-inbox / has-worktree) folded into the single action; conflicts / dirty tree / bad-state refusals surface immediately (CLI exit code or HTTP 4xx) and write nothing.
Doc: AGENTS.md (codebase map, `@fragua/workspace`).
Check: `packages/workspace/src/run-actions.ts`, `packages/workspace/test/run-actions.test.ts`, `packages/cli/test/operator-worktree.test.ts`.

**A10** — Skills discovery: `skill({ name, arguments? })` tool force-included per ground rule 12; catalogue discovered from `~/.agents/skills/`, `~/.claude/skills/`, and project cwd `.agents/skills/`. Per-run filter: globals ∪ run's project directory. Skills re-anchored from discovery checkout to run's worktree when cwd ≠ project root (`reanchorSkillsToRunTree`). Soft cap: 500 lines / 5000 tokens (warning, not rejection).
Doc: `ARCH §3` (`llm.start.skills[]`), AGENTS.md, `STATUS.md` (Skills discovery UI).
Check: `packages/workspace/src/skills/`, `packages/workspace/test/skills/`, `packages/agent/test/backend-skill-tool.test.ts`.

**A11** — MCP lifecycle: stdio and HTTP transports; OAuth token lifecycle managed via `mcp_oauth` table (store-backed provider); tools materialise as `mcp__<server>__<tool>`; opt-in per node via `mcp_servers:`. MCP connector and `.mcp.json` schema marked experimental.
Doc: `STATUS.md` (MCP tools, experimental), `ARCH §2` (`mcp_oauth` table entry).
Check: `packages/workspace/src/mcp/`, `packages/workspace/test/mcp/`, `packages/cli/test/mcp-command.test.ts`, `packages/cli/test/mcp-oauth-store.test.ts`.

**A12** — Worktree provisioning: per-run git worktree at `<cwd>/.fragua/worktrees/<run_id>/`. `git worktree add --detach <path> <sha>` using pinned `baseGitSha` from genesis event or HEAD at provision time. `ctx.env === undefined` causes tool handler to halt immediately (no silent fallback to process.cwd()).
Doc: `ARCH §6.1` (`snapshot-service.ts`), `handler-contract.md §ctx.env`.
Check: `packages/daemon/src/worktree-provisioner.ts`, `packages/daemon/test/worktree-provisioner.test.ts`, `packages/daemon/test/executor-worktree.test.ts`, `packages/workspace/test/worktree-env.test.ts`.

---

### 2.5 Lens: Surface (Server + CLI + Web)

**F1** — Loopback bind: server binds loopback by default; API carries no auth. `--host`/`web.host` for wider bind is a deliberate operator choice, emits warning "binding :: exposes the unauthenticated API beyond this machine".
Doc: `SPEC §2`, `STATUS.md` ("Token auth on the harness API").
Check: `packages/server/src/index.ts` (bind logic), `packages/cli/test/serve.test.ts` (warning exercised).

**F2** — Same-origin gate: before every route — (a) Origin header not the bound origin (or loopback equivalent) → 403; (b) Host header neither loopback nor bound host → 403 (DNS-rebinding defence); (c) bodied request without `content-type: application/json` → 415; (d) Vite dev origin (`http://localhost:5173`) trusted ONLY under `fragua serve --dev` (`FRAGUA_DEV_ORIGIN=1`), never in compiled binary or `fragua harness`.
Doc: `SPEC §2`, `STATUS.md`.
Check: `packages/server/test/origin-gate.test.ts`, `packages/server/src/index.ts` or middleware.

**F3** — Body validation: every endpoint validates body before any intent is appended; rejects 4xx on schema violation. Enqueue additionally: 400 `invalid_inputs` on missing required input or out-of-range choice, 400 `provider_unavailable` on missing credentials, 429 `queue_full` with `Retry-After`.
Doc: `SPEC §3.5`, `ARCH §7`.
Check: `packages/server/src/store/routes.ts`, `packages/server/src/schemas.ts`, `packages/server/test/store/routes.test.ts`.

**F4** — Plane discipline (writes): adapters/routes never call `store.appendIntent`/`enqueueRun`/`saveWorkflow`/`setRunTitle`/schedule CRUD directly; all writes go through the intent plane. AST lint catches computed `store["enqueueRun"]()` access as well as dotted access.
Doc: `ARCH §4.1`, `ARCH §7`, AGENTS.md.
Check: `packages/server/test/intent-plane-discipline.test.ts`.

**F5** — Plane discipline (reads): run-read route handlers project through the read plane; raw `deps.store.<reader>()` in a run-read route body fails build unless marked `read-discipline-allow:`. Read plane prohibits `node:fs` sync calls, raw `fetch`, `Bun.*`, `node:child_process` inside `packages/core/src/read-plane/`.
Doc: `ARCH §4.2`.
Check: `packages/server/test/read-plane-discipline.test.ts`, `packages/core/test/read-plane/discipline.test.ts`, `packages/core/test/read-plane/no-syscall.test.ts`.

**F6** — Enqueue preflights: `plane.buildEnqueue` validates typed inputs against workflow's `inputs:` block; coerces + folds inputs into `routing.inputs`; preflight checks provider-credential availability; checks queue backpressure.
Doc: `ARCH §7`.
Check: `packages/core/src/intent-plane/` (`commitEnqueue`), `packages/server/test/store/routes.test.ts`, `packages/core/test/intent-plane/plane.test.ts`.

**F7** — SSE cursors: SSE polls `events WHERE seq > cursor` every 100ms per subscribed run; reconnect with `Last-Event-ID=N` receives `seq > N` in order; dedup across reconnect confirmed by property test; terminal run closes SSE once per lifecycle frame.
Doc: `ARCH §1.3` ("SSE consumers poll"), `ARCH §9` (`SSE_POLL_MS=100`), `ARCH §10` (P19).
Check: `packages/server/src/store/sse.ts`, `packages/server/test/store/sse-feed-loop.test.ts`, `packages/server/test/store/sse-keepalive.test.ts`, `packages/web/test/lib/sse-stream.property.test.tsx`.

**F8** — Endpoint discovery: `server_endpoint` row written by whoever binds the listener (harness in-process server or `fragua serve --db <path>`), cleared on shutdown. CLIs discover the running URL by opening the DB read-only (one `open()` + one `SELECT`). No JSON rendezvous file.
Doc: `ARCH §0`, `ARCH §2` (`server_endpoint` table), AGENTS.md.
Check: `packages/store/src/store.ts` (`server_endpoint` read/write), `packages/cli/test/harness.test.ts`, `packages/cli/test/doctor.test.ts`.

**F9** — Stale rendezvous references: `server_endpoint` row cleared on shutdown (SIGINT). `fragua doctor` reads it for liveness. `run`/`runs` verbs do NOT need it — they open store directly.
Doc: `ARCH §0` ("server_endpoint"), AGENTS.md.
Check: `packages/server/src/index.ts` (shutdown clear), `packages/cli/test/doctor.test.ts`.

**F10** — Inline-import lint: no dynamic `import()`/`require()` in production source across `packages/*/src` + `cli/bin`. Type-position `import("x").Y` is not runtime and is allowed. Test files exempt.
Doc: AGENTS.md ground rule 6.
Check: `packages/server/test/inline-import-discipline.test.ts`.

**F11** — CLI as store-client: opens `~/.fragua/fragua.db` (or `--db <path>`), writes intents through intent plane, reads through read plane — no HTTP dependency; works daemon-down. `withStoreClient` (`store-client.ts`) is the seam: open `migrate:false` + build both planes.
Doc: `SPEC §2`, AGENTS.md (codebase map, `@fragua/cli`).
Check: `packages/cli/src/store-client.ts`, `packages/cli/test/run.test.ts`, `packages/cli/test/validate-store-free.test.ts`.

**F12** — Executor-deps sharing: `buildExecutorDeps` (`packages/cli/src/executor-deps.ts`) is the shared executor assembly behind both `daemon` and `ci`; `fragua ci` embeds the executor over an ephemeral store and writes `fact.*` itself via `runOne` (not just intents).
Doc: AGENTS.md (codebase map, `@fragua/cli`).
Check: `packages/cli/src/executor-deps.ts`, `packages/cli/test/executor-deps.test.ts`, `packages/cli/test/ci.test.ts`, `packages/cli/test/ci-drive.test.ts`.

**F13** — Harness lifecycle: `fragua harness` spawns daemon as subprocess and runs HTTP server in-process. Supervises daemon with restart policy (test output shows `failure N/M` counters). SIGINT clears `server_endpoint` row. Auto-builds web bundle when sources are newer than `dist/`.
Doc: `SPEC §2`, `STATUS.md`.
Check: `packages/cli/src/commands/` (harness command), `packages/cli/test/harness.test.ts`.

**F14** — Workflow resolution: bare names resolve globally first (`~/.fragua/workflows/<name>.yaml`), then locally (`<cwd>/.fragua/workflows/<name>.yaml`); path-shaped values resolve verbatim. Cross-source name collisions disambiguate by `cwd`.
Doc: AGENTS.md, `STATUS.md` (Bare-name workflow resolution).
Check: `packages/cli/test/workflow-path.test.ts`, `packages/cli/test/shipped-workflows-validate.test.ts`.

**F15** — Config cascade: global `~/.fragua/config.yaml` overlaid by `<cwd>/.fragua/config.yaml`; project keys win; nested objects merge one level deep; YAML only. `getFraguaHome()` resolves `$FRAGUA_HOME` or `~/.fragua`; project-local stores key off `cwd`. `config.yaml` and update-notice cache key off `homedir()`.
Doc: AGENTS.md, `SPEC §2`, `STATUS.md`.
Check: `packages/cli/test/config.test.ts`, `packages/cli/test/fragua-home.test.ts`.

**F16** — `migrate --to`: `fragua db migrate --to <lower>` walks `down` inverses descending using the newer binary, backs up first, refuses an irreversible step, refuses a data-losing step without `--allow-data-loss`, refuses a live daemon. Orthogonal to the contract-version resume gate.
Doc: `ARCH §1.11`, `SPEC §5`, `ARCH §12`.
Check: `packages/store/src/migrations.ts` (`migrateTo`, `planMigration`), `packages/store/test/migrate-to.test.ts`, `packages/cli/test/db.test.ts`.

**F17** — Web stack: React 18 + Vite 5 + Tailwind 4 CSS-first (`@theme inline`, no `tailwind.config.ts`). Server-state via `@tanstack/react-query` query factories. `bun run test:web` runs via vitest (jsdom), distinct from `bun test` which skips the web suite.
Doc: AGENTS.md (stack section).
Check: `packages/web/package.json`, `packages/web/src/lib/api.ts`, `packages/cli/test/web-build.test.ts`.

**F18** — Web query discipline: web accesses server via HTTP API through `src/lib/api.ts`; no direct store imports. Web imports only `@fragua/types` and `@fragua/core` at compile time (confirmed by measured import edges: web → types(23), core(6), no server edges).
Doc: AGENTS.md (codebase map, `@fragua/web`).
Check: `packages/web/src/lib/api.ts`, import edges (web has no `store`/`server`/`daemon`/`agent` import edges).

**F19** — Web package boundary: `web` depends on `types(23)` and `core(6)` at compile time; all other packages accessed at runtime via HTTP. Confirmed by import-edges.txt.
Doc: AGENTS.md ("web → server → store" is runtime, not compile-time).
Check: `packages/web/package.json`, import-edges.txt.

**F20** — DTO widening: `packages/web/src/lib/api.ts` re-exports read-plane DTOs (`RunSummary`/`RunDetail`); where old-daemon payloads may omit a field, the re-export widens that field to optional so the type matches runtime. Consumers are forced to guard.
Doc: AGENTS.md (codebase map, `@fragua/web`, "Read-plane DTOs").
Check: `packages/web/src/lib/api.ts` (1 358 lines), widened optional fields vs core read-plane types.

**F21** — Skill-citations lint: no `// SKILL.md §…` comments in source code.
Doc: AGENTS.md ground rule 7.
Check: `packages/test-utils/test/skill-citations.lint.test.ts`.

**F22** — Function-length lint: every function under `packages/daemon/src` and `packages/agent/src` at or below 200 lines.
Doc: `ARCH §6.1`.
Check: `packages/daemon/test/function-length.lint.test.ts`, `packages/agent/test/function-length.lint.test.ts`.

---

## 3. Known-Gap Register

Lenses should NOT report these as findings — they are explicitly admitted in the docs.

### From STATUS.md "What fragua does not deliver today"

| Gap | Source |
|---|---|
| Multi-machine deployment — single SQLite coordination surface, no story for multiple daemons across machines | STATUS.md |
| Token auth on the harness API — localhost-only, no token auth in v0 | STATUS.md |
| Watchdog for stuck-but-alive daemons (fiber deadlock) — resumability covers crash-restart but not fiber deadlock; heartbeat metric planned, deferred | STATUS.md |
| Postgres or non-SQLite backing — `IEventStore` is synchronous; not a drop-in port | STATUS.md |
| Workflow hot-reload for in-flight runs — `workflow_sha` pinned at enqueue | STATUS.md |
| Schema auto-migration across breaking bumps — runs pin `contract_version`; out-of-range pin produces recoverable `fact.run_paused{reason:"engine_incompatible"}` | STATUS.md |
| Per-project credential isolation, project extensions, file-server, rate-limit fairness — design-stage | STATUS.md |

### From SPEC.md "Not in scope" (§5)

| Gap | Source |
|---|---|
| Multi-machine deployment (out of scope by design) | SPEC §5 |
| Blob encryption — single-user local, DB read = full read | SPEC §5 |
| Auto-migration of contract drift — pauses rather than auto-upgrades | SPEC §5 |
| Schema downgrade (DB-structure axis) — supported but never automatic | SPEC §5 |
| Workflow hot-reload | SPEC §5 |
| Shell / network sandboxing of `bash` — explicitly not a sandbox; `cat ~/.ssh/id_rsa` runs | SPEC §5 |

### From ARCH.md §12 "Deferred decisions"

| Gap | Source |
|---|---|
| Blob encryption for secret-bearing outputs | ARCH §12 |
| Cross-machine deployment (synchronous `IEventStore` is the binding constraint; §4 surface segregation removes one blocker but not this) | ARCH §12 |
| Retention policies per workflow — manual `fragua prune` until demand | ARCH §12 |
| Blob streaming for >16MB — handler must chunk; revisit on real use case | ARCH §12 |
| Workflow hot-reload for in-flight runs — `workflow_sha` pinned | ARCH §12 |
| Per-workflow concurrency caps — add when needed | ARCH §12 |

### From ARCH.md inline admissions

| Gap | Source |
|---|---|
| Capability-gated auto-wake for too-new contract arm — deferred | ARCH §1.11 |
| No max-branch validator bound for `parallel` (only E036's ≥2 minimum); pathologically wide fan-out fails at seed loudly (`PayloadTooLargeError`) — "latent validator gap to close if very wide fan-outs become real" | ARCH §6.2 |
| No per-branch pause seam — "not built and won't be until there is demand" | ARCH §6.2, SPEC §3.1.1 I11 |
| `fact.run_paused{reason:"signal"}` (cross-engine external wait) — "NOT emitted yet" | ARCH §3 |
| Spilled input blob support in bundle export/import — "pending (proposal §8, item B5)" | ARCH §0 |

### From STATUS.md experimental / not-frozen markers

| Gap | Source |
|---|---|
| `judge` step — "experimental, needs the `typesafe` credential" | STATUS.md |
| MCP tools — "experimental"; connector contract and `.mcp.json` schema "not frozen" | STATUS.md |
| Bundle secret scrubbing — "scrubber registry, marker format, and CI exit code are not yet frozen"; `fragua ci --export` fail-closed profile (exit 80 on live-credential hit) — not yet frozen | STATUS.md |

### From handler-contract.md

| Gap | Source |
|---|---|
| Tools without provider-level dedup support get a "warning label at registration; operator is the only safety net" | handler-contract.md §1 |
| `optional:` leaf direct read has no fallback syntax yet — W016 stays advisory | SPEC §3.8 |

### One skipped test

| Item | Source |
|---|---|
| `(skip) executor — §3.7 fail-routing retarget > node fails with no fail-edge but retry_target set → retargets` — scenario not yet fully implemented | test:node output |
