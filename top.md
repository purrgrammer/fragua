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
| 2 | 🔴 | Replay semantics for non-external work undefined (artifacts silently overwrite, messages duplicate) | open |
| 3 | 🔴 | Intent fold lacks formal truth table for simultaneous combinations | open |
| 4 | 🔴 | Budget ledger declared-but-not-wired | open |
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

---

## Detail

### 1. ✅ ~~`externalCall` buffers intent in memory — hard-crash defeats orphan quarantine~~

**Resolution.** Replaced `CollectingRecorder` (in-memory buffer drained by executor) with `CommittingRecorder` (each `recordIntent`/`recordDone`/`recordFailed` commits its own SQLite txn synchronously). Executor uses `recorder.version()` for the terminal `node_completed`/`node_aborted` append since the recorder advances the OCC token as it commits. `sideEffectFacts` plumbing dropped from `result-to-facts.ts`. New property test **P25** demonstrates: `recordIntent` is durable on disk before the call returns, and a hard-crash simulation (no matching done) leads to startup-sweep quarantine.

Side benefit: SSE consumers now see `intent → done` interleaved with the actual `fn` time, instead of all-at-once at handler return.

Files touched: `packages/daemon/src/{recorder,executor,result-to-facts,index}.ts`, `packages/core/src/handler/external-call.ts` (comment), `packages/daemon/test/matrix.property.test.ts` (P25), `docs/ARCHITECTURE.md` (§1.1 + matrix).

---

### 2. 🔴 Replay semantics for non-external work undefined

**Evidence**
- `packages/store/src/store.ts:530-537` — `putArtifact` uses `INSERT … ON CONFLICT … DO UPDATE` → silent overwrite on `(run_id, node_id, iteration, key)` collision
- `appendMessage` uses `MAX(ordinal) + 1` → duplicates accumulate across replays
- No framework-level dedup; handlers are silently expected to be idempotent

**Gap**
On retry-via-unquarantine or backward-edge re-entry without iteration bump, a handler that calls `artifacts.put("result", ...)` overwrites prior content and `messages.append(...)` duplicates rows. P8 ("next turn converges") doesn't actually guarantee message dedup.

**Proposed approach**
Pick one model and document it:
- **(a) Framework dedup:** `messages.append` keyed by `(node, iteration, content_hash)` returns existing ordinal on collision. `artifacts.put` rejects on collision unless `replace: true`.
- **(b) Pre-dispatch wipe:** Executor deletes iteration-N artifacts/messages before re-dispatching iteration N. Simpler; loses partial progress on the second attempt.

Recommend (a). Add P25 + P26 properties: replay produces identical message ordinals; artifact dedup observable.

---

### 3. 🔴 Intent fold lacks formal truth table

**Evidence**
- `packages/core/src/handler/intent-fold.ts:20-85` — handles cancel-wins, steering concat, last-wins hitl, pause boolean, priority adjustment
- `packages/core/test/handler/intent-fold.test.ts` — covers single-intent cases; no combinatorial coverage
- Edge cases: `cancel + steer` (steer dropped silently? recorded? `appliedSeqs` only attached on the proceed path), N steers (concatenated with `\n` — order non-deterministic across writers), `unquarantine` arriving on non-quarantined run (silently dropped), `hitl_input` on `running` (silently dropped)

**Proposed approach**
Lift the fold into a documented truth table (one row per intent combination, deterministic outcome). Add `foldIntents.property.test.ts` using fast-check to enumerate all 2^N combinations and assert the table. Document semantics in `docs/handler-contract.md` or a new `docs/intent-fold.md`.

---

### 4. 🔴 Budget ledger declared-but-not-wired

**Evidence**
- `packages/core/src/types/graph.ts:84,126` — `budget_usd`, `max_cost_usd`, `budget_policy` parse correctly
- `packages/core/src/types/events.ts:122-128,162` — `BudgetSnapshot`, `budget.warn`, `budget.stop` declared
- No daemon code reads cumulative spend or fires the events
- `docs/ARCHITECTURE.md:727` — own admission

**Proposed approach**
Fold `costUsd` from `fact.node_completed` / `fact.side_effect_done` into `run_state.cumulative_cost_usd` (new column or routing.cumulative_cost). Pre-dispatch gate compares against `max_cost_usd` (per-node) and `budget_usd` (per-run); halts with `fact.run_halted { reason: "budget" }` at the boundary, not inside the handler. Emit `budget.warn` at 80% threshold. Property test P25-budget.

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

## Loop log

- **2026-04-25 — #1** Pre-commit recorder. Replaced buffered `CollectingRecorder` with `CommittingRecorder`; each side-effect fact now lands in its own short txn before `fn` runs. Closes the hard-crash quarantine gap described in §1.1. Added P25 property test. All 1084 tests green.
