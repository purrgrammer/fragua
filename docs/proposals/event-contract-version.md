---
title: Event-contract version — decouple resume-gating from the DB migration counter, and make version mismatch recoverable
summary: "The per-run schema_version gate conflates two things and over-punishes both. (1) It pins to the DB migration counter, which bumps on projection-only changes that never touch event/reducer semantics — so runs are gated on versions irrelevant to whether their events fold. (2) A mismatch produces fact.run_halted{schema_drift}, which is TERMINAL and unresumable — so a transient version skew (a momentarily-downgraded daemon, an imported run) kills a run permanently. Fix: gate on an event-contract version that bumps only on real fact/intent/reducer changes, and make the mismatch a recoverable pause, not a terminal halt."
status: proposed
maturity: sketch
last-reviewed: 2026-05-22
parent: cli-topology.md
---

# Event-contract version

> Child of [`cli-topology.md`](cli-topology.md). Spun out of
> [`db-import.md`](db-import.md) §4 (option 2). Touches SPEC §282 and
> ARCHITECTURE §143 — a contract change, not just code.

## 1. The mechanism today

Every run pins `run_state.schema_version = CURRENT_SCHEMA_VERSION` at enqueue
(`store.ts:524`; `pragmas.ts:4`, currently `17`). The executor gates on it at
entry (`executor.ts:337–348`):

```
if (state.schemaVersion < MIN_COMPATIBLE_SCHEMA_VERSION   // 1
 || state.schemaVersion > CURRENT_SCHEMA_VERSION)          // 17
   → fact.run_halted { reason: "schema_drift" }; return terminal
```

Two facts establish that this is a pure gate:

- Migrations advance only the global `schema_version` row, **never** the per-run
  pin (`migrations.ts:133`; run_state rebuilds copy the column verbatim).
- Reducers are version-agnostic — `foldFacts` never reads `schemaVersion`
  (`reducers.ts`). The pin is consulted *only* at the executor's entry, before
  any fold or dispatch.

SPEC §282: *"Runs pin a `schema_version`; mismatches halt rather than
auto-upgrade."*

## 2. Two defects

### 2.1 Wrong axis — it tracks the DB counter, not the event contract

`CURRENT_SCHEMA_VERSION` bumps on **every** migration, but most migrations are
projection-level — additive columns, indexes, `run_state` rebuilds — that do
**not** change `FactEvent` / `IntentEvent` payload shape or reducer semantics. A
run's events fold identically before and after such a bump. Yet the pin advances
and the gate widens regardless, gating runs on a number unrelated to whether
their events are interpretable.

> The pre-0.1.0 cleanup (shipped) collapsed the historical v1→v17
> chain into a **single baseline at version 1**, so there is no legacy
> projection-bump history and no stranded-old-run population to reason about at
> 0.1.0. This defect is therefore about *future* migrations: without the axis
> split, the very first post-0.1.0 projection-only migration re-introduces it.
> The cleanup buys a clean slate to land the right axis on — not a reason to skip
> it.

### 2.2 Wrong response — the trip is terminal, not recoverable

`fact.run_halted{reason:"schema_drift"}` sets status `halted`, which is in
`TERMINAL = {"completed","cancelled","halted"}` (`reducers.ts:22`).
`intent.resume` only wakes the three non-terminal pause statuses
(`wake-pending.ts:11`; `events.ts:154`); there is no "un-halt." So a halted run
is **permanently dead** — re-running means re-enqueuing from scratch.

The condition that trips the gate, however, is *recoverable*: a downgraded daemon
gets upgraded; an imported run lands on a store that later catches up; a retired
migration gets restored. **The response outlives the cause.** A transient skew
should not be a death sentence.

## 3. The fix

### 3.1 Gate on an event-contract version

Introduce `EVENT_CONTRACT_VERSION`, separate from the DB migration counter, that
bumps **only** when `FactEvent`/`IntentEvent` payload shapes or reducer semantics
actually change — a rare event. Runs pin *that*. The executor gates on it:

- The window almost never rejects, because contract changes are rare while DB
  migrations are frequent.
- `MIN_COMPATIBLE` (in contract terms) can stay at the floor essentially forever.
- Cross-store import ([`db-import.md`](db-import.md)) conflicts **only** on real
  contract divergence, not on DB-schema skew.
- **Operator-visible.** `fragua --version` and `fragua daemon status` print
  `event-contract vN` alongside the binary version, so an operator debugging a
  stuck-on-resume run reads the supported contract version directly instead of
  grepping source. Cheap to land with the constant.

The DB migration counter keeps doing its job (walk-forward `migrate()` for the
projection/schema); it just stops being the run-resume gate.

### 3.2 Make a mismatch a recoverable pause

When the contract gate *does* trip (genuine skew), park the run instead of
killing it:

- Emit a recoverable pause — the `fact.run_paused` reason `incompatible_engine`
  → a non-terminal `paused`-class status — not `fact.run_halted`.
- **Two arms, two statuses — the reducer sets the status from which side of the
  `[MIN_COMPATIBLE, CURRENT]` window the pin falls on** (the gate's axis: the
  DB-counter in §3.2-alone, the contract version after §3.1). Same pause reason,
  different wake behavior:
  - *Pin > `CURRENT`* (too new — a downgraded daemon, or a newer-producer import
    awaiting a binary upgrade): `paused_auto`. `wake-pending` retests compatibility
    each tick, re-parks while still incompatible, and auto-resumes once a capable
    daemon runs — **no operator action**.
  - *Pin < `MIN_COMPATIBLE`* (too old — the floor ratcheted past it): `paused`,
    **no auto-wake**. It can never heal by waiting (the floor only moves forward),
    so it needs an explicit `intent.resume` after the operator rebuilds from source
    or cancels.
- This removes "permanent death from a transient mismatch" without weakening the
  conservatism — an *incompatible* run still does not execute; it waits.
- **`schema_drift` is dropped from the terminal `HaltReason` enum** in the same
  change — `incompatible_engine` replaces it, it does not coexist (§5). Nothing
  unrecoverable remains behind it: corruption is a different failure mode, and a
  version skew heals via upgrade/downgrade.

### 3.3 What forces an `EVENT_CONTRACT_VERSION` bump

The contract surface is precisely **the events `foldFacts` reads and how it folds
them**: `FactEvent`/`IntentEvent` payload shapes, the enumerated reason/status
literals decision logic switches on, and reducer semantics. The discriminating
question for *any* change is one thing — **would a daemon at the prior contract
version, folding a stream containing this change, produce a different or erroneous
`run_state`?**

| Change | Bump? | Why |
|---|---|---|
| New fact / intent type | **yes** | old daemon doesn't fold it → wrong projection |
| New field on an existing payload | **iff a fold path reads it** | a field nothing folds is fold-invariant; a read field diverges old-vs-new — see the two-case note |
| Remove a fact type | **yes** | old daemon may still emit / expect it |
| New pause / halt reason | **yes** | decision logic, `wake-pending`, exit-code map enumerate the literal |
| Reducer behaviour change (same schema) | **yes** | the fold itself changed |
| New observability event | **no** | not folded — projection / UI only |
| New projection column / index / `messages` change | **no** | off the fold path |

**The two cases people get wrong, both resolved by fold-direction:**

1. **A new field on an existing fact — bump iff a fold path reads it, not because it
   was added.** A field nothing folds yields an identical `run_state` on every daemon
   → no bump. A field a reducer reads diverges old-vs-new (the old daemon drops it) →
   bump. Required-vs-optional is a **red herring** for bump-worthiness — it governs
   only how a *new* daemon tolerates *old* events that lack the field (the
   backward-compat handling of §3.4), never whether the version moves. Mechanically:
   adding the field trips the surface hash (field shapes are in scope, below), forcing
   the decision; a reader landing in the same PR also trips the `reducers.ts` gate →
   bump; if nothing reads it, re-snapshot with a `no-bump` marker and the bump defers
   to the future PR that adds the reader.
2. **Observability event additions — no bump, despite being additions to the event
   log.** Not because they are small: because `foldFacts` never reads them — same
   reason `messages` and projection columns are off-contract.

**Enforcement — force the decision, don't trust memory.** A per-PR judgment call
rots into "bump on everything" or "never bump." The structural surface is made
mechanical instead: a discipline test (in the shape of
`store/test/lint.test.ts`) snapshots a hash of the compiled TypeBox
`FactEvent`/`IntentEvent` schema set plus the enumerated reason/status arrays, and
**fails the build when that hash changes unless `EVENT_CONTRACT_VERSION` and the
snapshot move in the same diff.** The test does not *decide* the bump — it converts
the failure mode from "silently forgot" into "build red until you consciously choose
bump vs. re-snapshot-only." A false positive (a field reorder) is cheap to clear;
the test has **no false negatives for structural change**, which is the dangerous
direction. The residue the hash cannot see — a reducer-semantics change with an
unchanged schema (the canonical case: a reducer that *starts reading a
previously-ignored field* without the surface moving) — is narrowed the same way: any
PR touching `reducers.ts` must either bump `EVENT_CONTRACT_VERSION` or carry a
`no-bump` marker. Two mechanical gates; no reliance on anyone remembering the table.

**The two tests own disjoint scopes — declared, not assumed.**

*Contract-surface hash — parse-free over serializable declarations:*

- **In:** the `FactEvent`/`IntentEvent` variant *set* **and each variant's full
  TypeBox shape** (field names, types, required/optional); the enumerated literal
  arrays (`RunStatus`, `HaltReason`, pause reasons — every literal decision logic
  switches on).
- **Out:** reducer source of any kind (bodies *and* dispatch-arm membership),
  comments, formatting, helpers, test code, observability / `messages` / projection
  schema.

*`reducers.ts` touch-gate:* owns everything the hash is blind to that still affects
the fold — the entire reducer implementation, **including which dispatch arms exist**
and what each body reads.

The boundary is "what determines whether a fact written by daemon X folds correctly
on daemon Y." Two deliberate calls: (1) the hash includes field **shapes**, not just
the type set, so a field whose *type* changes under an already-reading reducer — which
need not touch the reducer text — still trips a gate; (2) dispatch-arm membership lives
in the gate, **not** the hash — putting it in the hash would force the hash to parse
reducer source (fragile, and it breaks disjointness), and any arm change already
touches `reducers.ts`, so the gate covers it.

**Annotation format (pinned once).** Both no-bump escapes use one inline marker —
`// contract: no-bump — <reason>` — at the site of the change: in `reducers.ts` for
the touch-gate, adjacent to the snapshot file for a re-snapshot. Inline keeps the
rationale next to what it explains and surfaces in `git blame`; the CI check is a
single diff-line match. No central log, no PR-description coupling.

### 3.4 Backward-compatibility invariant + `MIN_COMPATIBLE` ratchet

**Backward-compat invariant (this is what makes forward-ratcheting safe).** A daemon
at contract version `V` must fold-correctly **every** stream pinned at any version in
`[MIN_COMPATIBLE, V]`. Only the *downgrade* direction parks — a daemon **older** than
a run's pin. A current daemon never parks on an older run. Corollary: a new daemon may
**not** delete the reducer code paths for any contract version ≥ `MIN_COMPATIBLE`;
old-shape handling lives until the floor ratchets past it.

**`MIN_COMPATIBLE` ratchets only by deliberate act.** Advancing the floor strands every
run pinned below it permanently, so it is never a side effect of a refactor. It moves
only in a dedicated commit that (a) names the contract versions being dropped, (b)
confirms no supported run population — **including importable artifacts**
([`db-import.md`](db-import.md)) — pins below the new floor, and (c) removes the
now-dead old-version reducer paths. A snapshot test pins `MIN_COMPATIBLE`'s value, so
any change to it is a conscious, reviewed diff — same discipline as §3.3's
contract-surface hash.

### 3.5 (Optional, independent) backfill on semantics-preserving migrations

A cheap partial mitigation that can land before §3.1/§3.2: when a migration is
projection-only (events unchanged), advance eligible runs' pin to `CURRENT` in
the same migration. **Near-moot at 0.1.0** — the clean-slate baseline (single
version, no stale-pin population) leaves nothing to backfill; keep it in reserve for
the first future projection-only migration. Low priority.

## 4. Scope / dependencies / MVP

- **Depends on:** nothing structurally, but it is the right substrate *under*
  [`db-import.md`](db-import.md) — import safety becomes "contracts match," and a
  too-new import parks rather than halts.
- **Wins independently:** yes — it strictly improves resume semantics for *every*
  long-paused or version-skewed run, not just imported ones.
- **Sequence (a gated order, not a size menu):**
  1. **§3.2 — precursor, ship now (alongside [`intent-plane.md`](intent-plane.md)).**
     ~30 lines: flip the gate's *response* from a terminal `schema_drift` halt to a
     recoverable `incompatible_engine` pause with auto-wake on a compatible daemon,
     and drop `schema_drift` from the terminal enum. Keeps the existing DB-counter
     gate (axis unchanged). Removes the "permanent death from a transient mismatch"
     defect immediately **and** lets `cli-store-client`'s exit-code taxonomy land in
     its final post-fix shape rather than being rewritten once the response changes.
     The contract-surface hash (§3.3) does not exist yet at this step; its baseline
     snapshot is taken from the **post-§3.2** surface (after `schema_drift` removal +
     `incompatible_engine` addition) — nobody retroactively snapshots the pre-§3.2
     state.
  2. **§3.1 + §3.3 + §3.4 — the axis split, before [`db-import.md`](db-import.md).**
     Introduce `EVENT_CONTRACT_VERSION`, the bump checklist + its mechanical
     enforcement (§3.3), and the backward-compat / ratchet discipline (§3.4) so the
     gate rarely trips and cross-store import conflicts only on real contract
     divergence. Surface the version operator-side (§3.1) and take the first hash
     baseline here. This is the substrate import safety stands on.
  3. **§3.5 — backfill, near-moot at 0.1.0.** No stale-pin population on the
     clean-slate baseline; hold for a future projection-only migration.

## 5. Spec impact

- **SPEC §282** currently says *"mismatches halt rather than auto-upgrade."* This
  changes to: *mismatches **pause** (recoverable) rather than auto-upgrade*; the
  gate is the **event-contract** version, not the DB schema version.
- **ARCHITECTURE §143** ("Schema drift across long pauses") updates to describe
  the contract-version window and the pause-not-halt behavior, and records the
  **backward-compat invariant** (§3.4): a daemon at `V` folds every stream in
  `[MIN_COMPATIBLE, V]`; only downgrade parks; old reducer paths live until the
  floor ratchets past them.
- **`HaltReason` / `RunStatus`** — `schema_drift` is **removed** from the terminal
  `HaltReason` enum (not retained "for unrecoverable engine errors" — there is no
  residual; §3.2); the `incompatible_engine` pause reason enters the non-terminal
  set. Enum-consumer sweep per CLAUDE.md §1 (the `cli-store-client` exit-code map,
  `wake-pending` reason sets, humanize labels, `VALID_STATUSES`).
- **Two discipline tests ship with the axis split (§3.1):** the contract-surface
  hash snapshot (§3.3) and the `MIN_COMPATIBLE` value snapshot (§3.4) — both fail
  the build on an undecided change to what they pin.
