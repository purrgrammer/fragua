---
title: Event payload versioning + upcast (retire run schema-pinning)
status: proposed
maturity: designed
last-reviewed: 2026-05-20
---

# Event payload versioning + upcast

> "Events are truth" (AGENTS.md ground rule 5). But today a run **pins** the
> DB `schema_version` it started on, and the executor *halts* it with
> `fact.run_halted { reason: "schema_drift" }` if it ever resumes outside the
> `[MIN_COMPATIBLE_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION]` window. If events
> are truth, a historical event must stay replayable **forever** — a run
> should never become un-runnable because the engine moved on. This proposal
> versions event payloads and **upcasts** old events to the current shape on
> read, so the reducer only ever sees current-shape events and no run strands.
> Retires the run-pin + drift-halt. Sibling to
> [workflow-ir-storage](./workflow-ir-storage.md) (the two halves of "version
> tracking").

## What's wrong with run schema-pinning

The pin conflates two unrelated axes:

- **DB table DDL** (`migrations.ts` deltas — add a column, widen an enum).
  These walk forward on open and never strand a run; the daemon already
  resumes any run whose pin is in `[1, CURRENT]`. This part is fine.
- **Event payload / reducer contract** (a `fact.*` payload changes shape, or
  the reducer reinterprets a field). *This* is the real hazard — replaying an
  old event against a new reducer could mis-fold `run_state`. The pin + halt
  is a fail-loud guard for it: refuse rather than silently corrupt.

The guard is currently **dormant** (`MIN_COMPATIBLE=1`, `CURRENT=15`, so
nothing halts) — it only bites the day we raise `MIN_COMPATIBLE`, i.e. declare
"runs older than X are no longer replayable." That declaration is the design
smell: an event-sourced core shouldn't have an expiry date on its log.

## Design

1. **Tag every event with a payload version.** Add `payload_version INTEGER`
   to `events` (and `daemon_events`), defaulting to the current version for
   each `type` at write time. Versioning is **per event type** — `fact.run_paused`'s
   payload evolves independently of `fact.node_completed`'s — so the version
   is interpreted as `(type, payload_version)`.
2. **Upcasters.** A registry `upcast[(type, fromVersion)] : (payload) → payload`
   that bumps one version. Chain `n → n+1 → … → current`. Pure functions, no
   I/O. A removed event type upcasts to a tombstone the reducer skips.
3. **One decode boundary.** The store's event *reader* applies the upcast
   chain before returning any event. Nothing downstream — reducer, `run_state`
   rebuild, SSE replay, `events.json`, the steps fold, drift-lint — ever reads
   a raw stored payload. This single funnel is the invariant that makes the
   scheme safe; a second un-upcasted read path silently reintroduces the bug.
4. **Events stay immutable.** The upcast runs **on read**, every read; the
   stored row keeps its original `(payload_version, payload)` forever. We do
   **not** rewrite history to "settle" it — that would violate append-only.
   The cost is perpetual read-time transformation of old events; the benefit
   is the log is never mutated and any version can always be reconstructed.
5. **Retire the run-pin.** Delete the `schema_drift` halt
   (`executor.ts:364`) and the run-pinned `schema_version` gate. The DB-table
   `schema_version` + `migrations.ts` stay — table DDL is the orthogonal axis.

New events are always written at current version, so a run's upcast burden is
only its *historical* events and shrinks to zero for runs started after the
latest bump.

## Adversarial pass

1. **Upcasters are append-only forever-maintenance.** Every breaking payload
   change ships an `(n → n+1)` and it's kept indefinitely. Miss one and an old
   run mis-replays *silently* (worse than today's loud halt). → Mandatory
   golden-event fixtures: one captured payload per `(type, version)`, a test
   that upcasts each to current and asserts the reducer output. CI fails if a
   `type`'s current version has no upcast path from every prior version.
2. **A single raw read path defeats it.** If any consumer reads
   `events.payload` without going through the decode boundary, it sees stale
   shapes. → Enforce with a lint (no direct `payload` deref outside the
   reader) the way `lint.test.ts` already guards write-transaction purity.
3. **The 4 KB payload cap vs. upcast growth.** An upcast that enriches an old
   payload could exceed `MAX_EVENT_PAYLOAD` *in memory*. That's fine for the
   reducer (in-memory only, never re-persisted — decision 4), but anything
   that re-emits an upcast result (e.g. SSE) must not assume it fits the cap.
   → Upcasts target the in-memory shape, not a re-storable one; document that
   the cap applies to *writes*, not to upcast output.
4. **Removed event types.** Deleting a `fact.*` entirely needs its upcast to
   map old occurrences to a reducer no-op, not to vanish (a gap would shift
   nothing, but a throw would strand the run). → "tombstone" target shape the
   reducer explicitly ignores; never delete the upcast.
5. **Reducer determinism / OCC.** Replay must stay deterministic. Upcasts are
   pure, so this holds — but an upcaster that reads a clock or external state
   breaks replay. → Upcasters are pure-by-contract, enforced like reducers.
6. **Cross-event invariants.** An upcast that needs *sibling* events to fill a
   new field (e.g. a v2 field derivable only from a later event) can't be a
   pure per-event function. → If a field isn't reconstructable from the event
   alone, it's not a valid additive change; either default it or model it as a
   new event, never back-fill from neighbours.
7. **Is this worth it vs. just keeping the loud halt?** The halt is cheaper
   (no upcaster code) and safe (no silent corruption) — but it *strands runs*,
   which contradicts "events are truth". For a system whose entire state is a
   fold over an immutable log, "the log is always replayable" is load-bearing,
   not optional. The maintenance cost is the correct price; the halt is a
   pre-upcaster placeholder.

## Recommendation

Adopt per-type payload versioning + read-time upcast through a single decode
boundary; keep events immutable (no rewrite-on-read); retire the run-pin +
`schema_drift` halt; keep DB-table `schema_version` + `migrations.ts`. Land it
*before* the first breaking event-payload change (today there are none in
flight, so the upcast registry starts empty — the cost is the boundary +
column + lint, paid once while it's free).

## Migration

1. Add `payload_version` to `events` / `daemon_events` (DB-table migration;
   existing rows default to `1` — the only version that has existed).
2. Introduce the reader-side decode boundary + empty upcast registry +
   golden-fixture harness.
3. Remove the `schema_drift` halt and the run-pinned gate; leave the run's
   recorded `schema_version` as informational only (or drop it).
4. ARCH §3 (event taxonomy) + the `schema_drift` row in the swarm-debug
   failure-mode playbook updated in the same PR (AGENTS.md §1).

## Deferred / open

- Per-type vs. single-envelope version — per-type chosen for independent
  evolution; revisit only if the registry's `(type, version)` sprawl becomes
  unwieldy.
- Whether the run's recorded `schema_version` is dropped entirely or kept as a
  provenance breadcrumb.
