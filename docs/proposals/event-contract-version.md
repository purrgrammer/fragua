---
title: Event-contract version — decouple resume-gating from the DB migration counter, and make version mismatch recoverable
summary: "The per-run schema_version gate conflates two things and over-punishes both. (1) It pins to the DB migration counter, which bumps on projection-only changes that never touch event/reducer semantics — so runs are gated on versions irrelevant to whether their events fold. (2) A mismatch produces fact.run_halted{schema_drift}, which is TERMINAL and unresumable — so a transient version skew (a momentarily-downgraded daemon, an imported run) kills a run permanently. Fix: gate on an event-contract version that bumps only on real fact/intent/reducer changes, and make the mismatch a recoverable pause, not a terminal halt."
status: proposed
maturity: sketch
last-reviewed: 2026-05-21
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

> The [pre-0.1.0 cleanup](cleanup-pre-0.1.0.md) collapses the historical v1→v17
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

The DB migration counter keeps doing its job (walk-forward `migrate()` for the
projection/schema); it just stops being the run-resume gate.

### 3.2 Make a mismatch a recoverable pause

When the contract gate *does* trip (genuine skew), park the run instead of
killing it:

- Emit a recoverable pause — a new `fact.run_paused` reason (e.g.
  `incompatible_engine`) → a non-terminal `paused`-class status — not
  `fact.run_halted`.
- `wake-pending` re-checks contract compatibility on wake: a `paused`
  (incompatible) run resumes automatically once a compatible daemon is present,
  or on operator `intent.resume`. (The downgrade case simply waits for a
  capable daemon; no operator action needed.)
- This removes "permanent death from a transient mismatch" without weakening the
  conservatism — an *incompatible* run still does not execute; it waits.

### 3.3 (Optional, independent) backfill on semantics-preserving migrations

A cheap partial mitigation that can land before §3.1/§3.2: when a migration is
projection-only (events unchanged), advance eligible runs' pin to `CURRENT` in
the same migration. Reduces the population of stale pins without the axis split.

## 4. Scope / dependencies / MVP

- **Depends on:** nothing structurally, but it is the right substrate *under*
  [`db-import.md`](db-import.md) — import safety becomes "contracts match," and a
  too-new import parks rather than halts.
- **Wins independently:** yes — it strictly improves resume semantics for *every*
  long-paused or version-skewed run, not just imported ones.
- **MVP options, smallest first:**
  1. **§3.2 alone** — flip `schema_drift` from terminal halt to recoverable pause
     with auto-wake on a compatible daemon. Smallest change, removes the
     "permanent death" defect immediately, keeps the existing (DB-counter) gate.
  2. **§3.1 + §3.2** — add the contract-version axis so the gate rarely trips at
     all. The full fix; needed before cross-version import is routine.
  3. **§3.3** — orthogonal backfill, land any time.

## 5. Spec impact

- **SPEC §282** currently says *"mismatches halt rather than auto-upgrade."* This
  changes to: *mismatches **pause** (recoverable) rather than auto-upgrade*; the
  gate is the **event-contract** version, not the DB schema version.
- **ARCHITECTURE §143** ("Schema drift across long pauses") updates to describe
  the contract-version window and the pause-not-halt behavior.
- **`HaltReason` / `RunStatus`** — `schema_drift` leaves the terminal halt set
  (or stays only for genuinely-unrecoverable engine errors); a new pause reason
  enters the non-terminal set. Enum-consumer sweep per CLAUDE.md §1 (the
  `cli-store-client` exit-code map, `wake-pending` reason sets, humanize labels,
  `VALID_STATUSES`).
