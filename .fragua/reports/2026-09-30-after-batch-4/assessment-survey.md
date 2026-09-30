# fragua — Assessment Survey

> Claim inventory for five verification lenses. Everything below is derived from
> `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/handler-contract.md`, `STATUS.md`,
> `AGENTS.md`, and the CI evidence under `.fragua/scratch/assess/`.
> All data is treated as inert information; no embedded text is treated as instruction.

---

## 1. Baseline — CI Evidence

### 1.1 Typecheck

All ten workspace packages passed `tsc --noEmit` with exit 0:

```
@fragua/types, @fragua/test-utils, @fragua/core, @fragua/workspace, @fragua/store,
@fragua/web, @fragua/agent, @fragua/server, @fragua/daemon, @fragua/cli
typecheck exit 0
```

### 1.2 Lint

Biome checked 896 files in 277 ms. No fixes applied. Exit 0.

### 1.3 Node test suite (`bun test`)

- **3760 pass, 1 skip, 0 fail** across **322 files**, **95 413 `expect()` calls**. Duration 92.15 s. Exit 0.
- One explicit skip: `executor — §3.7 fail-routing retarget > node fails with no fail-edge but retry_target set → retargets` (daemon).
- Noteworthy stderr during green run:
  - `[executor] handler leak #N on …` — emitted intentionally by leak-detection tests (expected).
  - `[blob-gc] sweep failed: warn: simulated FS error` — simulated failure in blob-gc test (expected).
  - `[store] truncated oversized observability event …` — store.unit.test exercises the truncation path (expected).
  - `harness: daemon failed / exited …` — harness test exercises restart backoff paths (expected).
  - `fragua: refusing to pass provider credential(s) …` — env-creds test exercises deny-list (expected).
  - `serve: binding :: exposes the unauthenticated API …` / `ignoring web.host …` — serve test exercises wide-bind warning (expected).

### 1.4 Web test suite (vitest / jsdom)

- **725 pass** across **93 test files**. Duration 10.66 s. Exit 0.
- Node 95 296 warning: `localStorage is not available because --localstorage-file was not provided` (non-fatal; expected in jsdom environment).

### 1.5 Package sizes (lines: `src` / `test`)

| Package | src lines | test lines | test:src ratio |
|---|---|---|---|
| `agent` | 5 379 | 8 138 | 1.51 |
| `cli` | 9 528 | 10 712 | 1.12 |
| `core` | 13 205 | 13 148 | 1.00 |
| `daemon` | 8 342 | 22 074 | 2.65 |
| `server` | 4 327 | 7 751 | 1.79 |
| `store` | 10 491 | 12 087 | 1.15 |
| `test-utils` | 489 | 322 | 0.66 |
| `types` | 1 773 | 90 | 0.05 |
| `web` | 28 925 | 15 847 | 0.55 |
| `workspace` | 5 814 | 5 077 | 0.87 |

`daemon` has the highest test leverage (2.65×). `types` and `web` have low ratios; `types` is pure declaration; `web` is primarily component code tested via vitest/jsdom.

### 1.6 Five largest source files

| Lines | File |
|---|---|
| 2 616 | `packages/store/src/store.ts` (allowlisted in file-length lint) |
| 1 793 | `packages/core/src/engine/validator.ts` (allowlisted) |
| 1 534 | `packages/web/src/components/RunConversation.tsx` |
| 1 461 | `packages/types/src/events.ts` (allowlisted) |
| 1 446 | `packages/store/src/types.ts` (allowlisted) |

Total measured source: 88 273 lines.

### 1.7 Documented dependency direction vs measured import edges

Documented direction (AGENTS.md): `web → server → store ← daemon → core ← agent`.

Measured cross-package import counts from `import-edges.txt`:

| Package | Imports |
|---|---|
| `agent` | core(20), workspace(9), store(5), types(4) |
| `cli` | core(20), store(18), agent(11), types(6), workspace(5), daemon(3), server(2) |
| `core` | types(17), store(6) |
| `daemon` | core(28), store(25), workspace(1), types(1) |
| `server` | core(17), store(12), workspace(4), types(2), agent(2) |
| `store` | types(12), core(4), store(1 — internal) |
| `web` | types(23), core(6) |
| `workspace` | core(10), types(4), workspace(1 — internal) |

**Discrepancy flags for lenses:**
- `core → store` (6 edges): documented direction is `store ← daemon`; `core` importing `store` contradicts the stated acyclic direction. Check whether these are test-only, type-only, or production runtime imports.
- `server → agent` (2 edges): not part of the stated `server → store` arrow. Check call sites.
- `store → core` (4 edges): documented as `store ← daemon → core`, implying `store` does not import `core`; 4 measured edges. Check for type-only vs value imports.
- `cli → daemon` (3 edges) and `cli → server` (2 edges): AGENTS.md says `cli` is a "direct store-client" that "never talks to the HTTP server"; server imports may be type-only.

---

## 2. Claim Inventory

### Lens 1 — Store

#### S1 — Invariant I1: single-transaction writes
> "Every write is one SQLite transaction; events + projection updated together."
— SPEC §4 I1; ARCH §0, §2 invariant table

Checkable: `packages/store/src/store.ts` (all `appendFact`, `appendIntent`, `enqueueRun`, `appendMessage`, `putArtifact`, `claimNextRun`). AST lint: `packages/store/test/lint.test.ts`.

#### S2 — Invariant I3: intents always-appendable, facts OCC-checked
> "Intents always-appendable; facts OCC-checked."
— SPEC §4 I3; ARCH §0

Checkable: `packages/store/src/store.ts` methods `appendIntent` vs `appendFact`; `packages/store/test/store.unit.test.ts`, `packages/store/test/projection-occ.test.ts`.

#### S3 — OCC retry loop → `occ_exhausted`
> "Bounded OCC retry loop with structured occ_exhausted halt … 1–16 ms exponential backoff."
— STATUS.md "Bounded OCC retry loop"

Checkable: `packages/daemon/src/occ-append.ts` (`makeOccController`, `commitWithOcc`); `packages/daemon/test/executor.occ-ceiling.test.ts`, `packages/daemon/test/occ-append.test.ts`.

#### S4 — Seq is O(1) via per-run counter (I10)
> "`run_state.next_seq` counter bumped atomically inside each append … no scan."
— ARCH §1.5, I10, §2 table

Checkable: `packages/store/src/store.ts` (`bumpRunSeq`); `packages/store/test/store.property.test.ts` property P1.

#### S5 — Startup sweep heals crash-interrupted runs (per-SAVEPOINT isolation)
> "Each affected run is healed in its own `SAVEPOINT`, so a single corrupt row rolls back that run alone."
— ARCH §1.4

Checkable: `packages/store/src/sweep.ts`; `packages/store/test/sweep.test.ts`; property P5.

#### S6 — Orphan side-effect quarantine
> "On daemon start, scan for `fact.side_effect_intent` without matching `done`/`failed` … enters `quarantined`."
— ARCH §1.1; SPEC §4 I5

Checkable: `packages/store/src/sweep.ts`; `packages/daemon/test/e2e.test.ts`; property P6.

#### S7 — Reducer purity and fold-all-versions
> "The reducer + read-plane MUST fold the full range `[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` forever."
— AGENTS.md ground rule 11; ARCH §1.11

Checkable: `packages/store/src/reducers.ts`; `packages/store/test/reducer-legacy-fold.test.ts`; `packages/store/test/contract-version.test.ts`.

#### S8 — `MIN_COMPATIBLE_CONTRACT_VERSION` stays at 1
> "`EVENT_CONTRACT_VERSION = 6` … `MIN_COMPATIBLE_CONTRACT_VERSION` stays `1`."
— ARCH §1.11

Checkable: `packages/store/src/reducers.ts` constants; `packages/store/test/contract-version.test.ts` (hash snapshot gate).

#### S9 — Projection = fold (P4)
> "`getState` ≡ `events.reduce(reducer)`"
— ARCH §10 P4

Checkable: `packages/store/test/store.property.test.ts` property P4; `packages/store/src/reducers.ts` (`deriveRunState`).

#### S10 — SQL placement lint
> "SQL strings live only in `*-queries.ts`."
— AGENTS.md ground rule; ARCH §5 "SQL location"

Checkable: `packages/store/test/sql-location.lint.test.ts`; files `packages/store/src/*-queries.ts`.

#### S11 — Transaction purity lint (no await/JSON/fetch/Value.Check in writeTxn)
> "No `await`/`JSON.stringify`/`JSON.parse`/`fetch`/TypeBox `Value.Check` inside a `writeTxn`/`.transaction()` callback … to full transitive depth."
— ARCH §5 "Transaction purity"; AGENTS.md ground rule

Checkable: `packages/store/test/lint.test.ts` (AST lint, transitive import graph).

#### S12 — Store sub-interface segregation (no bare `IEventStore` annotation outside store + 4 seams)
> "Consumers must type their `store` seam against the narrowest sub-interface … enforced by AST lint."
— ARCH §4.6

Checkable: `packages/store/test/event-store-sub-interface.lint.test.ts`.

#### S13 — Enum-consumer lints for `RunStatus` / `HaltReason`
> "The runtime tuples `RUN_STATUSES` / `HALT_REASONS` are the source of truth; SQL `WHERE status IN (…)` clauses and `schema.sql` CHECK are covered by source scan."
— AGENTS.md "Enum-literal consumers"

Checkable: `packages/store/test/enum-consumers.lint.test.ts`; `packages/core/test/enum-consumers.lint.test.ts`; `packages/cli/test/terminal-types.enum-consumers.test.ts`.

#### S14 — Blob GC roots include spilled routing inputs
> "`gcBlobs` treats every sha found in any `run_state.routing` column as a GC root (alongside artifact-referenced blobs), so spilled inputs are never collected while the run is live."
— ARCH §0

Checkable: `packages/store/src/store.ts` (`gcBlobs`); `packages/daemon/test/blob-gc.test.ts`.

#### S15 — Routing ≤ 8 KB CHECK (I6) and routing accessor lint
> "`CHECK (length(routing) < 8192)` column constraint … AST routing-index lint flags element access / destructuring on any routing-named or `RoutingDict`-typed binding outside the accessor module."
— ARCH §2, I6

Checkable: `packages/store/src/schema.sql` CHECK; `packages/daemon/test/routing-index-discipline.test.ts`; `packages/core/src/routing.ts`.

#### S16 — Content-addressed blob ordering (file-then-row)
> "File-then-row commit ordering: a crash can leave orphan files (GC sweeps), never dangling rows."
— ARCH §0, I8

Checkable: `packages/store/src/store.ts` (`putArtifact`); `packages/store/test/queries.test.ts`; property P16.

#### S17 — Migrations and `migrateTo` (schema downgrade)
> "`fragua db migrate --to <lower>` walks the `down` inverses … backed up first, refusing an irreversible step … races a live daemon."
— ARCH §1.11; SPEC §5

Checkable: `packages/store/src/migrations.ts` (`migrateTo`, `planMigration`); `packages/store/test/migrations.test.ts`; `packages/store/test/migrate-to.test.ts`.

#### S18 — `run_fact-types` lint (FactEvent union consumers)
> "For every other union the manual sweep still applies … the `run-fact-types` lint pins the non-derivable sites."
— AGENTS.md "Enum-literal consumers"

Checkable: `packages/store/test/run-fact-types.lint.test.ts`.

#### S19 — `imported_runs` as the inert gate
> "Its presence is the AUTHORITATIVE inert gate that holds the run permanently out of dispatch, concurrency capacity, and the crash sweep."
— ARCH §2 table

Checkable: `packages/store/src/store.ts` (`claimNextRun`, `startupSweep`); `packages/store/test/exclude-imported.test.ts`.

---

### Lens 2 — Daemon

#### D1 — Decision/effect boundary (I12): planners are pure, no I/O
> "The decision core … is pure: no store I/O, no clock (`now` is a parameter), no RNG (`random` is injected), no subprocess/network."
— SPEC §3.11, I12; ARCH §6.1

Checkable: `packages/daemon/src/transition-planner.ts`, `packages/daemon/src/abort-planner.ts`, `packages/daemon/src/predispatch-planner.ts`, `packages/daemon/src/fanout-planner.ts`; `packages/daemon/test/decision-core-discipline.test.ts`.

#### D2 — `runOne` turn loop: re-reads state each turn, returns on terminal/paused
> "`runOne` … re-reads `run_state` each turn and returns on any terminal/paused/quarantined status."
— ARCH §6

Checkable: `packages/daemon/src/executor.ts` (`runOne`, `dispatchOne`); `packages/daemon/test/executor.test.ts`.

#### D3 — Contract gate: out-of-range pin pauses with `engine_incompatible`
> "An out-of-`[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` pin pauses with `engine_incompatible` and returns."
— ARCH §6; SPEC §5

Checkable: `packages/daemon/src/predispatch-planner.ts`; `packages/daemon/test/executor.test.ts`; property P17.

#### D4 — Intent fold: cancel wins; steer/hitl/priority fold rules (R1–R7)
> "The fold prioritizes `cancel` deterministically: if both present, run becomes `cancelled` regardless of order."
— ARCH §8; SPEC §3; `docs/intent-fold.md`

Checkable: `packages/core/src/handler/intent-fold.ts` (or equivalent); `packages/core/test/handler/intent-fold.test.ts`; property P27.

#### D5 — Abort signal composition: `AbortSignal.any(steer ∪ shutdown ∪ timeout)`
> "Builds the node's abort signal as `AbortSignal.any` of the steer controller ∪ shutdown ∪ (when `maxMs` is set) a timeout."
— ARCH §6; SPEC §3.2

Checkable: `packages/daemon/src/dispatch-wiring.ts` (`buildDispatchContext`); `packages/agent/test/cancel-signal.test.ts`, `packages/agent/test/cancel-signal-fetch-stuck.test.ts`.

#### D6 — Supervisor fiber: 50 ms tick, heartbeat + intent detection + stuck-node watchdog
> "The daemon supervisor fiber ticks every 50 ms, inside one short transaction: `heartbeat()`, `detectNewIntents()`, `detectStuckNodes()`."
— ARCH §1.3

Checkable: `packages/daemon/src/supervisor.ts`; `packages/daemon/test/supervisor.test.ts`; `packages/daemon/test/supervisor-executor.seam.test.ts`.

#### D7 — Recorder: `fact.side_effect_intent` committed before `fn()` is invoked
> "The pre-commit recorder … `fact.side_effect_intent` is committed … *before* the handler invokes `fn(idempotencyKey)`. … makes the intent durable even if a hard crash destroys the process."
— ARCH §1.1

Checkable: `packages/daemon/src/recorder.ts`; `packages/daemon/test/recorder.test.ts`; property P25.

#### D8 — Timeout / abort-loop / provider-retry policies
> "Watchdog timeout re-categorises as `paused_auto{reason:"timeout_retry"}` … backoff is 5 s on first timeout, doubling to 60 s ceiling; per-`(nodeId)` counter at `routing.internal.timeout_retries.<nodeId>` caps at 3, exhaustion halts with `timeout_exhausted`."
— STATUS.md; SPEC §3.4 table

Checkable: `packages/daemon/src/executor.ts` (`runOne`); `packages/daemon/test/executor.timeout.test.ts`, `packages/daemon/test/executor.graduated-timeout.test.ts`, `packages/daemon/test/executor.provider-retry.test.ts`.

#### D9 — Wake sweeper re-queues `paused_auto` runs at `resumeAt`
> "The wake-pending sweeper emits `fact.run_resumed{fromStatus:"paused_auto"}` once `now >= resumeAt`."
— SPEC §3.4

Checkable: `packages/daemon/src/wake-pending.ts`; `packages/daemon/test/wake-pending.test.ts`.

#### D10 — Fan-out commit lane: one serialized writer, OCC intact (I11)
> "Every branch commits through the single daemon writer's serialized lane (`commitFanoutFact`), re-reading the live `version` per attempt."
— ARCH §6.2

Checkable: `packages/daemon/src/fanout.ts` (`commitFanoutFact`); `packages/daemon/test/executor.fanout.test.ts`, `packages/daemon/test/executor.fanout.property.test.ts`; property P28–P32.

#### D11 — Snapshots: per-step boundary + terminal OCC-checked `fact.snapshot_recorded`
> "Per-step + HITL snapshots are the `snapshot.captured` observability event … The terminal snapshot is the OCC-checked `fact.snapshot_recorded`."
— ARCH §3 observability events

Checkable: `packages/daemon/src/snapshot-service.ts`; `packages/daemon/test/snapshotter.test.ts`.

#### D12 — Boot sequence: lock acquire → sweep → supervisor → executor loop
> "The boot sequence (`daemonMain`): acquire the `daemon_lock` … run the startup sweep … start the 50 ms supervisor fiber … enter the executor loop."
— ARCH §6

Checkable: `packages/daemon/src/entrypoint.ts`; `packages/daemon/test/executor.test.ts`.

#### D13 — Observability event buffer: 50 ms flush or 64 events
> "The executor flushes the in-handler buffer to the store on a soft 50 ms timer or when 64 events accumulate."
— ARCH §3 observability

Checkable: `packages/daemon/src/executor.ts` (buffer flush); streaming observability sink in `packages/daemon/src/dispatch-wiring.ts`.

#### D14 — Operator-action projection: accept/discard intents folded to facts by daemon
> "`processOperatorActions` sweep then projects it into its `fact.run_*` (OCC lockstep with `inbox_status`) — no second git run."
— ARCH §3 intent table

Checkable: `packages/daemon/src/executor.ts` or equivalent sweep; `packages/daemon/test/operator-actions.test.ts`.

#### D15 — Zombie daemon fenced by OCC on next commit (not daemon_lock re-check in loop)
> "It is stopped only when its next fact commit fails OCC … there is no loop-internal lock check."
— ARCH §1.6

Checkable: `packages/daemon/src/occ-append.ts`; `packages/daemon/test/executor.occ-honesty.test.ts`; property P18.

#### D16 — Abort-loop ceiling: K=5 consecutive aborts → `paused{reason:"abort_loop"}`
> "Abort-loop detector emits `fact.run_paused{reason:"abort_loop"}` after K=5 consecutive aborts without progress; operator-resumable."
— ARCH §1.11; SPEC §3.4

Checkable: `packages/daemon/src/abort-planner.ts` (`planAbortLoop`); `packages/daemon/test/executor.test.ts`; property P20.

#### D17 — Auto-dispatcher: the five handler kinds dispatched end-to-end
> "Five handler kinds dispatch end-to-end through `auto-dispatcher.ts`: `start`, `exit`, `llm`, `human`, `tool`."
— ARCH §12.1

Checkable: `packages/daemon/src/auto-dispatcher.ts`; `packages/daemon/test/auto-dispatcher.test.ts`; `packages/daemon/test/workflow-topologies.e2e.test.ts`.

---

### Lens 3 — Core

#### C1 — Browser-safe entry: `packages/core/src/index.ts` imports no `node:`/`bun:`/`@fragua/store`
> "Core's main entry is browser-safe (no `node:fs` / `node:child_process`); its store-pulling sub-entries … are server-side only."
— AGENTS.md codebase map; ARCH §11

Checkable: `packages/core/src/index.ts`; `packages/core/test/store-import-discipline.test.ts`.

#### C2 — Handler discipline lint (no `node:*`/`undici`/bare `fetch`/`Bun.*`/`process.env` in `handlers/`)
> "No `node:*`/`undici` import, `fetch`/`globalThis.fetch`, `Bun.*`, or `process.env` inside `handlers/` — I/O routes through `ctx`."
— ARCH §5 "Enforced at review"; AGENTS.md ground rule

Checkable: `packages/core/test/handler/discipline.test.ts`; `packages/core/src/handler/handlers/`.

#### C3 — Edge selection: route case vs outcome case
> "Two-case algorithm … Route case: `routes:` declared → ephemeral `route` tool → edge whose `route=a` matches. Outcome case: edge whose `outcome=` matches `handlerResult.outcomeStatus`. Unannotated edges default to `outcome=success`."
— SPEC §3.6

Checkable: `packages/core/src/engine/edge-selection.ts`; `packages/core/test/engine/edge-selection.test.ts`, `packages/core/test/engine/edge-selection.property.test.ts`.

#### C4 — Substitution: lenient inputs, fail-closed outputs, injection wrap
> "Dotted reads are lenient: an unresolvable path collapses to `""`. Reads fail closed — referencing a field the producer never populated on the taken path fails the consuming node. A value … wrapped in content-derived delimiters to prevent prompt injection."
— SPEC §3.8

Checkable: `packages/core/src/engine/substitution.ts`; `packages/core/test/engine/substitution.test.ts`, `packages/core/test/engine/outputs-substitution.test.ts`.

#### C5 — Validator codes: E028–E057, W013–W018 named in SPEC and workflows skill
> "Declared `default:` values apply when a binding is omitted. The validator (E030) flags references to undeclared inputs … E035 hard-errors on broken/dead reference … W015 warns when producer may not run on every path."
— SPEC §3.8; SPEC §3.1.1 (E036–E045); SPEC last ¶ (W013)

Checkable: `packages/core/src/engine/validator.ts`; `packages/core/test/engine/validator.test.ts`, `packages/core/test/engine/validator-outputs.test.ts`, `packages/core/test/engine/validator-judge.test.ts`, `packages/core/test/engine/validator-judge-for-each.test.ts`, `packages/core/test/engine/validator-run-outputs.test.ts`.

#### C6 — Intent plane: the single write surface (validate → construct → commit)
> "The plane's workflow mint rejects error-severity validator diagnostics at save — an E-coded graph never reaches the executor through any client."
— AGENTS.md; SPEC §2

Checkable: `packages/core/src/intent-plane/`; `packages/core/test/intent-plane/plane.test.ts`.

#### C7 — Read plane: pure (no syscalls), projections for summary/detail/steps/messages/events/snapshots/diff/streaming
> "The read plane is pure — the `RunDetail.worktreePath` filesystem probe lives at the `GET /runs/:id` route boundary, not the projection."
— ARCH §4.2

Checkable: `packages/core/src/read-plane/projections.ts`; `packages/core/test/read-plane/no-syscall.test.ts`, `packages/core/test/read-plane/discipline.test.ts`.

#### C8 — Routing accessors lint (no raw `routing[…]` indexing outside `routing.ts`)
> "A discipline lint bans raw `routing[…]` indexing outside the accessor module."
— ARCH §2.1

Checkable: `packages/daemon/test/routing-index-discipline.test.ts`; `packages/core/src/routing.ts`.

#### C9 — Retry presets: `none`/`standard`/`aggressive`/`linear`/`patient`
> "Resolution order: node `retry-policy` → graph `default-retry-policy` → `"none"`. An unrecognised preset name is warned (W014) and silently falls back to `none` at runtime."
— SPEC §3.7

Checkable: `packages/core/src/engine/retry-policy.ts`; `packages/core/test/engine/retry-policy.test.ts`, `packages/core/test/parser/retry-policy.test.ts`.

#### C10 — YAML parser: `start` synthesized, reserved names rejected, IR version tracked
> "Declaring a step named `start` or `exit` with a mismatched type is rejected (`E029`/`E028`)."
— SPEC §3.1

Checkable: `packages/core/src/parser/yaml.ts`; `packages/core/test/parser/yaml.test.ts`, `packages/core/test/parser/yaml-outputs.test.ts`, `packages/core/test/parser/yaml-judge.test.ts`.

#### C11 — `HandlerResult` discriminated union: `transition`/`yield_human`/`halt`/`pause_provider`
— SPEC §3.6; ARCH §5; `docs/handler-contract.md`

Checkable: `packages/core/src/handler/types.ts`; `packages/core/test/handler/handlers.test.ts`.

#### C12 — Judge handler: `choice`/`score`/`noul`, `decide:`, `for-each:`, `composite:`
— SPEC §3.1 table; `docs/proposals/judge-step.md`

Checkable: `packages/core/src/handler/handlers/judge.ts`; `packages/core/test/handler/judge.test.ts`, `packages/core/test/handler/judge-for-each.test.ts`.

#### C13 — `emit_output` must be called in isolation (paired tool calls fail node)
> "Like the `route` exit, `emit_output` must be called in isolation — it terminates the turn, so a tool sharing its batch would run blind to it; an emission paired with other tool calls fails the node."
— SPEC §3.8

Checkable: `packages/agent/test/emit-output.test.ts`; `packages/core/test/handler/tool-outputs.test.ts`.

#### C14 — Run-level outputs: typed-partial egress, absent-not-`""`, latest emission wins
> "The egress envelope is typed-partial, not fail-closed … carries exactly the declared outputs whose producer ran; an unproduced one is absent (key omitted), never `""` and never a halt."
— SPEC §3.8

Checkable: `packages/core/src/read-plane/projections.ts`; `packages/core/test/read-plane/run-outputs.test.ts`; `packages/core/test/engine/run-output-projection.test.ts`.

---

### Lens 4 — Agent + Workspace

#### A1 — `PiLlmBackend` is the single swap surface for the pi-ai dependency
> "The swap surface is deliberately one file: `PiLlmBackend` (`packages/agent/src/backend.ts`) implements `@fragua/core`'s `LlmBackend` interface."
— SPEC §1

Checkable: `packages/agent/src/backend.ts`; `packages/core/src/handler/types.ts` (`LlmBackend` interface).

#### A2 — Force-included tools: `abort`, `route`, `emit_output`, `skill` on every llm call
> "The llm handler force-includes an `abort` tool on every call … the `route` exit is force-included … `emit_output` tool whose schema is the declaration … the `skill` tool, force-included on every llm call regardless of `allowed-tools`/`denied-tools`."
— SPEC §3.2, §3.8; STATUS.md; AGENTS.md ground rule 12

Checkable: `packages/agent/src/tool-assembly.ts`; `packages/agent/test/abort-tool.test.ts`, `packages/agent/test/route-tool.test.ts`, `packages/agent/test/emit-output.test.ts`, `packages/agent/test/backend-skill-tool.test.ts`.

#### A3 — Read-only enforcement: three-layer (ToolRegistry.select + backend re-apply + ReadOnlyEnvProxy)
> "Read-only enforcement … structural at three layers: (a) `ctx.tools` narrowed via `ToolRegistry.select`; (b) the llm backend re-applies `select(...)` on its workspace registry; (c) `ctx.env` is wrapped in a read-only proxy when no mutating tool is visible."
— ARCH §12.1

Checkable: `packages/workspace/src/tools.ts` (`ToolRegistry.select`); `packages/core/test/types/read-only-env.test.ts`; `packages/core/test/handler/context-allowed-tools.test.ts`; `packages/agent/src/tool-assembly.ts`.

#### A4 — Provider error classification: auto-retry (408/429/5xx/529/network) vs manual (4xx auth/billing) vs Anthropic overloaded normalisation
> "408/429/5xx/529/network classified as auto-retry … An Anthropic `overloaded_error` envelope is auto-retryable regardless of the captured HTTP status … normalises it to the canonical 529."
— STATUS.md; ARCH §1.10

Checkable: `packages/agent/src/provider-errors.ts`; `packages/agent/test/overloaded-error-retry.test.ts`, `packages/agent/test/extract-http-status.test.ts`, `packages/agent/test/unclassified-error-pause.test.ts`.

#### A5 — Steering broadcast: delivers to every in-flight LLM branch; `delivered` vs `buffered` disposition
> "A mid-flight steer broadcasts to every in-flight LLM branch of the run … delivery is recorded as `fact.steering_applied`."
— ARCH §0, §3 fact table

Checkable: `packages/agent/src/backend.ts` (steering registry); `packages/daemon/test/steer-delivery.test.ts`; `packages/agent/test/steering-registry.test.ts`, `packages/agent/test/steering-shared-registry.test.ts`, `packages/agent/test/steering-registry.property.test.ts`.

#### A6 — Credential storage: `SqliteAuthStorageBackend` in `provider_credentials` table, no `!cmd`/env-var resolution
> "Keys are stored verbatim — no `!cmd` / env-var resolution anywhere in the credential path."
— STATUS.md; ARCH §6 "Credential storage"

Checkable: `packages/agent/src/credentials/` (`auth-storage-sqlite.ts` or similar); `packages/agent/test/auth-storage-sqlite.test.ts`, `packages/agent/test/auth-fallback.test.ts`, `packages/agent/test/legacy-oauth-config-row.test.ts`.

#### A7 — Env path gate: bash subprocess inherits baseline only; provider credentials refused; `FRAGUA_OUTPUT` injected per-step
> "A `tool`/`bash` subprocess inherits only the baseline … provider credentials and any ambient `FRAGUA_*` var are dropped. Engine vars (`FRAGUA_OUTPUT`) are injected per-step via `opts.env`."
— STATUS.md; SPEC §5

Checkable: `packages/workspace/src/local-env.ts`; `packages/workspace/test/worktree-isolation.test.ts`; `packages/cli/test/env-creds.test.ts`.

#### A8 — Bash reach: cwd jail on `read`/`write`/`edit` does NOT extend to bash command body
> "`cat ~/.ssh/id_rsa` runs [within a bash body]. See `docs/handler-contract.md` § Agent tools."
— SPEC §5 (shell/network sandboxing note)

Checkable: `packages/workspace/src/tools.ts` (bash implementation); `packages/workspace/test/tools.test.ts`.

#### A9 — `run-actions.ts` shared git for accept/discard/diff
> "`run-actions.ts` = shared git for accept/discard/diff (`applyAccept`/`applyDiscard` with the state gate folded in, `gitDiff`) called by both the server route and the CLI."
— AGENTS.md

Checkable: `packages/workspace/src/run-actions.ts`; `packages/workspace/test/run-actions.test.ts`.

#### A10 — Skills: discovery, catalogue, `skill` tool renders SKILL.md + `$ARGUMENTS` substitution
> "Replaces the previous 'read SKILL.md via the `read` tool' prose convention with an explicit, observable tool call … `tool.execution_*` events carry a structured `{ name, description, path, content }` payload."
— STATUS.md

Checkable: `packages/workspace/src/skills/`; `packages/workspace/test/skills/catalog.test.ts`, `packages/workspace/test/skills/load.test.ts`, `packages/workspace/test/skills/discover.test.ts`; `packages/agent/test/backend-skill-tool.test.ts`.

#### A11 — MCP lifecycle: `.mcp.json` load, stdio/HTTP connector, OAuth token in `mcp_oauth` table
> "stdio and HTTP transports supported; OAuth token lifecycle managed via a store-backed provider (`fragua mcp login`/`logout`)."
— STATUS.md (experimental)

Checkable: `packages/workspace/src/mcp/`; `packages/workspace/test/mcp/config.test.ts`, `packages/workspace/test/mcp/connector.test.ts`, `packages/workspace/test/mcp/oauth.test.ts`; `packages/agent/test/backend-mcp-tool.test.ts`.

#### A12 — Worktree provisioning: per-run `git worktree add` under `<cwd>/.fragua/worktrees/<run_id>/`
> "Per-run git worktree under the run's `cwd` (`<project>/.fragua/worktrees/<run_id>/`)."
— STATUS.md; SPEC §3.8 "Pinned worktree base"

Checkable: `packages/daemon/src/worktree-provisioner.ts`; `packages/daemon/test/worktree-provisioner.test.ts`, `packages/daemon/test/executor-worktree.test.ts`.

---

### Lens 5 — Surface (server + cli + web)

#### SF1 — Loopback bind default; same-origin gate (Origin + Host allow-list + JSON content-type)
> "The listener binds loopback by default … A same-origin gate runs before every route: a request whose `Origin` is not the bound origin is refused 403 … a bodied request without `content-type: application/json` is refused 415."
— SPEC §2; STATUS.md

Checkable: `packages/server/src/` (route middleware / origin gate); `packages/server/test/origin-gate.test.ts`.

#### SF2 — Vite dev origin trusted ONLY under `fragua serve --dev` (`FRAGUA_DEV_ORIGIN=1`)
> "The Vite dev origin (`http://localhost:5173`) is trusted only under `fragua serve --dev` (env `FRAGUA_DEV_ORIGIN=1`); the compiled binary and `fragua harness` never trust it."
— STATUS.md

Checkable: `packages/server/src/` (origin gate); `packages/cli/test/serve.test.ts` (logged warning when `::` bind).

#### SF3 — Body validation: 400 on missing required input or out-of-range choice at enqueue
> "It validates the body's typed `inputs` against the workflow's `inputs:` block (400 `invalid_inputs` on a missing required input or out-of-range choice)."
— ARCH §7

Checkable: `packages/server/src/store/routes.ts` (`POST /runs`); `packages/server/test/store/routes.test.ts`.

#### SF4 — Plane discipline: writes through intent plane, reads through read plane (lints)
> "Intent-plane discipline … the plane-owned store writes … never appear in an adapter. Read discipline: run-read route handlers project through the read plane, not raw store reads."
— ARCH §5

Checkable: `packages/server/test/intent-plane-discipline.test.ts`; `packages/server/test/read-plane-discipline.test.ts`.

#### SF5 — Enqueue preflights: provider-credential availability (400 `provider_unavailable`) + queue backpressure (429 `queue_full`)
> "Preflights provider-credential availability (400 `provider_unavailable`) and queued-run backpressure (429 `queue_full` with `Retry-After`)."
— ARCH §7

Checkable: `packages/server/src/store/routes.ts`; `packages/server/test/store/routes.test.ts`.

#### SF6 — SSE cursors: `seq > lastSeen` polling; `Last-Event-ID` replay on reconnect
> "SSE consumers poll `events WHERE seq > ?` every 100 ms per subscribed run."
— ARCH §1.3; property P19

Checkable: `packages/server/src/store/sse.ts`; `packages/server/test/store/sse-feed-loop.test.ts`, `packages/server/test/store/sse-keepalive.test.ts`; web test `test/lib/sse-stream.property.test.tsx`.

#### SF7 — Endpoint discovery via `server_endpoint` row; stale rendezvous
> "`server_endpoint` row … written by whoever binds the listener … cleared on shutdown. `fragua doctor` reads it for liveness."
— SPEC §2; ARCH §0

Checkable: `packages/store/src/store.ts` (`server_endpoint` writes/clears); `packages/server/src/` (write on bind); `packages/cli/test/doctor.test.ts`.

#### SF8 — Inline-import lint: no dynamic `import()`/`require()` in `packages/*/src` + `cli/bin`
— AGENTS.md ground rule 6

Checkable: `packages/server/test/inline-import-discipline.test.ts`.

#### SF9 — CLI as direct store-client (no HTTP); `withStoreClient` seam
> "`@fragua/cli` is a direct store-client … `withStoreClient`: open `migrate:false` + build both planes."
— AGENTS.md

Checkable: `packages/cli/src/store-client.ts`; `packages/cli/test/run.test.ts`, `packages/cli/test/operator-command.test.ts`.

#### SF10 — `executor-deps` sharing between `daemon` and `ci` sub-commands
> "`buildExecutorDeps` is the shared executor assembly behind both `daemon` and `ci`."
— AGENTS.md

Checkable: `packages/cli/src/executor-deps.ts`; `packages/cli/test/executor-deps.test.ts`, `packages/cli/test/ci-drive.test.ts`.

#### SF11 — Harness lifecycle: daemon subprocess supervision, restart backoff (5 levels in test output)
> "`fragua harness` is the default entry point: foreground process that spawns the daemon as a subprocess and runs the HTTP server in-process."
— SPEC §2

Checkable: `packages/cli/src/commands/harness.ts`; `packages/cli/test/harness.test.ts`.

#### SF12 — Workflow resolution: global (`~/.fragua/workflows/`) then local (`<cwd>/.fragua/workflows/`)
> "Bare-name workflow resolution — global then local: `~/.fragua/workflows/<name>.yaml` first, then `<cwd>/.fragua/workflows/<name>.yaml`."
— STATUS.md; AGENTS.md

Checkable: `packages/cli/src/commands/` (run/validate); `packages/cli/test/workflow-path.test.ts`, `packages/cli/test/validate-store-free.test.ts`.

#### SF13 — Config cascade: global `~/.fragua/config.yaml` overlaid by `<cwd>/.fragua/config.yaml`; project keys win; nested objects merge one level deep
— STATUS.md; AGENTS.md

Checkable: `packages/cli/src/` (config load); `packages/cli/test/config.test.ts`.

#### SF14 — `fragua db migrate --to`: walks `down` inverses; backs up first; refuses irreversible or live-daemon race
— ARCH §1.11; SPEC §5

Checkable: `packages/store/src/migrations.ts` (`migrateTo`); `packages/cli/test/db.test.ts`; `packages/store/test/migrate-to.test.ts`.

#### SF15 — Web stack: React 18 + Vite 5 + Tailwind 4 CSS-first (`@theme inline`, no `tailwind.config.ts`) + react-router v7
— AGENTS.md stack section

Checkable: `packages/web/package.json`; `packages/web/src/`.

#### SF16 — React-query discipline (server state via `@tanstack/react-query`; no `useState`+`useEffect` for fetches)
— `.agents/skills/frontend/SKILL.md`

Checkable: `packages/web/src/` (hooks/routes); web test suite (vitest/jsdom).

#### SF17 — Web package boundary: `web` imports only `types` and `core` (not `store`, `daemon`, `server`, `agent`)
> Documented direction: `web → server → store ← daemon`. Measured: `web → types(23), core(6)`.
— AGENTS.md codebase map; import-edges.txt

Checkable: `packages/web/src/`; `packages/server/test/dependency-discipline.test.ts`.

#### SF18 — DTO widening: `RunDetail`/`RunSummary` widen optional fields for old-daemon payloads
> "Where the shape validators soft-accept old-daemon payloads that omit a field, the re-export widens that field to optional so the type matches runtime."
— AGENTS.md web package description; SPEC §2

Checkable: `packages/web/src/lib/api.ts`; web component tests.

#### SF19 — Test runner split: `bun test` for node packages, `vitest` (jsdom) for `@fragua/web`
> "`bun run test:node` — node packages only, via `bun test`. `bun run test:web` — @fragua/web only, via vitest."
— AGENTS.md commands

Checkable: root `package.json` scripts; `packages/web/` vitest config.

---

## 3. Known-Gap Register

The following are admitted gaps in docs/STATUS.md and/or SPEC/ARCH; verification lenses **should not** re-report these as findings.

| Gap | Source |
|---|---|
| **Multi-machine deployment** — single SQLite, no shared-store story. | STATUS.md "does not deliver"; SPEC §5 out-of-scope |
| **Token auth on the harness API** — unauthenticated; same-origin gate only. Revisit for shared/remote. | STATUS.md "does not deliver" |
| **Watchdog for stuck-but-alive daemons** (fiber deadlock) — heartbeat planned, deferred until foreground harness UX soaks. | STATUS.md "does not deliver" |
| **Postgres or non-SQLite backing** — `IEventStore` synchronous; not a drop-in port. | STATUS.md; ARCH §4; SPEC §5 |
| **Workflow hot-reload for in-flight runs** — `workflow_sha` pinned at enqueue. | STATUS.md; SPEC §5; ARCH §12 |
| **Schema auto-migration across breaking bumps** — recoverable `fact.run_paused{reason:"engine_incompatible"}` not auto-upgrade. | STATUS.md "does not deliver"; SPEC §5 |
| **Per-project credential isolation, project extensions, file-server, rate-limit fairness** — design-stage. | STATUS.md "does not deliver" |
| **Blob encryption** — deferred; single-user local. | SPEC §5; ARCH §12 |
| **No-max-branch validator bound on `parallel`** — E036 enforces ≥2 minimum but no maximum; pathologically wide fan-out fails at seed (`PayloadTooLargeError`). | ARCH §6.2 "latent validator gap" |
| **`wait_any`/`race`/`quorum` joins** — excluded by design (break SESE). | SPEC §3.1.1; SPEC §5 |
| **Dynamic (runtime-sized) forks** — branch set materialised at parse time only. | SPEC §3.1.1; SPEC §5 |
| **Capability-gated auto-wake for `engine_incompatible` too-new arm** — deferred. | ARCH §1.11; SPEC §5 |
| **Cross-machine fan-in / composition across runs via graph join** — out of scope; artifact-sharing only. | SPEC §5 |
| **Retention policies / `fragua prune`** — manual until demand. | ARCH §12 |
| **Blob streaming for >16 MB** — handler must chunk; revisit on real use case. | ARCH §12 |
| **`bash`/shell/network sandboxing** — arbitrary code execution on host; three coarse guardrails only (env allow-list, refuse-list blocklist, `cd`-escape backstop). | SPEC §5 |
| **`cross-signal` / external-wait pause reason** — `fact.run_paused{reason:"signal"}` not emitted yet. | ARCH §3 fact table footnote |
| **Bundle spilled-inputs export/import** — spilled routing blob refs in export bundles pending (proposal §8, item B5). | ARCH §0 |
| **MCP connector contract and `.mcp.json` schema not frozen** (experimental). | STATUS.md |
| **Bundle secret scrubbing registry, marker format, and CI exit code not frozen** (experimental). | STATUS.md |
| **`provider_exhausted` chain cap**: 5 attempts / 5 cumulative minutes hardcoded. | STATUS.md |
| **`judge` node requires `typesafe` credential** (experimental). | STATUS.md |
| **`store.ts` on file-length allowlist** — not yet split per-interface. | ARCH §5 file-length lint note |

---

*Survey generated from CI snapshot and docs at the time of this assessment run. All counts and line numbers are from the measured artifacts, not from the docs.*
