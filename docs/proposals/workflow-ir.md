---
title: Workflow IR — store the canonical graph, hash the IR, version it for conversion
summary: "Stop treating raw YAML as the unit of execution. (C) Parse once at a boundary into a typed Graph — DONE. (A) Persist that Graph as a canonical, versioned IR (`ir` + `ir_version`), loc stripped (validator-only), `source` demoted to provenance — DONE; sha stays source-hash. (B) Make `workflows.sha` a stable hash of the canonical IR core — DEFERRED until the IR has had a full cleanup pass AND the graph feature set is complete (you don't hash a shape you're still growing); the resulting FK migration is the accepted cost. This doc now exists for (B): the freeze gate and the canonicalization spec."
status: in-progress
maturity: partial
last-reviewed: 2026-05-28
---

# Workflow IR

> **Status: (C) done · (A) done · (B) deferred post-feature-complete.** The
> live content of this doc is §8 — the (B) freeze gate and the canonicalization
> checklist. The (A)/(C) story is condensed into §1 below; git has the rest.
> Interlocks with [`event-contract-version.md`](archive/event-contract-version.md)
> (sibling versioning pattern, shipped) and [`bundles.md`](archive/bundles.md)
> (what an exported run carries, shipped).

## 1. What shipped (A + C)

Three moves of escalating commitment were always (A) + (B) + (C); **(A) and
(B) are separable — only (B) changes the FK identity** — and only (A)+(C)
landed.

| | Move | Contract change? | State |
|---|---|---|---|
| **(C)** | Parse once at a `GraphLoader` boundary; dispatch consumes `Graph`. | none (in-memory only) | shipped (`packages/daemon/src/graph-loader.ts`) |
| **(A)** | Persist the canonical IR (`workflows.ir` + `ir_version`); `source` demoted to provenance. `sha` unchanged (still `sha256(source)`). | adds columns | shipped (`packages/store/src/schema.sql`; both columns `NOT NULL`) |
| **(B)** | `sha = hash(canonical IR core)` instead of `sha256(source)`. | changes a persisted, FK-referenced identity | **deferred** post-feature-complete — see §8.0 |

What the IR carries: the **normalized `Graph`** — defaults materialized,
synthesized `start` node present, optional fields resolved — i.e. exactly what
the executor consumes today, serialized as canonical JSON with `loc` stripped
(validator-only metadata, source-formatting-dependent, useless to the
executor). `source` stays as human provenance for display + re-edit; the
relationship is one-way: `source --parse--> normalized Graph --serialize-->
canonical IR`. `ir_version` is a **third axis**, distinct from
`schema_version` (SQLite migrations) and `sha` (content identity); it starts
at `1` with no converters in the registry — the first bump arrives with the
first real change, and the load path is the existing `GraphLoader` calling
the converter chain (currently empty) before handing the executor a current
`Graph`.

When (B) eventually lands it makes the bundle path parser-free: a bundle
carries `{ ir, ir_version, source, sha }` and the importer trusts the IR + `sha`
and executes directly — no YAML parser needed, no parser-version coupling.
But (B) is the **forever-contract** move; it waits.

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
**You don't hash a shape you're still growing.** The earlier "freeze pre-0.1.0
because the migration is free" framing was overridden by this risk call: a
wrong forever-freeze is worse than a planned, one-time migration done when the
shape has settled. (A) carries none of this risk — it changes no identity — so
it shipped regardless.

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

- **`loc` (line/col) is already out** (§1): it's validator-only metadata, never
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

### 8.2 Implementation findings (carry forward into (B))

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
  particular would mis-key (source-hash vs IR-hash) if left as-is. **That single
  function's home is `plane.buildSaveWorkflow`** (the intent plane, shipped —
  `@fragua/core/intent-plane`): the intent plane already consolidates the three mint sites into one
  save op for its own reasons (one audit surface, no CLI/server drift), so (B)
  becomes a one-line source-hash → IR-hash swap *inside that function*, not a
  three-site sweep. The plane refactor is therefore the natural carrier for (B),
  and the schedule-dispatcher's fire-time mint routes through the same op (a
  save-then-enqueue driven by the fiber). Minting also now **requires a valid
  parse** — every write path must reject unparseable source (already done at
  upload, `fd4cd59a`; confirm the dispatcher path).
- **`sha` is never recomputed after mint — make it an invariant.** Computed once
  at mint; never re-derived on read from a loaded/up-converted IR. No
  rehash-and-compare-on-read (a tempting future "validation" that would reject
  every up-converted or imported workflow). Import trusts the carried `sha`;
  optional verification recomputes the *core* hash (frozen, `ir_version`-
  independent) and compares — never the full struct.

### 8.3 Residual notes

- **Four version axes stay separate**: `schema_version` (store migrations),
  `ir_version` (IR contract), `sha` (content identity), and
  `EVENT_CONTRACT_VERSION` (fold contract —
  [`event-contract-version.md`](archive/event-contract-version.md)). The
  proposal's whole value is not collapsing them — and the pairing that bites
  is `ir_version` vs `EVENT_CONTRACT_VERSION`: a new node type / attr / default
  is an **`ir_version`** bump + an up-converter (§1), *not* an event-contract
  bump, because the executor records the routing *result*
  (`fact.node_completed.payload.nextNode`) and the reducer folds that verbatim
  — the node-language change never reaches `foldFacts`.
- **Source provenance fidelity** (only bites under (B)): the stored `source` for
  a `sha` is whichever upload won; not byte-equal to every author's input. Fine
  for execution; note it for any "show original" UI.
- **Sequencing**: (C) + (A) shipped. (B) lands when §8.1's checklist is ready
  and the graph feature set has settled. The bundle format already reserves
  the carrying shape (`{ ir, ir_version, source, sha }`) — see
  [`bundles.md`](archive/bundles.md).
