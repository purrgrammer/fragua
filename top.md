# Architecture review — open items toward 10/10

> Outcome of an adversarial review of `docs/ARCHITECTURE.md` + `docs/SPEC.md` cross-checked against the implementation.
>
> **Verdict: 7.5–8/10.** Structural choices are excellent (SQLite as sole coordination surface, intent/fact split, projection-in-transaction, content-addressed blobs, property-test matrix). The list below is what stands between us and 10/10.

## Status legend
- 🔴 **critical** — affects correctness or rating
- 🟡 **important** — design improvement
- 🟢 **minor** — polish
- ✅ **resolved** — fixed, committed, docs updated

## Index

| # | Sev | Title | Status |
|---|---|---|---|
| 1 | 🔴 | ~~`externalCall` buffers intent in memory — hard-crash defeats orphan quarantine~~ | ✅ resolved |
| 2 | 🔴 | ~~Replay semantics for non-external work undefined (artifacts silently overwrite, messages duplicate)~~ | ✅ resolved |
| 3 | 🔴 | ~~Intent fold lacks formal truth table for simultaneous combinations~~ | ✅ resolved |
| 4 | 🔴 | ~~Budget ledger declared-but-not-wired~~ | ✅ resolved |
| 5 | 🔴 | `canonicalStringify` lacks Unicode normalization (and Date/Buffer reject is undocumented) | open |
| 6 | 🟡 | Schema drift halts paused runs on any version bump (no additive vs breaking distinction) | open |
| 7 | 🟡 | Daemon health: server route exists, UI staleness banner does not | open |
| 8 | 🟡 | Quarantine triage UI missing — operator must hand-craft `intent.unquarantine` | open |
| 9 | 🟡 | Timeout-leaked handlers keep running and burning tokens (no `signal.abort()` on loser) | open |
| 10 | 🟡 | No load-shed / `max_queued_runs` / backpressure at enqueue | open |
| 11 | 🟡 | No authN/Z on server endpoints | open |
| 12 | 🟡 | `onCommit` API is effectively dead code (only tests subscribe) | open |
| 13 | 🟡 | Event payload 4KB cap is runtime-only; `fact.steering_applied` etc. will explode in real use | open |
| 14 | 🟡 | Abort-loop ceiling K=5 — "progress" not defined, magic number | open |
| 15 | 🟡 | Parallel + quarantine: sibling branch semantics on retry undocumented | open |
| 16 | 🟢 | No instrumentation around `BEGIN IMMEDIATE` lock wait | open |
| 17 | 🟢 | `gcBlobs` exists but never auto-invoked | open |
| 18 | 🟢 | No chaos test matrix (disk-full, clock skew, torn-write, OOM, fsync-fail) | open |
| 19 | 🟢 | Time/clock injection inconsistent across tests | open |
| 20 | 🟢 | Fan-in heuristic version not pinned per run — replay determinism risk | open |
| 21 | 🟢 | First-class simulation (`swarm simulate`) not delivered | open |
| 22 | 🟢 | Provider credentials live in process env — should move to DB (per existing memory note) | open |
| 23 | 🟡 | Pending-intent driver missing — `intent.unquarantine` and `intent.cancel_requested` on non-running states (paused_hitl / quarantined) are persisted by the server but never consumed by the daemon (uncovered while resolving #3) | open |

---

## Detail

### 1. ✅ ~~`externalCall` buffers intent in memory — hard-crash defeats orphan quarantine~~

**Resolution.** Replaced `CollectingRecorder` (in-memory buffer drained by executor) with `CommittingRecorder` (each `recordIntent`/`recordDone`/`recordFailed` commits its own SQLite txn synchronously). Executor uses `recorder.version()` for the terminal `node_completed`/`node_aborted` append since the recorder advances the OCC token as it commits. `sideEffectFacts` plumbing dropped from `result-to-facts.ts`. New property test **P25** demonstrates: `recordIntent` is durable on disk before the call returns, and a hard-crash simulation (no matching done) leads to startup-sweep quarantine.

Side benefit: SSE consumers now see `intent → done` interleaved with the actual `fn` time, instead of all-at-once at handler return.

Files touched: `packages/daemon/src/{recorder,executor,result-to-facts,index}.ts`, `packages/core/src/handler/external-call.ts` (comment), `packages/daemon/test/matrix.property.test.ts` (P25), `docs/ARCHITECTURE.md` (§1.1 + matrix).

---

### 2. ✅ ~~Replay semantics for non-external work undefined~~

**Resolution.**

- **Artifacts: replay-safe by default.** `putArtifact` now checks for an existing ref at `(run, node, iteration, key)`. Identical content → no-op (returns existing ref); different content → throws `ArtifactCollisionError` unless the caller passes `{ replace: true }`. Tool nodes (`tool.ts`) opt into `replace: true` because shell stdout is non-deterministic by nature.
- **Messages: opt-in dedup.** Schema gains a `content_hash TEXT` column (additive migration, no version bump). `appendMessage` accepts `opts?: { dedup?: boolean }`; default OFF because agent transcripts carry per-call timestamps that legitimately differ across attempts. With `dedup: true`, an identical-content rewrite at the same scope returns the existing ordinal instead of minting a duplicate row.

**Property tests added.**
- P26 (matrix): `ctx.artifacts.put` no-ops on identical content, throws on diff, accepts `replace`
- store.property: same as P26 at the store layer
- store.unit: opt-in message dedup behaviour

**Files touched:** `packages/store/src/{store,types,migrations,schema.sql}`, `packages/core/src/handler/{types,context}.ts`, `packages/core/src/handler/handlers/tool.ts`, `packages/store/test/{store.property,store.unit}.test.ts`, `packages/daemon/test/matrix.property.test.ts`, `docs/{ARCHITECTURE,handler-contract}.md`.

---

### 3. ✅ ~~Intent fold lacks formal truth table~~

**Resolution.** Truth table formalised in [`docs/intent-fold.md`](docs/intent-fold.md). Implementation in `intent-fold.ts` rewritten to honor seven precedence rules (R1–R7), per-state preconditions, and a new `intent.dropped` observability event for every intent that doesn't effect a state change. New `shouldPauseAfterDispatch` decision flag captures the pause-defers-to-after-handler semantics for steer/hitl + pause batches. P27 (200 fast-check runs) asserts the table holds across all `RunStatus` × intent-batch combinations.

**Files touched:** `packages/core/src/handler/intent-fold.ts`, `packages/daemon/src/executor.ts` (wired runStatus + dropped emission + shouldPauseAfterDispatch handling), `packages/core/test/handler/intent-fold.test.ts` (10 unit cases), `packages/daemon/test/matrix.property.test.ts` (P27), `docs/intent-fold.md` (new), `docs/ARCHITECTURE.md` (matrix).

---

### 4. ✅ ~~Budget ledger declared-but-not-wired~~

**Resolution.** Pure `evaluateBudget` policy module in `packages/core/src/engine/budget-policy.ts` evaluates run-level (`graph.attrs.budget_usd` / `budget_tokens`) and per-node (`node.attrs.max_cost_usd` / `max_tokens`) ceilings at every turn boundary. Executor calls it after accounting attach and edge selection, before the terminal commit; on breach it rewrites `result` to a budget halt and queues `budget.stop` into observability. Warns fire once per `(scope, metric)` per run, deduped via `routing.__budget_warned`. `graph.attrs.budget_policy = "warn"` keeps the run going through stops.

The reducer accumulates per-node cost in a new `RunMetrics.nodeCosts` map (additive JSON change, no schema bump). Parser validates `budget_policy` against the `"warn" | "stop"` enum at registration time so typos fail at `POST /workflows`. The agent backend's `BudgetSnapshot` is now populated from real cumulative numbers via `ctx.budgetSnapshot` threaded through the handler context (Option A from the budget.md plan).

**Tests.** `packages/core/test/engine/budget-policy.test.ts` (12 unit cases — empty config, warn-once, ceiling crossed default + warn-only policy, per-node breaches, run-vs-node precedence, ratio in warns, ordering). `packages/daemon/test/executor.budget.test.ts` (3 end-to-end — halt on overspend, warn-only mode, warn-once-per-run). Parser ENUM test in `parser.test.ts`.

**Files touched:** `packages/core/src/engine/{budget-policy,index}.ts`, `packages/core/src/parser/parser.ts`, `packages/core/src/types/{graph,events}.ts`, `packages/core/src/handler/{types,context}.ts`, `packages/core/src/executor/types.ts`, `packages/store/src/{reducers,types,store}.ts`, `packages/daemon/src/executor.ts`, `packages/agent/src/{handler-bridge,backend}.ts`, four test files, `docs/ARCHITECTURE.md` (§13.1 retired).

---

### 5. 🔴 `canonicalStringify` — Unicode + undocumented Date/Buffer reject

**Evidence**
- `packages/core/src/handler/canonical-stringify.ts` — strict on bigint/symbol/function/cyclic/non-finite; otherwise leans on `JSON.stringify`
- Two args with structurally-equal strings but different Unicode normalization (NFC vs NFD) produce different `argsHash` → different idempotency keys → provider may not dedup

**Proposed approach**
- Unicode-normalize all strings to NFC before serialization
- Reject `Date` and `Buffer`/`Uint8Array` explicitly with a typed error so handlers learn to convert
- Document the canonical form fully in `docs/handler-contract.md` (BNF-level)
- Cross-version stability test using a fixed corpus

---

### 6. 🟡 Schema drift = strict equality halts paused runs

**Evidence**
- `packages/daemon/src/executor.ts:193` — `if (state.schemaVersion !== CURRENT_SCHEMA_VERSION) halt`
- `packages/store/src/migrations.ts:23` — same strict check
- Long-paused HITL runs die on every release that bumps the version, even for additive changes

**Proposed approach**
Distinguish `schema_version` (breaking) from `feature_version` (additive). Or use a min/max compatible range. Document the bumping policy. For an interactive tool, the operationally-friendly default matters.

---

### 7. 🟡 Daemon health surface — UI doesn't surface staleness

**Evidence**
- `packages/server/src/routes/health.ts` — health route exposes `daemonInfo` with heartbeat age
- `packages/web/vite.config.ts:60-71` — vite config polls pidfile (only used in dev)
- Production web UI has no banner on stale daemon

**Proposed approach**
Web header banner when `heartbeat_age_ms > LOCK_TTL_MS / 2`. Distinguishes "daemon down" from "daemon stuck." Doesn't need a new endpoint — just consume what `health` already returns.

---

### 8. 🟡 Quarantine triage UI

**Evidence**
- Only an HTTP endpoint (`POST /runs/:id/unquarantine`) exists
- Operator must inspect orphan envelope (toolName, args, run state) by reading raw events

**Proposed approach**
A `/runs/:id/quarantine` view: orphan envelope, last 20 events, three buttons (`treat_as_done` / `retry` / `cancel`) plus a note field. Defer until #1 is fixed (otherwise the view is misleading because hard-crashes don't quarantine).

---

### 9. 🟡 Timeout-leaked handlers

**Evidence**
- `packages/daemon/src/executor.ts:385-391` — `Promise.race` rejects with synthetic timeout; handler promise is not aborted
- Leaked handler keeps streaming LLM tokens, completing in background, no further accounting
- `fact.handler_timeout_leaked` records the moment but not subsequent damage

**Proposed approach**
On timeout: explicitly call `signal.abort()` on the handler's signal; log a follow-up `fact.handler_timeout_unwound` if it does unwind within an additional grace; if N (=3?) leaks accumulate without process-cycle, exit the daemon (singleton + sweep re-takes).

---

### 10. 🟡 No load-shed / backpressure

**Evidence**
- `enqueueRun` succeeds unconditionally
- No `max_queued_runs` config
- Misconfigured client can fill `run_state` indefinitely

**Proposed approach**
Add `MAX_QUEUED_RUNS` config (default 10000?), check at `POST /runs` and return 429 with `Retry-After`. Surface queue depth in `health`.

---

### 11. 🟡 No authN/Z on server endpoints

**Evidence**
- `packages/server/src/index.ts` + routes — no auth middleware
- POST `/runs/:id/cancel` and friends are open on whatever interface the server binds

**Proposed approach**
Minimum: shared-secret bearer token (`SWARM_API_TOKEN`), reject unauth on writes. Reads (event SSE) might stay open for local dev. Document path to OIDC/mTLS for production. Bind to loopback by default.

---

### 12. 🟡 `onCommit` is effectively dead code

**Evidence**
- `packages/store/src/store.ts:184` — `emitCommit` called from append paths
- No daemon or server subscriber; only tests register listeners
- API suggests cross-process wake-ups but cannot deliver them (two processes, no IPC)

**Proposed approach**
Either delete the API or wire it to the supervisor's intent-detection fast path (in-process daemon optimization — saves a few polling round-trips for same-process commits). Document scope explicitly: "in-process only."

---

### 13. 🟡 Event payload 4KB cap is runtime-only

**Evidence**
- `events.payload TEXT … CHECK (length(payload) < 4096)` in schema
- `fact.steering_applied { folded: <user-text> }` will easily exceed
- No author-time enforcement; surprise at runtime

**Proposed approach**
Either:
- (a) Move `folded` (and similar bulky fields) to artifact/message refs; payload carries only the ref
- (b) Type each fact payload as a sum with compile-time size budgets and a lint
Recommend (a) — already aligns with §I9 "preview vs raw" pattern.

---

### 14. 🟡 Abort-loop ceiling

**Evidence**
- `packages/daemon/src/executor.ts:67,452-470` — K=5 magic constant; counter resets on any non-abort outcome including `yield_hitl` and `halt`
- "Without progress" undefined — the doc claims K consecutive aborts *without progress*

**Proposed approach**
- Make K configurable per workflow with sane default
- Define progress explicitly (e.g., "node_completed succeeded since last abort")
- Add observability: emit a `fact.abort_loop_warned` at K-1 so users see it coming

---

### 15. 🟡 Parallel + quarantine sibling semantics

**Evidence**
- Handler-contract attributes branch external calls to the parent parallel node
- On retry-via-unquarantine, what happens to siblings already in flight is undocumented

**Proposed approach**
Document. Likely: quarantine waits for all siblings to settle (success/abort), then retry restarts the parallel node from the parent (all branches re-run). Property test P25-parallel-quarantine.

---

### 16. 🟢 No `BEGIN IMMEDIATE` lock-wait instrumentation

**Evidence** `busy_timeout=5000` masks contention silently

**Proposed approach** Wrap `db.exec("BEGIN IMMEDIATE")` calls; record wait time histogram; expose via `/health`.

---

### 17. 🟢 `gcBlobs` not auto-invoked

**Evidence** Method exists; only tests call it

**Proposed approach** Daemon supervisor: GC on schedule (every N hours, only when idle) or on-demand via `swarm db gc`. Bound work per call to keep latency predictable.

---

### 18. 🟢 No chaos test matrix

**Evidence** P1-P24 cover invariants but not adversarial environments

**Proposed approach** Add P25-P30 covering:
- disk-full (`SQLITE_FULL`)
- clock-jump-back / NTP correction
- torn write (synthetic — flip a few WAL frame bytes mid-commit)
- OOM during handler
- fsync failure
- supervisor crash mid-run

---

### 19. 🟢 Clock injection

**Evidence** `now()` used in SQL; `AbortSignal.timeout()` uses real wall clock

**Proposed approach** Centralize clock through a `Clock` interface; SQL uses `?ts` binds the daemon owns; tests inject a fake clock. P5/P11 become hermetic.

---

### 20. 🟢 Fan-in heuristic determinism

**Evidence** `packages/core/src/engine/fan-in.ts` — heuristic ranker; if logic changes, replay diverges

**Proposed approach** Pin a `fan_in_version` per run in `run_state`; reducer dispatches on version. Replay uses the run's pinned version, not current.

---

### 21. 🟢 First-class simulation

**Evidence** `SPEC.md:11` claims it; not delivered

**Proposed approach** `swarm simulate <events.jsonl>` replays a saved log against a fresh DB and asserts bit-identical `run_state` + projection. Single deliverable that proves most invariants and is the strongest demo of the architecture's claim.

---

### 22. 🟢 Credentials in DB

**Evidence** Memory note: "Store provider/credentials in DB so daemon+serve env doesn't desync on restart"

**Proposed approach** New `credentials` table. Encrypt at rest with a process-startup-decrypted key (passphrase or OS keychain). Audit: who reads what when. Don't ship plaintext credentials in DB.

---

### 23. 🟡 Pending-intent driver missing

**Evidence**
- `packages/server/src/store/routes.ts:271-281` — `POST /runs/:id/unquarantine` persists `intent.unquarantine`
- `packages/daemon/src/wake-hitl.ts` — only checks for `intent.hitl_input`; doesn't process unquarantine or cancel
- `packages/daemon/src/executor.ts:182-189` — paused/quarantined runs are skipped before the fold runs
- Surfaced while writing `docs/intent-fold.md` (issue #3)

**Gap**
- `intent.unquarantine` on a `quarantined` run: never consumed; run sits forever
- `intent.cancel_requested` on a `paused_hitl` run: never consumed; the operator's cancel is silently ignored

**Proposed approach** New `wakePendingIntents` (or extend `wakePendingHitl`) at the top of the executor loop. Walks runs in non-dispatching states (`paused_hitl`, `quarantined`) and consumes:
- `intent.unquarantine { resolution: "treat_as_done" | "retry" | "cancel" }` on quarantined runs → emit `fact.run_resumed` (or `fact.run_cancelled`)
- `intent.cancel_requested` on paused/quarantined runs → emit `fact.run_cancelled`

The fold itself stays as-is. This is purely about delivering state-changing intents that don't go through dispatch.

---

## Loop log

- **2026-04-25 — #1** Pre-commit recorder. Replaced buffered `CollectingRecorder` with `CommittingRecorder`; each side-effect fact now lands in its own short txn before `fn` runs. Closes the hard-crash quarantine gap described in §1.1. Added P25 property test. All 1084 tests green.
- **2026-04-25 — #2** Replay semantics. Artifacts gained collision-detection (no-op on same content, throws on diff content unless `replace: true`); messages gained opt-in dedup via a new `content_hash` column (additive migration, no version bump). Default behaviour matches the natural pattern: artifacts are typically deterministic (replay-safe by default), messages carry timestamps (caller opts into dedup explicitly). Tool node passes `replace: true` for stdout/stderr. P26 added; existing P15 reframed; new store-unit and store-property tests cover the edges. All 1087 tests green.
- **2026-04-25 — #3** Intent fold truth table. Rewrote `foldIntents` with seven precedence rules, per-state preconditions, and a new `intent.dropped` observability event. New `shouldPauseAfterDispatch` decision flag captures pause-defers-to-after-handler semantics when steer/hitl arrive in the same batch as pause (per user feedback: specific intents must not be dropped implicitly). Documented in new `docs/intent-fold.md`. P27 (200 fast-check runs) asserts the table; 10 unit cases cover the headline rules. Surfaced item #23 (pending-intent driver missing for unquarantine + cancel-on-paused). All 1094 tests green.
- **2026-04-25 — #4** Budget ledger wired. New pure `evaluateBudget` policy module enforces run + node ceilings at the turn boundary; executor rewrites `result` to a budget halt on breach, queues `budget.stop` observability before the terminal `fact.run_halted`. Warn-at-80 % fires once per scope+metric per run. `budget_policy = "warn"` makes stops non-blocking. New `RunMetrics.nodeCosts` accumulates per-node cost (additive JSON change, no schema bump). Parser ENUM_KEYS rejects typos in `budget_policy` at registration. Agent backend's `BudgetSnapshot` now populated from real cumulative numbers. 15 new tests (12 unit + 3 e2e + parser enum). All 1110 tests green.
