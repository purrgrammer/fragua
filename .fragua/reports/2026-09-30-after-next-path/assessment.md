# Assessment

fragua is a durable AI-workflow execution engine — YAML workflows compiled to a deterministic state machine driving LLM agents over a single SQLite event log, split across ten packages (`web → server → store ← daemon → core ← agent`, plus `cli`/`workspace`). **Verdict: a genuinely well-built, spec-faithful system whose *behaviour* almost always matches its docs, but whose *enforcement* (discipline lints) and *doc pointers* routinely overstate their reach — the risk is latent, not live.** Baseline is fully green: `tsc --noEmit` exit 0 across all 10 packages, `biome check` clean over 879 files, and both test runners pass (3,685 node tests / 95,442 assertions, 725 web tests, one intentional skip). Of 119 claims across five lenses, the overwhelming majority verified; the defects found are almost all defense-in-depth gaps and documentation drift, with a handful of real single-user-threat-model security footguns.

## Scores

| Axis | Score | What drove it |
|---|---|---|
| simple | 7 | God-files with no length lint outside daemon — `store.ts` (2,638 lines, SqliteStore ~100 methods) and `agent/backend.ts` (1,554 lines, `runInner` ~800 lines). Decision/effect boundary leaks: fan-out reconstructs `planLeakHalt` inline and several lifecycle facts are chosen in the driver, not a planner (Pattern C). |
| testable | 8 | Excellent test mass (daemon 2.66× test:src, 95k assertions, property tests, pure planners) — but the discipline lints that are supposed to *keep* the code testable are weaker than advertised (Pattern A): several are per-line regex or directory scans, not the AST/import-graph walks they claim. |
| observable | 9 | Event log is truth; observability events, delta-suppressed snapshots, and SSE cursors are all as specified. Only nick: `setRunTitle` is a second eventless `run_state` writer beyond the sanctioned `claimNextRun` (documented, low). |
| flexible | 7 | Real flexibility (six store sub-interfaces, intent/read planes, IR versioning) — but the headline "swap the LLM dep in one file" is false: runtime provider imports span ~10 files across agent+cli (A-1). |
| efficient | 7 | O(1) seq counter, sha256 CAS blobs, delta-suppression are all sound — undercut by unbounded reads (`windowHours` unclamped, `/analytics/runs` fans out 100×`getEvents(5000)`, `events.json` uncapped) and MCP connect/teardown churn per llm dispatch inside loops. |
| fidelity | 7 | Behaviour matches docs; *citations* frequently don't. Wrong test-file pointers (C-1), wrong module pointers (D-16, D-22, A-3 line numbers), wrong validator name (A-13 Ajv vs TypeBox), wrong skills path (A-18 `.fragua/skills`), property-matrix rows cited in the wrong package (P5/P6/P16). See Doc drift. |
| security | 6 | Two real footguns beyond the documented single-user model: the Vite dev origin `http://localhost:5173` is permanently allow-listed *including in the production binary* (Surface F3), and `judge` interpolates untrusted output/input/file content into model-visible state without the prompt-injection boundary wrapping used for llm prompts (Core F1). |

## Do now

1. **Gate the Vite dev origin behind a dev-only flag** — `verified`. `packages/server/src/origin-gate.ts` `originAllowed()` unconditionally returns `true` for `http://localhost:5173` (`VITE_DEV_PORT`), so any page on loopback:5173 can drive the unauthenticated control plane on 6767 in a shipped binary. *Fix: guard the 5173 branch on an explicit dev/env flag so the compiled binary never trusts it.*

2. **Unify the store path on `getFraguaHome()`** — `verified`. `packages/cli/src/commands/harness.ts:121` and `workflow-path.ts` `globalWorkflowsDir` use `homedir()`, while `store-client.ts` `resolveStorePath`, `providers`, `db`, `doctor` use `getFraguaHome()`; with `$FRAGUA_HOME` set, `harness` binds one store and `run` enqueues into another no daemon watches. *Fix: route every CLI store/workflow-dir resolution through `getFraguaHome()`.*

3. **Wrap untrusted values in the judge prompt path** — `verified`. `packages/core/src/handler/handlers/judge.ts` `resolveState`/`resolveList` call `substitute(...)` without `wrapValues:true`, unlike `agent/handler-bridge.ts:88`, sending `${{ outputs }}`/`${{ inputs }}`/file content to the System-One model unfenced. *Fix: pass `wrapValues:true` on the judge substitution calls so the SHA-256-derived `fragua_output` boundary applies.*

4. **Extend read-plane discipline to every run-read route** — `verified`. `packages/server/test/read-plane-discipline.test.ts` scans only `routes.ts`/`runs-routes.ts`/`sse.ts`; `routes/run-files.ts` (`store.getState`, `store.getEvents`) and `routes/projects.ts` (`store.listProjects`) read the store directly and are invisible to the lint. *Fix: add those files to the scan set and route their reads through the read plane.*

5. **Clamp the unbounded read paths** — `verified`. `routes.ts:731` `windowHours` has a fallback but no ceiling (`?windowHours=1e12` scans all history); `/analytics/runs` fans out `100×getEvents(5000)`; `events.json`/`messages` apply no server-side cap. *Fix: clamp `windowHours` to a max and give the fan-out/uncapped endpoints server-side ceilings, matching the already-clamped siblings.*

## Patterns

**Pattern A — Discipline lints claim more reach than they enforce.** The single most recurring defect class; each is latent (no live violation today) but each is a hole the codebase believes is closed.
- Store I1 transaction-purity lint follows only same-file helpers; the cross-file `*-queries.ts` functions every `writeTxn` body calls are unscanned.
- Store sub-interface lint is a per-line regex (`: IEventStore`) — a `type S = IEventStore` alias or a multi-line annotation evades it.
- Core read-plane fs-discipline is directory-scoped and matches three fs identifiers *by syntactic name*; `import { existsSync as e }` bypasses it, and its own comment claiming aliasing "can't slip past" is false. Bans no network/subprocess/async I/O.
- Core handler I/O discipline walks a directory, not the import graph; a banned call in a helper outside `handlers/` is never seen. External-side-effect check is regex, not AST.
- Server read-plane discipline omits `run-files.ts`/`projects.ts` (Do-now #4).
- Server intent-plane discipline is a per-line regex over a fixed method list; `store['enqueueRun']()` or a split call evades it — while its AST-based sibling lints do not.

**Pattern B — Decision/effect boundary leaks into the driver.** SPEC §3.11's pure-planner discipline is real for the linear path but not honoured everywhere.
- Fan-out (`fanout.ts settleBranch`) reconstructs `planLeakHalt`'s fact pair inline instead of calling the planner — a shape change in `predispatch-planner.ts` won't propagate.
- Several lifecycle facts (`run_paused{operator}`, `run_started`, `dispatch_started`, fanout `run_terminated{fanout_malformed}`, crash `run_terminated`) are chosen inline in `dispatch-turn.ts`/`fanout.ts`/`executor.ts`.
- Per-dispatch wiring (steer-merge, abort handling) is duplicated between `dispatch-turn.ts` and `fanout.ts` with divergent abort paths (`planAbort` vs raw `abortResultToFacts`).

**Pattern C — God-files with no length lint outside daemon.** The 200-line function lint is daemon-only.
- `store.ts` (2,638 lines) exposes ~100 public methods; MCP-OAuth, judge, bundle export/import, `retainPortableTables`, `metricsSnapshot` belong to no declared sub-interface.
- `agent/backend.ts` (1,554 lines) concentrates ~9 responsibilities; `runInner` alone runs ~800 lines with no equivalent lint.

**Pattern D — Duplicated seams with no shared source or equality test.**
- `newScheduleId` is byte-for-byte reimplemented in `server/index.ts` and `cli/store-client.ts`.
- Substitution grammar regexes (`INPUT_REF_RE`, `OUTPUT_REF_RE`, embedded grammars in `COMBINED_REF_RE`) are three hand-maintained literals with no test asserting they agree.
- Fan-out steer-merge (Pattern B) is a third instance.

**Pattern E — Prefix/scope over-admission (single-user threat model).**
- `bash` env floor admits *any* `FRAGUA_*`/`LC_*` ambient var by prefix, beneath the operator allow-list.
- Read/write/edit path gate realpaths the prefix then writes the lexical path (TOCTOU, `inferred`).
- Judge unfenced interpolation (Do-now #3) and the permanent Vite origin (Do-now #1) are the security-facing members.

## Doc drift

| Doc says | Code says | Where |
|---|---|---|
| LLM dep swap surface is "one file" (`backend.ts`) | Runtime provider imports span ~10 files across agent+cli | A-1 (`partial`); F1 agent |
| `judge` rows Ajv-validated on read | Validated with TypeBox `Value.Check` | A-13 (`partial`) |
| Skills discovered from `<project>/.fragua/skills` | Paths are `.agents/skills` + `.claude/skills`; `.fragua/skills` absent | A-18 (`partial`) |
| Browser-safety lint in `core/test/lint.test.ts` | Lives in `core/test/handler/discipline.test.ts`; `lint.test.ts` is the W013 lint | C-1 (`partial`) |
| Provider-retry logic checkable in `abort-planner.ts` | Lives in `transition-planner.ts` + `provider-retry-policy.ts` | D-16 (`partial`) |
| Boot fn `daemonMain`; entrypoint installs SIGTERM/SIGINT + closes store | Fn is `startDaemon`; signals + store-close are CLI (`cli/commands/daemon.ts:127`) | D-22 (`partial`) |
| `migrateTo` "backs up first" and "refuses a live daemon" | Both are CLI-layer (`fragua db`); absent from `migrations.ts` | S-15 (`partial`) |
| Read-plane discipline covers run-read routes | `run-files.ts`/`projects.ts` read store directly, unlinted | X-5 (`partial`) |
| S-25 enum lint is one-directional | Lint is bidirectional (checks `stale` **and** `missing`) — prior finding refuted | S-25 (`refuted`) |
| Property-matrix P5/P6/P16 in `store.property.test.ts` | Live in the daemon package | Store F6 |
| `claimNextRun` is the sole eventless `run_state` writer | `setRunTitle` is a second eventless writer | Store F4 |

## What held up

Verified and load-bearing, compactly: single-transaction writes with OCC via `run_state.version` and distinct `appendIntent`/`appendFact` (S-1, S-3, S-9); O(1) per-run `next_seq` shared by facts + observability (S-4, S-11); payload/routing/message size guards as byte pre-check + SQL CHECK backstop (S-5, S-6, S-8); sha256 CAS blobs with file-then-row ordering and routing-root-aware GC (S-7, S-27, S-28, S-29); startup sweep with per-run SAVEPOINT preserving paused states and `currentNode` on crash-requeue (S-12, S-13); `deriveRunState` fold agreeing with the live projection and folding `[MIN_COMPATIBLE=1, EVENT_CONTRACT=6]` (S-17, S-18, S-20); distinct schema vs contract versions with a touch-gate (S-16, S-19). Daemon: pure planners lint-pinned (D-1), driver owns effects (D-2), contract gate pauses `engine_incompatible` (D-7), intent fold (cancel wins, pause coexists) (D-8), pending-steer stash (D-9), releasable composite abort signal (D-10), `max-ms:0` opt-out (D-11), 50ms supervisor (D-12), durable-before-fn recorder (D-13), graduated timeout/abort-loop/provider-retry caps (D-14, D-15, D-16), wake sweeper (D-18), serialized fan-out lane with `fanout_joined` linearization (D-19, D-20), OCC-gated terminal snapshot before worktree dispose (D-21). Core: browser-safe main entry with server-only sub-entries (C-1, C-2), two-case edge selection with fail-to-exit graceful completion (C-4, C-5), lenient inputs / fail-closed outputs (C-6, C-7), content-derived wrapping on llm prompts (C-8), mint-time E-code rejection (C-10), single write plane (C-11, C-12), pure read plane (C-13, C-14), degrading routing accessors (C-15, C-16), five retry presets (C-17), synthesized start / reserved exit (C-18), discriminated `HandlerResult` (C-20). Agent/workspace: force-included abort/skill/emit_output/route tools with isolation enforcement (A-3–A-6), three-layer read-only enforcement (A-7), provider-status capture + `overloaded_error→529` (A-8, A-9), broadcast steering with last-agent buffer clear (A-10, A-11), store-backed credentials with per-row isolation (A-12, A-13), shared `applyAccept`/`applyDiscard` (A-17), worktree provisioning + dual snapshot refs (A-20, A-21). Surface: loopback-default bind with exposure warning (X-1), same-origin + DNS-rebind + media-type gate (X-2), typed-input/provider/backpressure validation (X-4), DB-row endpoint discovery replacing `serve.json` (X-8), store-client CLI working daemon-down (X-9, X-11), AST inline-import lint (X-10), banded `runs wait` exit codes (X-12), shared `buildExecutorDeps` (X-13), config cascade + UUIDv7 project identity (X-16, X-17), web boundary (types+core only) with widened DTOs (X-21, X-22), fail-closed export scrub exit-80 (X-23), `deriveRunState`-on-import (X-24).

## Critical path

1. **Unify store-path resolution on `getFraguaHome()`** — foundational: until every CLI/harness surface agrees on which store file it opens, no downstream fix or test can be trusted (a `$FRAGUA_HOME` operator validates against a store no daemon watches). Unblocks reliable end-to-end verification of every subsequent step. Estimate: 0.5 day.
2. **Harden the discipline-lint family to AST + import-graph + full file coverage** — must precede the boundary/security fixes so those fixes are enforced and can't silently regress; a regex lint that can't see the violation can't protect the fix. Unblocks step 3. Estimate: 2 days.
3. **Close the boundary violations the hardened lints now surface** — direct store reads in `run-files.ts`/`projects.ts`, cross-file `writeTxn` purity, exit-tool isolation consistency, and the fan-out `planLeakHalt`/lifecycle-fact leaks. Depends on step 2 to stay fixed. Estimate: 2 days.
4. **Ship the security hardening** — dev-gate the Vite origin, add `wrapValues` to judge, tighten the `FRAGUA_*` env prefix; each lands with a regression test the step-2 lints (and origin-gate tests) now anchor. Estimate: 2 days.
5. **Reclaim efficiency and split the god-files** — clamp `windowHours`/analytics/events reads, add an agent-package function-length lint, then split `backend.ts`/`store.ts` along their now-lint-enforced seams. Last because it is the largest, lowest-urgency work and benefits from the lint hardening. Estimate: 4 days.
