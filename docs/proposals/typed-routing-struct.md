# Typed wrapper struct for `run_state.routing` — DRAFT proposal

> **Status: DRAFT (parked).** From a `propose` run that did not converge — it hit
> its goal-gate loop cap with the design SHAPE decided (option (c): a typed
> wrapper struct with reserved namespaces) but five precision items from the
> panel critique still open (see *Open items* at the end). The body below is the
> run's grounding/decision doc; the full draft prose + panel transcript persist
> in the original run's event log. Soundness verdict: **sound** — the open items
> are precision fixes, not design flaws. Pick this up when implementing routing
> typing (and the cap-as-tripwire decision discussed alongside it).


Grounding for the design draft. The author reads this instead of re-deriving the
landscape each revision. Shape is DECIDED — option (c), a typed wrapper struct
with reserved namespaces. This doc maps every current mechanism, invariant, and
seam the draft must respect.

---

## 1. The problem and the decision to settle

`run_state.routing` is a single `TEXT` column holding an unschematized JSON dict
(`schema.sql:52` — `routing TEXT NOT NULL CHECK (length(routing) < 8192)`). It
carries load-bearing per-run dispatch state across heterogeneous, flat,
dot-delimited keys, guarded only by an 8 KB byte cap. Every dispatch-driving key
except the fan-out frontier is read with an ad-hoc inline cast
(`typeof v === "number" ? v : 0`, `as string`, etc.). A mis-folded patch — a key
written with the wrong type, or a tampered-bundle import — degrades silently
into a wrong dispatch decision (a skipped budget gate, a corrupt retry counter,
a lost frontier).

`routing` in memory is typed `Record<string, unknown>` (`reducers.ts` —
`RunState.routing`, `applyFact` spreads it; `store.ts:318`
`JSON.parse(row.routing) as Record<string, unknown>`). There is **no schema**
between the JSON column and the readers.

**Decision (do not re-open):** introduce a TypeBox-schematized wrapper struct
with reserved namespaces per subsystem (`inputs` / `budget` / `retry` /
`frontier` / `timer` / …). Not per-key read accessors (option a, the
`readActiveNodes` generalisation the appraisal leans toward), not a whole-object
TypeBox `Check` at the fold boundary (option b). The draft designs (c) in
detail and answers the five sub-questions: the namespace shape, where validation
runs, per-namespace fail-safe posture, migration/back-compat, and blast radius.

---

## 2. Current mechanisms (file:line)

### 2.1 The column + the two write seams

- **Column + cap:** `packages/store/src/schema.sql:52`
  `routing TEXT NOT NULL CHECK (length(routing) < 8192)`. Byte cap re-checked in
  app code at `store.ts` `writeProjection` (`store.ts:2272-2276`,
  `MAX_ROUTING_BYTES`) and at enqueue (`store.ts:741-744`).
- **Seam A — reducer fold:** `packages/store/src/reducers.ts`. `applyFact`
  shallow-copies `routing: { ...state.routing }` per fact, and only ever mutates
  the frontier key `internal.active_nodes` (`ACTIVE_NODES_ROUTING_KEY`,
  `reducers.ts:14`). Cases that touch it: `fact.dispatch_started`,
  `fact.node_completed`, `fact.node_aborted`, `fact.fanout_started`,
  `fact.fanout_joined`. `genesisToInitialState` seeds `routing: payload.routing`
  from the genesis `intent.run_enqueued` (`reducers.ts`, in
  `genesisToInitialState`).
- **Seam B — `routingPatch` option on `appendFact`:**
  `store.ts:595-600` — `state.routing = { ...state.routing, ...opts.routingPatch }`.
  This is the daemon materialising applied intents + retry/abort bookkeeping. A
  shallow key-wise merge; no validation.
- **Serialization point:** `writeProjection` (`store.ts:2271-2272`)
  `JSON.stringify(state.routing)` — runs INSIDE the `writeTxn` closure (called at
  `store.ts:608`). See §3 for why the I1 lint does not flag it and why that
  matters for option (b) vs (c).

### 2.2 Every routing key, its writer, its reader, its current degrade

| key | type | writer | reader (cite) | current degrade |
|---|---|---|---|---|
| `inputs` | object (may hold `$fragua_blob` refs) | genesis seed (`store.ts:768`), spilled by `spillRoutingInputs` (`routing-blobs.ts:83`) | `readInputMap` (`executor-helpers.ts:225`), `buildSubstitutionArgs` (`executor-helpers.ts:213`) | non-object → `{}`; stray blob-ref dropped |
| `internal.active_nodes` | `string[]` \| absent | fold (`reducers.ts` fanout cases) | `readActiveNodes` (`reducers.ts:17`) | element-validated → `null` (no fan-out) |
| `internal.auto_resume_at` | number | `transition-planner.ts:744,752`, `abort-planner.ts:149`, `wake-pending` | `ci.ts:87`, wake-pending sweep | `typeof v === "number"` else undefined |
| `internal.retry_count.<nodeId>` | number | `transition-planner.ts:738`, retry block | `nodeRetryCount` (`executor-helpers.ts:110`), `result-to-facts.ts:322` | `Number.isFinite` else `0` |
| `internal.timeout_retries.<nodeId>` | number | `abort-planner.ts:149` (`timeoutRetryKey`, `abort-planner.ts:25`) | abort-planner / executor | inline numeric coerce |
| `internal.provider_retry.attempt` | number | `transition-planner.ts:752,762` (`PROVIDER_RETRY_ATTEMPT_KEY`, `provider-retry-policy.ts:26`) | `transition-planner.ts:522,761` | `readNumber` else `0` |
| `budget_override.{run,node}.{cost,tokens}` | number | intent-fold of `intent.budget_adjusted` | `readBudgetOverrides` (`executor-helpers.ts:140-167`) | per-key `typeof v === "number"` filter |
| `__budget_warned` | `string[]` | `executor.ts:1220`, `transition-planner.ts:733` (`BUDGET_WARNED_KEY`, `executor-helpers.ts:35`) | `readBudgetWarned` (`executor-helpers.ts:151`) | non-array → empty set |
| `max_retries_override.<nodeId>` | number | intent-fold (`intent-fold.ts:200`) | executor (`maxRetriesOverrideKey`, `executor-helpers.ts:45`) | inline coerce |
| `max_loops_override` | number | intent-fold (`intent-fold.ts:218`) | executor (`MAX_LOOPS_OVERRIDE_KEY`, `executor-helpers.ts:41`) | inline coerce |
| `max_goal_gate_retries_override` | number | intent-fold | goal-gate policy (`MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY`, `executor-helpers.ts:42`) | inline coerce |
| `goal_gates.<nodeId>` | OutcomeStatus string | transition-planner (gate completion) | `readGateOutcomes` (`goal-gate-policy.ts:44`) | value-set check (`success`/`fail`/`retry`) |
| `goal_gates.__retries` | number | transition-planner | `readGoalGateRetries` (`goal-gate-policy.ts:37`) | `Number.isFinite` else `0` |
| `graph.goal` | string | `executor.ts:702` (start patch from `graph.attrs.goal`) | `handler-bridge.ts:93` (agent ctx) | `typeof v === "string"` else undefined |

`CONTEXT_VARS` (`packages/core/src/types/context.ts:13-15`) maps `run_id →
graph.run_id`, `goal → graph.goal` — the namespace prefix convention these keys
already follow informally.

### 2.3 Blob spill (§0 path the wrapper must preserve)

`packages/store/src/routing-blobs.ts`: only string values under
`routing.inputs` are spill-eligible (`spillRoutingInputs:83`). Per-value cap
`PER_VALUE_SPILL_BYTES = 1024` (`:26`); margin `ROUTING_SPILL_MARGIN_BYTES =
3072` (`:29`). Spilled values become `BlobRef = { $fragua_blob: <sha>, bytes }`
(`:38`, `makeBlobRef:62`). `materializeRouting` (`:205`) deep-resolves refs on
read; `collectRoutingBlobShas` (`:238`) feeds `gcBlobs` root protection
(`store.ts:2202-2213`). The spill runs at enqueue BEFORE the txn (`store.ts:732`)
so a crash leaks an orphan file, not a dangling row. Any wrapper must keep
`inputs` (a) blob-spill-eligible and (b) walkable by `collectRoutingBlobShas`.

### 2.4 routingPatch construction (the daemon side)

Patches are built in `transition-planner.ts` (`buildPlan` accreting
`routingPatch` across `:728-787`), `abort-planner.ts` (`:147-155`), and merged
key-wise (plan wins) in `executor-helpers.ts` `mergeFanoutAppendOpts`
(`executor.ts:152-158`). `intent-fold.ts` produces a `routingDelta` that the
planner folds in. The patch is always a flat `Record<string, unknown>` whose
keys are the dotted strings above.

---

## 3. Invariants and contracts implicated

- **I6 — `run_state.routing` ≤ 8 KB** (`SPEC.md:292`; `ARCHITECTURE.md:32`;
  `schema.sql:52`). The wrapper must still serialize under 8 KB; the byte CHECK
  and `MAX_ROUTING_BYTES` re-check stay. A nested namespaced object is *larger*
  per byte than the flat dotted form (`{"budget":{"override":{"run":{"cost":1}}}}`
  vs `{"budget_override.run.cost":1}`) — the draft must weigh the byte budget,
  especially against the static-but-wide fan-out frontier (`ARCHITECTURE.md:388`).

- **I1 — every store write is one txn; no `await` / `JSON.stringify` inside a
  txn body** (`SPEC` invariant; enforced `packages/store/test/lint.test.ts`).
  **Critical nuance:** the lint is a *coarse regex over the literal text between
  `.transaction(() => {` braces* (`lint.test.ts` `txnBodies`). It does NOT follow
  function calls. So `writeProjection`'s `JSON.stringify(state.routing)`
  (`store.ts:2272`) already runs under the write lock today and *passes the lint*
  because it sits behind a method call. This is the trap option (b) fell into in
  spirit, not letter: a whole-object `TypeBox.Check`/`Compile` at the fold
  boundary would add CPU under the write lock even while escaping the literal
  lint. The draft's job (sub-question 2) is to show the wrapper constructs +
  validates the typed struct BEFORE the txn (where `routingPatch` is built, or at
  the intent-fold/planner seam) and stores only an already-serialized / already
  -typed value inside — keeping the txn body pure SQL + a key-wise spread, exactly
  as `store.ts:595-600` is now.

- **I11 — fan-out frontier is log-derived diagnostic, never an authority**
  (`SPEC.md:297`; `ARCHITECTURE.md:383,524`). The active set
  (`internal.active_nodes`) must remain a pure fold of `fanout_started` +
  per-branch `dispatch_started`/`node_completed`/`node_aborted`. Property suite
  P32 (`ARCHITECTURE.md:524`) asserts only those facts mutate the frontier and
  every other fact leaves it byte-identical, and that `applyFact` never mutates
  its input. A wrapper struct must not break this: the frontier namespace is
  fold-output, and the reducer's shallow-copy discipline has to survive.

- **Trust model (`ARCHITECTURE.md §2.1`, lines 142-151), quoted:**
  > "`routing` is a projection cache, not a second source of truth. It is
  > written only inside the same transaction as an event append (I1), through
  > exactly two seams … Readers therefore treat the dict as trusted and opaque:
  > no validation on read. The one read path reachable by untrusted bytes — a
  > tampered bundle fed through `fragua import` — element-validates and degrades
  > to a safe default (`readActiveNodes`)."

  And the rebuild guarantee:
  > "Corruption is recoverable, not load-bearing: the whole `run_state` row,
  > `routing` included, is disposable. `deriveRunState` reconstructs it by
  > replaying the run's event log … Nothing lives *only* in `routing`."

  The "why not normalize" paragraph (`:150`) is the bar the wrapper must clear:
  the value of `routing` is that new engine features (fan-out frontier,
  provider-retry counter) landed *without a schema migration*. A wrapper that
  reintroduces per-feature migration friction loses that property.

- **I11 / fold-all-versions (ground rule #11, `AGENTS.md`):** "Emit the newest
  contract version; FOLD all versions." A stricter validator MUST NOT brick
  in-flight runs whose `routing` predates the wrapper. Degrade-to-default must
  cover legacy *flat dotted* shapes; the reducer + read plane fold
  `[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` forever. Never
  pause/fail a run *solely* because its routing is in the old shape.

- **Contract touch-gate (`scripts/check-contract-bump.sh`):** any diff touching
  `packages/store/src/reducers.ts` must either bump `EVENT_CONTRACT_VERSION`
  (`pragmas.ts`) or carry an inline `// contract: no-bump — <reason>` marker.
  Rationale: a reducer that starts *reading a previously-ignored field* changes
  fold semantics invisibly to the contract-surface hash. The draft must decide
  (sub-question 4) whether the wrapper changes fold semantics. If the genesis
  seed's shape or the frontier fold changes how `applyFact` reads/writes
  `routing`, that is a fold-semantics change → bump. If the wrapper is purely a
  read-side typing of the same bytes (the dotted keys stay on disk), it can be
  no-bump. This is the single highest-leverage decision in the proposal.

---

## 4. Prior art / doors left open

- **`readActiveNodes` (`reducers.ts:17`)** is the validate-and-degrade prototype
  the whole proposal generalises. Element-validated, degrades to `null`. Its
  doc comment names the exact threat model: "the only non-typed write path is a
  tampered bundle fed through `fragua import`." This is the template for
  per-namespace fail-safe (sub-question 3): frontier degrades to "no fan-out."

- **`docs/proposals/fan-out-nodes.md`** (Model A) put the frontier in `routing`
  *deliberately* to avoid a schema migration — cited in `reducers.ts:7-13` and
  `ARCHITECTURE.md:150`. The door it left open: the frontier is the one key with
  a real validate-and-degrade reader; everything else got ad-hoc casts. The
  proposal closes that gap.

- **`docs/proposals/recoverable-budget-pause.md`** (Stage 3) introduced
  `budget_override.*`, `max_retries_override.*`, `max_loops_override`,
  `max_goal_gate_retries_override` as operator-recoverable pacing keys folded
  from intents (`ARCHITECTURE.md:167-170`; `intent-fold.ts:200,218`). These are
  the `routingPatch`/`routingDelta` keys §2.1 of `ARCHITECTURE.md` calls "operational
  pacing state rather than fold outputs" — the pure fold does NOT re-materialize
  them, only their provenance (the intents) stays in the log. This bifurcation
  (fold-derived keys vs pacing keys) is the natural namespace seam the wrapper
  should reflect, and it bears on sub-question 4: pacing namespaces are NOT
  reconstructed by `deriveRunState`, so a bundle re-import legitimately loses
  them (acceptable — they default safe).

- **`docs/proposals/archive/event-contract-version.md`** defines the
  `EVENT_CONTRACT_VERSION` axis + the resume gate (`SPEC.md:309`) and the touch
  -gate rationale (§3.3). Read before deciding the bump in sub-question 4.

- **Struct-spill prior art (`routing-blobs.ts:STRUCT_INLINE_MAX_BYTES`,
  `maybeSpillStruct`)** shows the established "construct + spill + validate
  outside the txn, store a tiny ref inside" pattern already used for structured
  `outputs:` (`store.ts:545-560`). The wrapper's "validate before the txn" answer
  can lean on this exact precedent.

- **The `$fragua_blob` spill (`ARCHITECTURE.md:17`, `routing-blobs.ts`)** only
  ever touches `inputs`. A namespaced wrapper that moves `inputs` keeps spill
  trivial; a wrapper that reshapes `inputs` internals breaks `spillRoutingInputs`
  (it reads `routing["inputs"]` as a flat string map, `routing-blobs.ts:99`) and
  `collectRoutingBlobShas`'s GC roots. Door: keep `inputs` shape byte-stable.

---

## 5. Constraints the design must respect + open questions for the draft

### Binding constraints

1. **Validation runs outside the write txn.** Construct + TypeBox-check the
   typed struct at the patch-construction seam (intent-fold / transition-planner
   / abort-planner) or in a pre-txn step in `appendFact`/`enqueueRun`; the txn
   body stays a key-wise spread + pure SQL (I1; `lint.test.ts`). Do not add a
   `Compile`/`Check` call reachable from inside `writeTxn`.
2. **Serialize under 8 KB.** Whatever nesting the namespaces add, the worst-case
   (wide fan-out frontier + many per-node retry counters + warn tags) stays
   under `MAX_ROUTING_BYTES`. Quantify the byte overhead of namespacing vs the
   current flat dotted keys.
3. **Preserve the blob-spill + GC-root paths.** `inputs` stays spill-eligible
   and `collectRoutingBlobShas`-walkable; the wrapper must not hide refs from GC.
4. **Fold all versions; never brick legacy runs.** Reads of a pre-wrapper flat
   dotted `routing` blob must degrade to the typed default, not fail. The
   migration is read-tolerant by construction.
5. **Single writer assumption holds.** `routing` has one writer (the daemon
   fold); corruption is a mis-fold, not a race (`ARCHITECTURE.md:146`,
   single-coordination-surface). The wrapper hardens against mis-fold, not
   concurrency.

### Open questions the draft must answer

- **Q1 (shape).** Name the reserved namespaces and the TypeBox type under each.
  Candidate split following the fold-output vs pacing seam:
  `inputs` (genesis seed, spillable), `frontier` (fold-derived: active set),
  `budget` (overrides + warn tags), `retry` (per-node retry + timeout + provider
  attempt counters), `goalGate` (per-gate outcomes + retarget count + cap
  override), `limits` (max_loops / max_goal_gate overrides), `timer`
  (auto_resume_at), `context` (graph.goal / graph.run_id). Map all 14 keys in
  §2.2 to a home. Decide: do dotted-per-node keys (`retry_count.<nodeId>`)
  become a `Record<string, number>` under a namespace, or stay flat?
- **Q2 (where validation lands).** On write (construct typed struct, check, then
  serialize before the txn — the lean) vs on read (keep storing
  `Record<string, unknown>`, validate-and-degrade per namespace on every read,
  the `readActiveNodes` generalisation). Note these are not exclusive: the
  cheapest safe design may keep the on-disk bytes flat+dotted (no fold-semantics
  change, no contract bump) and put the typing entirely on typed *accessor*
  modules that validate-and-degrade — i.e. shape (c)'s *type discipline* without
  changing the column's serialization. The draft must pick and justify against
  I1 + the contract gate.
- **Q3 (fail-safe per namespace).** Decide degrade-vs-pause per namespace.
  Precedent says degrade (frontier → no fan-out; budget overrides → fall back to
  graph/node attrs; retry counters → 0; warn tags → empty). Ask whether any
  namespace warrants pause-with-reason instead — e.g. a corrupt *budget override*
  that degrades to "no override" could let a run overspend; a corrupt *frontier*
  is self-healing via re-derive. Justify each.
- **Q4 (migration + contract).** Decide: does the wrapper change `applyFact`
  fold semantics (→ `EVENT_CONTRACT_VERSION` bump + re-snapshot) or is it a
  read-side retype of identical bytes (→ `// contract: no-bump`)? Address how
  live runs' existing flat `routing` blobs read under the wrapper (read-tolerant
  default), and confirm `deriveRunState` + bundle import still rebuild (pacing
  keys legitimately not re-materialized — already true today,
  `ARCHITECTURE.md:148`). Decide whether `schema.sql` changes at all (the lean:
  no — keep the column + 8 KB CHECK, change only the in-app typing), which avoids
  a `fragua db migrate` step entirely.
- **Q5 (blast radius).** Enumerate every reader to migrate to typed accessors:
  `executor-helpers.ts` (`readInputMap`, `nodeRetryCount`, `readBudgetWarned`,
  `readBudgetOverrides`, `buildSubstitutionArgs`, override-key helpers),
  `budget-policy.ts` (via its `BudgetInput`), `goal-gate-policy.ts`
  (`readGoalGateRetries`, `readGateOutcomes`), `transition-planner.ts` +
  `abort-planner.ts` (patch construction), `reducers.ts` (`readActiveNodes`,
  genesis seed), `handler-bridge.ts:93` (`graph.goal`), `ci.ts:87`
  (auto_resume_at), `store.ts` (spill/GC/`writeProjection`/`materializeRouting`),
  the auto-titler seed (`executor.ts:593-597`). Scope it as a single accessor
  module (`@fragua/core`) that all of the above route through — the seam that
  makes the migration mechanical and the discipline enforceable.

### Recommended framing for the draft

The lowest-risk realisation of decision (c) is **a typed accessor layer + a
TypeBox `RoutingStruct` schema, with the on-disk serialization unchanged** (still
the flat dotted JSON the reducer already writes). Namespaces are a *typed view*
(`getBudget(routing)`, `getFrontier(routing)`, …) that validate-and-degrade per
namespace — generalising `readActiveNodes` — while writes continue to go through
the existing key-wise `routingPatch` spread. This keeps I1 (no validation in the
txn), I6 (no byte growth), the blob-spill/GC paths, and avoids both a schema
migration and (if `reducers.ts` fold reads are unchanged) a contract bump. The
draft should weigh this against a true reshape-on-disk wrapper and state the
trade explicitly; the reshape buys a cleaner serialization but costs a contract
-version decision and a read-tolerant legacy-fold path for every live run.

---

## Open items (panel critique — resolve before landing)

1. **Drop the genesis-time budget sanitize claim.** No seam exists to strip
   before persistence without violating events-are-truth or
   `run_state.routing == deriveRunState(events)`. An imported run's persisted
   `routing` stays exactly `deriveRunState(events)`, degraded only on read via
   per-namespace getters; keep `store.ts` hydration a plain `JSON.parse`.
2. **Specify `getInputs` guards verbatim against `readInputMap`** — all three:
   the `__proto__` key filter, the per-entry `$fragua_blob` un-materialized-ref
   drop, and object-or-`{}`. Add a regression test that an input named
   `__proto__` is dropped identically by `getInputs` and `readInputMap`.
3. **Cut the recursive `InputValue` TypeBox tower** → `Type.Record(Type.String(),
   Type.Unknown())`; drop `InputValue`/`BlobRefSchema`/`InputScalar` as TypeBox
   nodes (keep `InputValue` only as a documentary TS alias). `OUTCOME_STATUS`
   stays (it is value-checked by `getGoalGate`).
4. **Reconcile the single-seam lint exception count.**
   `spillRoutingInputs`/`gcBlobs` read `routing["inputs"]` by literal — a third
   production index. Either add an exported `INPUTS_KEY` constant routed through,
   or document `routing-blobs.ts` as a third allow-list exception.
5. **Fix the `@fragua/cli` blast-radius gap.** Add `@fragua/cli` to the
   per-package enumeration; move the `ci.ts (autoResumeAt)` entry there; keep
   `@fragua/core` re-exporting `AUTO_RESUME_AT_KEY`.
