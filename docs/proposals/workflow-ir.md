---
title: Workflow IR — store the canonical graph, hash the IR, version it for conversion
summary: "Stop treating raw YAML as the unit of execution. (C) Parse once at a boundary into a typed Graph — DONE. (A) Persist that Graph as a canonical, versioned IR (`ir` + `ir_version`), loc stripped (validator-only), `source` demoted to provenance — ships at 0.1.0, sha stays source-hash. (B) Make `workflows.sha` a stable hash of the canonical IR core — DEFERRED until the IR has had a full cleanup pass AND the graph feature set is complete (you don't hash a shape you're still growing); the resulting FK migration is the accepted cost."
status: accepted
maturity: designed
last-reviewed: 2026-05-22
---

# Workflow IR

> **Status: (C) done · (A) ready to build · (B) deferred post-feature-complete.**
> Three moves of escalating commitment: (C) the in-memory parse-once refactor —
> **already landed** (`packages/daemon/src/graph-loader.ts`). (A) persist the
> canonical IR (loc stripped — it's validator-only metadata) — low-risk,
> testable, ships now; **`sha` stays source-hash**. (B) make `sha` a hash of the
> IR core — the *only* move that touches the persisted, FK-referenced identity,
> and a **forever contract**; **deferred until the IR has had a full cleanup
> pass AND the graph feature set is complete** (§8.0) — you don't hash a shape
> you're still growing — with the FK migration accepted as the cost. The key
> correction to the original framing: **(A) and (B) are separable** — only (B)
> changes the FK identity.
> Interlocks with [`event-contract-version.md`](event-contract-version.md)
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
| **(C)** | Parse once at a `GraphLoader` boundary; dispatch consumes `Graph`. | none (in-memory only) | **DONE** (`graph-loader.ts`) |
| **(A)** | Persist the canonical IR (`workflows.ir` + `ir_version`); `source` demoted to provenance. `sha` **unchanged** (still source-hash). | adds columns | **now** — low-risk |
| **(B)** | `sha = hash(canonical IR core)` instead of `sha256(source)`. | changes a persisted, FK-referenced identity | **deferred** post-feature-complete (§8.0) |

**(A) and (B) are separable — the original framing coupled them, wrongly.**
Only (B) touches `run_state.workflow_sha` (the FK). (A) adds the `ir` /
`ir_version` columns and a `Graph ↔ canonical-JSON` codec while `sha` stays
`sha256(source)`; nothing about identity changes, and faithfulness is testable
(`deserialize(serialize(parse(src))) ≡ parse(src)` modulo `loc`). That makes (A)
shippable now with no freeze risk.

The original proposal argued (B) must happen pre-0.1.0 because the FK rewrite is
"free" before release. **That's been overridden by a deliberate risk call**
(§8.0): freezing an identity hash over a graph shape that's still gaining
features is a forever-contract over a moving target. So (B) is *deferred* until
the IR has had a cleanup pass and the graph feature set is complete; the FK
rewrite (rehash every workflow, rewrite every run's `workflow_sha`) is the
accepted, one-time migration cost of waiting until the shape has settled.

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
consumes today, made explicit and serialised. Persist it as canonical JSON,
**with `loc` (line/col) stripped**: `loc` is validator-only metadata (consumed
at upload, when the freshly-parsed Graph still carries it), useless to the
executor, and source-formatting-dependent. It does not belong in the persisted
IR. The `Graph` type keeps `loc?` for the transient parse→validate phase; the
serializer drops it.

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
store, `schema_version` stays `1`. The `workflows` table after **(A)**:

```sql
CREATE TABLE workflows (
  sha        TEXT PRIMARY KEY,   -- (A): still sha256(source). (B): hash(IR core).
  name       TEXT NOT NULL,
  source     TEXT NOT NULL,      -- human provenance (identity only until (B))
  ir         TEXT NOT NULL,      -- canonical JSON of the normalized Graph (loc-stripped)
  ir_version INTEGER NOT NULL,   -- IR contract version (NOT schema_version), starts at 1
  created_at INTEGER NOT NULL
) STRICT;
```

Both `ir` columns land in the baseline now (additive, NOT NULL) — every stored
workflow carries its IR. `run_state.workflow_sha` stays the FK; its *value* is
source-hash under (A) and becomes IR-hash only if (B) ships at freeze. No
migration walk; the dev store is recreated.

**`ir_version` at 0.1.0 = 1, with no converters yet.** Don't pre-build the
converter-chain machinery before there's a v2 to convert from: ship the column
+ a loader guard (`ir_version > CURRENT` → refuse; `< CURRENT` → run the chain,
which is empty today). The registry pattern (from
[`event-contract-version.md`](event-contract-version.md)) arrives with the first
real bump. The `Graph ↔ JSON` codec (serialize at mint, deserialize on load)
*is* needed now and must round-trip faithfully (modulo `loc`).

## 8. Decisions, the (B) gate, and the canonicalization spec

### 8.0 The (B) gate — DECIDED: defer to post-feature-complete

**Ship (A) now (sha stays `sha256(source)`). Do NOT attempt to freeze (B) at
0.1.0. (B) lands only after (1) a full cleanup pass of the canonical IR shape
and (2) the graph feature set is complete — i.e. once the IR core is *solid and
stable*. The resulting FK migration is the deliberately-accepted cost.**

Rationale (the explicit risk call): `sha` is frozen at mint and FK-referenced
(`run_state.workflow_sha`); a canonicalization frozen *before the graph is
feature-complete* is a forever contract over a still-moving target — every new
semantic node type / attr is another chance to have frozen it wrong, re-minting
a different `sha` for the same workflow on re-upload (silent duplicate identity).
**You don't hash a shape you're still growing.** This overrides the proposal's
original "freeze pre-0.1.0 because the migration is free" framing: a wrong
forever-freeze is worse than a planned, one-time migration done when the shape
has settled. (A) carries none of this risk — it changes no identity — so it
ships at 0.1.0 regardless.

Readiness bar for (B), when the time comes: §8.1's core field-set enumerated +
a canonical-JSON serializer pinned (JCS / RFC 8785 subset) + a property test
that semantically-equal sources collapse and semantically-different ones don't.
§8.1 is the **checklist for that future cleanup pass**, not a 0.1.0 deliverable.

### 8.1 The canonicalization spec — the forever-freeze surface

Grounded in the real types (`packages/core/src/types/graph.ts`). The IR is the
parsed `Graph` (`{ id, directed, attrs, nodes: Record<id,Node>, edges: Edge[] }`),
which is already plain-JSON (no Maps/functions). The hash covers the **semantic
core** — a frozen projection, NOT the full struct (this is what decouples the
hash from `ir_version`: a future non-semantic field never changes the hash, so
the one frozen core-projection verifies any `ir_version`; no historical
canonicalizers needed). The core rules, each a forever contract:

- **`loc` (line/col) is already out** (§4): it's validator-only metadata, never
  persisted in the IR — so the hash never sees it. Called out here because it's
  the cleanest proof that the IR must be the *executable* projection, not a
  faithful dump of the parse tree.
- **Exclude `label` (graph / node / edge `attrs.label`)** — cosmetic; a label
  edit must not fork identity.
- **`graph.id` IS in the core.** `graph.id` = the workflow `name` (parser:
  `yaml.ts`). Including it means renaming forks identity — *intended* (a
  "deploy" workflow ≠ a "test" with the same shape). State it; don't assume it.
- **Array ordering is per-field, not uniform** — the subtle trap:
  - `edges` and `inputs[]`: canonical *sort* (a graph is order-independent; sort
    edges by `(from, to, outcome, route)`, inputs by `name`).
  - Set-like attrs — `allowed_tools`, `denied_tools`, `routes`, `skills`: sort
    (order-independent sets).
  - **`context_files`: do NOT sort** — files prepend to the system prompt in
    declared order, so order is semantic. Same for any future ordered list.
- **Number form**: float attrs exist (`budget_usd`, `max_cost_usd`,
  `retry_backoff_factor`, `retry_*_delay_ms`) → pin a canonical number
  representation (`2` ≡ `2.0`). Note `timeout: "30s"` (string) and `max_ms`
  (number) are *distinct fields* — the hash will not collapse equivalent
  durations expressed two ways. Acceptable; document it.
- **Optional-field normalization**: absent ≡ absent; never emit `null`/`undefined`
  keys. Sort object keys.

### 8.2 Implementation findings (apply to both (A) and (B))

- **"IR is the executable" is qualified — runtime config still overlays it.**
  `retry_policy` resolves node → `graph.default_retry_policy` → `"none"`, and
  `timeout` resolves node → `.fragua/config.yaml` `timeouts.*` *at execution*.
  So the IR is the **declared** graph; local config still applies at run time.
  Correct for identity (hash only what the author declared) and consistent with
  the cwd/location model for import — but the "no parser needed on import" win
  must not be over-read as "no config needed."
- **Centralize minting; one path currently assumes `sha == sha256(source)`.**
  `sha` is minted at the server `POST /workflows`, the server's *by-name*
  resolution path (`workflowSha = sha256Hex(detail.source)`, used to dedup), and
  the daemon schedule-dispatcher. (B) must route all three through a single
  `workflowIdentity(source) → { sha, ir, ir_version }`; the by-name dedup path in
  particular would mis-key (source-hash vs IR-hash) if left as-is. Minting also
  now **requires a valid parse** — every write path must reject unparseable
  source (already done at upload, `fd4cd59a`; confirm the dispatcher path).
- **`sha` is never recomputed after mint — make it an invariant.** Computed once
  at mint; never re-derived on read from a loaded/up-converted IR. No
  rehash-and-compare-on-read (a tempting future "validation" that would reject
  every up-converted or imported workflow). Import trusts the carried `sha`;
  optional verification recomputes the *core* hash (frozen, `ir_version`-
  independent) and compares — never the full struct.

### 8.3 Residual notes

- **Three version axes stay separate**: `schema_version` (store), `ir_version`
  (IR contract), `sha` (content identity). The proposal's whole value is not
  collapsing them.
- **Source provenance fidelity** (only bites under (B)): the stored `source` for
  a `sha` is whichever upload won; not byte-equal to every author's input. Fine
  for execution; note it for any "show original" UI.
- **Sequencing**: (C) done. (A) + the `ir_version` scaffold ship now. (B) lands
  at freeze iff §8.1 is ready, ideally alongside [`db-import.md`](db-import.md)
  (the bundle carries `{ ir, ir_version, source, sha }`).
