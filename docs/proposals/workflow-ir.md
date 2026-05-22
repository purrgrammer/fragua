---
title: Workflow IR — store the canonical graph, hash the IR, version it for conversion
summary: "Stop treating raw YAML as the unit of execution. Parse once at a boundary into a typed Graph (the in-memory refactor, landing now); persist that Graph as a canonical, versioned IR; make a workflow's identity (`workflows.sha`) a stable hash of the canonical IR rather than of the source bytes; and version the IR so the loader can up-convert older stored/imported IR to the current Graph shape. `source` stays as human provenance. Decided before 0.1.0 because the hash-basis change is free pre-release and a migration after."
status: proposed
maturity: sketch
last-reviewed: 2026-05-22
---

# Workflow IR

> **Sketch.** Three moves of escalating commitment: (C) the in-memory
> parse-once refactor (no contract change, landing now); (A) persist the
> canonical IR; (B) make `sha` a hash of that IR. (A)+(B) are one
> pre-release decision because they change a persisted, FK-referenced
> identity. Interlocks with [`event-contract-version.md`](event-contract-version.md)
> (the sibling versioning pattern), [`db-import.md`](db-import.md) (what a
> bundle carries), and [`project-id.md`](project-id.md).

## 1. Goal / why

Today `workflows` stores raw YAML (`source`) keyed by `sha = sha256(source)`,
and the dispatch path re-parses that string: `auto-dispatcher`'s
`specsForGraph(source)` and the executor's `graphFor` both call
`parseWorkflow(source)`. Three problems:

1. **Raw strings in the hot path.** Parsing belongs at a boundary
   (upload/enqueue), not scattered through dispatch. Parse errors should
   surface at upload, every consumer shouldn't re-parse, and the in-memory
   contract should be a typed `Graph`, not "a string that might be a workflow."
2. **Byte-identity, not semantic identity.** `sha256(source)` forks a new
   workflow on a whitespace/comment/key-order change that compiles to the
   same graph. Identity should be by *meaning*.
3. **No IR contract.** The executable shape (`Graph`) is implicit — derived
   on the fly, never persisted, never versioned. An imported run (a CI bundle)
   has to re-parse YAML with *this* machine's parser to run, coupling replay to
   parser-version drift.

The target: the **canonical IR is the executable + identity artifact**; `source`
is provenance; the IR is **versioned** so the loader can convert older IR
forward; `sha` is a stable hash of the canonical IR, minted once.

## 2. The three moves

| | Move | Contract change? | When |
|---|---|---|---|
| **(C)** | Parse once at a `GraphLoader` boundary; dispatch consumes `Graph`. | none (in-memory only) | **now** — stands alone, removes the smell |
| **(A)** | Persist the canonical IR (`workflows.ir` + `ir_version`); `source` demoted to provenance. | adds columns | pre-0.1.0 |
| **(B)** | `sha = hash(canonical IR)` instead of `sha256(source)`. | changes a persisted, FK-referenced identity | **pre-0.1.0 or never-cheaply** |

(B) is the load-bearing reason to decide before release: `run_state.workflow_sha`
is a persisted FK; switching the hash basis after ship means rehashing every
workflow and rewriting every run's FK. Pre-0.1.0, under the clean-break policy,
it's a no-op. Same logic as the run_id widening.

## 3. (C) — the parse-once boundary (landing now)

`makeGraphLoader(store).load(sha) → { ok: true, graph } | { ok: false, reason:
"missing" | "unparseable" }`, memoized by sha (a sha's source is immutable, so
parse-once-cache-forever, daemon-wide). `parseWorkflow` is called in exactly one
place; `auto-dispatcher` (`specsForGraph(graph)`) and the executor (`graphFor`)
both consume `Graph` from it. No storage or hash change — this is the refactor
that makes (A)/(B) a small follow-on rather than a rewrite. After (A) the loader
swaps its body from "parse YAML source" to "deserialize stored IR + up-convert"
(§5); its callers don't change.

## 4. (A) — the IR is the canonical, executable graph

The IR is the **normalized `Graph`**: defaults materialized, the synthesized
`start` node present, optional fields resolved — i.e. exactly what the executor
consumes today, made explicit and serialised. Persist it as canonical JSON.

`source` stays: it's the human artifact (comments, formatting, "what the author
typed") for display and re-edit. It is **no longer identity** and no longer the
thing the executor reads. The relationship is one-way: `source --parse-->
normalized Graph --serialize--> canonical IR`. A second frontend (a builder API,
a different DSL) could compile to the same IR without touching the executor.

## 5. IR versioning — the part that makes conversion possible

The IR is a **versioned contract** (`ir_version`, an integer on the workflows
row). This is a *different version axis* from both the store `schema_version`
(SQLite migrations) and the workflow `sha` (content identity). Keep them
distinct — conflating them is the trap.

- A registry of **up-converters** `vN → vN+1` (pure functions over the IR JSON),
  composed to lift any stored `ir_version` to the current `Graph` shape on load.
  Sibling to the event-contract-version axis argument.
- **Load path** (post-A): read `{ ir, ir_version }`; if `ir_version <
  CURRENT_IR_VERSION`, run the converter chain; hand the executor a current
  `Graph`. The `GraphLoader` from (C) becomes this.
- **Down-conversion** is not required (you never execute on an older runtime),
  but the converter registry keeps the door open for export-to-older if a bundle
  consumer ever needs it.
- Adding a node type / attr / a new default = an `ir_version` bump + a converter
  that fills the new field for old IR. Old runs keep replaying because their IR
  up-converts deterministically.

## 6. (B) — `sha` is a hash of the canonical IR, minted once

`sha = hash(canonicalize(IR))`. Canonicalization is a **frozen, explicit**
projection: sorted keys, materialized defaults, normalized optionals,
deterministic array order — covering only the semantically load-bearing fields.

The footgun, and its resolution:

- **`sha` is computed once at upload and stored — never recomputed on read.** So
  adding an IR field later (an `ir_version` bump) does NOT rehash existing
  workflows: their `sha` is frozen identity, and their stored IR up-converts on
  load (§5). The canonical hash is the *minting function*, not a
  recomputed-on-read invariant.
- New uploads mint under the current canonicalization; old workflows keep their
  original `sha`. Two source texts that canonicalize to the same IR collapse to
  one `sha` (the win); the stored `source` is "a source that produces this IR,"
  so to show "the exact bytes that produced run X" you rely on the run pinning
  `workflow_sha` + the (first/last) stored source — acceptable, since the IR is
  the executable truth.

Import angle: a bundle carries `{ ir, ir_version, source, sha }`. The importer
trusts the IR + `sha` and executes directly — **no YAML parser needed, no
parser-version coupling.** This is strictly better than source-hash for the
bundle future (where the importer would otherwise re-parse to run).

## 7. Schema sketch (edit the baseline in place — no store version bump)

Pre-0.1.0 policy: edit the baseline `schema.sql` directly, recreate the dev
store, `schema_version` stays `1`. The `workflows` table:

```sql
CREATE TABLE workflows (
  sha        TEXT PRIMARY KEY,   -- now hash(canonical IR), minted once
  name       TEXT NOT NULL,
  source     TEXT NOT NULL,      -- human provenance (was identity)
  ir         TEXT NOT NULL,      -- canonical JSON of the normalized Graph
  ir_version INTEGER NOT NULL,   -- IR contract version (NOT schema_version)
  created_at INTEGER NOT NULL
) STRICT;
```

`run_state.workflow_sha` semantics are unchanged (still the FK), but the value
is now an IR-hash. No migration walk; the dev store is recreated.

## 8. Open questions / risks

1. **Canonicalization correctness — and the 0.1.0 freeze fork.** The hash is only
   as stable as the canonical serializer; every field it covers must serialize
   deterministically (pin it to a spec — JCS / RFC 8785 or a documented subset:
   key order, number form, unicode). It is a **forever contract**: because `sha`
   is frozen at mint and FK-referenced (`run_state.workflow_sha`), changing
   canonicalization later means the same workflow mints a *different* `sha` on
   re-upload — silent duplicate identity, not corruption, but it breaks the
   "reformatting doesn't fork" promise. **So shipping IR-hash at 0.1.0 *requires*
   the canonicalization specified, frozen, and tested before the schema freezes.**
   If it can't be nailed in time, the honest fallback is: **ship source-hash
   (`sha256(source)`) at 0.1.0 and accept a one-time post-0.1.0 migration to
   IR-hash** — the lesser evil versus freezing a wrong canonicalization forever.
   This is the gating decision for the (A)+(B) leg.
2. **`sha` covers the semantic core only — which decouples it from `ir_version`.**
   Hash only execution-load-bearing fields (nodes, edges, dispatch/routing
   attrs), not the full IR struct. Consequence: a future `ir_version` bump that
   adds a non-semantic field does **not** change the hash, so **canonicalization
   is frozen ONCE over the core — it is NOT itself versioned per `ir_version`.**
   That answers "do we need every historical canonicalizer to verify old shas?"
   — no; the one frozen core-projection verifies any `ir_version`. Document the
   exact core field set.
3. **`sha` is never recomputed after mint — make it an invariant.** Computed once
   at upload from the source-parsed IR; never re-derived from a loaded or
   up-converted IR. No code path may rehash-and-compare on read (a tempting
   future "validation" that would reject every up-converted or imported
   workflow). Import **trusts the carried `sha`**; optional verification recomputes
   the *core* hash (frozen, `ir_version`-independent per #2) and compares — never
   the full struct.
4. **Three version axes.** `schema_version` (store), `ir_version` (IR contract),
   `sha` (content identity). The proposal's whole value is keeping them separate;
   any implementation must not collapse them.
5. **Source provenance fidelity.** With IR-hash, the stored `source` for a `sha`
   is whichever upload won; it's not guaranteed byte-equal to every author's
   input. Fine for execution; note it for any "show original" UI.
6. **Sequencing.** (C) now (in-memory, no contract). (A)+(B)+versioning together,
   pre-0.1.0, landing with or just before [`db-import.md`](db-import.md) (the
   bundle carries IR + ir_version) and reusing the versioning pattern from
   [`event-contract-version.md`](event-contract-version.md).
