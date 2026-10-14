# Assessment

fragua is a durable AI workflow engine. YAML workflows compile to a deterministic state machine that dispatches LLM, tool, human, judge and parallel steps through `pi-ai`/`pi-agent-core`. Every transition is a typed `intent.*`/`fact.*` event in one SQLite store, with a `run_state` projection updated in the same transaction. **Verdict:** the pure layers hold up and are heavily tested. These are the planners, the intent fold, edge selection, the event-store write path, the contract-version gates and the run-actions git flow. The defects are at the edges where a fence is assumed rather than enforced: a daemon that lost its lock keeps running, the recorder's OCC fence lets stale handlers retry through, the sweep and import write outside the lock or the projection, and untrusted text crosses the shell, MCP and origin boundaries unescaped. A few knobs that authors can set do nothing at runtime. **Baseline:** CI is green (survey §1.1). Typecheck exits 0 across all 10 packages, biome is clean on 942 files, `test:node` has 3990 pass, 1 skip and 0 fail, and `test:web` has 749 of 749 passing. The one skip is the `retry_target` retarget case for a fallback SPEC §3.6 says no longer exists.

## Scores

| Axis | Score | What drove it |
|---|---|---|
| simple | 6 | `IEventStore` is a 111-method façade over ten sub-interfaces, and the sub-interface lint misses concrete `SqliteStore` annotations. Fact selection leaks out of the planners into `wake-pending`, `operator-actions`, `steer-delivery` and `snapshot-service`. Fan-out branches skip the linear `planAbort` path (`fanout.ts:227-233`). The `core ↔ store` package cycle is not in the documented dependency direction. |
| testable | 7 | 4740 green tests, pure planners and property harnesses. But ARCH §10 rows P1/P2/P4/P24 are sequential and narrow (inferred), and P18 is store-level only, which is why the recorder's fence hole (`recorder.ts:89-114`) went uncaught. Several lints match by name or regex rather than by import or type. |
| observable | 6 | One typed log is real. But the log and the projection disagree in places: a re-imported run gets new events, outputs and artifacts with no projection or `next_seq` update, and the sweep quarantines runs without the `activeMs` credit the reducer gives them. The supervisor fiber can die silently on a store throw, and a failed heartbeat is swallowed (`supervisor.ts:79-86`). |
| flexible | 7 | Provider, model and environment swaps mostly go through `PiLlmBackend`. But it is not the single swap surface: there are 13 runtime import statements in 10 files, plus credential sites. Web value-imports the server-only `@fragua/core/read-plane` sub-entry. The synchronous `IEventStore` is an admitted limit. |
| efficient | 7 | Mature libraries are reused rather than rebuilt (pi-ai, pi-agent-core, pi-mcp). There is per-dispatch churn: repeated `messages.since(0)` full reads, an MCP respawn per node, and bash spill files left in tmpdir (inferred). Named-thread hydration feeds the whole run's transcript into every threaded prompt, which costs tokens (`handler-bridge.ts:400-406`). |
| fidelity | 5 | ARCH §1.6 says a zombie is stopped "when its next commit fails OCC", but the recorder adopts the live version, so the commit doesn't fail. `retry-policy: standard` alone gives zero retries. Named threads are not isolated. `runs priority` never reaches the claim order. One claim is refuted outright (eviction order) and two daemon sub-claims are refuted. About 45 more claims are only partially true. |
| security | 4 | A `${{ }}` token inside double quotes in a tool `run:` still lets `$(…)` expand, so LLM output can execute on the host (inferred, high). On a wildcard bind the origin gate accepts any Host, which reopens DNS rebinding (inferred, high). A harness launched with `FRAGUA_DEV_ORIGIN=1` exported in the environment trusts the Vite dev origin. MCP tools sidestep read-only enforcement and E042, and MCP `${VAR}` expansion reads the full `process.env`. |

## Do now

1. **Shell injection through quoted tokens in a tool `run:`.** Severity high, confidence `inferred`. *Evidence:* `core/src/engine/substitution.ts:96` (`fmt` = `shellQuote` when `escapeForShell`) single-quotes every value regardless of where the token sits. Inside `"…"` those single quotes are literal, so `$(…)` and backticks in an input or an LLM-produced output expand under `sh -c`. The validator checks `run:` for E030/E035 but never checks quote context. I re-read the mechanism during reconciliation but did not execute it. *Fix:* make tool-step substitution context-aware: escape for double-quote context inside `"…"`, use the `'\''` form inside `'…'`, quote whole bare tokens, and reject tokens in backticks or heredoc bodies with a new validator error.
2. **A reclaimed daemon is never fenced.** Severity high. This merges two daemon findings and the store eviction lock-gap. *Evidence:* `heartbeatDaemonLock` runs `UPDATE daemon_lock … WHERE id = 1 AND pid = ?` (`store/src/daemon-queries.ts:189-195`) and throws away the change count. The supervisor swallows any outcome (`supervisor.ts:79-86`). The executor loop calls `claimNextRun` with no ownership check (`executor.ts:176-186`). Then `CommittingRecorder.commit` retries on `ConcurrencyError` while `status === 'running'` by adopting `live.version` (`recorder.ts:89-114`, whose comment admits this as an "ACCEPTED TRADE"). So a stale handler's side-effect facts interleave with a new dispatch's facts. Separately, `evictDaemonLockIfStale` commits the lock delete and then sweeps without holding the lock (`store-coordinator.ts:136-154`). Confidence: recorder `verified`; zombie claim loop `inferred`, though the SQL and the loop were re-read at reconciliation and double execution was not run end to end; eviction gap `inferred`. *Fix:* have the heartbeat report lock loss so the daemon stops claiming and aborts its handlers, and have the recorder retry only when the live run is still on the same dispatch.
3. **Named-thread hydration ignores thread identity.** Severity high, confidence `verified`. *Evidence:* `agent/src/handler-bridge.ts:400-406` keeps rows where `nodeId === threadId` and otherwise falls back to `ctx.messages.since(0)`, the whole run. SPEC §3.3/§3.8 says two steps share a conversation only if they share a `thread:`. So `thread: review` and `thread: impl` both receive every message in the run, which means wrong context and wasted tokens. *Fix:* pass the set of node ids that share the dispatching node's `thread:` into the handler input, filter on it, and never fall back to the whole run.
4. **Re-importing a run that is already present mutates it.** Severity high, confidence `verified`. *Evidence:* `store/src/store-bundle-import.ts:285-348`. The `already` flag is read outside the transaction and only gates `insertRunState`, `writeRunStateProjection`, `setRunStateNextSeq` and `markRunImported`. `insertEventOrIgnore`, `insertMessageOrIgnore`, `insertOutput` (INSERT OR REPLACE) and `upsertArtifact` still run, even though the comment says "re-import is a no-op". A divergent bundle adds events above `next_seq` and overwrites outputs. *Fix:* read `already` inside the write transaction and skip every per-run insert when it is true.
5. **The origin gate stops guarding on a wildcard bind and trusts an ambient env var.** This merges two surface findings. Severity high plus medium. *Evidence:* `server/src/origin-gate.ts:85` (`hostAllowed` returns true for any Host when the bind is a wildcard) and `:69-73` (the Origin only has to equal the delivered Host). A rebinding page at `http://evil.example:6767` passes both checks. `cli/src/commands/serve.ts:187` turns on `devMode` from `FRAGUA_DEV_ORIGIN` inside `startServer`, the same code the harness runs. Confidence: wildcard path `inferred` (the gate was re-read, the chain to tool execution was not traced); env var `verified`. *Fix:* on a wildcard bind, accept only loopback names and IP literals as Host, and read `FRAGUA_DEV_ORIGIN` only in `serve`'s argument parsing.

Next in line: MCP tools escape the read-only layers and E042, and resolve `${VAR}` against the full `process.env` (high, inferred; merged agent + core). After that, OCC halt escalation can run out of attempts and still return `halted: true` (`occ-append.ts:94-113`, medium, verified).

## Patterns

**P1. The fence is assumed, not enforced.** Liveness and OCC fences that the docs rely on don't actually stop the actor.
- Heartbeat result discarded; claim loop has no ownership check (daemon, inferred).
- Recorder adopts the live version, so the stale-token fence and P18 don't hold for side-effecting handlers (daemon, verified).
- OCC halt escalation and the crash net run out of attempts and still report terminal, leaving the run `running` with nothing dispatching it (`occ-append.ts:94-113`, `executor.ts:274-282`, verified).
- `max_loops` ceiling resets on every `runOne` pass because `RunTurnState.dispatches` starts at 0 (`executor.ts:305`, `run-turn-state.ts:48-53`, verified).

**P2. Decisions read outside the write lock.** A check-then-act where the check isn't serialised with the act.
- Sweep uses a bare deferred `SAVEPOINT` after unlocked scans (`sweep.ts`).
- Eviction sweeps after it has released the lock (`store-coordinator.ts:136-154`).
- `putArtifact` collision pre-read and forward `migrate()` version read happen outside a transaction (store, inferred).
- Import reads `already` outside the transaction (verified).
- `appendFact` mutates the caller's payload on output spill, so an OCC retry can skip the blob row (inferred).
- Enqueue saves the workflow row before rejections the plane doesn't pre-check: CLI `run.ts:202` before `:207-251`; server `routes.ts:459` before `:461` (verified).

**P3. Two producers of one truth, drifting.**
- Sweep quarantine vs `reducers.ts:318-324` on `activeMs` (verified).
- `WRITE_CLASS_TOOLS` (`validator.ts:98-106`) vs `ENV_MUTATOR_TOOLS` (`read-only-env.ts:25`).
- Preflight and queue backpressure are HTTP-only (`routes.ts:409-430`) and absent from CLI `run`.
- Fan-out abort mapping vs linear `planAbort` (verified).
- Scalar `choice` parsing in `yaml.ts:368-372` vs `choiceFromOptions`.
- `sweep.ts:93-97` hand-lists terminal statuses outside the enum lints.
- Inline fact choices outside the planners (low, verified).

**P4. Declared knobs that don't act.**
- Retry presets' `maxAttempts` has no reader (`retry-policy.ts:75-79`, verified).
- `intent.priority_adjusted` folds only into `routing.priority` (`intent-fold.ts:252-263`). `run_state.priority`, which the claim query sorts on (`run-state-queries.ts:599`), is set only at genesis (`reducers.ts:433`), and the fold runs only after a claim. The lens rated this inferred; reconciliation re-read verified it.
- Named `thread:` identity is ignored (verified).
- `max_loops` is per pass, not per run (verified).
- Fail, route and success back-edges are uncapped by default with no validator warning (`transition-planner.ts:515-536`, verified).

**P5. Untrusted text crosses a boundary unescaped or unvalidated.**
- Quoted shell tokens (high, inferred).
- Judge `for-each` items and `{file}` leaves are inserted without the delimiter that string state gets (`judge.ts:417,440-444`, verified).
- MCP `${VAR}` reads full `process.env` (`mcp/config.ts:108-109`, verified).
- MCP tools are appended under a pinned `allowed_tools` (`tool-assembly.ts:200-206`).
- Client `routing` at enqueue is copied unvalidated and overrides typed inputs (`plane.ts:450`; schedules omit `inputDecls`; verified).
- Output-path bracket access lets prototype keys through (inferred).
- Origin gate on a wildcard bind (inferred).

**P6. Lints match names, not semantics.**
- I1 txn-purity escapes via namespace import, façade delegation, aliasing or a named callback, and omits fs I/O (inferred).
- Sub-interface lint escapes via `SqliteStore` annotations (inferred).
- Routing-index lint keys on a `/routing$/i` binding name.
- Skill-citation lint is a comment regex.
- Decision-core lint is a line regex.
- Handler roots are chosen by directory.
- Novel-field canary injects only a literal key (inferred).

**P7. One throw takes down a fiber.**
- Supervisor's `getUnappliedIntents`/`getState` are unguarded (`supervisor.ts:94,166`, verified).
- A store error in `wakePending`/`processOperatorActions`/`claimNextRun` kills the executor loop, and `entrypoint.ts:247-251` does not abort the sibling fibers (verified).
- The schedule tick has a single try/catch around the whole tick.

## Doc drift

Refuted claims are marked **(refuted)**. Every other row is a partial claim.

| Doc says | Code says | Where |
|---|---|---|
| `evictDaemonLockIfStale` runs `startupSweep` first **(refuted)** | Guarded delete first, then sweep without the lock | `store-coordinator.ts:136-154` |
| Retry outcome commits no `node_completed` **(refuted sub-claim)** | `node_completed` is emitted; only `node_started` is swapped | `transition-planner.ts:470-476,786-805` |
| 8-way `MAX_CONCURRENT_RUNS` **(refuted sub-claim)** | No such constant; run default 16, fan-out 8 | `entrypoint.ts:99`, `fanout.ts:65` |
| ARCH §1.6: zombie stopped when its next commit fails OCC | Recorder adopts the live version and retries through | `recorder.ts:89-114` |
| Every write is BEGIN IMMEDIATE | Sweep uses a bare SAVEPOINT; forward `migrate()` is deferred and reads version outside the txn | `sweep.ts`, `migrations.ts:159-192` |
| Intents always appendable, facts OCC-checked | OCC only on `appendFact` | `store-writer.ts` |
| Routing < 8 KB pre-checked | `appendIntentWithFact` relies on the CHECK only | `store-writer.ts` |
| Message cap in bytes | Counts UTF-16 units | `store-writer.ts:549,622` |
| ARCH §9 payload guard `s.length >= N` | `utf8ByteLength` (code is right) | `store.ts:686-693` |
| P1 contiguity / P24 racing claims | Both sequential, single connection | `store.property.test.ts:41-71,769-793` |
| Sweep quarantines orphans of running runs | Paused runs with orphans are quarantined too | `sweep.ts:43-148` |
| `deriveRunState` ≡ projection | `activeMs` diverges for sweep-quarantined runs | `reducers.ts:318-324` vs `run-state-queries.ts:666-675` |
| Two sanctioned eventless writes | Import also writes the projection and `next_seq`; re-import "no-op" still writes events, outputs and artifacts | `store-bundle-import.ts:285-348` |
| SQL only in `*-queries.ts`, 13 files | 14 files; CLI holds raw SQL | `cli/src/commands/db.ts:136-159` |
| Enum lints pin every SQL status site | Terminal statuses hand-listed | `sweep.ts:93-97` |
| Bump-iff rules pinned by the canary | Canary injects only a literal key | `reducer-novel-field-canary.test.ts` |
| ExecutorOpts: `max_loops` halts | It pauses | `predispatch-planner.ts:27-40` |
| Dispatch unbounded by default | llm defaults to 4h; tool falls back to `DEFAULT_TOOL_MAX_MS`; only explicit 0 is unbounded | `auto-dispatcher.ts:62-77`, `tool.ts:85` |
| Crash net terminates the run | Bounded loop can run out without landing the fact | `executor.ts:247-284` |
| Retry-After within the cumulative cap | Retry-After bypasses the cap | `provider-retry-policy.ts:96-121` |
| Budgets enforced mid-handler | Fan-out checks only at commit boundaries | `fanout.ts:204,325-360` |
| Shutdown aborts on error | Error path rethrows without `ctrl.abort()` | `entrypoint.ts:247-251` |
| Checkout guard | Refusal lives only in the intent plane | `plane.ts:233,327` |
| `web → server → store ← daemon → core ← agent` | `store → core` is a runtime edge (cycle); core sub-entries are server-only because of `node:crypto`/`Bun.spawn` | `store/src/reducers.ts:8` |
| Enqueue validates inputs | Only when `inputDecls` is passed; explicit `routing` wins unvalidated; `choice` default is unchecked | `plane.ts:439-458` |
| Intent plane validates every write | Initial `routing` copied without `validateRoutingPatch` | `plane.ts:450` |
| Output reads fail closed | Prototype-named paths unguarded (inferred) | `outputs-substitution.ts:174-182` |
| Values crossing into prompts are wrapped | Judge `for-each`/`{file}` leaves unwrapped; tool `run:` single-quoted only | `judge.ts:417,440-444` |
| Run-level outputs live in `engine/run-output*` | That path doesn't exist | `read-plane/projections.ts:270-306` |
| Retry presets set attempts | `maxAttempts` is unread | `retry-policy.ts:72-80` |
| E042 read-only parallel branches | Name-based over bash/write/edit; ignores MCP; E041 admits judge branches | `validator.ts:93-106` |
| Operator notes trimmed to budget | Older notes dropped first; only the newest is shortened | `routing.ts:585-605` |
| Out-of-profile keys rejected | Blocklist; unlisted keys silently ignored | `outputs-profile.ts:122-158` |
| `PiLlmBackend` is the single swap surface (~10 sites) | 13 statements in 10 files plus auth-storage, env-creds, provider-tester | `agent/src` |
| Isolation violation halts `route_call_not_isolated` | Legacy reason, no longer emitted; node fails non-retryable | `exit-tools.ts`, `outcome.ts` |
| `findAbortToolCall` scans the whole transcript | Only the post-hydration slice | callers of `messages.slice(hydratedCount)` |
| Retry-After from header or body | Header only | `provider-errors.ts` |
| Stale worktree skill refused by the gate | `SKILL.md` loads via an ungated fs read; only bundled resources are refused | `skill-tool.ts` |
| MCP collisions hashed | First-wins drop | `tool-assembly.ts` |
| Tool caps | Defaults the model can raise; mutation queue keyed off `process.cwd()` | `path-utils.ts:78-85`, `tools.ts:185,281` |
| Dev origin only under `serve --dev` | Also `FRAGUA_DEV_ORIGIN` inside shared `startServer`; wildcard bind drops the Host check | `serve.ts:187`, `origin-gate.ts:85` |
| Endpoints reject 4xx before any intent | Bad priority or routing on POST /runs fails inside `commitEnqueue` after the workflow save | `routes.ts:449-470` |
| CLI reads through the read plane | Many raw store reads | `cli/src/commands/operator.ts` |
| `$FRAGUA_HOME` redirects workflow lookup | Server by-name lookup and config use `homedir()` | server `defaultWorkflowReader` |
| Store clients open with `migrate:false` | `vacuum`, `gc-blobs` and `gc` auto-migrate | `db.ts:56,63`, `gc.ts:71` |
| Web reads `server_endpoint` for its API origin | Relative `/api` | `web/src/lib/api.ts:53` |
| Harness backoff bounded at "failure N/5" | Time-gated; counter exceeds max ("failure 7/2" in test log) | `harness.ts:253-278` |
| bunfig excludes web tests; no shadows | Not excluded; vendored shadcn primitives carry shadows | `bunfig.toml`, `components/ui/` |

Doc-internal contradictions the survey flagged and the lenses did not dispute:
- ARCH §0 calls bundle import/export "pending", but it is built.
- ARCH §12.1 lists five handler kinds; there are seven.
- ARCH §4 says "four interfaces"; there are ten.
- ARCH §6.2 places `runFanout` in `executor.ts`; it is in `fanout.ts`.
- ARCH §1.3/§1.7 imply the heartbeat runs every 50 ms tick; §9 sets 5000 ms.
- `validator-codes.md` has no E054 row.

## What held up

- **Store:**
  - Per-run seq counter via `UPDATE…RETURNING` with P1 contiguity.
  - The 4 KB payload byte guard.
  - Observability events skip OCC and the reducer.
  - `claimNextRun`/`setRunTitle` as the eventless writes.
  - Routing written only inside the append transaction.
  - STRICT tables and pragmas, CHECKs, generated columns and partial indexes.
  - Contract v7 / MIN_COMPATIBLE 1 with legacy facts still folded, plus the contract-surface hash test.
  - Status mapping for `run_terminated`/`run_paused`; `checkout_released` semantics; `steering_applied` folds to unchanged.
  - Content-addressed blobs, GC roots, output index in the same txn, spill constants.
  - `imported_runs` inert gate; schedules, credentials and OAuth constraints; `CHECKOUT_HELD_SQL`.
  - `idempotencyKey` composition with intent-before-fn.
- **Daemon:**
  - Pure decision core and plan vocabulary; single producer for `dispatch_started` and the `max_loops` pause; contract-gate pause.
  - Intent-fold truth table; `ctx.signal` composition.
  - Supervisor tick, heartbeat cadence and watchdog shape.
  - `timeout_retry` on the linear path; abort-loop ceiling; goal gate.
  - Fan-out commit lane, resume, bail and leak handling; operator notes delivered to branches; snapshot service.
  - Observability buffer, operator actions, schedules, worktree provisioning, `onNodeExited`/`onRunTerminal` hooks, parallel-graph arbitraries.
- **Core:**
  - Handler discipline enforced by transitive walks; `canonicalStringify`; tool halts without env.
  - Read-only env scoping; edge selection.
  - Single-pass substitution: values are never re-scanned or cross-injected.
  - Validator codes match the docs.
  - Routing accessors; read-plane purity; the web DTO re-export.
  - `HandlerResult`/`Outcome`/`OUTCOME_STATUSES`; skill-citation lint.
- **Agent + workspace:**
  - Force-included tools and stripping rules; three-layer read-only enforcement for built-in tools; `pause_provider` mapping and rehydration.
  - Steering registry; store-backed credentials with LWW refresh.
  - Deny-by-default bash env floor; guardrail set as documented; skill tool shape.
  - `run-actions` accept/discard/diff gates and the dirty-base S/P/D flow; worktree and `--checkout` layout.
  - `backend.ts` stays under the function-length lint; cache-prefix, thinking-level and preflight tests.
- **Surface:**
  - POST /runs returns `invalid_inputs`/`provider_unavailable` 400 and `queue_full` 429 with Retry-After.
  - Same-origin gate on a loopback bind; remaining API, CLI and web conventions as surveyed.

## Critical path

| Order | Title | Why it gates the next step | Estimate |
|---|---|---|---|
| 1 | Close the untrusted-input boundaries (shell tokens, MCP, enqueue routing, origin gate) | No prerequisites, and its files don't overlap the store→daemon chain, so it lands first without conflicts. It adds the validator code and SECURITY.md rows that step 5's doc pass reconciles. | 4 days |
| 2 | Serialise store fences: sweep, eviction and import inside the write lock; sweep `activeMs` matches the reducer | Steps 3–4 change what happens when a lock is lost and a run is re-claimed. Their tests can't tell a new bug from the existing sweep/eviction/projection drift until this is fixed. | 3 days |
| 3 | Detect daemon lock loss and contain fiber failures | The dispatch fence in step 4 only holds if a daemon that lost its lock stops minting new dispatches. This step also provides the lock-loss signal step 4's tests drive. | 2 days |
| 4 | Fence recorder commits by dispatch identity; make OCC halt escalation land | This finalises the zombie and OCC semantics that the ARCH §1.6 rewrite and the `max_loops`/fan-out abort work in step 5 build on. | 3 days |
| 5 | Make declared knobs act (threads, retry presets, priority, per-run `max_loops`, fan-out abort) and reconcile doc drift | Last because the doc pass has to describe the final behaviour from steps 1–4. | 6 days |
