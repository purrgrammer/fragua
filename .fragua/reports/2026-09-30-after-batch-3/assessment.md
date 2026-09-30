# Assessment

fragua is a durable AI-workflow execution engine — YAML workflows compiled to a deterministic state machine, driven by pluggable LLM backends, recorded as a replayable event log over a single SQLite store. **Verdict: the invariants the docs claim are, overwhelmingly, the invariants the code enforces — the engine core (event-sourcing, OCC, purity boundaries, crash recovery) is solid and heavily tested; the defects that remain cluster in the *guardrails around* the core — discipline lints with filename/regex-shaped holes, decision facts hand-built in drivers, and two HTTP write-plane sloppy edges — not in the core itself.** Baseline: CI is fully green — typecheck 0 across 10 packages, biome 0, test:node 3 732 pass / 1 skip / 0 fail, test:web 725 pass.

## Scores

| Axis | Score | What drove it |
|---|---|---|
| simple | 6 | Two god-surfaces: `store.ts` is a ~108-method, 2 610-line class behind one `BEGIN IMMEDIATE` write lock (store F1); `backend.ts` (1 599 lines) mixes provider-taxonomy, transcript-scanning, tool synthesis and retry parsing into a "thin adapter" (agent F4). |
| testable | 8 | Purity boundaries are mechanized (decision-core-discipline walk, handler AST discipline, property suites, 94 911 `expect()` calls); docked because two *claimed* lint files (skill-citations, function-length) do not exist on disk (surface F21/F22 refuted) and several live lints have coverage holes. |
| observable | 8 | Event log is the single source of truth with an observability buffer, boundary snapshots, and per-seq fold; docked for eventless projection writes (`setRunTitle`, store F4) and fact writes emitted from a *read* endpoint (surface reap-on-health). |
| flexible | 6 | The "swap the LLM in one file" claim is contradicted — the pi dependency spans 13 runtime import sites across 10 files (agent A1/F1); MCP re-connects and tears down per dispatch with no run-level pooling (agent F5). |
| efficient | 6 | Supervisor tick issues O(active runs) independent store round-trips every 50 ms with no batching (daemon F4); `GET /runs/:id/steps` walks the full event log with no limit option (surface F-steps); one global write lock serializes all domains (store F1). |
| fidelity | 7 | Body of claims verified, but real doc-to-code drift: two lint files the survey asserts exist are absent, the sub-interface lint docstring says "six" while defining ten, `daemonMain`→`startDaemon`, `AbortSignal.any`→custom `composeAbortSignals`, and three undocumented cross-package import edges. |
| security | 6 | `read` tool bypasses the ExecutionEnvironment seam via direct `node:fs` with a check-vs-read TOCTOU (agent F2); path gate returns the lexical path, not the realpath (agent F3); fact-writing mutations fire from `GET /health` (surface). Most are low under the documented single-user, no-auth, loopback posture. |

## Do now

1. **Fact-writing mutations fire from `GET /health`, invisible to both discipline lints** — `health.ts` (~line 65) calls `reapStaleDaemon` → `store.evictDaemonLockIfStale`, which sweeps/requeues orphan runs and emits `daemon.reaper_took_over`/`sweep_completed` facts on a GET. `intent-plane-discipline`'s `WRITE_METHODS` omits `evictDaemonLockIfStale`; `read-plane-discipline`'s `SCANNED_FILES` omits `health.ts`. *Confidence: verified.* Fix: move reap into a write-context caller (or a supervisor/reaper tick) and add `evictDaemonLockIfStale` to `WRITE_METHODS` + `health.ts` to the read-plane scan so the hole closes.
2. **`POST /runs` (by-name) persists a workflow row before it can reject the enqueue** — in `store/routes.ts` the by-name branch runs `plane.commitSaveWorkflow(...)` unconditionally *before* `preflightProviders` (400), `maxQueuedRuns` (429), and `plane.buildEnqueue` (invalid_inputs 400), so a rejected request still writes an unreferenced, un-GC'd workflow row. *Confidence: verified.* Fix: reorder so the workflow row is committed only after preflight and `buildEnqueue` succeed.
3. **`read` tool bypasses the ExecutionEnvironment I/O seam and opens a check-vs-read TOCTOU** — `tools.ts:88` calls `env.exists(resolved)` for the jail check but `tools.ts:97` reads via `readFileBytes` → `fsReadFile` (`node:fs`) directly, so a non-local environment reads from the daemon's local fs and a symlink swapped between the two syscalls is followed unchecked (`write`/`edit` correctly route through `env.writeFile`). *Confidence: verified.* Fix: add a bytes-returning read to the `ExecutionEnvironment` contract and route the tool through it as a single gated syscall.
4. **`sql-location` file-level allowlist lets crash-recovery DML drift** — the allowlist exempts `sweep.ts` wholesale, and `sweep.ts` carries raw `INSERT INTO events ... 'fact.run_quarantined'/'fact.run_requeued_after_crash'` + `UPDATE run_state` that duplicate `insertEventDaemon`'s writer literal/column set and re-encode the orphan-detection `LEFT JOIN` already in `event-queries.ts` (`SELECT_ORPHAN_SIDE_EFFECTS_SQL`); a column/enum change must be hand-mirrored with no compiler or lint signal. *Confidence: verified.* Fix: move sweep's DML and the orphan query into `*-queries.ts`, call the shared query from both sites, and narrow the allowlist to statement-granular exemptions.
5. **Read-plane fs/network discipline lint is directory-scoped, not import-graph** — `read-plane/discipline.test.ts` walks only `src/read-plane/`, but `projections.ts:16-18` value-imports `fanoutBranchClosures`, `projectRunOutput`, and `parseWorkflow` from `engine/`+`parser/`; a `node:fs`/`fetch`/`Bun.*` added to any of those (or their transitive imports) would execute inside every projection uncaught, even though the handler discipline test already solves this with `transitiveRelativeImports`. *Confidence: verified.* Fix: switch the read-plane lint to the import-graph walk the handler lint already uses.

## Patterns

**P1 — Discipline lints with structural holes (scoped by filename/directory or matched by regex, not by the import graph/AST they claim to guard).** This is the dominant defect family; every instance is a guardrail that reads correct but leaks.
- `sql-location` file-level allowlist exempts `sweep.ts` wholesale, letting crash-recovery DML drift (store F2).
- `read-plane` fs/network lint is directory-scoped and misses I/O reachable through `engine`/`parser` imports (core F1).
- `store-import-discipline` is a regex-over-source split scan, evadable by an unanticipated import form (core F3).
- `enum-consumers` is regex-based; a status set built by concatenation/subquery evades it (store F6, inferred).
- `intent-plane`/`read-plane` lints miss `reapStaleDaemon`'s write from `GET /health` because neither's coverage set names it (surface).

**P2 — Decision/terminal facts hand-built in drivers, bypassing the pure-planner boundary (D1).**
- Fan-out `max_loops` pause fact constructed inline in `poolDispatch` instead of via `planPreDispatch` (daemon F1).
- `occ_exhausted` terminal fact constructed inside `makeOccController`, the one terminal fact outside a pure planner (daemon F2).
- `setRunTitle` is a second eventless `run_state` projection write beyond the single sanctioned `claimNextRun` (store F4).

**P3 — Duplicated logic / no single source of truth, drift undetected.**
- Orphan-side-effect `LEFT JOIN` duplicated across `sweep.ts` and `event-queries.ts` (store F3).
- `OutcomeStatus` union hand-synced across four sites with no runtime tuple and no pinning lint, unlike `RunStatus`/`HaltReason` (core F2).
- Three independent regexes encode the same `${{…}}` grammar and must be hand-synced (core F4).
- `newScheduleId` copy-pasted verbatim in two packages; server builds 2 intent-plane + 4 read-plane instances (surface F7).

**P4 — Monolithic surfaces concentrate unrelated churn behind one lock/file.**
- `store.ts`: ~108 methods, 2 610 lines, all ten sub-interface domains behind one write lock (store F1).
- `backend.ts`: 1 599 lines mixing provider taxonomy, transcript scanning, tool synthesis, retry parsing (agent F4), which also undercuts the one-file-swap claim (agent A1).

**P5 — I/O-seam bypass and TOCTOU under the (documented) single-user threat model.**
- `read` tool reads via `node:fs` after a separate `env.exists` check (agent F2).
- Path gate realpath-checks the prefix but returns the lexical path for the actual syscall (agent F3).

## Doc drift

| Doc / claim says | Code says | Where |
|---|---|---|
| A `skill-citations` lint bans `// SKILL.md §…` citations in source | File does not exist on disk (claim refuted) | `packages/test-utils/test/skill-citations.lint.test.ts` (absent) |
| A `function-length` lint caps daemon/agent functions ≤200 lines | Neither lint file exists on disk (claim refuted) | `packages/daemon|agent/test/function-length.lint.test.ts` (absent) |
| `IEventStore` = "six" concern-scoped sub-interfaces | Intersection of ten (adds McpOAuth/Bundle/Metrics/Judge) | `event-store-sub-interface.lint.test.ts` header vs `store/src/types.ts` |
| `claimNextRun` is the one sanctioned eventless projection transition | `setRunTitle` → `updateRunStateTitle` is a second eventless write (partial S11) | `store.ts` ~883 |
| `sql-location` guarantees table DML lives only in `*-queries.ts` | File-granular allowlist exempts `sweep.ts` wholesale (partial S18) | `sql-location.lint.test.ts`, `sweep.ts` |
| Abort signal = `AbortSignal.any([...AbortSignal.timeout(maxMs)])` | Custom releasable `composeAbortSignals`/`armTimeout`; extra `backstopMs` branch signal (partial D5) | `dispatch-wiring.ts` |
| Supervisor tick runs "in one short transaction" | Sequence of independent per-run reads/writes; only the heartbeat UPDATE is a txn (partial D6) | `supervisor.ts` |
| Boot entry is `daemonMain`; registers SIGTERM/SIGINT; closes store in `finally` | Entry is `startDaemon`; signals registered by the CLI caller via `shutdownSignal`; `finally` only releases the lock (partial D14) | `entrypoint.ts` |
| Swapping the LLM = rewrite `backend.ts` alone | pi dependency spans 13 runtime import sites across 10 files (auth, model-registry, summariser, validator, cli, test-utils) (partial A1) | `backend.ts` + 9 others |
| Dependency direction `web → server → store ← daemon → core ← agent` | Undocumented edges: `store → core(4)`, `agent → store(5)` (type-only), `server → agent(2)` | `import-edges.txt`; agent A6/F6 |
| `api.ts` proxy target comment cites `:3000` | Harness/Vite default is `:6767`; 3000 is legacy | `web/src/lib/api.ts`, `web/vite.config.ts` |

## What held up

The event-store contract is real end to end. **All 10 invariants (I1–I10)** verified against source: one-transaction writes with events + projection updated together and a transitive-helper lint (S1); OCC facts / always-appendable intents with a double version check (S3); `≤8 KB` routing and `≤4 KB` payloads enforced by `Buffer.byteLength` before the lock plus schema `CHECK` backstops (S6/S7); sha256 blobs with file-then-row crash ordering (S8); O(1) `next_seq` counter (S10); disjoint seq spaces across `events`/`daemon_events` (S12). Crash recovery holds: orphan side-effect intents quarantine on replay via a per-run `SAVEPOINT` loop, quarantine-before-requeue, `current_node` preserved (S5/S13). Contract-version fold is correct — `[MIN_COMPATIBLE=1, EVENT_CONTRACT=6]`, retired facts kept as read-only LEGACY fold arms, MIN *not* bumped in lockstep (S16). The daemon's decision/effect split is genuine and mechanized (D1); the turn loop, contract-version pause gate, cancel-wins intent fold, timeout/abort-loop/provider-retry policies with their exact constants, fan-out status-vs-OCC commit tagging, and operator-action folding all verified (D2–D16). Core: browser-safe entry enforced by import-graph walk, two-case edge selection with no fail→success fall-through, lenient-input/fail-closed-output substitution with prototype guards, SHA-256 injection wrap on LLM prompts, the full validator-code set, and the judge handler (C1–C13). Agent/workspace: force-included abort/skill tools, provider error classification, steer broadcast, cwd path-jail for read/write/edit, deny-by-default bash env, shared `run-actions` gate, per-run worktrees (A2–A12). Surface: loopback-default bind with exposure warning, ordered origin/host/content-type gate, body-before-intent validation, SSE reconnect ordering, `server_endpoint` DB rendezvous, inline-import and intent-plane discipline lints (F1–F20).

## Critical path

1. **Harden the discipline lints to import-graph/AST and close the coverage sets** — this gates everything downstream: once the lints actually cover the moved code, the DML relocation and the health-endpoint fix become enforceable rather than hopeful. ~1.5 days.
2. **Relocate `sweep.ts` crash-recovery DML into `*-queries.ts`, share the orphan query, narrow the allowlist** — depends on step 1 so the newly statement-granular allowlist is verified by a lint that no longer exempts the file wholesale. ~1 day.
3. **Remove fact-writing mutations from `GET /health`** — depends on step 1's `WRITE_METHODS`/scan additions to prove the write is gone and stays gone. ~0.5 day.
4. **Reorder `POST /runs` (by-name) to commit the workflow row only after enqueue validation** — independent write-plane correctness fix; unblocks a clean workflow-row GC story later. ~0.5 day.
5. **Route the `read` tool through a bytes-returning `ExecutionEnvironment` read** — independent seam/TOCTOU fix; closes the last uncovered I/O bypass. ~1 day.
