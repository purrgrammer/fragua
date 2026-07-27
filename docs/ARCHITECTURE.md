# fragua — Architecture

> **Authoritative.** The design the codebase implements. Companion to [`SPEC.md`](./SPEC.md) (goals), [`handler-contract.md`](./handler-contract.md) (writing handlers), and [`execution-model.md`](./execution-model.md) (filesystem layout for workflow authors).
>
> SQLite-backed event store with projection-in-transaction, intent/fact split, hard-abort semantics, content-addressed blob storage. No filesystem coordination surface.

---

## 0. Context and decisions

### What we're committing to
- **Single coordination surface: one SQLite database.** All state, events, queue, locks, and artifact metadata. The harness supervises a daemon subprocess + in-process HTTP server against `~/.fragua/fragua.db` by default; both halves read and write. WAL mode handles multi-process access. Artifact *content* lives on the filesystem under `blobsDir`, keyed by sha256 — keeping raw bytes out of the WAL. The CI primitives (`fragua daemon --db <path>` + `fragua serve --db <path>`) hit the same store contract against an explicit DB path.
- **Event sourcing with projection-in-transaction.** Events are the immutable log of truth. A materialized projection (`run_state`) is updated inside the same transaction as the event append. Reads of current state are one row; event fold is only used for migration/debug.
- **Intent/fact split.** Web writes intents (always-appendable, no OCC). Daemon writes facts (OCC-checked against `run_state.version`). 90% of retry pressure disappears.
- **Hard abort for all interrupts.** Pause, cancel, and steer all trip a single `AbortSignal`. Handlers unwind, emit `fact.node_aborted` with partial metrics, executor re-enters (or halts) based on new state.
- **Durable HITL via unwind-and-rehydrate.** `kind=human` nodes return `yield_human`, the executor emits `fact.run_paused{reason:"human"}`, the process is free. Human input (`intent.human_input`) wakes the daemon; it rehydrates from the projection and resumes at the route-matched edge.
- **Content-addressed blobs on disk.** Tool outputs never inline in event payloads or the WAL. Handlers write raw content to `<blobsDir>/<first2>/<sha256>`; a metadata row in `blobs` points at it. Events carry a ref + bounded preview. File-then-row commit ordering: a crash can leave orphan files (GC sweeps), never dangling rows. The same CAS backs **spilled run inputs**: when a `routing.inputs` string value exceeds `PER_VALUE_SPILL_BYTES` (1 KiB) or the total routing JSON exceeds `ROUTING_SPILL_MARGIN_BYTES` (3 KiB), the value is written to the blob CAS and replaced in the genesis event with a `{ "$fragua_blob": "<sha256>", "bytes": N }` reference object. `materializeRouting` resolves these refs on read (executor substitution, auto-titler). `gcBlobs` treats every sha found in any `run_state.routing` column as a GC root (alongside artifact-referenced blobs), so spilled inputs are never collected while the run is live. Bundle export/import support is pending (proposal §8, item B5).
- **Orphan-side-effect quarantine.** External tools use provider idempotency keys; on crash-replay, orphaned `SIDE_EFFECT_INTENT` without matching `DONE` quarantines the run for operator review. No blind retry.
- **No IPC.** Daemon↔web coordination is SQLite polling (50ms daemon supervisor, 100ms SSE). No unix socket. No stale `.sock` cleanup. No `EADDRINUSE`.
- **Singleton daemon via `daemon_lock` row with heartbeat.** Zombie detection on reclaim + startup sweep of mid-flight runs. Where to reach the HTTP server lives in a separate `server_endpoint` row (written by whoever binds the listener — the harness's in-process server or a standalone `fragua serve`), so CLIs discover the running URL by opening the DB read-only — one `open()` + one `SELECT` per invocation, no JSON rendezvous file.
- **Web UI works daemon-down.** Reads hit SQLite directly; intents queue; SSE continues polling. No daemon required for observability or control-plane writes.

### Invariants (the contract)

| # | Invariant | Enforced by |
|---|---|---|
| **I1** | Every write is one SQLite transaction; events + projection updated together | Store module API; lint rule: no `await`/`fetch`/`JSON.stringify` inside `db.transaction()` bodies |
| **I2** | No handler state outside the projection | HandlerContext API; pure-function handler signature |
| **I3** | Intents always-appendable; facts OCC-checked | Two distinct store methods (`appendIntent`, `appendFact`) |
| **I4** | Handlers receive `AbortSignal`; respecting it is contract | HandlerContext carries signal; pre-wired LLM/HTTP clients auto-propagate |
| **I5** | External side effects carry a provider idempotency key; orphan `INTENT` quarantines the run on crash-replay | `SideEffectEnvelope.idempotencyKey`; startup sweep emits `fact.run_quarantined` |
| **I6** | `run_state.routing` ≤ 8KB; payload lives in messages/artifacts | `CHECK (length(routing) < 8192)` column constraint |
| **I7** | Event payloads ≤ 4KB | `store.ts::validatePayload` (binding 4 KiB-**byte** guard via `TextEncoder().byteLength`); the `CHECK (length(payload) < 4096)` column constraint is a coarse code-point backstop only |
| **I8** | Raw tool output addressed by sha256 on the filesystem under `blobsDir`; `blobs` row holds metadata only; artifacts are named refs scoped by `(run, node, iteration, key)`; replay-safe by default — same-content rewrite is a no-op, different-content rewrite at the same scope throws `ArtifactCollisionError` unless the caller passes `{ replace: true }` | Store API writes file→row in that order so orphans are always files, never dangling rows; `putArtifact` checks existing ref and either matches sha (no-op), throws collision, or overwrites with explicit replace |
| **I9** | LLM-visible preview (`messages`) is distinct from system-recorded raw (`artifacts`); individual messages < 1,048,576 characters | Handler API exposes `messages.append()` and `artifacts.put()` separately; `CHECK (length(content) < 1048576)` + pre-check throws `MessageTooLargeError` |
| **I10** | Seq assignment is O(1) via per-run counter on `run_state.next_seq`; never scanned | Store module; `UPDATE run_state SET next_seq = next_seq + 1 RETURNING ...` inside append txn |
| **I11** | A `parallel` region is single-entry/single-exit: `wait_all` is its only join, pause is run-global (one shared `AbortSignal`), the per-branch active set is a log-derived **diagnostic** (the scalar `run_state.status` stays sole lifecycle authority), and branches commit through the one daemon writer (commit unit = branch-step, not a synchronised superstep) | Validator E036–E045; `runFanout` single-writer commit lane (§6.2); the fan-out property suite (P28–P31) |

---

## 1. Adversarial review — findings and resolutions

### 1.1 Orphan `SIDE_EFFECT_INTENT` after crash
**Attack.** Daemon crashes after `fact.side_effect_intent` is committed but before `fact.side_effect_done`. The external API call actually happened (credit charged, PR merged). On replay, absence of `DONE` is not proof of non-execution — blindly re-running doubles the effect.

**Resolution.**
1. **Provider-level idempotency keys.** External tool envelope carries `idempotencyKey = sha256(runId + nodeId + iteration + argsHash + attempt)`. Handler passes this as `Idempotency-Key` header (or provider-equivalent). Provider dedupes server-side; jointly we achieve at-most-once.
2. **Pre-commit recorder.** `fact.side_effect_intent` is committed in its own short SQLite transaction *before* the handler invokes `fn(idempotencyKey)`. The recorder (`packages/daemon/src/recorder.ts` — `CommittingRecorder`) advances `run_state.version` synchronously on each commit; the executor's terminal `node_completed` / `node_aborted` append uses the recorder's evolved version. This makes the intent durable even if a hard crash (SIGKILL / OOM / panic) destroys the process before `fn` returns — an in-memory buffer would be lost; a committed row is not. `fact.side_effect_done` / `fact.side_effect_failed` are committed the same way, on completion.
3. **Startup quarantine.** On daemon start, scan for `fact.side_effect_intent` events without a matching `fact.side_effect_done`/`fact.side_effect_failed` (joined by `idempotencyKey`). Any run with such an orphan enters `quarantined` status. Run does not resume until a human writes `intent.unquarantine { resolution: "treat_as_done" | "retry" | "cancel", note }`.
4. **Retry uses the same key.** If operator chooses `retry`, the handler re-executes with the same `idempotencyKey`. If the provider already processed the prior attempt, it returns the cached response. Safe under operator error.
5. **Tools without provider dedup** get a warning label at registration; operator is the only safety net. Documented as handler-author responsibility.

### 1.2 Artifact key collision under loops
**Attack.** Node `A` runs in iteration 1 of a graph cycle, calls `artifacts.put("result", ...)`. On iteration 2, same node, same user key → `UNIQUE` constraint violation.

**Resolution.** `artifacts` PK becomes `(run_id, node_id, iteration, key)` explicitly — no string encoding. The handler API auto-scopes: `put`/`get` use the implicit current `(nodeId, iteration)`, while `getFrom` takes an explicit `{ nodeId, iteration, key }` for cross-scope reads (see `packages/core/src/handler/types.ts`). `iteration` is the per-node retry counter, bumped each time a backward edge re-enters a node after a non-success outcome (0 on first entry). Downstream nodes receive `ArtifactRef { runId, nodeId, iteration, key }` through routing, never raw strings.

### 1.3 Unix socket IPC is net-negative
**Attack.** `.sock` cleanup, `EADDRINUSE`, permission errors, reconnect bookkeeping — hundreds of lines for something SQLite already does in <0.1ms per query.

**Resolution.** `packages/ipc` is deleted from the plan.
- **Daemon supervisor fiber** ticks every 50ms, inside one short transaction:
  - `heartbeat()` — UPDATE `daemon_lock.heartbeat_at`
  - `detectNewIntents()` — for every registered abort controller, check if there are unapplied intents; trip abort if yes
  - `detectStuckNodes()` — watchdog for handlers that exceeded `maxMs + LEAK_GRACE_MS`. Skipped for nodes whose `HandlerSpec.maxMs` is `undefined` (llm opt-out via `max_ms=0`).
- **Web SSE streams** poll `events WHERE seq > ?` every 100ms per subscribed run. At 10 concurrent subscribers, ≈100 qps of indexed reads; <1ms each.
- **No `.sock` file.** Nothing to clean up on crash. Nothing to reconcile on restart.

### 1.4 Crash-recovery limbo
**Attack.** Daemon hard-crashes while runs were `running`. On restart, those rows still say `running`; the executor only claims `queued`; runs sit dead until watchdog fires a minute later.

**Resolution.** The **startup sweep** runs before the executor loop, in a single transaction: it requeues crash-interrupted `running` rows (resetting `ready_at`, bumping `version`, appending `fact.run_requeued_after_crash`) while **preserving `current_node`** so each resumes on the in-flight node rather than re-emitting `fact.run_started` and re-running from the start node; it quarantines orphan side-effects (§1.1); and it leaves `paused`, `paused_human`, and `quarantined` rows untouched. Rerun-from-start was never the intended recovery semantics — partial-side-effect safety lives in the orphan quarantine, not in re-execution. See `packages/store/src/sweep.ts`.

Combined with the watchdog (1.10) and zombie detection (1.6), recovery is immediate rather than minute-delayed.

### 1.5 `MAX(seq)` write-path contention
**Attack.** `INSERT ... SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE run_id=?` adds a B-tree seek inside every write txn. Under load, the extra latency amplifies `SQLITE_BUSY` across both processes.

**Resolution.** A per-run `next_seq` counter on `run_state` is bumped atomically inside each append (the bumped value seeds the event's `seq`) — no scan — and combined with `BEGIN IMMEDIATE`, concurrent appends serialize cleanly without index pressure. I10 captures this.

### 1.6 Zombie daemon after lock reclaim
Unchanged from Revision 1. Daemon lock has TTL; stalled process fails OCC on every commit; loop-internal re-check of `daemon_lock` forces it to exit on takeover.

### 1.7 Heartbeat outlives stuck executor
Consolidated into the supervisor fiber (1.3). Heartbeat, intent detection, and stuck-node detection share one 50ms tick. If the executor fiber wedges in a tight sync loop, the event loop is blocked — supervisor also stops, lock stales, another daemon reclaims. Belt and suspenders via handler-level `AbortSignal.timeout()` (§5).

### 1.8 LLM provider ignores `AbortSignal`
Unchanged. `Promise.race` with hard timeout bounds damage; leaked handlers emit `fact.handler_timeout_leaked` for accounting honesty.

### 1.9 Mid-flight abort replay
Covered by provider idempotency keys (1.1) and per-node iteration scoping (1.2). Handlers with `side_effect: "none" | "idempotent"` can replay freely; `external` handlers rely on the provider key.

### 1.10 LLM provider transport error mid-stream
**Attack.** The LLM provider returns 402 (insufficient balance), 429 (rate limit), 5xx, or the network drops mid-stream. pi-ai surfaces this as `AssistantMessageEvent { type: "error" }`; without intervention the llm handler converts it into `outcome.status = "fail"`, indistinguishable from a deliberate `abort` tool call. The run halts and all completed work in the transcript is abandoned even though it survives in the `messages` table.

**Resolution.**
1. **HTTP-status capture.** `PiLlmBackend` registers `StreamOptions.onResponse` to record the last `ProviderResponse.status` per LLM call. On stream `error`, the captured status (or `null` for pre-response network failures) is paired with the provider's `errorMessage` and bubbled out as a new outcome shape.
2. **Handler-result kind `pause_provider`.** The handler-bridge translates the provider-error outcome to `HandlerResult.kind = "pause_provider"` carrying `{ httpStatus, provider, errorMessage }`. The executor commits `fact.run_paused` with `reason: "payment_required"` for 402 (top-up off-ledger) or `reason: "provider_error"` otherwise, and transitions the run to `paused`.
3. **Generic resume intent.** Operator writes `intent.resume`. The daemon wakes the run back to `queued` and re-dispatches the same `(nodeId, iteration)` with the rehydrated transcript loaded as `priorMessages`. Worktree, branch, and message ordering all survive — same path as `paused_human` rehydration.
4. **Manual + auto classes.** 408 / 429 / 5xx / 529 / network errors emit `fact.run_paused{reason:"provider_retry"}` (with `attempt`, `resumeAt`) and project to `paused_auto` for timer-driven wake. An Anthropic `overloaded_error` envelope is auto-retryable regardless of the captured HTTP status — a mid-stream overload returns 200, so the backend normalises it to the canonical 529 before classification. 400 / 401 / 402 / 403 / 404 / 413 / 422 stay manual (`paused{reason:"provider_error"}`, or `paused{reason:"payment_required"}` for 402); auto-retry against a busted account would burn money.

### 1.11 Remaining concerns
- **sha256 oracle for blobs** — deferred to optional encryption later; single-user local tool has DB read = full read anyway.
- **SSE push ordering** — not an issue in polling model. Consumers read `seq > lastSeen`, always consistent.
- **Intent-flood DOS** — retry-storm ceiling (abort-loop detector emits `fact.run_paused{reason:"abort_loop"}` after K=5 consecutive aborts without progress; operator-resumable per Stage 3 of recoverable-budget-pause.md). HTTP rate-limit at web layer.
- **WAL bloat from large artifacts** — `blobs` holds metadata only; content lives on the filesystem so multi-MiB writes never frame into the WAL. Live SSE readers can't pin large blob bytes in the WAL as a result. See §2.
- **Contract drift across long pauses** — `contract_version` pinned per run (`EVENT_CONTRACT_VERSION` at enqueue), the run-resume gate. It is a SEPARATE axis from the DB-migration counter `schema_version`: it bumps only on real `FactEvent`/`IntentEvent`/reducer changes, so projection-only migrations never trip the gate. The daemon resumes any pin in `[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` and **pauses** (recoverable) an out-of-range pin with `fact.run_paused { reason: "engine_incompatible", pinnedVersion, supportedMin, supportedMax }`. The payload's window distinguishes the arms: `pinnedVersion > supportedMax` (too new — a downgraded daemon, or a newer-producer import) heals once a capable daemon runs; `pinnedVersion < supportedMin` (too old) needs an operator rebuild-from-source or cancel. Both project to `paused` (operator-resumable) — capability-gated auto-wake for the too-new arm is deferred. **Backward-compat invariant:** a daemon at contract version `V` folds-correctly every stream pinned in `[MIN_COMPATIBLE, V]`; only the *downgrade* direction parks (an older daemon meeting a newer pin) — a current daemon never parks on an older run, and may not delete reducer paths for any contract version ≥ `MIN_COMPATIBLE` until the floor ratchets past it. `MIN_COMPATIBLE_CONTRACT_VERSION` ratchets only by deliberate act (it strands every run below it). Parallel fan-out drove the first real bump: `EVENT_CONTRACT_VERSION = 2` (new `fact.fanout_started` / `fact.fanout_joined` + the active-set reducer fold), `MIN_COMPATIBLE_CONTRACT_VERSION = 1` — so the gate is now live but backward-compatible: a v2 daemon folds every pin in `[1, 2]` (pre-fan-out runs replay unchanged), and only a v1 daemon meeting a v2 pin parks (too-new). The v4 fact-taxonomy collapse (fact-taxonomy.md §3.1–3.2 — three terminal facts → one `fact.run_terminated { status }`, `fact.run_paused_human` → `fact.run_paused { reason: "human" }`) is an **emission-only** cut: new runs emit the v4 facts, but the retired `fact.run_{completed,halted,cancelled,paused_human}` types stay read-only, never-emitted members of `FactEvent` with their fold paths intact, so `MIN_COMPATIBLE_CONTRACT_VERSION` stays `1` and runs pinned `< 4` keep folding. The floor ratchets — stranding runs below it — only when a historical format becomes genuinely un-foldable, never as an emission cleanup (bumping it in lockstep with `EVENT_CONTRACT_VERSION` bricks every in-flight run pinned lower). Two discipline tests guard it: a contract-surface hash snapshot (`packages/store/test/contract-version.test.ts`) and the `reducers.ts` touch-gate (`scripts/check-contract-bump.sh`) — both force a conscious bump-or-resnapshot. **Bump iff** a daemon at the prior contract version, folding a stream with the change, would produce a different/erroneous `run_state`: new/removed fact or intent type → yes; new field a fold path reads → yes; new pause/halt reason → yes; reducer behaviour change → yes; new observability event or projection column → no (off the fold path). Separately, the DB-migration `schema_version`: `migrate()` creates the baseline on a fresh DB and walks an existing DB forward through `SCHEMA_MIGRATIONS` (keyed by target version) up to CURRENT. The *automatic* open paths still refuse a store newer than the binary (`checkVersion`) — nothing downgrades by surprise. Each step is `{ up, down? }`: a schema downgrade is a first-class but **explicit operator action** via `fragua db migrate --to <lower>`, which walks the `down` inverses (descending), backs up first, and refuses to cross an irreversible step or to race a live daemon. It is run by the *newer* binary (the one that defines the `down` steps), after which the older binary opens the store cleanly. This is the schema axis only — orthogonal to the `contract_version` resume gate above. See `packages/store/src/pragmas.ts`, `packages/store/src/migrations.ts` (`migrateTo`/`planMigration`), and `docs/proposals/reversible-migrations.md`.
- **Replay determinism under LLM non-determinism** — determinism is a property of the **folded event log, not of re-execution**. Reconstructing `run_state` is a pure fold over recorded `fact.*` (`deriveRunState`, `reducers.ts`), so a given log always reaches exactly one state; recorded turns rehydrate from the `messages` table as `priorMessages` (1.10) rather than re-running. Durability is **turn-grained**: a turn whose response was recorded before a crash is never re-issued, but the *un-recorded tail* — a call in flight when the process died — re-executes on resume and may return different bytes. So forward re-execution is not bit-identical; only the fold is. External-call safety across that boundary is the provider idempotency key (1.1); pure/idempotent handlers replay freely.

---

## 2. Schema

All tables are `STRICT`. The append-mostly per-run tables (`events`, `messages`, `blobs`, `artifacts`) additionally use `WITHOUT ROWID` for compact PK-clustered storage; the lifecycle and singleton tables (`schema_version`, `workflows`, `run_state`, `daemon_lock`, `daemon_events`) use the default rowid layout (`daemon_events` in particular relies on `INTEGER PRIMARY KEY AUTOINCREMENT`, which is incompatible with `WITHOUT ROWID`). Every table is narrow — the only "big" data (artifact content) lives on the filesystem under `blobsDir`, keyed by sha256. Per-run tables cascade on run deletion.

The authoritative DDL is `packages/store/src/schema.sql`; connection pragmas (WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`, `temp_store=MEMORY`, 64 MB `cache_size`, 256 MB `mmap_size`, `wal_autocheckpoint=1000`, and the creation-only `page_size=8192`) live in `packages/store/src/pragmas.ts`. Every write transaction opens `BEGIN IMMEDIATE`, grabbing the write lock up front. Per-run tables cascade on run deletion. The table rundown — load-bearing columns and the invariant each enforces:

| Table | Purpose | Load-bearing columns / constraints |
|---|---|---|
| `schema_version` | DB-migration counter (singleton row). | `version`; the migration axis only — orthogonal to a run's `contract_version`. |
| `workflows` | Workflow catalog, keyed by source `sha`. | `ir` (parsed Graph serialised with `loc` stripped) + `ir_version` (the IR contract version, distinct from `schema_version` / `contract_version` / the sha), both NOT NULL — every workflow is parsed once at mint. |
| `run_state` | Projection + queue + seq counter (one row per run). | `version` (OCC token, I3); `status` CHECK over the nine `RunStatus` values (the `@fragua/types` predicates `isTerminal = {completed,cancelled,halted}` gate resume/accept, `isSettled = isTerminal ∪ {quarantined}` gates SSE-close + schedule overlap-skip); `current_node`; `contract_version` (the `EVENT_CONTRACT_VERSION` pin and run-resume gate, NOT the DB counter); `routing` with the 8 KB CHECK (I6); `next_seq` (per-run counter, I10); `priority` + `ready_at` (queue ordering, reset on every transition into `queued`); `enqueued_at` (immutable); `dispatch_started_at` (activeMs accounting); generated `total_cost_usd` / `billed_tokens` columns folded off `metrics`; project-identity `project_id` (stable UUIDv7 from `.fragua/config.yaml`, decoupled from `cwd`) + `project_name`, both NOT NULL; worktree-snapshot + inbox projection columns (`base_git_sha`/`base_git_ref`/`final_git_sha`/`final_head_ref`/`diff_base_sha` HEAD-relocation-honest diff base, `change_stat` < 1024 CHECK, `inbox_status` enum CHECK, `accepted_sha`). Indexes: the partial `idx_run_state_queue (priority DESC, ready_at ASC) WHERE status='queued'` is the queue in disguise (O(log N) claim); the partial `idx_run_state_inbox WHERE inbox_status='pending'`; plus status / workflow / updated / cwd / project_id / schedule indexes. |
| `events` | Append-mostly per-run event log (`intent.*` / `fact.*`). | PK `(run_id, seq)`; `payload` 4 KB CHECK (I7); `writer` deliberately unconstrained so the provenance value space can evolve without a rebuild (convention: `daemon` for facts, `client` for intents). Two indexes: `idx_events_type (type, run_id, seq)` and `idx_events_ts (ts, run_id, seq)` for cross-run time-ordered Home-feed scans (the global cursor is the `(ts, run_id, seq)` tuple — per-run `seq` carries no global order). |
| `messages` | Append-mostly conversation transcript; never rewritten. | PK `(run_id, ordinal)`; `content` (pi-agent-core `AgentMessage` JSON, round-trips losslessly) with the 1 MiB CHECK (I9); generated `role` column so UI filters skip `json_extract` on hot paths; `pass` (goal-gate re-entry epoch — a gate retarget resets per-node retry counters, so a threadless node's resume hydration scopes to `(node_id, iteration, pass)` for a clean fresh-pass transcript); `content_hash` backs the opt-in replay dedup path (default OFF — transcripts carry per-call timestamps that legitimately differ across attempts). |
| `blobs` | Content-addressed metadata only; bytes live at `<blobsDir>/<first2>/<sha256>` on disk. | PK `sha256` + `size_bytes`. |
| `artifacts` | Per-`(run, node, iteration, key)` named refs into `blobs` (I8). | PK `(run_id, node_id, iteration, key)` (the loop-scoping fix, §1.2); `blob_sha` FK; `idx_artifacts_blob` for GC. |
| `daemon_lock` | Pure liveness — one daemon per store (singleton row). | `pid` + `heartbeat_at` (TTL reclaim, §1.6). |
| `server_endpoint` | HTTP-server discovery rendezvous (singleton row). | `url`/`port`/`pid`, written by whoever binds the listener (harness in-process server or standalone `fragua serve`), cleared on shutdown; separate from `daemon_lock` so "is the daemon alive" and "where is the server" stay distinct. |
| `daemon_events` | Daemon-level audit log (lifecycle, sweeps, reaper takeovers, GC, leak/provision). | `seq INTEGER PRIMARY KEY AUTOINCREMENT` (rowid layout, incompatible with `WITHOUT ROWID`); same 4 KB payload cap; optional `run_id` FK `ON DELETE SET NULL` (NULL for global entries). Disjoint from the per-run `seq` space so global entries never interleave into the reducer's projection. |
| `imported_runs` | Local inert marker — one row per `fragua import`, never carried in a bundle. | PK `run_id`; its presence is the AUTHORITATIVE inert gate that holds the run permanently out of dispatch, concurrency capacity, and the crash sweep (dispatch keys on this marker, not on the also-null `cwd`). |
| `schedules` | Recurring-run primitive. | `(workflow_ref, cwd, interval_ms)` + the `next_fire_at` cursor; the dispatcher fires rows where `next_fire_at <= now AND paused_at IS NULL` once per minute, then advances `next_fire_at` anchored to actual fire time. `workflow_ref` is a name/path string (NOT a sha) so resolution at fire time survives workflow edits; an unresolvable ref records `fact.schedule_invalid_workflow` and auto-pauses. `overlap_policy` enum CHECK; `last_run_id` / `run_state.schedule_id` are informational (no FK — schedule deletion is hard DELETE while runs persist). `idx_schedules_due WHERE paused_at IS NULL` + cwd / project_id indexes. |
| `provider_credentials` | Built-in pi-ai provider credentials, one row per provider id. | PK `provider`; `payload` is the full `AuthCredential` JSON; `kind` denormalises `payload.type` for post-mortem SELECTs. No indexes (<20 rows; PK is the only access pattern). The agent's `SqliteAuthStorageBackend` rebuilds the in-memory blob on read and applies a returned `next` blob by full-replace. |
| `provider_config` | Custom-provider definitions, one row per provider id. | PK `provider`; `config` is the `ProviderConfigSchema` body (`baseUrl`/`headers`/`compat`/`models`/`modelOverrides`) minus `apiKey` (credentials always come from `provider_credentials`). Per-row Ajv validation in the agent layer skips one corrupt row without poisoning siblings; no SQL CHECK on `api`/`provider` shape since pi-ai's types are extensible. |
| `mcp_oauth` | Remote (HTTP) MCP server OAuth state — one row per MCP server URL. | PK `url`; `payload` is an opaque JSON blob (OAuth client registration + token set) round-tripped verbatim — the store never models its internal shape. Secret-bearing and excluded from run bundles exactly like `provider_credentials`. `json_valid` CHECK ensures the column is always well-formed JSON. No indexes (PK is the only access pattern). Written and read by `@fragua/workspace/src/mcp/oauth.ts` via the store-backed OAuth provider bridge. |
| `outputs` | Structured-step-outputs index, rebuildable from `fact.node_completed.payload.outputs`. | PK `(run_id, node_id, iteration)`; `INSERT OR REPLACE` gives last-write-wins for re-entrant nodes; `struct` JSON validated at write, bounded by the 4 KB cap. OFF the `run_state` fold — the reducer never reads it; it is a re-snapshot. `idx_outputs_run`. |

**Size targets:**
- `run_state` row: ~500 bytes; thousands of rows negligible.
- `events` row: ~300 bytes; partial indexes small.
- `messages` rows: < 1,048,576 characters per row (enforced; large values spill through `ctx.artifacts.put`).
- `blobs` row: ~100 bytes (metadata only). Content files up to 16 MiB apiece live under `blobsDir`.

### 2.1 `run_state.routing` — flat dotted bytes, typed read surface, fold-rebuildable

`routing` is a flat, dotted JSON dict carrying load-bearing per-run state: the typed run inputs under `inputs` (with `$fragua_blob` spill refs, §0), the fan-out frontier under `internal.active_nodes` (I11), operator budget overrides under `budget_override.<scope>.<metric>`, retry/pacing counters (`internal.retry_count.<nodeId>`, `internal.timeout_retries.<nodeId>`, `internal.provider_retry.attempt`), and the auto-wake timer `internal.auto_resume_at`. The on-disk serialization is unschematized — there is no per-key column schema. The 8 KB size CHECK (I6) is a defense-in-depth tripwire (it catches a payload leaking into a variable-length namespace), not a budget the code is designed against — reads go through bounded, typed accessors. That shape is deliberate; the trust model:

**Typed-routing contract (read surface).** The on-disk bytes stay flat + dotted; namespaces are a *typed view*, not a reshape (docs/proposals/typed-routing-struct.md §6). This is deliberate, not a migration dodge: the column has no struct to be lifted to, because its load-bearing keys are *dynamic* — keyed by runtime values (`internal.retry_count.<nodeId>`, `budget_override.<scope>.<metric>`, `goal_gates.<nodeId>`, `max_retries_override.<nodeId>`). A map keyed by arbitrary node ids is intrinsically an open string-keyed record; the struct-shaped thing is the *decoded* namespaced view (`inputs` / `frontier` / `budget` / `retry` / `goalGate` / `limits` / `timer` / `context`), and that view is what gets typed. A single accessor module (`packages/core/src/routing.ts`) is the source of truth for the dotted-key vocabulary (the key constants / builders) and the READ surface: eight validate-and-degrade accessors (`getInputs`, `getFrontier`, `getBudget`, `getRetry`, `getGoalGate`, `getLimits`, `getTimer`, `getContext`) that fold each family of dynamic keys into a typed lookup (`getRetry(routing).count(nodeId)`, `getBudget(routing).override(scope, metric)`) — the accessors, plus the documentary `RoutingStruct` schema, *are* the lift. Each generalises a former ad-hoc inline cast and degrades to the conservative authored default — never pausing — so a mis-folded key or a tampered import bundle yields a safe default, never a wrong dispatch decision (budget override → the lower authored cap; frontier → no fan-out; counters → 0). Retyping the view needs no `EVENT_CONTRACT_VERSION` bump and no schema migration — and not as cost-avoidance: `routing` is a `run_state` projection, not an emitted event payload, so the fold-all-versions rule (ground rule 11, which governs the append-only log) does not govern its in-memory type; the bytes don't move and, because routing only ever grows additively, every historical blob reads identically. A discipline lint bans raw `routing[…]` indexing outside the accessor module (the one sanctioned exception beyond the reducer's frontier write).

**Trust model.** `routing` is a projection cache, not a second source of truth. It is written only inside the same transaction as an event append (I1), through exactly two seams: the reducer fold (`reducers.ts` — the genesis `intent.run_enqueued` seeds `inputs`, facts evolve `internal.active_nodes` via the relocated `getFrontier`) and the `routingPatch` option on `appendFact` (the daemon materializing applied intents and retry/abort bookkeeping into the projection it just evolved, through the key-wise spread). There is no out-of-band writer — the web/CLI write plane only appends intents; the single daemon writer is the only process that folds them into `routing`. Validation runs on READ, in the accessors, never in the write txn (I1) — the txn body stays pure SQL + the key-wise spread, with no TypeBox `Check`/`Compile` reachable from `writeTxn`. The accessors are exactly the typed form of the prior casts, so a pre-wrapper run's flat dotted bytes read identically and legacy runs never brick.

**Rebuild path.** Corruption is recoverable, not load-bearing: the whole `run_state` row, `routing` included, is disposable. `deriveRunState` (`packages/store/src/reducers.ts`) reconstructs it by replaying the run's event log — genesis seed + pure fact fold — and bundle import does exactly this on every import (bundles carry no projection). The fan-out property suite (P28) asserts replay-equivalence for the fold-derived keys. The `routingPatch` keys (budget overrides, retry counters, the auto-resume timer) are operational pacing state rather than fold outputs; the pure fold does not re-materialize them, but their provenance stays in the log — the `intent.budget_adjusted` / abort facts that produced them are recorded. Nothing lives *only* in `routing`.

**Why not normalize.** Promoting these keys into typed columns or side tables was considered and rejected. The key set is small, heterogeneous, and churns with engine features — the fan-out frontier and the provider-retry counter both landed without a schema migration precisely because `routing` absorbed them. A column or table per key would mean a DB migration per engine feature and multi-table writes for what is cache state. The size CHECK (I6) plus the blob-spill path (§0) keeps the dict bounded, and the event log — not the dict — remains the thing that must be correct.

---

## 3. Event taxonomy

### Intent events (writer: `client`, no OCC)
| Type | Payload fields | Semantics |
|---|---|---|
| `intent.run_enqueued` | `workflowSha`, `priority?`, `projectId`, `projectName`, `routing`, `contractVersion`, `workflowName?`, `workflowScope?`, `workflowPath?`, `scheduleId?` | Queue a new run |
| `intent.steering_requested` | `text: string` | Abort current node; inject steering before re-entry |
| `intent.pause_requested` | — | Abort current node; transition to `paused` |
| `intent.cancel_requested` | `reason?` | Abort current node; transition to `cancelled` |
| `intent.human_input` | `route: string`, `note?: string` | Wake a `paused_human` run; `route` is one of the node's declared `routes=` names chosen by the operator |
| `intent.resume` | `note?: string` | Generic wake for any `paused_*` run; re-dispatches the same `(nodeId, iteration)` |
| `intent.unquarantine` | `resolution: 'treat_as_done'\|'retry'\|'cancel'`, `note?: string` | Operator acknowledgement for a quarantined run |
| `intent.priority_adjusted` | `newPriority: number`, `note?: string` | Operator bump |
| `intent.budget_adjusted` | `scope: 'node'\|'run'`, `metric: 'cost'\|'tokens'`, `newLimit: number` (>0), `note?: string` | Operator raises a budget ceiling on a `paused{reason:'budget'}` run; folded into `routing.budget_override.<scope>.<metric>` so the next turn-boundary budget check uses the new ceiling. Web bundles a follow-up `intent.resume` ("Raise & Resume"); intents stay separate at the protocol level |
| `intent.max_retries_adjusted` | `nodeId: string`, `newLimit: number` (>0), `note?: string` | Operator raises a node's `max_retries` cap on a `paused{reason:'max_retries'}` run; folded into `routing.max_retries_override.<nodeId>`. Stage 3 of recoverable-budget-pause.md |
| `intent.goal_gate_adjusted` | `newLimit: number` (>0), `note?: string` | Operator raises the failing gate's retarget cap on a `paused{reason:'goal_gate'}` run; folded into `routing.max_goal_gate_retries_override` (takes precedence over the gate's `max_retries`) |
| `intent.max_loops_adjusted` | `newLimit: number` (>0), `note?: string` | Operator raises the per-run dispatch ceiling on a `paused{reason:'max_loops'}` run; folded into `routing.max_loops_override` |
| `intent.accept_run` | `sha`, `replayed: number`, `tailStaged: boolean` | Records a completed accept: the request path (server route / CLI) already replayed the run's commits onto the operator's HEAD + staged the tail **synchronously**; this intent carries the result and is folded into `fact.run_accepted`. Inbox `pending → acted` |
| `intent.discard_run` | `refs: string[]` | Records a completed discard: the request path already deleted `refs/fragua/{snapshots,heads}/<runId>`; this intent carries the deleted refs and is folded into `fact.run_discarded`. Inbox `pending → discarded` (terminal-terminal) |

Post-terminal operator actions run **synchronously in the caller** (intent-plane §3.7): the git executes via `@fragua/workspace`'s shared `applyAccept`/`applyDiscard` — the CLI runs it directly (store-client), the Web UI via the `POST /runs/:id/{accept,discard}` route — with the state gate (terminal / in-inbox / has-worktree) folded into that one action, so a conflict / dirty tree / bad-state refusal surfaces immediately (CLI exit code, HTTP 4xx) and writes nothing. On success the result is recorded as the intent above **through the intent plane**; the daemon's `processOperatorActions` sweep then **projects** it into its `fact.run_*` (OCC lockstep with `inbox_status`) — no second git run. This keeps facts daemon-written while the operator's experience is synchronous.

### Fact events (writer: `daemon`, OCC-checked)
| Type | Payload fields | Semantics |
|---|---|---|
| `fact.run_started` | `workflowSha`, `contractVersion`, `startNode`, `baseGitSha?`, `baseGitRef?` | Run enters `running`. `baseGitRef` is the source repo's branch at provision — the post-run merge/commit target default |
| `fact.dispatch_started` | `nodeId`, `iteration`, `pass?`, `resumeOf: 'fresh'\|'crash'\|'paused'\|'paused_human'\|'paused_auto'\|'quarantined'` | Stamps `dispatchStartedAt` for activeMs accounting; lets analytics distinguish "ran straight through" from "had to be woken up" |
| `fact.node_started` | `nodeId`, `iteration`, `pass?` | Node dispatched. `pass?` (here and on the other lifecycle facts) is the goal-gate re-entry epoch — `goal_gates.__retries` at dispatch, omitted when 0; a retarget pass resets per-node retry counters, so `(nodeId, iteration)` alone collides across passes |
| `fact.node_completed` | `nodeId`, `iteration`, `pass?`, `tokens`, `costUsd`, `inputCostUsd?`, `outputCostUsd?`, `cacheReadCostUsd?`, `cacheWriteCostUsd?`, `inputTokens?`, `outputTokens?`, `cacheReadTokens?`, `cacheWriteTokens?`, `modelName?`, `nextNode`, `outcomeStatus?: 'success'\|'fail'\|'retry'`, `route?: string` (present iff the source node declared `routes=` and the llm agent exited via the synthesised `route` tool), `outputs?: Record<string, unknown>` (present iff the node declared `outputs:` and emitted a value via `emit_output`; written to the `outputs` index table in the same transaction) | Node succeeded. Cost / token splits are optional for back-compat; the run-level reducer defaults missing fields to 0. The four-bucket cost split (`inputCostUsd` / `outputCostUsd` / `cacheReadCostUsd` / `cacheWriteCostUsd`) sums to `costUsd` for llm handlers; tool / human handlers leave them unset. `outcomeStatus` lets the UI distinguish "completed OK" from "completed with outcome=fail" without walking edges |
| `fact.node_aborted` | `nodeId`, `iteration`, `pass?`, `cause`, `partialTokens`, `partialCostUsd`, `partialInputCostUsd?`, `partialOutputCostUsd?`, `partialCacheReadCostUsd?`, `partialCacheWriteCostUsd?`, `partialInputTokens?`, `partialOutputTokens?`, `partialCacheReadTokens?`, `partialCacheWriteTokens?` | Mid-flight abort. Partial cost / token splits cover work done before the abort; optional for back-compat with pre-split runs. Under a `parallel` region a branch sub-node aborts here (operator pause / shutdown / abort-loop / per-branch backstop) and **stays in the active set** (the reducer's `node_aborted` is a no-op on the set), so it re-dispatches next turn via a fresh `fact.dispatch_started{resumeOf:"paused"}` |
| `fact.fanout_started` | `nodeId` (the `parallel` node), `iteration`, `pass?`, `branches: string[]` | A `parallel` region opened: seeds the active set (`routing["internal.active_nodes"]`) with the branch entry sub-nodes. The live frontier is a pure fold of this fact plus each branch's `dispatch_started` / `node_completed` / `node_aborted` |
| `fact.fanout_joined` | `nodeId`, `iteration`, `pass?`, `nextNode` (the join), `branchesCompleted: number` | All branches reached the `wait_all` barrier (active set drained to empty), so `current_node` advances to the join. One per region completion |
| `fact.intents_folded` | `intentSeq`, `folded` | Operator intents (steer / hitl / priority / pause) merged into routing/messages by the fold |
| `fact.side_effect_intent` | `nodeId`, `iteration`, `toolName`, `argsHash`, `attempt`, `idempotencyKey` | External tool about to run |
| `fact.side_effect_done` | `idempotencyKey`, `artifactKey`, `tokens?`, `costUsd?` | External tool completed |
| `fact.side_effect_failed` | `idempotencyKey`, `errorCode`, `retriable: bool` | External tool failed cleanly |
| `fact.tool_completed` | `toolName`, `argsHash`, `artifactKey`, `preview`, `summary?` | Non-external tool result |
| `fact.message_appended` | `ordinal`, `role`, `nodeId: string\|null`, `iteration` | Message metadata. `nodeId` is null for messages appended outside a node turn (e.g. seed messages) |
| `fact.run_paused` | `reason: 'human'\|'operator'\|'provider_error'\|'payment_required'\|'budget'\|'provider_retry'\|'handler_retry'\|'timeout_retry'\|'max_retries'\|'goal_gate'\|'max_loops'\|'abort_loop'\|'provider_exhausted'\|'engine_incompatible'`, plus reason-specific fields. **HITL arm** (status `paused_human`): `human` (`nodeId`, `text`, `routes: string[]`, `routeLabels?: Record<string, string>`, `snapshot?`) — yielded for human input on a workflow `kind=human` node; `routes` is the closed enum of route names declared on the source node (one button per route in the web UI; button label comes from the matching outgoing edge's `label=` override in `routeLabels`, falling back to `humanize(route)`); `snapshot` embeds the worktree diff for the operator's first paint, absent for bare-cwd runs. Operator-resumable arms (status `paused`): `operator` (`nodeId`), `provider_error` (`nodeId`, `httpStatus`, `provider`, `errorMessage`), `payment_required` (`nodeId`, `provider`, `errorMessage`), `budget` (`nodeId`, `scope`, `metric`, `limit`, `actual`), `max_retries` (`nodeId`, `currentLimit`, `attempts`), `goal_gate` (`gateNodeId`, `currentLimit`), `max_loops` (`currentLimit`, `dispatches`), `abort_loop` (`nodeId`, `consecutiveAborts`), `provider_exhausted` (`nodeId`, `attempts`, `cumulativeMs`), `engine_incompatible` (`pinnedVersion`, `supportedMin`, `supportedMax` — arm inferred: too-new if `pinnedVersion > supportedMax`, else too-old). Auto-wake arms (status `paused_auto`): `provider_retry` (`nodeId`, `httpStatus`, `provider`, `errorMessage`, `attempt`, `resumeAt`), `handler_retry` (`nodeId`, `attempt`, `delayMs`, `resumeAt`, `maxRetries`), `timeout_retry` (`nodeId`, `attempt`, `delayMs`, `resumeAt`, `maxAttempts`, `attemptedMs`). | Unified pause fact (fact-taxonomy.md §3.2). Status follows reason 1:1: `human` → `paused_human` (a workflow question, answered via `intent.human_input`); reasons in `AUTO_WAKE_PAUSE_REASONS` (`provider_retry`, `handler_retry`, `timeout_retry`) → `paused_auto` (wake-pending sweep auto-resumes at `resumeAt`); everything else → `paused` (operator must `intent.resume`, optionally preceded by a cap-adjustment intent: `intent.budget_adjusted`, `intent.max_retries_adjusted`, `intent.goal_gate_adjusted`, `intent.max_loops_adjusted`). The cross-engine `signal` reason value (external wait) is NOT emitted yet (fact-taxonomy.md §6.2). `timeout_retry` re-categorises a watchdog `maxMs` overrun as system-initiated pause-retry — partial-spend metrics still accrue via a paired `fact.node_aborted{cause:"timeout"}` |
| `fact.provider_retry_attempted` | `nodeId`, `attempt`, `httpStatus: number\|null`, `delayMs` | One per attempt in an auto-retry chain — separate fact rather than mutated payload preserves I3 (fact immutability) |
| `fact.run_resumed` | `fromStatus: RunStatus`, `inputIntentSeq?` | Left a paused/quarantined state |
| `fact.run_terminated` | `status: 'completed'\|'errored'\|'aborted'` discriminant. **completed**: `finalNode`. **errored**: `reason: 'budget'\|'error'\|'aborted_exit'\|'occ_exhausted'\|'timeout_exhausted'\|'route_not_picked'\|'route_call_not_isolated'\|'edge_no_match'\|'worktree_error'`, `detail?`, `occContext?` (set when reason="occ_exhausted"), `nodeId?` + `partialTokens?`/`partialCostUsd?` (+ optional per-bucket token/cost splits, set when the halt terminated a turn whose spend never reached `fact.node_completed`/`fact.node_aborted` — the reducer folds them into `run_state.metrics`, mirroring `fact.node_aborted.partial*`). **aborted**: `intentSeq`. | Unified terminal fact (fact-taxonomy.md §3.1) — one per run. The reducer projects `run_state.status`: `completed` → `completed` (sets `currentNode=finalNode`), `errored` → `halted`, `aborted` → `cancelled`. The errored `reason` set is genuinely-terminal only; operator-recoverable failure modes (`max_loops`, `abort_loop`, `goal_gate`, `max_retries`, `provider_exhausted`, and version mismatch via `engine_incompatible`) are `fact.run_paused` reasons instead. `timeout_exhausted` lands when the per-`(nodeId)` watchdog-retry counter saturates (default 3 attempts) — see `paused_auto{reason:"timeout_retry"}` for the recoverable side. The three `route_*` reasons land when a routing node fails to commit a route via the synthesised `route` tool or chose a route the graph doesn't handle. |
| `fact.snapshot_recorded` | `eventIdx`, `treeSha`, `commitSha`, `parentSnap`, `headSha`, `headRef`, `diffBaseSha`, `committed`, `uncommitted` | Terminal worktree snapshot. Once per worktree-backed run, after the terminal status fact. Reducer projects `change_stat` / `inbox_status` / `final_*`. Per-step + HITL snapshots are the `snapshot.captured` observability event, not facts. |
| `fact.run_quarantined` | `reason: 'orphan_side_effect'\|'other'`, `orphanedIntents?: seq[]` | Awaiting operator |
| `fact.run_requeued_after_crash` | `prevNode?`, `lastAliveAt?` | Startup sweep requeued. `lastAliveAt` is the dying daemon's last heartbeat — reducer credits `lastAliveAt − dispatchStartedAt` to `activeMs` |
| `fact.handler_timeout_leaked` | `nodeId`, `leakedAt` | Accounting truth |
| `fact.daemon_takeover` | `reclaimedFrom: pid`, `at: ts` | Lock reclaim |
| `fact.run_accepted` | `sha`, `replayed: number`, `tailStaged: boolean` | Daemon-folded from `intent.accept_run`: replayed the run's commits onto the operator's current branch and staged the uncommitted tail. Sets `run_state.accepted_sha`; inbox `pending → acted`. |
| `fact.run_discarded` | `refs: string[]` | Operator (`intent.discard_run`): deleted the run's `refs/fragua/{snapshots,heads}/<id>`. Inbox `pending → discarded` (terminal-terminal). |

All payloads ≤ 4KB. Content references are `artifactKey`.

### Observability events (writer: `daemon`, no OCC)

Anything emitted via `ctx.emit` from a handler — `agent.message_start/end`, `llm.text_delta`, `llm.thinking_delta`, `llm.toolcall_delta`, `cost.recorded`, `tool.execution_start/end`, `intent.dropped`, `budget.warn` / `budget.stop`, etc. Best-effort streaming telemetry, not transactional bundle: no version bump, no decision logic reads them, consumers are SSE tails and projections. Events land in the same `seq` space as facts.

The executor flushes the in-handler buffer to the store on a soft 50ms timer or when 64 events accumulate, whichever first, so the conversation view streams mid-LLM-call. The handler's tail (`edge.selected`, post-handler budget warnings) is drained synchronously before the terminal `fact.node_*` so consumers see the trail in causal order.

`snapshot.captured` (payload: `SnapshotCapturedData` — `runId`, `eventIdx`, `nodeId`, `treeSha`, `commitSha`, `parentSnap`, `headSha`, optional `headRef` / `diffBaseSha` / `committed` / `uncommitted`) is the executor-emitted per-step + HITL worktree snapshot, feeding the Diff scrubber. Delta-suppressed (no event when the tree is unchanged on a step boundary). The terminal snapshot is the OCC-checked `fact.snapshot_recorded`, not this.

`llm.start.skills[]` carries one `SkillCatalogRecord` (see `packages/types/src/skills.ts`) per skill the model saw on this call. Each record includes `name`, `location`, `sha256`, `bytes`, `scope`, `source_dir`, optional `compatibility`, and — for `scope === "project"` — `project_cwd` so replay can correlate which project's skills were active for this run after per-run filtering at llm dispatch.

### Daemon events (writer: `daemon`, separate `daemon_events` table)

Process-lifecycle and infrastructure events. Persisted in the dedicated `daemon_events` table — disjoint from the per-run `seq` space because many entries are global (no run scope) and they must not interleave into the per-run reducer's projection. Same 4 KB payload cap as fact events.

| Type | Payload fields | Semantics |
|---|---|---|
| `daemon.started` | `pid`, `hostname` | Daemon acquired the lock and started the executor |
| `daemon.stopped` | `pid`, `reason: 'clean'\|'leak_limit'\|'signal'\|'error'`, `detail?`, `leaked?: {runId, nodeId}[]` | Daemon exiting; emitted before lock release. `leaked` carries the handler-leak sites (leak order, producer-capped) when `reason='leak_limit'`. `fragua doctor` reads the newest `daemon.started`/`daemon.stopped` row to print a "last exit:" line when no live daemon holds the lock — a `daemon.started` with no later stop means the prior daemon crashed hard |
| `daemon.reaper_took_over` | `priorPid`, `priorHostname`, `priorHeartbeatAt`, `staleForMs` | Lock TTL exceeded; this daemon force-acquired |
| `daemon.sweep_completed` | `requeued: number`, `quarantined: number`, `durationMs` | Startup sweep finished |
| `daemon.sweep_run_failed` | `runId`, `error: string` | A single run's startup-sweep mutation threw (corrupt/missing `run_state` row); its savepoint was rolled back and the sweep continued. One poisoned row can't abort the sweep or crash-loop the daemon at boot |
| `daemon.blob_gc_completed` | `deleted: number`, `durationMs` | Orphan-blob GC sweep finished |
| `daemon.blob_gc_failed` | `reason: string`, `durationMs` | Orphan-blob GC sweep threw (permission error, race, …); loop survives. Leaves a queryable trace instead of stderr-only |
| `daemon.leak_detected` | `runId`, `nodeId`, `count`, `ceiling` | A handler leaked past `maxMs + leakGrace`; per-process counter advanced. Only fires for nodes with a numeric `HandlerSpec.maxMs` — unbounded llm (`max_ms=0`) skips the watchdog. |
| `daemon.worktree_provisioned` | `runId`, `ok: boolean`, `errorDetail?` | Provisioner result; `ok: false` records why a run halted at provision time |
| `intent.schedule_create` | `scheduleId`, `workflowRef`, `cwd`, `intervalMs`, `intervalText`, `title?`, `overlapPolicy`, `fireOnCreate` | Operator created a schedule (writer: web/CLI). Audit only — the row in `schedules` is the canonical state |
| `intent.schedule_pause` | `scheduleId` | Operator paused a schedule |
| `intent.schedule_resume` | `scheduleId` | Operator resumed a schedule (no catch-up: `next_fire_at = now + interval_ms`) |
| `intent.schedule_delete` | `scheduleId` | Operator hard-deleted a schedule |
| `fact.schedule_fired` | `scheduleId`, `runId` | Dispatcher enqueued a run for the schedule (also writes `run_id` on the row) |
| `fact.schedule_skipped` | `scheduleId`, `reason: 'overlap'\|'paused'` | Dispatcher skipped a due fire because the prior run is non-terminal under `overlap=skip` |
| `fact.schedule_late` | `scheduleId`, `missedIntervals`, `lastTargetAt` | Emitted *before* the catch-up fire when ≥1 slot was missed; one fire per resume window per proposal §Catch-up policy |
| `fact.schedule_invalid_workflow` | `scheduleId`, `error` | Workflow ref failed to resolve / parse / validate; schedule auto-paused |

Schedule events ride `daemon_events` (not the per-run `events` table) because the dispatcher writes them outside any one run's lifecycle: `intent.schedule_create` arrives before any run exists, `fact.schedule_skipped` may not produce a run at all, and `fact.schedule_fired` carries the new run id on the row's `run_id` column for join-back. The `schedules` table itself is the canonical state; the events here are a queryable audit log.

`run_id` on the row is set for run-scoped daemon events (leak_detected, worktree_provisioned, fact.schedule_fired); global lifecycle / sweep / GC events leave it NULL.

---

## 4. Store interfaces

The store contract is segregated into four sub-interfaces along the
fault lines that actually matter (write vs read, run-state vs analytics
vs daemon coordination). `IEventStore` is preserved as a composite
type alias so existing callers don't break, but new code should depend
on the narrowest interface that fits its needs — analytics routes need
`IAnalyticsReader`, the supervisor needs `IDaemonCoordinator`, the
daemon executor needs the full set.

`SqliteStore` implements all four in a single class today. Splitting
them by surface is **necessary but not sufficient** for any future
shared or out-of-process backing — say, the reader interface fronted by
a Postgres replica or the analytics one by DuckDB. It removes one
blocker (a backing could vary per surface without disturbing the
writer), but it does **not** make such a backing reachable today: the
binding constraint is that all four interfaces are **synchronous**
(matching `bun:sqlite`), and a networked store is inherently async.
Reaching a shared backing would require async-ifying every method and
every callsite — a structural change this segregation does not perform.
SPEC §5 is authoritative here: multi-machine / shared deployment is out
of scope by design, and this split is groundwork, not a drop-in seam.
See §12.

The composite `IEventStore` is preserved as `IEventWriter & IEventReader & IAnalyticsReader & IDaemonCoordinator` in `packages/store/src/types.ts`, where every method signature is authoritative.

### 4.1 IEventWriter

The single-transaction mutation surface (shares the SQLite writer connection, runs under `BEGIN IMMEDIATE`): event-log appends (`appendFact` OCC-checked against `run_state.version`, `appendIntent` always-appendable, observability events outside OCC), run-lifecycle mutations (`enqueueRun`, the atomic OCC-protected `claimNextRun`, `startupSweep`, `setRunTitle`), message + artifact writes (`appendMessage` with opt-in dedup, `putArtifact` scoped + replace-guarded), workflow save, and maintenance (`vacuum`, `gcBlobs`, `close`). See `packages/store/src/types.ts`.

### 4.2 IEventReader

Read-only run-level reads — run state + enumeration (`getState`, `listRunIds`, `listRunSummaryRows`, `runStateCounts`), the event log (per-run, by-type, snapshot-scrubber feed, the three global-feed cursor variants, unapplied intents), messages (full + the narrow wire shape + thread listing), per-run cost/step aggregates, the outputs index, raw blob reads, scoped artifact reads, and the workflow catalog + emergent-paths project/cwd listings. Includes the daemon's wake-pending sweep helpers (`getWakeCandidates`, `getNextPendingIntent`, `findOrphanSideEffects`, `getInboxActionCandidates`, `getGcEligibleSnapshotRuns`) so the daemon never reaches for `db` directly. See `packages/store/src/types.ts`.

### 4.3 IAnalyticsReader

Dashboard aggregations — `enqueued_at`-anchored windows, bucketed time
series, distributions, drilldown. Distinct from `IEventReader` because
the queries are more expensive (window functions, `json_each` pivots,
multi-row aggregations) and warrant their own connection tuning when
we eventually split workloads — a fat `cache_size` and consistent-read
transactions are appropriate here in a way they aren't on the hot
event-log path.

The methods cover KPI totals over an `enqueued_at`-anchored window, the bucketed time series (runs / spend / tokens / cache by bucket), distributions (halt-reason, model), top workflows + the workflow directory, the first-run anchor, the cursor-paginated drilldown, and the global metrics totals + model breakdown. See `packages/store/src/types.ts`.

### 4.4 IDaemonCoordinator

The `daemon_events` and `daemon_lock` surface — orthogonal to the rest
because no transaction overlaps with run state; the tables are
independent. This is the cleanest interface to extract first if you
ever want a separate process holding the daemon lock.

It covers the `daemon_events` append/read, the `daemon_lock` lifecycle (`acquire` / `forceAcquire` TTL-reclaim / `heartbeat` / `release` / `currentDaemonLock`), and schedule CRUD + the two daemon-side advancers (`recordScheduleFire`, `recordScheduleSkipped`). See `packages/store/src/types.ts`.

Schedule methods are CRUD over the `schedules` table plus two
daemon-side advancers (`recordScheduleFire`, `recordScheduleSkipped`)
that the dispatcher fiber calls atomically inside its tick. They
bypass OCC because schedules don't ride the per-run reducer: a
schedule's only state transitions are paused/resumed/fired/deleted,
all single-row updates with no cross-table invariants. Audit rows live
on `daemon_events` (see §3).

### 4.5 Errors and shared types

`ArtifactScope` is `{ runId, nodeId, iteration, key }` and `ArtifactRef` extends it with `{ sha256, sizeBytes, mime }`. The store throws typed errors — `ConcurrencyError` (OCC conflict), `ArtifactCollisionError` (same-scope rewrite with differing content), `ArtifactTooLargeError`, `SchemaDriftError`, `QuarantineError`. These plus `SweepResult`, `EnqueueRunParams`, `GetEventsOpts`, `GetMessagesOpts`, `GetDaemonEventsOpts`, `NarrowMessage`, `StepAggregateRow`, `RunCostTotalsRow`, `Project`, the analytics row types, and the global-feed cursor option types all live in `packages/store/src/types.ts`. SQL strings are split per-table across `event-queries.ts`, `run-state-queries.ts`, `message-queries.ts`, `artifact-queries.ts`, `workflow-queries.ts`, `daemon-queries.ts`, and `analytics-queries.ts` — each file owns its table's reads + writes. A drift-lint checks the source interface files against their implementing class so the four sub-interfaces and `SqliteStore` can't disagree.

**Implementation notes:**
- All methods synchronous; `bun:sqlite` is sync.
- Every write wraps in `db.transaction(() => ...)()` or the
  equivalent `BEGIN IMMEDIATE` / `COMMIT` pair. `BEGIN IMMEDIATE` grabs
  the write lock up front; busy_timeout handles contention.
- No in-process commit-listener API. Same-process daemons could subscribe but the only consumer that would benefit (the supervisor) lives in the same process as the writer for `appendFact` and a different process for `appendIntent` (web → daemon), so an in-process listener can't cross the boundary that matters. The 50ms supervisor poll covers both directions uniformly. SSE consumers poll `events WHERE seq > ?` directly.

---

## 5. Handler contract

A Handler is a pure async function: given an immutable `HandlerContext`, produce a `HandlerResult`. `iteration` is the per-node retry counter and the side-effect envelope carries `idempotencyKey`. The authoritative shapes are `docs/handler-contract.md` (the contract) and `packages/core/src/handler/types.ts` (the types).

A `HandlerSpec` registers a node kind with its `sideEffect` class (`none` / `idempotent` / `external`), an optional `maxMs` watchdog (llm may opt out via `max-ms: 0`), and the handler fn.

`HandlerContext` is the immutable per-call surface that routes **all** I/O through `ctx` — no direct fetch, filesystem, DB, or process access. It carries run/node identity, the per-node `iteration` (0 on first entry, §3.6), the `signal` (`AbortSignal.any([steer, timeout, shutdown])`), the opaque `routing` dict, pre-wired `llm` / `http` clients (signal + accounting auto-propagated), a `tools` registry already narrowed by the node's `allowed_tools` / `denied_tools`, the `messages` append/read API (pi-agent-core `AgentMessage`, round-trips losslessly), the scope-aware `artifacts` API (`put`/`get`/`ref`/`getFrom`), `externalCall` (the idempotency-keyed external-tool helper, below), `emit` for observability events, the `args` substitution inputs, and optional `humanInput` / `steering` / `env` (per-run worktree, falls back to process cwd) / `budgetSnapshot` (cumulative spend vs ceilings).

`HandlerResult` is a discriminated union over `kind`:
- **`transition`** — the success path: optional `nextNode` (omit to let edge selection decide), `outcomeStatus` (`success`/`fail`/`retry`), an llm-set `route` on routing nodes, a single-line `failureReason` (surfaces as `fact.run_terminated{errored}.detail` on `fail → __end__`), the token/cost metrics with the optional four-bucket cost + token splits and `modelName`, and optional `outputs` (structured values from `emit_output`, llm steps only).
- **`yield_human`** — `text` + the declared `routes` (+ optional `routeLabels`) for a `kind=human` node.
- **`halt`** — a `reason` over the halt union + optional `detail`. Stage 3 of recoverable-budget-pause.md converts the operator-recoverable arms to pauses: `max_retries_exceeded` is emitted by the executor as `fact.run_paused{reason:"max_retries"}` directly (via the `retriesExhaustedPause` sentinel, not via this halt arm), while `goal_gate_unsatisfied` → `goal_gate` and `max_loops` → `max_loops` still translate at result-to-facts time (an optional `pauseContext` carries `currentLimit` + `attempts` so the pause reads "exhausted N of M"). Genuinely-terminal reasons (`aborted_exit`, `occ_exhausted`, `timeout_exhausted`) and the executor-only `abort_loop` / `provider_exhausted` are emitted directly by the executor; a version mismatch is a recoverable `fact.run_paused{reason:"engine_incompatible"}`, not a halt.
- **`pause_provider`** — a recoverable provider transport failure carrying `httpStatus` (null on pre-response network failures), `provider`, `errorMessage`, and an optional `retryAfterMs` (provider `Retry-After`, honoured exactly when set, otherwise full-jitter exponential).

`externalCall` is the canonical helper for `side_effect: "external"` tools. It:
1. Canonicalises `params.args` via `canonicalStringify` (sorted keys, rejects non-JSON-serialisable values) and hashes the result → `argsHash`.
2. Computes `idempotencyKey = sha256(runId + nodeId + iteration + argsHash + attempt)`.
3. Emits `fact.side_effect_intent` via the executor (not the handler directly).
4. Invokes `fn(idempotencyKey)`; `fn` passes the key to the provider as an idempotency header.
5. On success: emits `fact.side_effect_done`, returns result.
6. On `AbortError`: does NOT emit `done`; executor will see orphan on replay if we crashed here.
7. On clean failure: emits `fact.side_effect_failed`.

Handlers never compute `argsHash` themselves. The framework owns canonicalisation so structurally-equal args across replay boundaries produce a stable key regardless of how the handler built them.

### Enforced at review
- `no-restricted-imports`: `fetch`, `undici`, `fs`, `child_process` banned inside `handlers/`.
- AST rule: no `await`/`JSON.stringify` inside `.transaction(() => ...)` bodies.
- Handler PRs must: declare `sideEffect`, set `maxMs` (or document why omission is correct for llm-style handlers that self-bound via cost/tokens), include replay property test for external tools.

---

## 6. Daemon loop

The boot sequence (`daemonMain`): acquire the `daemon_lock` — if it's held but the heartbeat is older than `LOCK_TTL_MS`, TTL-reclaim it (`forceAcquireDaemonLock`), otherwise exit non-zero. Then, **before anything else**, run the startup sweep to heal crash damage (§1.4). Wire SIGTERM/SIGINT onto one shutdown `AbortController`, start the 50 ms supervisor fiber (heartbeat + intent detection + watchdog), and enter the executor loop. On exit, release the lock and close the store.

The executor loop (`runExecutor`) claims the next run (`claimNextRun(MAX_CONCURRENT_RUNS)`, sleeping 50 ms when the queue is empty) and dispatches each into `runOne` concurrently.

`runOne` is the per-run turn loop. It re-reads `run_state` each turn and returns on any terminal/paused/quarantined status (zombie-checking the lock on entry). It then checks the contract-version gate — an out-of-`[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` pin pauses with `engine_incompatible` and returns (§1.11). Otherwise it folds unapplied intents (`cancel` wins — commits the cancel fact and returns), builds the node's abort signal as `AbortSignal.any` of the steer controller ∪ shutdown ∪ (when `maxMs` is set) a timeout, dispatches the handler (bounded by a `maxMs + LEAK_GRACE_MS` race when applicable, unbounded for llm), maps the result (or a caught error) to facts, and appends them under OCC — retrying the turn on `ConcurrencyError`. See `packages/daemon/src/executor.ts`.

### 6.1 Executor module decomposition

`packages/daemon/src/executor.ts` is the orchestration entry point
(`runExecutor`, `runOne`, the `dispatchOne` turn loop) and the public
facade — call sites and tests import `runExecutor`, `runOne`,
`ExecutorOpts`, `makeLeakBudget`, and the re-exported `classifyAbortCause`
/ `buildSubstitutionArgs` / `resolveBackoff` from it. The behaviour-bearing
leaf logic lives in focused sibling modules, each owning one concern and
reaching only into the store API:

- `executor-helpers.ts` — pure, dependency-light helpers: abort
  classification, the leak-watchdog sentinel, routing/number/string
  coercers, the per-node retry-count reader (`internal.retry_count.<nodeId>`),
  resume-of derivation, budget routing readers + override keys, edge-selected
  observability, substitution-arg building, backoff / max-retries resolution,
  the routing-patch merge, and `sleep`. Unit-tested in isolation.
- `occ-append.ts` — `tryAppendFact` (the OCC append primitive, conflict →
  `false`) and `makeOccController` (the per-`runOne` conflict controller:
  warn at 2, halt with `occ_exhausted` at 3, with the halt append itself
  retried against fresh state).
- `snapshot-service.ts` — `captureBoundarySnapshot` (per-step / HITL Diff
  snapshots) and `disposeTerminalWorktree` (terminal snapshot then dispose,
  gated on the `fact.snapshot_recorded` append landing).

Event-store invariants are unchanged across the split: facts stay
OCC-checked, observability stays best-effort and reducer-free, and handler
I/O still routes through `ctx`.

### 6.2 Parallel fan-out execution

A `type: parallel` node hands control to `runFanout` (in `executor.ts`), which drives the whole region to its `wait_all` join before the outer `dispatchOne` loop advances. The model is an **on-log reactive frontier**, not a bulk-synchronous superstep:

- **The frontier is a fold of the log.** `fact.fanout_started` seeds the active set (`routing["internal.active_nodes"]`); each branch's `fact.node_completed` removes its node while a bundled `fact.dispatch_started` adds the successor; `fact.node_aborted` is a no-op on the set (the branch stays active to re-dispatch). The live frontier and a from-scratch `deriveRunState` fold therefore agree by construction — the active set is **diagnostic, derived, never an authority**; the scalar `run_state.status` is the lifecycle truth that claim / sweep / SSE read.
- **Reactive pool, not a batch.** Branches dispatch concurrently into a `Promise.race` pool; the instant one settles, its fact commits and its successor dispatches — a fast branch never waits on a slow sibling (no head-of-line blocking). This is why the **commit unit is the branch-step, not a superstep**: there is no per-superstep barrier, and the log is legitimately interleaved.
- **One writer, OCC intact.** Every branch commits through the single daemon writer's serialized lane (`commitFanoutFact`), re-reading the live `version` per attempt and retrying the *append* (never re-executing the handler) on a sibling-moved-version conflict. K concurrent branches are OCC-contention-free because only one writer ever commits; `fanout_joined` is the linearization point that closes the region. A commit that fails because the run left `running` (operator pause / cancel) is classified `status`, not OCC, so it never spuriously feeds the conflict counter.
- **Two-level recovery.** A mid-region stop recovers at two granularities. **Frontier-level:** a sub-node that already committed `node_completed` is gone from the active set, so recovery re-dispatches only the unfinished sub-nodes — no re-execution of completed work, and **no barrier is needed to know it**, because each branch's cursor *is* its position in the folded active set (so an asymmetric crash — branch A deep, branch B shallow — recovers each branch independently). **Transcript-level:** an interrupted sub-node rehydrates its own thread (`node:<id>#<iter>`) and continues from where it died, exactly like a linear node's resume (an abort does not bump the iteration).
- **Pause is run-global.** There is no per-branch pause seam (and none will be built until there is demand). The operator's pause / cancel — or a budget breach detected at any branch commit — trips the run's one shared `AbortSignal`, aborting every in-flight branch; on resume each branch re-enters from its logged checkpoint. A branch that hard-fails every turn trips a **per-branch** abort-loop ceiling (process-local, like the linear counter — it resets on restart; the durable backstops are the per-branch wall-clock timeout and the run budget). The supervisor's per-handler watchdog reclaims a leaked branch (one that ignores its signal) via `fact.handler_timeout_leaked`, and an early-terminal pool bail aborts the still-in-flight branches rather than leaving them burning cost.
- **Bounded routing.** The branch set is **static per run** — materialised at parse time, never grown during dispatch — and the frontier holds at most one node per branch. So a fan-out's `routing` footprint scales with the (static) branch width, not with runtime dispatch; realistic fan-outs sit far under I6 (`routing` < 8 KB), and the column CHECK enforces it at the seed `fanout_started` append. There is no *max*-branch validator bound today (only E036's ≥2 minimum), so a pathologically wide fan-out fails its seed loudly (`PayloadTooLargeError`) rather than corrupting — a latent validator gap to close if very wide fan-outs become real, not an active risk. A hypothetical dynamic ("fork N at runtime") variant would still materialise the full branch set at plan time, never stream branches during dispatch.

Well-formedness is checked at parse time (E036–E045): ≥2 distinct branch entries, disjoint closures (E044) each reaching the join (E039), branch nodes are read-class `llm` (E041 / E042 — no write tools, no nested `parallel` via E040, no explicit `thread` via E043), the join is a defined step (E038), and the serialized branch list fits the seed fact's event-payload budget (E045 — `fact.fanout_started` embeds it whole under the 4 KiB cap). The per-branch values the join reads are typed `outputs:` (§3.8), so the join's `${{ outputs.<branch>.<field> }}` reads fail closed when a branch never populated them. See `packages/daemon/src/executor.ts` (`runFanout`) and [`docs/proposals/fan-out-nodes.md`](proposals/fan-out-nodes.md).

---

### Credential storage

Built-in pi-ai provider credentials (api_key + OAuth tokens) live in
the `provider_credentials` table on the global store
(`~/.fragua/fragua.db`). The store is the only credential coordination
surface: the harness daemon, `fragua serve`, and `fragua providers`
share one view of which providers are credentialed, and OAuth refresh
is last-writer-wins under SQLite WAL rather than file-locked. Keys
are stored verbatim — no `!cmd` / env-var resolution anywhere in the
credential path.

### Custom-provider config storage

Custom-provider definitions (Ollama, vLLM, LM Studio, corporate
proxies, plus any built-in-provider overrides) live in the
`provider_config` table on the same global store. One row per
provider id; the JSON `config` blob carries the `ProviderConfigSchema`
body (`baseUrl`, `headers`, `compat`, `models`, `modelOverrides`)
minus the `apiKey` field — credentials always go through
`provider_credentials`. `ModelRegistry.loadCustomModels` Ajv-validates
each row on read; one corrupt row is skipped (surfaced via
`registry.getError()`) without poisoning sibling providers. The
`!cmd` / env-var resolver that previously backed the `apiKey` field
and header values (`packages/agent/src/credentials/resolve-config-value.ts`)
is deleted entirely; secrets that previously rode through that shim
live in `provider_credentials` plus `authHeader: true` instead. 

## 7. Web server

The server is a Hono HTTP + SSE surface **for the Web UI only** (the CLI is a direct store-client). Enqueue is `POST /runs`: it validates the body's typed `inputs` against the workflow's `inputs:` block (400 `invalid_inputs` on a missing required input or out-of-range choice), preflights provider-credential availability (400 `provider_unavailable`) and queued-run backpressure (429 `queue_full` with `Retry-After`, running runs bounded separately by the daemon's `maxConcurrentRuns`), then enqueues through the intent plane (`plane.buildEnqueue` → `commitEnqueue`, which coerces + folds `inputs` into `routing.inputs`) — adapters never call `store.enqueueRun` directly, since the plane is the single write surface the server, CLI, and schedule dispatcher share. The control-plane verbs are thin intent-writers — one POST per `intent.*` (`steer` / `pause` / `cancel` / `human` / `resume` / `unquarantine` / `priority` / `budget` / `max_retries` / `goal_gate` / `max_loops`), with bodies and effects tabulated in §3 and SPEC §3.5. Post-terminal `accept` / `discard` append operator-action intents the daemon folds, returning `{seq}` on success and surfacing state-gate refusals as 4xx (404 not_found · 409 not_terminal / not_in_inbox / discarded / no_worktree, etc.). Beyond that: read endpoints (`/events`, `/messages`, `/steps` as JSON, and `/stream` — the SSE that polls `events WHERE seq > cursor` and writes each frame with the type inside the JSON payload so the browser dispatches via one `message` listener), schedule CRUD (each mutation lands a `intent.schedule_*` audit row on `daemon_events`; bad interval/overlap → 400), skill discovery (read-only filesystem re-walks keyed by `base64url(skill_dir)`), and worktree-snapshot git reads (pure object-database `ls-tree` / `show` / `diff`, no checkouts). See `packages/server/src/`.

No IPC. No daemon dependency for reads or intent writes. Polling is the whole story.

---

## 8. Queue fairness

**Rule.** Within a priority tier, FIFO on `ready_at`. `ready_at` is reset to `now()` on every transition INTO `queued` (initial enqueue, HITL wake, crash requeue, unquarantine-retry). Ties break by `run_id` (deterministic, seeded by ULID-like ordering). The claim query orders by `priority DESC, ready_at ASC, run_id ASC`; the SQL index (`idx_run_state_queue`) covers only the first two columns — `run_id ASC` is the tiebreaker in the ORDER BY clause, not in the index.

**Why this over alternatives:**

| Strategy | Behavior | Why rejected |
|---|---|---|
| Preserve original `enqueued_at` on resume | Long-paused runs jump to front on wake | Starves new submissions |
| Priority boost on HITL wake | Interactive runs preempt batch | Priority inversion; hogging |
| Round-robin per workflow | Fair across workflows | Complex; unclear within-workflow |
| **FIFO on `ready_at`** | Everyone queues fresh on transition | Simple; predictable; no starvation at single-machine scale |

**Scenario — N priority-10 runs wake from HITL simultaneously:**
SQLite serializes the N `intent.human_input` commits; each human-resume transaction sets `ready_at = now()` inside the same txn. Even at ms-level clustering, SQL commit order gives each a distinct `ready_at`; ties break by `run_id`. The claim query (`priority DESC, ready_at ASC, run_id ASC`) pops them deterministically in commit order. No thundering herd.

**Not starvation-free in theory:** a relentless priority-11 stream starves priority-10. That's priority's point. If workflow-level fairness becomes a need, add `workflow_max_concurrent` per workflow (cheap partial-index count). Not needed day 1.

**Observability:**
- Derive `wait_time_ms = now() - ready_at` at read time; expose in UI.
- `intent.priority_adjusted` is the operator escape hatch if something starves.

**Edge — operator cancel mid-resume:**
Human-wake (`intent.human_input`) and `intent.cancel_requested` can arrive in either order. Both are intents, both non-OCC, both processed by the daemon supervisor's fold. The fold prioritizes `cancel` deterministically: if both present, run becomes `cancelled` regardless of order. Documented in fold semantics.

---

## 9. Size bounds

| Name | Value | Enforced by |
|---|---|---|
| `MAX_EVENT_PAYLOAD_BYTES` | 4096 | `events.payload CHECK (length(...) < N)` + store pre-check (`s.length >= N`) |
| `MAX_ROUTING_BYTES` | 8192 | `run_state.routing CHECK (length(...) < N)` + store pre-check |
| `MAX_BLOB_BYTES` | 16 * 1024 * 1024 | Store module; throws `ArtifactTooLargeError` (gated on `Uint8Array.byteLength > N`) |
| `MAX_MESSAGE_CONTENT_BYTES` | 1024 * 1024 | `messages.content CHECK (length(...) < N)` + store pre-check throws `MessageTooLargeError` |
| `MAX_PREVIEW_CHARS` | 512 | Handler convention |

**Limit semantics:** for the four `<` CHECKs, the largest value that lands
successfully is `N - 1`; the constant is the *first rejected size*. Pre-flight
checks use the same `>=` shape, so JS code and SQL agree on rejection
threshold. `MAX_BLOB_BYTES` is the only inclusive cap (`> N` rejects).

**Unit caveat:** JS `string.length` is UTF-16 code units; SQLite `length()`
on TEXT is Unicode code-point count. They agree on BMP characters and diverge
by up to 2× on surrogate-pair-heavy content. The pre-flight check is the
binding constraint in practice — it runs first and is stricter for non-BMP
content. `MAX_BLOB_BYTES` is the only honest-bytes constant.
| `MAX_CONCURRENT_RUNS` | 8 (configurable) | `claimNextRun` |
| `LOCK_TTL_MS` | 30000 | Daemon lock reclaim |
| `HEARTBEAT_INTERVAL_MS` | 5000 | Supervisor fiber |
| `SUPERVISOR_TICK_MS` | 50 | Supervisor fiber |
| `SSE_POLL_MS` | 100 | Web SSE handler |
| `LEAK_GRACE_MS` | 30000 | Hard timeout grace |
| `ABORT_LOOP_CEILING` | 5 | Executor → `fact.run_paused{reason:"abort_loop"}` (operator-resumable per Stage 3) |
| `MAX_LOOPS` | 1000 (configurable via `ExecutorOpts.maxLoops`; per-run override via `intent.max_loops_adjusted`) | Executor → `fact.run_paused{reason:"max_loops"}` (operator-resumable per Stage 3) |

---

## 10. Property-test matrix

Harness: `fast-check` with seed-reproducible runs. Clock injected. SQLite in-memory or tmp-file.

| # | Invariant | Generator | Assertion |
|---|---|---|---|
| P1 | Seq monotonic & contiguous per run | N fibers × K writes | `events.seq = 1..NK` contiguous; `run_state.next_seq` matches |
| P2 | OCC correctness | K fibers racing `appendFact(v=N)` | Exactly one succeeds; K-1 `ConcurrencyError` |
| P3 | Intent never lost | Intents interleaved with aborts | All submitted intents in `getEvents` |
| P4 | Projection = fold | Random event sequences | `getState` ≡ `events.reduce(reducer)` |
| P5 | Crash recovery requeue | Kill at random SQL boundary | Startup sweep requeues all `running`; no half-applied txn |
| P6 | Orphan quarantine | Kill between `intent` and `done` | Startup → run `quarantined`; no re-run |
| P7 | Unquarantine retry | `intent.unquarantine:retry` | Run resumes; tool re-executes with same `idempotencyKey` |
| P8 | Mid-flight abort → replay | Abort at random await points | `fact.node_aborted` present; next turn converges; external tool count ≤ 1 per `idempotencyKey` |
| P9 | Daemon singleton | Start two daemons | Second exits non-zero; lock unchanged |
| P10 | Concurrency bound | Enqueue 100 runs, `MAX=4` | `COUNT(status='running') ≤ 4` at every snapshot |
| P11 | HITL durability | Pause → kill → restart → input | Progresses from exact stop point |
| P12 | Event payload bound | 5KB payload attempt | Throws; no insert |
| P13 | Routing bound | 10KB routing attempt | Throws; projection unchanged |
| P14 | Blob dedup | Identical content twice | Single `blobs` row; two `artifacts` |
| P15 | Artifact loop scoping | Same node, 3 iterations, same key | 3 distinct `artifacts` rows; no PK violation |
| P16 | Blob GC | Delete run; sweep | Orphan blobs removed; shared blobs retained |
| P17 | Version-mismatch refusal | Resume with out-of-range pin | `RUN_PAUSED { reason: "engine_incompatible", pinnedVersion, supportedMin, supportedMax }` — recoverable, status `paused`; arm (too-new/too-old) inferred from the payload window |
| P18 | Zombie daemon commit | Force-acquire; original commits | Commit fails (OCC or lock check); original exits |
| P19 | SSE replay | Reconnect with `Last-Event-ID=N` | Receives `seq > N` in order |
| P20 | Abort loop ceiling | K>5 consecutive aborts, no progress | `fact.run_paused{reason:"abort_loop"}` (operator-resumable per Stage 3) |
| P21 | Queue fairness | N priority-10 HITL wakes | Claim order = commit order of `intent.human_input` |
| P22 | Cascade delete | Delete run_state row | events/messages/artifacts for that run all gone; blobs unchanged |
| P23 | STRICT enforcement | Insert string into integer column | Throws; no row inserted |
| P24 | Claim atomicity | K fibers racing `claimNextRun` | Each popped run claimed by exactly one fiber |
| P25 | Pre-commit recorder durability | `recordIntent` then no `recordDone` (simulated hard crash) | Intent fact in `events` before recorder returns; sweep quarantines without a matching done having ever existed |
| P26 | Artifact replay safety | Same-scope `putArtifact` calls with identical / differing content | Identical → no-op (existing ref); differing → `ArtifactCollisionError` unless `{ replace: true }`; only one row per scope |
| P27 | Intent fold truth table | Random batches of intents × all `RunStatus` values | Cancel always wins if present; pause coexists with steer/human as `shouldPauseAfterDispatch`; multi-instance human/priority last-wins; every intent ends up applied or in `dropped`; per-state preconditions enforced. See [`docs/intent-fold.md`](./intent-fold.md) |
| P28 | Fan-out replay-equivalence | ≥3 `parallel` branches, randomized per-branch settle latencies | `deriveRunState(log) ≡ live` under every commit interleaving; each branch runs once; `fanout_joined` exactly once |
| P29 | Fan-out crash recovery | Crash mid-region with asymmetric branch depth (A deep, B shallow) | Only uncommitted sub-nodes re-dispatch; a completed sub-node never re-runs; the region converges (no barrier required to re-derive per-branch cursors) |
| P30 | OCC on the fan-out seams | OCC storm on `fanout_started` / branch `node_completed`+`dispatch_started` / `fanout_joined` | Region still joins exactly once; P4 holds throughout; a status-stop never mis-counts as OCC |
| P31 | Per-branch liveness | A branch hangs / leaks / aborts every turn beside healthy siblings | Leak → `handler_timeout_leaked` + halt; abort-loop → per-branch `run_paused{abort_loop}` naming the branch; a fast branch commits without waiting on a slow one; an early bail aborts the in-flight pool |
| P32 | Fan-out frontier isolation | Populated `internal.active_nodes` × every fact type | Only `fanout_started` / `dispatch_started` / branch `node_completed` / `fanout_joined` may change the frontier; every other fact leaves it byte-identical; `applyFact` never mutates its input state (the routing shallow copy is load-bearing) |

The driven crash-replay and fault-injection (OCC-storm) harnesses generate `type: parallel` graphs alongside the linear spine, so P4 / P5 / P8 are exercised over fan-out, not just sequential runs.

---

## 11. Module layout

Dependency direction: `web → server → store ← daemon → core ← agent`. `store` is the SQLite event store (schema + pragmas + migrations + reducers + startup sweep); `core` holds the pure types, YAML parser, handler contract, engine reducers, and the shared write plane (`intent-plane`) + read plane (`read-plane`) both the server and CLI route through; `daemon` is the executor + supervisor + provisioner + recorder; `agent` is the pi-ai LLM backend and bridges; `workspace` provides the `ExecutionEnvironment` adapters, tools, and shared accept/discard/diff git; `server` is the Hono HTTP + SSE surface for the Web UI; `web` is the React dashboard (the only HTTP client); `cli` is a direct store-client (no HTTP). The authoritative per-package breakdown — entry points and what lives where — is the "Codebase map" table in [`AGENTS.md`](../AGENTS.md).


---

## 12. Deferred decisions

- **Blob encryption** for secret-bearing outputs — single-user local; deferred.
- **Cross-machine deployment** — single-machine by design (SPEC §5). `IEventStore` is synchronous (matches `bun:sqlite`); a shared/Postgres backing is inherently async, so it would require async-ifying the interface and every callsite. The §4 surface segregation removes one blocker (a backing can vary per surface) but not this one — the synchronous interface remains the binding constraint, so a shared instance is structurally foreclosed today, not a clean drop-in.
- **Retention policies** per workflow — manual `fragua prune` until demand.
- **Blob streaming** for >16MB — handler must chunk; revisit on real use case.
- **Auto-migration across schema bumps** — `migrate()` creates the baseline on a fresh DB and walks an existing store forward through the `SCHEMA_MIGRATIONS` step-delta map (`packages/store/src/migrations.ts`, keyed by target version) up to CURRENT; a store newer than the binary is refused. Each step carries an optional `down` inverse, so a downgrade is available as an explicit, backed-up operator action (`fragua db migrate --to <lower>` → `migrateTo`), never automatic.
- **Workflow hot-reload for in-flight runs** — not planned; `workflow_sha` pinned.
- **Per-workflow concurrency caps** — add when needed; easy via partial-index counts.

### 12.1 Handler coverage

Five handler kinds dispatch end-to-end through `auto-dispatcher.ts`:
`start`, `exit`, `llm`, `human`, `tool`. The pure reducers
behind them (`retry-policy.ts`, `edge-selection.ts`,
`external-call.ts`) are property-tested.

Read-only enforcement on review/observer nodes is structural at three
layers: (a) `ctx.tools` is narrowed via `ToolRegistry.select` before
the `HandlerContext` is built; (b) the llm backend re-applies
`select(...)` on its workspace registry before handing tools to pi-ai;
(c) `ctx.env` is wrapped in a read-only proxy when no mutating tool
(`bash` / `write` / `edit`) is visible, so `env.writeFile` /
`env.exec` throw `ReadOnlyEnvError` even for handlers that bypass the
tool registry.

Known gaps in coverage live as proposals in [`proposals/`](./proposals/) — see [`proposals/README.md`](./proposals/README.md) for the index.

---

## 13. Risks ranked

1. **Handler discipline drift** — #1 long-term risk. Structural lint + review gate mandatory. A single handler ignoring `AbortSignal` breaks invariants.
2. **Provider without idempotency support** — any external tool that can't accept a dedup key cannot be made safe; operator review is the only line of defense. Tag loudly.
3. **SQLite write throughput ceiling** — unknown until measured. Counter-based seq (1.5) + BEGIN IMMEDIATE + STRICT + partial indexes should be comfortable below 1000 writes/sec. Measure in M6.
4. **LLM provider abort leakage** — real and uncontrollable; `Promise.race` bounds; `handler_timeout_leaked` records truth.
5. **Mid-flight external tool double-execution** — provider idempotency keys + quarantine close the window; relies on (2).
6. **Schema drift for long-paused runs** — refusing to resume is safe but operationally annoying; acceptable v1.

---

## 14. What this architecture buys

- **One coordination surface.** All races resolve in SQLite; nothing in the filesystem; no unix sockets.
- **Zero-cost pause snapshots.** Projection always current; pausing = emitting an event.
- **Deterministic property tests.** Seed-reproducible across the full coordination seam.
- **Web works daemon-down.** Reads + intent writes never block on daemon availability.
- **Content-addressed blobs.** Deduplication, loop-safe replay, clean GC.
- **Orphan side effects are caught, not masked.** Quarantine + idempotency keys = at-most-once jointly with provider.
- **Fair, predictable queueing.** `ready_at` FIFO; no hidden scheduler rules.
- **Auditable.** Every state transition is a durable event; `events` table is system memory.
