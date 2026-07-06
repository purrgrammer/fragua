# Typed wrapper struct for `run_state.routing` — DRAFT proposal

> **Status: IMPLEMENTED.** Shape decided (option (c): typed wrapper struct,
> reserved namespaces) and shipped as a **typed accessor layer over unchanged
> on-disk bytes** (no reshape, no schema migration, no contract bump) at
> `packages/core/src/routing.ts`. Eight validate-and-degrade accessors
> (`getInputs`, `getFrontier`, `getBudget`, `getRetry`, `getGoalGate`,
> `getLimits`, `getTimer`, `getContext`) are the live implementation.
> §1–§5 are the grounding; **§6 is the concrete design** — it answers Q1–Q5
> and folds in all five panel rulings. The full original `propose` draft +
> panel transcript persist in that run's event log.


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
`frontier` / `timer` / …) — where "wrapper struct" names a typed *view* over the
unchanged bytes (the decoded namespaces + a documentary `RoutingStruct` schema),
**not** a reshape of the column. The on-disk form stays flat + dotted; the column
has dynamic, runtime-keyed entries (`retry_count.<nodeId>`,
`budget_override.<scope>.<metric>`) and so is intrinsically an open record with no
closed struct to be lifted to (§6 spells this out). The view is realised as
namespace-level accessors — distinct from option (a)'s per-key read accessors (the
`readActiveNodes` generalisation the appraisal leans toward) by carrying typed
per-namespace views + the schema, and from option (b)'s whole-object TypeBox
`Check` at the fold boundary by validating on read, never in the txn. The draft designs (c) in
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

---

## 6. The design

**The chosen realisation of decision (c): a typed accessor layer over unchanged
on-disk bytes.** `run_state.routing` stays the flat, dotted JSON the reducer
writes today. Namespaces are a *typed view*, not a reshape — a `@fragua/core`
module exports the key constants (one source of truth), validate-and-degrade
accessors, and a documentary `RoutingStruct` TypeBox schema. Writes keep going
through the existing key-wise `routingPatch` spread.

**Why the accessors *are* the lift, not a fallback to dodge a migration.** The
on-disk form is not a struct-shaped object and never can be: its load-bearing
keys are *dynamic*, keyed by runtime values — per-node retry counters
(`internal.retry_count.<nodeId>`), per-(scope, metric) budget overrides
(`budget_override.<scope>.<metric>`), per-gate outcomes (`goal_gates.<nodeId>`),
per-node max-retries (`max_retries_override.<nodeId>`). A map keyed by arbitrary
node ids has no closed struct to be lifted to; the honest static type of the
column is, and stays, an open string-keyed record. The thing that *does* have a
fixed shape is the **decoded namespaced view** (`inputs / frontier / budget /
retry / goalGate / limits / timer / context`) — and that is exactly what
`RoutingStruct` describes and what the accessor return types (`BudgetView`,
`RetryView`, `GoalGateView`, …) hand back, folding each family of dynamic keys
into a typed lookup (`getRetry(routing).count(nodeId)`,
`getBudget(routing).override(scope, metric)`). So "lift the data structure to a
proper type" decomposes into two parts: the part with a fixed shape (the view) is
typed; the part with dynamic keys (the storage) is intrinsically a `Record` and
there is nothing to lift it to. The accessors are the lift — they turn the flat
dynamic-key map into the typed view at the one boundary where the type matters,
the read.

**This needs neither a schema migration nor a contract bump — and not because
we're dodging the cost.** `routing` is a `run_state` *projection*, not an emitted
event payload, so Ground Rule 11's fold-all-versions machinery (which governs the
append-only log) does not apply to *retyping* it: the bytes don't move, the
reducer's fold reads are unchanged, and because routing has only ever grown
additively (optional namespaces) every historical blob reads identically through
the accessors. This also keeps I1 (no validation in the txn), I6 (no byte
growth), and the blob-spill/GC paths intact. A genuine reshape-on-disk (nesting
the dotted keys into literal namespace objects) would cost a re-snapshot of every
live run and a *larger* byte footprint under the 8 KB cap — while still leaving
the dynamic per-node keys as `Record`s inside the nesting, so it would not even
close the typing gap the accessors already close. We reject it: real cost, for a
serialization change that buys nothing the accessors don't.

### 6.1 The accessor module (`packages/core/src/routing.ts`) — answers Q1, Q5

A single module both writers (key constants) and readers (accessors) route
through. It exports:

- **Key constants / builders** — the dotted-key vocabulary as named exports:
  `INPUTS_KEY`, `ACTIVE_NODES_KEY`, `AUTO_RESUME_AT_KEY`, `retryCountKey(node)`,
  `timeoutRetriesKey(node)`, `PROVIDER_RETRY_ATTEMPT_KEY`,
  `budgetOverrideKey(scope, metric)`, `BUDGET_WARNED_KEY`,
  `maxRetriesOverrideKey(node)`, `MAX_LOOPS_OVERRIDE_KEY`,
  `MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY`, `goalGateOutcomeKey(node)`,
  `GOAL_GATE_RETRIES_KEY`, `GRAPH_GOAL_KEY`. Today these literals live scattered
  across `executor-helpers.ts` / `goal-gate-policy.ts` / planners; this gathers
  them.
- **Typed accessors**, each a *typed view* assembled by reading the relevant
  dotted keys with validate-and-degrade (generalising `readActiveNodes`):

  | accessor | reads (keys) | returns | degrade |
  |---|---|---|---|
  | `getInputs(routing)` | `inputs` | `Record<string, unknown>` (own props only) | non-object → `{}`; `__proto__` key filtered; entry still an un-materialized `$fragua_blob` ref dropped (verbatim parity with `readInputMap`) |
  | `getFrontier(routing)` | `internal.active_nodes` | `string[] \| null` | element-validated → `null` (= no fan-out). This **is** `readActiveNodes`, relocated. |
  | `getBudget(routing)` | `budget_override.*`, `__budget_warned` | `{ override(scope,metric): number\|undefined; warned: ReadonlySet<string> }` | per-key `typeof === "number"` else undefined; warned non-array → ∅ |
  | `getRetry(routing)` | `internal.retry_count.<n>`, `internal.timeout_retries.<n>`, `internal.provider_retry.attempt` | `{ count(n); timeoutRetries(n); providerAttempt }: number` | `Number.isFinite` else `0` |
  | `getGoalGate(routing)` | `goal_gates.<n>`, `goal_gates.__retries` | `{ outcome(n): OutcomeStatus\|undefined; retries: number }` | outcome value-checked against `OUTCOME_STATUS`; retries finite else `0` |
  | `getLimits(routing)` | `max_loops_override`, `max_goal_gate_retries_override`, `max_retries_override.<n>` | `{ maxLoops; maxGoalGateRetries; maxRetries(n) }: number\|undefined` | finite else undefined (→ caller falls back to attrs) |
  | `getTimer(routing)` | `internal.auto_resume_at` | `number \| undefined` | `typeof === "number"` else undefined |
  | `getContext(routing)` | `graph.goal`, `graph.run_id` | `{ goal: string\|undefined; runId }` | `typeof === "string"` else undefined |

  **Per-node keys stay flat-dotted on disk** (`internal.retry_count.<nodeId>`);
  the accessor presents them as a function (`getRetry(routing).count(nodeId)`),
  not a materialised `Record`, so there is zero reshape and no prefix-scan cost
  on the hot path.

- **`RoutingStruct`** — a documentary TypeBox schema describing the logical
  namespaces, used by the accessors' value-checks and as the single place the
  shape is written down. Per **ruling 3**, the `inputs` slot is
  `Type.Record(Type.String(), Type.Unknown())` — **no recursive `InputValue`
  tower**, no `BlobRefSchema`/`InputScalar` TypeBox nodes (`getInputs` is
  annotation-only and never `Value.Check`s a deep tree). `OUTCOME_STATUS` stays a
  value-checked union (it *is* exercised by `getGoalGate`).

### 6.2 Where validation runs — answers Q2

On **read**, in the accessors — never in the write txn. On-disk stays flat+dotted
(no fold-semantics change). Writes are unchanged: planners/intent-fold build the
same `routingPatch`, the txn body stays a key-wise spread + pure SQL (I1 intact;
no `Compile`/`Check` reachable from `writeTxn`). The accessors are exactly the
typed form of today's ad-hoc inline casts, so a pre-wrapper run's bytes read
identically.

### 6.3 Fail-safe posture — answers Q3: **degrade everywhere, no pause**

Every namespace degrades to the *conservative authored default*, and crucially
none of those degrades can let a run exceed an authored bound:

- frontier → `null` (no fan-out; self-heals on re-derive).
- **budget override → undefined ⇒ the run falls back to the *lower* authored
  cap.** This was Q3's worry ("could a corrupt override let a run overspend?") —
  the answer is no: an override only ever *raises* a ceiling via operator intent,
  so losing it makes the run pause *sooner*, never overspend. Degrade is safe.
- retry / timeout / provider counters → `0` (re-counts from scratch; bounded by
  the same caps).
- limits overrides → undefined ⇒ authored `max_*` attrs apply.
- goal-gate outcome → undefined ⇒ gate treated unsatisfied (re-runs, bounded by
  cap); retries → `0`.

No namespace warrants pause-with-reason; pause would be *less* safe than the
conservative default in every case.

### 6.4 Migration & contract — answers Q4 (folds in **ruling 1**)

- **No `schema.sql` change** — column + 8 KB CHECK stay; no `fragua db migrate`.
- **No `EVENT_CONTRACT_VERSION` bump.** `applyFact`'s fold reads/writes are
  unchanged (it still only touches `internal.active_nodes`, now via the relocated
  `getFrontier`). The new accessors are read-side, called by the
  executor/policies, **not by the fold**. Relocating `readActiveNodes` into the
  accessor module means `reducers.ts` imports it — which trips the
  contract-touch-gate; since the fold *behaviour* is byte-identical this is a
  legitimate `// contract: no-bump — relocate frontier reader, fold unchanged`.
- **Ruling 1 (genesis sanitize: dropped).** There is no seam to strip a tampered
  bundle's `routing` before persistence without breaking events-are-truth or
  `run_state.routing == deriveRunState(events)`. `store.ts` hydration stays a
  plain `JSON.parse`; an imported run's persisted `routing` remains exactly
  `deriveRunState(events)`, degraded *only on read* by the accessors. Pacing
  namespaces (budget/limits/retry overrides) are intent-folded, not
  fold-rederived, so a bundle re-import legitimately doesn't re-materialise them —
  already true today, and safe (they default conservative).
- **Legacy runs never brick.** The accessors read the same flat dotted bytes
  live runs already carry; degrade-to-default covers any malformed legacy shape.

### 6.5 The single seam + its lint — folds in **rulings 2, 4, 5**

The migration is mechanical because every raw `routing[...]` index moves behind
the accessor module. The readers to convert (Q5):
`executor-helpers.ts` (`readInputMap`/`nodeRetryCount`/`readBudgetWarned`/`readBudgetOverrides`/`buildSubstitutionArgs`/override-key helpers),
`budget-policy.ts`, `goal-gate-policy.ts` (`readGoalGateRetries`/`readGateOutcomes`),
`transition-planner.ts` + `abort-planner.ts` (patch construction reads),
`reducers.ts` (`readActiveNodes`, genesis seed), `handler-bridge.ts:93`
(`graph.goal`), **`@fragua/cli` `ci.ts:87`** (`auto_resume_at`), and
`store.ts` (spill/GC/`materializeRouting`).

- **Ruling 2 — `getInputs` guard parity.** It preserves all three guards
  verbatim from `readInputMap`: the `__proto__` key filter, the per-entry
  un-materialized-`$fragua_blob` drop, and object-or-`{}`. A regression test
  asserts an input named `__proto__` is dropped *identically* by `getInputs` and
  the legacy `readInputMap`.
- **Ruling 4 — honest seam count.** `routing-blobs.ts` (`spillRoutingInputs`,
  `gcBlobs`) indexes `routing["inputs"]` by literal — make it import the exported
  `INPUTS_KEY` so it routes through the one constant rather than a fourth raw
  literal. The single-seam lint then has exactly two sanctioned raw-index sites:
  the accessor module itself, and the reducer's frontier write (both documented).
- **Ruling 5 — `@fragua/cli` blast radius.** `ci.ts:87` reads
  `routing[AUTO_RESUME_AT_KEY]`; it routes through `getTimer` (or the re-exported
  constant). `@fragua/core` keeps re-exporting `AUTO_RESUME_AT_KEY` so `ci.ts`'s
  import source is unchanged.
- **Enforcement:** a discipline lint (mirroring the new
  `decision-core-discipline` test) bans raw `routing[` / `.routing[` indexing
  outside the accessor module + the two documented exceptions — so the seam
  can't silently erode.

### 6.6 The cap becomes a tripwire (I6)

With routing read through bounded, typed accessors, the 8 KB CHECK stops being a
budget the code is designed against and becomes a *defense-in-depth tripwire*
that should never fire in correct operation. Keep the CHECK; reframe I6 in
`SPEC.md` as a backstop (it catches a payload leaking into a variable-length
namespace), not a functional limit. (This is the cap-as-tripwire decision raised
alongside this work — it lands here, not as a separate change.)

### 6.7 Implementation phases

1. **Spec-first:** update `SPEC.md`/`ARCHITECTURE.md` §2.1 — the typed-routing
   contract (accessors are the read surface; on-disk stays flat dotted) + I6 as a
   tripwire.
2. **Accessor module:** `packages/core/src/routing.ts` — key constants +
   `RoutingStruct` + the eight accessors, each generalising its existing reader,
   validate-and-degrade. Tests, incl. the `__proto__` parity test (ruling 2) and
   a legacy-flat-bytes degrade test.
3. **Migrate readers** (Q5 list) to the accessors; delete the ad-hoc casts.
   `reducers.ts` `readActiveNodes` → `getFrontier` with the `// contract: no-bump`
   marker; `routing-blobs.ts` → `INPUTS_KEY` (ruling 4); `ci.ts` → `getTimer`
   (ruling 5).
4. **Discipline lint** banning raw `routing[...]` outside the seam (§6.5).
5. `bun run ci` green; no schema migration, no contract bump.
