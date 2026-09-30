# Assessment

fragua is a durable AI-workflow execution engine: YAML workflows compile to a deterministic state machine that drives LLM agents across providers and lands every transition as `intent.*`/`fact.*` events on a single SQLite event store, replayable by a pure reducer. **Verdict: a disciplined, invariant-heavy codebase whose claims hold up under source verification — the real risk is not correctness of the happy path but a handful of resilience, fold-consistency, and injection gaps that the otherwise-excellent lint wall does not yet defend.** Baseline is green: `tsc --noEmit` exit 0 across all ten packages, biome exit 0 (896 files), node suite 3760 pass / 1 skip / 0 fail (322 files), web suite 725 pass (93 files). No lens refuted a claim; every divergence is a `partial` that resolves to doc drift.

## Scores

| Axis | Score | What drove it |
|---|---|---|
| simple | 7 | Small seams, lint-enforced discipline — but the fan-out driver re-implements planner logic inline (max_loops, dispatch_started, seed routing-patch: daemon F3–F5) and OutputProfile has twin compilers (core F2), both drift surfaces. |
| testable | 8 | Very high leverage (daemon 2.65× test:src, property tests P1–P32, an AST-lint wall). Docked because the P4 projection≡fold property never drives the sweep path that violates it (store F2), and several lints have coverage holes (patterns below). |
| observable | 7 | Full event log + observability buffer + snapshots. Docked: `setRunTitle` mutates the projection with no event so a title is not replayable (store F3), and the recorder's orphaned-handler interleave window is documented-but-unregistered (daemon F6). |
| flexible | 7 | Clean provider/env swap seams — but the "one-file swap surface" claim is false: the pi-ai SDK has runtime imports in ~8 agent files plus cli/test-utils (agent F1). |
| efficient | 7 | O(1) per-run seq (I10), cursor SSE. Docked mainly by MCP connections being torn down and re-established on every llm dispatch with no pooling (agent F2). |
| fidelity | 6 | Code is honest but docs overstate: supervisor "one short transaction" (D6), `daemonMain` name (D12), single-file SDK swap (A1), "skill on every call" (A2), plus stale serve.json/rendezvous comments and a mislabelled W006/E006 code. |
| security | 6 | Same-origin-only authority is a known gap, but two live holes remain: judge `for-each` item content reaches the model unfenced while authored state is fenced (core F1), and `POST /runs` accepts an unvalidated `priority` number (surface F2). Path gate is check-then-use TOCTOU (agent F4, inferred). |

## Do now

1. **Harden the executor and supervisor loop heads against a single throw (daemon F1 + F2, medium, verified).** `executor.ts runExecutor` calls `wakePending` / `processOperatorActions` / `claimNextRun` with no try/catch; `supervisor.ts` calls `getUnappliedIntents` and `getState` inside the per-run loops unguarded. A single malformed row or transient store error unwinds the fiber — the executor throw exits the daemon, the supervisor throw stops the 5s heartbeat and lets the lock TTL lapse. Fix: wrap each per-run/per-tick store call in a try/catch that logs and skips the offending run, re-throwing only truly fatal errors, matching the file's stated "never crash the daemon" invariant.

2. **Make the sweep-quarantine projection fold identically to the reducer (store F2, medium, verified).** `reducers.ts fact.run_quarantined` runs `closeDispatchInterval` (adds `now - dispatchStartedAt` to `metrics.activeMs`); `UPDATE_RUN_STATE_QUARANTINED_BY_SWEEP_SQL` nulls `dispatch_started_at` but never touches the metrics column, so `getState()` reports a lower `activeMs` than `deriveRunState()` — a P4 breach no test covers. Fix: route sweep quarantine through the same reducer arm (or replicate `activeMs` accumulation in the SQL) and extend the P4 property to drive `startupSweep`.

3. **Fence judge `for-each` item content before it reaches the judging model (core F1, medium, verified).** `judge.ts resolveList` deliberately omits `wrapValues`; items merge into plan state under `JUDGE_FOR_EACH_ITEMS_KEY`, get `JSON.stringify`'d, and are sent as `req.state` — while authored state goes through `substitute(..., wrapValues:true)`. A laundered array item carrying judging instructions is unfenced. Fix: apply the same content-derived delimiter wrapping to for-each items (or fence them at the state-assembly boundary), and add an injection test.

4. **Validate `priority` on the HTTP enqueue path (surface F2, medium, verified).** `routes.ts POST /runs` forwards `body.priority` straight to `plane.buildEnqueue` with no finite/integer/range check; the CLI guards with `Number.parseInt`+`Number.isFinite` but the web path's only backstop is the `INTEGER NOT NULL` STRICT column, which yields a raw store-error 400 for `Infinity`/fractional instead of a clean `invalid_inputs`. Fix: validate priority in the plane's enqueue builder so both clients reject it uniformly with `code:"invalid_inputs"`.

5. **Close the blob-GC read-then-delete race for live routing inputs (store F1, medium, inferred).** `gcBlobs` calls `selectAllRoutings` + `getAllOutputStructs` outside any transaction, builds the protected set, then `deleteOrphanBlobs`; a concurrent `enqueueRun` that commits a routing-referenced blob after the root read but before the delete can have its live input collected, breaking a later rehydrate. Fix: take the root snapshot and the delete inside one `BEGIN IMMEDIATE` (or re-check each candidate's referencing rows under the lock before deleting).

## Patterns

**P-A — Daemon loop reads crash the whole process.** Unguarded store calls in the two long-lived fibers turn one bad row into a full outage. Instances: executor loop head (daemon F1), supervisor intent-detection + stuck-node watchdog (daemon F2).

**P-B — Fold/projection divergence (breaks "events are truth" / P4).** The SQL projection and the reducer disagree, and no property covers it. Instances: sweep quarantine `activeMs` (store F2); `setRunTitle` writes `run_state.title` with no event, so title is lost on re-projection (store F3).

**P-C — Inline fact construction bypassing the decision core (I12 drift).** The fan-out driver reconstructs fact payloads the planners own, creating divergence surfaces. Instances: `max_loops` pause triplicated in `fanout.ts poolDispatch` (daemon F3); `fact.dispatch_started` inline with hardcoded `resumeOf:'paused'` vs the planner's `deriveResumeOf` (daemon F4); `run_started`/seed routing-patch assembled inline in `startRun`/`seedFrontier` (daemon F5).

**P-D — Twin implementations kept in sync by hand.** Logic duplicated across two maintained sites. Instances: OutputProfile schema-gen vs hand-rolled value validation (core F2); origin gate + read/intent planes instantiated at multiple composition roots (surface F5); skill/judge tool reconciliation inline in `backend.ts` despite the tool-assembly split (agent F5).

**P-E — Discipline lints narrower than the invariant they defend.** The lint wall is strong but has enumerable holes. Instances: SQL-location regex misses `INSERT OR IGNORE/REPLACE INTO` (store F4); I1 txn-purity lint follows only relative imports and keys on literal callee names (store F5); W013 whitelist scanned by regex not AST (core F3); core browser-safety has no transitive `node:`/`bun:` import-graph walk (core F4); `HandlerResult.halt.reason` has no drift guard (core F5); read-plane discipline lint's `SCANNED_FILES` omits `run-snapshots.ts` and `skills-routes.ts`, which do raw `store.getState`/`listCwds` (surface F1); web package boundary enforced by package.json alone, no lint (SF17).

**P-F — Check-then-use TOCTOU (inferred, single-user threat model).** Static races requiring concurrent activity. Instances: blob-GC root read vs delete (store F1); path gate symlink swap between `resolvePath` and the fs op (agent F4).

## Doc drift

| Doc says | Code says | Where |
|---|---|---|
| Supervisor ticks "inside one short transaction" (heartbeat/detectNewIntents/detectStuckNodes) | Three separate store reads per tick, no transaction; no methods by those names | ARCH §1.3 → `supervisor.ts` (D6 partial) |
| Boot sequence `daemonMain` | Exported symbol is `startDaemon`; only the opts type is `DaemonMainOpts` | ARCH §6 → `entrypoint.ts` (D12 partial) |
| pi-ai swap surface is "deliberately one file" (`PiLlmBackend`) | Runtime SDK imports in ~8 agent files + cli (3) + test-utils (1) | SPEC §1 → `agent/src/*` (A1 partial, agent F1) |
| `skill` tool force-included "on every llm call" | Catalogue-gated; stripped when `effectiveSkills.length === 0` | SPEC §3.2 / AGENTS rule 12 → `backend.ts` runInner (A2 partial) |
| `ServerEndpointRow` "replaces serve.json"; `fragua run` uses "the discovery file's URL" / "rendezvous" | Discovery is the `server_endpoint` DB row only; `fragua run` is a direct store-client, no HTTP discovery | types.ts:406, index.ts:243, serve.ts:130, health.ts:9 (surface F3, F4) |
| `// W006: cycles without an exit…` | Block actually pushes `code:'E006'`; W006 absent from validator-codes.md | `validator.ts:730` (core F6) |
| Recorder orphaned-handler interleave window (status-only fence) | Real, documented in an "ACCEPTED TRADE" comment, but not in the SPEC §3 known-gap register | `recorder.ts` (daemon F6) |

## What held up

All 81 lens claims verified against source (17 store S1–S19, 17 daemon D1–D17, 14 core C1–C14, 12 agent/workspace A1–A12, 19 surface SF1–SF19); the only qualifications are the six `partial` rows above. Confirmed structural guarantees: single-transaction writes with events+projection together (I1/S1); intents always-appendable vs OCC-checked facts (I3/S2); O(1) per-run seq counter (I10/S4); per-SAVEPOINT crash-sweep isolation + orphan quarantine before requeue (S5/S6); pure reducer folding the full `[1,6]` contract range with legacy arms (S7/S8); the 8 KB routing CHECK and pre-txn guard (S15); file-then-row blob ordering (S16); `imported_runs` as the single inert dispatch/capacity/sweep gate (S19); pure decision-core planners with a lint confining I/O to drivers (D1); deterministic cancel-wins intent fold (D4); side-effect-intent committed before `fn()` (D7); graduated timeout/abort-loop/provider-retry policies (D8/D16); OCC-fenced zombie daemon with no loop-internal lock check (D15); browser-safe core entry (C1); lenient-inputs/fail-closed-outputs substitution (C4); read-plane purity with a no-syscall test (C7); three-layer read-only enforcement (A3); verbatim credential storage with no `!cmd`/env resolution (A6); baseline-only bash env with credential refusal (A7); the loopback same-origin gate chain end-to-end (SF1/SF6) and the react-query / plane-discipline / DTO-widening conventions (SF16/SF4/SF18).

## Critical path

1. **Daemon loop resilience** — nothing else matters if the daemon can die on one bad row; must be solid before other daemon-area edits land. Est: 0.5 day.
2. **Restore fold/projection equality** — re-establishes "events are truth" / P4, the invariant the rest of the store trusts and that the widened lint (step 5) will assert. Est: 1 day.
3. **Centralize fan-out fact construction into the planners** — removes the P-C drift surfaces in the same driver files touched in step 1; do after resilience so the two edits don't collide. Est: 1–1.5 days.
4. **Close injection + input-validation holes** — judge fencing and priority validation are independent security hardening that should land before the lint wall is tightened to guard them. Est: 1 day.
5. **Widen the discipline lints and fix doc drift** — pins every corrected behaviour above (SQL regex, read-plane `SCANNED_FILES`, browser-safety walk, halt-reason drift) and clears the stale comments; last because it asserts the now-corrected state. Est: 1.5 days.
