---
title: Cross-machine import — merge a run's events into another store
summary: "Import a run's events from one store (a CI artifact, an ephemeral fragua ci .db) into another (a central/operator store). Cheap because seq is per-run — a verbatim copy of run_state + content-addressed workflows + events, with PK-conflict handling. Requires the widened run_id (collision safety across machines) and confronts the per-run schema_version compatibility window."
status: proposed
maturity: sketch
last-reviewed: 2026-05-21
parent: cli-topology.md
---

# Cross-machine import

> Child of [`cli-topology.md`](cli-topology.md). An additive tail (`fragua db
> import`); blocks nothing. Consumes the artifact produced by
> [`fragua-ci.md`](fragua-ci.md).

## 1. Problem

`fragua ci` (and any ephemeral/remote fragua) produces a `.db` whose events are
the run's truth. To make that consumable later — feed an operator dashboard, a
central audit store, cost rollups — we need to merge one store's run into
another.

## 2. Why it's cheap

Walked against `schema.sql`: **`events` PK is `(run_id, seq)`, `WITHOUT ROWID`,
and `seq` is per-run** (`run_state.next_seq` is a per-run counter). There is no
global sequence to reassign. Importing run `R` is a verbatim copy of:

- its `run_state` row (preserving or remapping `cwd`, the only project identity —
  no `projects` table to reconcile). **After the [pre-0.1.0 cleanup](cleanup-pre-0.1.0.md)
  removes the sub-agent linkage columns (`parent_run_id`, …), a run is a single
  self-contained row again** — the run-tree FK problem an adversarial pass
  flagged disappears.
- the content-addressed `workflows` row by `sha` (identical content ⇒ identical
  sha ⇒ idempotent, no duplication);
- its `events` rows, unchanged (each `< 4096` bytes by column CHECK);
- **any `blobs` / `artifacts` rows the events reference** (`schema.sql:215,221`).
  This is the remaining real edge — the copy set is not just `events`; events
  that point at blob storage need the blobs imported too (or the import declares
  them dangling). The cleanup does *not* solve this.

`fragua db import <src.db> [--run <id>]` copies the above; on a `run_id` PK
conflict it **skips if identical / remaps if not** (remap rewrites the id across
that run's `events` rows — trivially scoped now that there are no child runs
pointing back at it).

## 3. Two preconditions

### 3.1 run_id collision safety

`run_id` is ULID-*like* today (`run-id.ts`: base-32 ms timestamp + 8 random bytes
`% 32`, ~40 bits of suffix entropy) — *"unique-enough for a single-machine
deployment."* Merging runs minted on different machines makes collisions
plausible. The [pre-0.1.0 cleanup](cleanup-pre-0.1.0.md) **already widens the
generator** (true ULID / UUIDv7, no `% 32` loss) while resetting the schema, so
0.1.0 stores mint collision-safe ids from day one. Import still detects PK
conflicts as a backstop.

### 3.2 schema-version compatibility (the limiting mechanism)

This is the real constraint on import, and worth stating precisely because it is
*latent* today.

**What it is.** Every run pins `run_state.schema_version =
CURRENT_SCHEMA_VERSION` at enqueue (`store.ts:524`; constant in
`pragmas.ts:4`, currently `17`). The executor refuses out-of-range pins at its
entry (`executor.ts:337–348`):

```
if (state.schemaVersion < MIN_COMPATIBLE_SCHEMA_VERSION   // 1
 || state.schemaVersion > CURRENT_SCHEMA_VERSION)          // 17
   → fact.run_halted { reason: "schema_drift" }
```

Migrations advance only the global `schema_version` row, never the per-run pin
(`migrations.ts:133`; run_state rebuilds copy the column verbatim). Reducers are
version-agnostic — the pin is a **pure entry gate**, never consulted during fold
(`reducers.ts`). SPEC §282: *"Runs pin a `schema_version`; mismatches halt rather
than auto-upgrade."*

**What it constrains for import.** An imported run carries its source pin. If the
source machine's `CURRENT_SCHEMA_VERSION` is **newer** than the target store's,
the imported run has `schema_version > target CURRENT` → the target daemon halts
it with `schema_drift` on any resume. (The reverse — source older — is fine while
the target's `MIN_COMPATIBLE` stays `1`.) So: **import is safe only into a store
whose binary is at least as new as the producer's** — the same rule as
"don't resume on a downgraded daemon."

**Today's reality:** with `MIN_COMPATIBLE = 1`, nothing old is ever rejected; the
only live trigger is a *newer* pin than the local binary. So this rarely bites
until (a) someone bumps `MIN_COMPATIBLE` to retire migrations, stranding old runs
permanently (no auto-upgrade), or (b) you import across machines on different
versions. See the [companion note](#4-can-the-schema-version-limit-be-lifted) on
lifting it.

## 4. Can the schema-version limit be lifted?

The pin tracks the **DB migration counter** (`CURRENT_SCHEMA_VERSION`), but most
bumps (v2…v17) are projection-level — additive columns, indexes, `run_state`
rebuilds — that **do not change `FactEvent`/`IntentEvent` payload shape or
reducer semantics**. Yet they still advance the pin, and (if `MIN_COMPATIBLE`
ever rises) could strand runs whose events are perfectly foldable.

The lever is that conflation. Options, in increasing cost:

1. **Backfill on semantics-preserving migrations.** When a migration is
   projection-only (events unchanged), advance eligible runs'
   `run_state.schema_version` to `CURRENT`. Today's conservative design declines
   to guess; but projection-only deltas are safe to backfill explicitly.
2. **Split the version axis.** Gate resume on an *event-contract version* that
   bumps only when fact/intent payloads or reducer semantics actually change
   (rare), separate from the DB migration counter. The compatibility window then
   almost never rejects; `MIN_COMPATIBLE` stays `1` essentially forever; import
   conflicts only on real contract divergence, not on DB-schema skew.
3. **Event upcasting.** Transform old-shape events to the current contract on
   read, so even genuinely-old contracts fold. Heaviest; only needed if (2)'s
   window must still admit pre-contract runs.

**This is now its own proposal: [`event-contract-version.md`](event-contract-version.md).**
It also surfaces a second defect the import lens missed — the `schema_drift`
trip is a **terminal halt**, not a recoverable pause (`halted ∈ TERMINAL`,
`reducers.ts:22`; `intent.resume` wakes only `paused_*`, `wake-pending.ts:11`),
so a *transient* version skew kills a run permanently. That proposal narrows the
gate (option 2 above) **and** makes the trip recoverable. For import's purposes:
a too-new source pin should *park* the imported run (resume when the target
catches up), not silently halt it.

## 5. Scope / dependencies / MVP

- **Depends on:** [`fragua-ci.md`](fragua-ci.md) (produces the artifact);
  widened `run_id` ([`intent-plane.md`](intent-plane.md)).
- **Wins independently:** yes — purely additive `fragua db import`.
- **MVP:** copy `run_state` + content-addressed `workflows` + `events` verbatim;
  PK-conflict skip-if-identical / remap; refuse import when the source pin exceeds
  the target's `CURRENT_SCHEMA_VERSION` (clear error, not a silent later halt).
  The schema-version *lift* (§4) is explicitly **out of MVP scope** — a separate
  proposal if the constraint proves real.
