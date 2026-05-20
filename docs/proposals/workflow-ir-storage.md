---
title: Workflow JSON-IR storage + version tracking
status: proposed
maturity: designed
last-reviewed: 2026-05-20
---

# Workflow JSON-IR storage + version tracking

> Today a workflow is stored as **YAML source text** in `workflows.dot_source`
> and re-parsed on every dispatch. The content address is
> `sha = sha256(source)`. This proposal covers: (1) persisting the parsed,
> canonical **JSON IR** alongside the source so the wire/store carries the
> typed graph rather than re-deriving it everywhere; (2) tracking an **IR
> schema version** so a stored workflow can be gated against the running
> engine; and (3) the `dot_source` → `source` column rename deferred from the
> DOT→YAML cutover (it was left because its meaning was expected to change
> here — task #26).

## Why now: the IR finally canonicalises

Three recent cleanups make a *canonical* IR actually well-defined — it
wasn't before:

- **Closed, fully-typed attrs** (`#5`, commit `1603ec6c`): `NodeAttrs` /
  `EdgeAttrs` / `GraphAttrs` no longer carry `[extra: string]` index
  signatures. The IR field set is now finite and known, so a canonical
  serialisation has no "what about unexpected keys?" hole.
- **Fully explicit edges** (`#2`, commit `2d1d5ad2`): linear fall-through is
  gone (E032). The edge set is exactly `start→first` + authored
  `next`/`on`/`routes` + goal-gate retargets — no synthesis that depends on
  declaration order. The graph is a pure function of the source.
- **kebab → snake lowering + single substitution token**: authoring is
  kebab-case but the IR is snake_case (`thread_id`, `max_retries`, …), and
  `${{ inputs.x }}` is the only substitution token (`$ARGUMENTS` removed).
  So the IR is independent of authoring cosmetics.

`canonicalStringify` (`packages/core/src/handler/canonical-stringify.ts`)
already exists — sorts object keys, NFC-normalises strings, rejects
`undefined`/`BigInt`/`Date`/cycles/non-finite, detects post-NFC duplicate
keys. It's the serialiser used for side-effect `argsHash` and is the natural
basis for an IR hash.

## The shape on the wire / in the store

The in-memory `Graph` (`packages/core/src/types/graph.ts`) is already JSON:
`{ id, directed:true, attrs, nodes: Record<id,Node>, edges: Edge[] }`. The
JSON IR is that, plus an explicit version tag and minus the non-semantic
bits (see adversarial §, below):

```jsonc
{
  "irVersion": 1,            // workflow-IR shape version (NOT the DB schema_version)
  "id": "work",
  "directed": true,
  "attrs": { /* GraphAttrs */ },
  "nodes": { "<id>": { "type": "...", "attrs": { /* NodeAttrs */ } } },
  "edges": [ { "from": "...", "to": "...", "attrs": { /* EdgeAttrs */ } } ]
}
```

`POST /workflows` and `POST /runs`'s disk-resolution path already parse the
source for validation; they'd attach the IR to the registration. The daemon
stops calling `parseWorkflow(wf.dotSource)` at dispatch and reads the stored
IR (parse-once, not parse-per-dispatch).

## Adversarial pass

The naive form — *"replace `dot_source` with the JSON IR and set
`sha = sha256(canonicalIR)`"* — breaks in several ways. Each is a real
hazard, not a nit:

1. **Re-hashing orphans every historical run.** `run_state.workflow_sha` is
   `NOT NULL REFERENCES workflows(sha)`. If the content address changes from
   `hash(source)` to `hash(IR)`, every existing run's FK dangles and the
   `idx_run_state_workflow` join breaks. A migration cannot re-key
   `workflows` without rewriting `run_state` too, and even then the *old*
   shas are baked into terminal `fact.run_started { workflowSha }` events
   (immutable log). **Conclusion: the primary content address must stay
   `hash(source)`.** Re-hashing is not a migration; it's a data loss.

2. **`hash(IR)` is not stable across engine versions.** The whole value of
   content-addressing is "same input → same sha → dedup + cache". But the IR
   shape evolves (every `irVersion` bump). Adding a field, baking a new
   default into `attrs`, or normalising differently changes `hash(IR)` for a
   *byte-identical source*. So `hash(IR)` is only stable *within* one
   `irVersion` — it cannot be the durable identity. `hash(source)` is the
   only thing stable across engine upgrades.

3. **`loc` is in the IR and is non-semantic.** `Node`/`Edge` carry
   `loc: {line,col}` for error reporting. Two sources differing only in
   comments/whitespace produce identical semantics but different `loc` →
   different `hash(IR)`. Any IR hash MUST strip `loc` (and any future
   source-position metadata) first.

4. **Edge order is array order; `canonicalStringify` preserves it.** `edges`
   is `Edge[]`. Sorted-key canonicalisation does *not* reorder arrays, so
   reordering two sibling edges in the source changes `hash(IR)` even though
   edge selection keys on `outcome`/`route` (validator E024 forbids
   collisions, so order is not a tiebreak). A semantic IR hash must sort
   edges by a stable key (`from,to,outcome,route`). *But* if we keep
   `hash(source)` as identity (per §1), this only matters for an *optional*
   semantic hash — don't pay the complexity unless that hash earns its keep.

5. **Storing only the IR loses the source.** The UI "view workflow", audit,
   and any re-export need the human YAML (comments, structure). Replacing
   `dot_source` with IR-JSON throws that away. Keep the source; *add* the IR.

6. **Three things called "version" now collide.** (a) DB `schema_version`
   (`CURRENT_SCHEMA_VERSION=14`, migrations); (b) run-pinned `schema_version`
   (drift-halt across pauses); (c) this new workflow **`irVersion`**. They
   are independent axes. Name the new one unambiguously (`irVersion`, never
   bare `version`/`schema_version`) or on-call debugging conflates them.

7. **`Node.id` duplicates the map key.** `nodes` is `Record<id,Node>` and
   each `Node` repeats `.id`. In a canonical form that's a redundant field
   that can disagree with its key. Drop `.id` from the canonical value (the
   key is authoritative) or assert equality on parse.

8. **`undefined` vs absent.** `canonicalStringify` *throws* on `undefined`.
   The parser already omits unset attrs (`if (coerced !== undefined)`), so
   today it's safe — but it's a latent landmine: any future code path that
   sets `attrs.foo = undefined` turns a hash call into a throw. A
   normalisation pass (drop `undefined`/empty before hashing) makes this
   robust instead of incidentally-correct.

9. **Defaults are baked in.** The parser folds the `defaults:` block into
   each llm node. So two sources — one explicit `model:`, one relying on the
   same default — produce the *same* IR. Generally desirable (the resolved
   graph is what runs), but it means the IR is not a faithful round-trip of
   the source: you cannot reconstruct "was this explicit or defaulted?" from
   the IR. Fine if source is retained (§5); surprising if not.

## Recommendation

Survive the adversarial pass by **adding, not replacing**:

| Column (`workflows`) | Meaning |
|---|---|
| `sha` (PK, unchanged) | `sha256(source)` — durable identity; preserves run FKs + log. |
| `source` (rename of `dot_source`) | YAML text — display / audit / re-parse fallback. |
| `ir` (new, TEXT) | `canonicalStringify` of the parsed IR (loc-stripped, `Node.id` dropped). Execution + wire payload. |
| `ir_version` (new, INTEGER) | Workflow-IR shape version. Gates a stored IR against the running engine, exactly like run `schema_version`. |

- **Identity stays `hash(source)`** — no re-hash, no FK rewrite, no orphaned
  runs (kills §1, §2).
- **The IR is a derived cache**, not the identity. On read, if
  `ir_version < CURRENT_IR_VERSION` (or `ir` is NULL — migrated rows), re-parse
  `source` and refresh `ir`/`ir_version` in place. The source is always the
  ground truth; the IR is a parse-once optimisation + the canonical wire
  shape.
- **`irVersion`** is bumped only on a breaking IR-shape change (field added
  the engine *requires*, semantics of an existing field changed). Additive,
  optional fields don't bump it. Compatibility window mirrors the run
  `schema_version` pattern: `[MIN_COMPATIBLE_IR_VERSION, CURRENT_IR_VERSION]`.
- **A semantic `hash(IR)`** (loc-stripped, edges-sorted) is *deferred* — it
  only buys dedup across cosmetic source edits, and per the "need demand
  first" rule we add it when a concrete consumer wants it, not speculatively.
  When added it's a separate non-PK column, never the identity.
- **`(scope, name)` aliasing** (the lineage table from the original #26
  sketch) is orthogonal to all of the above and can land independently — it
  maps a human handle to the latest `sha`, which is useful whether or not the
  IR is stored.

Net: the user-visible win (typed IR on the wire, parse-once dispatch, version
gating) lands without destabilising the content address or losing source.

## Migration

1. `ALTER TABLE workflows RENAME COLUMN dot_source TO source` (+ rename
   `WorkflowRow.dotSource` → `source`, `saveWorkflow(…, source)`,
   `insertWorkflowIfAbsent`, the daemon/agent/server readers — the
   identifier sweep deferred in [[dot-retirement-deferrals]]).
2. `ALTER TABLE workflows ADD COLUMN ir TEXT` (nullable) `+ ADD COLUMN
   ir_version INTEGER` (nullable). Existing rows: `ir = NULL` → lazily
   backfilled by the re-parse-on-read path. No re-hash; `sha` untouched.
3. Daemon dispatch: read `ir` when present + `ir_version` in range; else
   `parseWorkflow(source)`, write back. ARCH §2 schema table + the
   `dot_source` references in ARCH/handler-contract updated in the same PR
   (AGENTS.md §1 obligation).

## Deferred / open

- Semantic `hash(IR)` for cosmetic-edit dedup (above) — needs a demand.
- Typebox-first IR schema authority in `@swarm/types` (generate the validator
  + JSON Schema for editor IntelliSense from one source) — larger; pairs with
  the JSON-Schema-for-config idea cut from project-config.
- Whether `POST /workflows` should accept a pre-built IR (API clients that
  don't want to ship YAML) — only if a non-CLI client appears.
