---
title: Workflow JSON-IR storage + content addressing
status: proposed
maturity: designed
last-reviewed: 2026-05-20
---

# Workflow JSON-IR storage + content addressing

> Today a workflow is stored as **YAML source text** in `workflows.dot_source`,
> re-parsed on every dispatch, and content-addressed by `sha = sha256(source)`.
> That makes a comment or whitespace edit mint a "new" workflow. This proposal
> moves the stored + hashed artifact to the **canonical JSON IR**: the content
> address tracks *what the workflow means*, the IR is hydrated straight from
> the DB to run, and the YAML is regenerated from the IR for display. Pairs
> with [event-versioning](./event-versioning.md) (the run-replay half of "version
> tracking"). Closes #26 + absorbs the deferred `dot_source` rename.

## Settled decisions

1. **Content-address the IR, not the source.** `sha = hash(canonical IR)`.
   Cosmetic edits (comments, whitespace, key order, kebab spelling) parse to
   an identical IR → same sha → no new version. (Pre-release: re-keying
   `workflows` + the `run_state.workflow_sha` FK is a one-shot reset, not a
   migration to preserve.)
2. **Store the IR, hydrate it to run.** The daemon reads the parsed IR from
   the DB instead of calling `parseWorkflow` per dispatch. Parse-once at
   upload.
3. **Drop the YAML at rest; regenerate it.** No `source` column. A small
   IR→YAML emitter renders "view source" / export on demand. Comments don't
   round-trip — consistent with decision 1 (comment edits aren't changes) and
   acceptable: structure round-trips, prose doesn't.
4. **A new version means the *workflow* changed, not the *IR representation*.**
   The hash is over a representation-version-independent normal form;
   `irVersion` is excluded from it (see §Canonical form). An engine that bumps
   the IR shape must not re-mint shas for unchanged workflows.
5. **`loc` is source metadata, not IR.** Decomplect it at parse time (see
   §Parse output). It never reaches the stored IR or the hash.

## IR cleanup (do this first — a clean IR is a hashable IR)

The current `Graph` (`packages/core/src/types/graph.ts`) carries cruft that
either pollutes the hash or is plain dead. Removing it is a prerequisite, not
a nicety — every stray field is a place for two semantically-equal workflows
to hash apart, or for a representation detail to leak into identity.

| Field | Action | Evidence |
|---|---|---|
| `Graph.directed: true` | remove | zero readers; constant. |
| `AttrScalar` (exported type) | remove | only the definition exists post-#5; no references. |
| `NodeAttrs.timeout` (duration string) | remove; keep `max_ms` | parser only maps `timeout-minutes`→`max_ms`; nothing writes `timeout`. The `auto-dispatcher` branch reading it is dead. |
| `EdgeAttrs.thread_id` | remove | parser never sets it; the `engine/thread.ts` edge-fallback rung is unreachable. |
| `NodeAttrs.fallback_retry_target` + graph-level fallback rung | remove; collapse the §3.4 retarget chain to `gate.retry_target → graph.retry_target` | no authoring path sets either fallback; they're aspirational rungs in `goal-gate-policy.ts` / `executor.ts` with no producer. |
| `Node.id` | drop from the canonical/stored form (re-attach `id = key` on hydrate) | redundant with the `nodes` map key; a place for key/value disagreement. |
| `HandlerType` alias + `handlerOf()` | inline to `node.type` at the 2 web call sites, drop the seam | `handlerOf(n) === n.type` since the codergen→llm unification. |
| `goal_gate` | **keep** | not redundant — marks gate-ness independently of the retarget destination (the W007 "gate with no retarget" case is a real, expressible state). |

Each removal is its own small PR with a test delta; none changes runtime
behaviour (they're dead reads or constants).

## Parse output: decomplect IR from source metadata

`parseWorkflow` currently returns a `Graph` with `loc` embedded on every node
and edge. Split the two concerns:

```ts
parseWorkflow(source: string): { ir: WorkflowIR; sourceMap: SourceMap }
```

- **`WorkflowIR`** — the pure semantic graph. No `loc`, no `Node.id`, no
  `directed`. This is what gets hashed, stored, hydrated, and run.
- **`SourceMap`** — `Map<nodeId | edgeKey, Location>`, the line/col index. Used
  *only* by the validator to anchor diagnostics at the offending source line
  (the sole consumer of `loc` today). Lives for the duration of validation;
  never persisted.

`validate(ir, sourceMap)` takes both. So a diagnostic still points at
`work.yaml:42`, but the artifact we hash and store has no source coupling.

## Canonical form + hashing (the core)

`canonicalStringify` (`packages/core/src/handler/canonical-stringify.ts`)
already gives byte-identical output for structurally-equal values: sorts
object keys, NFC-normalises strings, rejects `undefined`/`NaN`/`Date`/cycles,
detects post-NFC duplicate keys. It does **not** reorder arrays. So the
canonical IR is `canonicalStringify(normalize(ir))` where `normalize` pins
every degree of freedom `canonicalStringify` leaves open:

1. **Strip non-semantic fields** — `loc` (already gone post-decomplect),
   `Node.id` (key is authoritative), `directed`.
2. **Omit absent/empty** — drop `undefined`, `[]`, `""` so "key absent" and
   "key present but empty" hash identically. (Also dodges the
   `canonicalStringify`-throws-on-`undefined` landmine.)
3. **Sort set-semantic arrays** — `allowed_tools`, `denied_tools`, `skills`,
   `routes`, and `inputs[]` (by `name`) are sets; `[read, bash]` and
   `[bash, read]` mean the same thing, so sort them. (Order is not meaningful
   for any IR array — there is no ordered list in the IR.)
4. **Sort edges** by `(from, to, outcome ?? "", route ?? "")` — `edges` is a
   JS array but edge *selection* keys on `outcome`/`route` (E024 forbids
   collisions), so order is non-semantic and must be normalised away.
5. **Exclude `irVersion`** from the hashed bytes — it's representation
   metadata, not workflow content (decision 4).

### Why this gives "version iff the workflow changed"

The hash domain is *only* the load-bearing semantic fields, in a form that
doesn't depend on the IR's representation version:

- **Cosmetic source edit** (comment, whitespace, reorder tools/edges, kebab
  spelling) → same normal form → same sha. ✓ (decision 1)
- **Additive `irVersion` bump** (engine adds an optional field a workflow
  doesn't set) → the field is omitted by rule 2 → same sha. ✓ (decision 4)
- **Representation rename** (engine renames a field, or moves where a value
  lives) → handled by an **upcast** `(irVersion n → n+1)` that runs on
  hydrate; the hash is always computed over the *current* normal form, so a
  pure rename normalises to the same bytes → same sha. ✓
- **Real semantic change** (author changes a prompt, model, edge, retarget)
  → different normal form → new sha. ✓ (this is the only thing that should
  mint a version)

Upcasters are the price: every breaking IR-shape change ships an
`(n → n+1)` function, kept forever, with a golden-IR test proving an
unchanged workflow's sha is stable across the bump. That maintenance is the
mechanism that keeps identity stable across representation churn.

### One open question for you

**Is the workflow `id` (the `name:`) part of the content hash?** Two readings:

- **Exclude it** (recommended): `id` is a *handle*, the `(scope, name) → sha`
  alias carries it, and renaming a workflow doesn't mint a new version. Two
  identically-structured workflows with different names collapse to one sha —
  which is correct for a content-addressed store (they *are* the same
  content). Closest to "content addressing".
- **Include it**: a rename counts as a new version; identical-but-differently-
  named workflows stay distinct. Simpler mental model ("the file is the
  unit") but couples identity to a label.

I lean exclude. Flagging because it's a genuine judgment call, not derivable.

## Storage

`workflows` table after the change:

| Column | Meaning |
|---|---|
| `sha` (PK) | `sha256(canonical IR)` — semantic content address. |
| `ir` (TEXT) | `canonicalStringify(normalize(ir))` — the hydration + wire payload. |
| `ir_version` (INTEGER) | representation version of the stored `ir`; gates the upcast-on-read. |
| `created_at` | unchanged. |

`dot_source` is **gone** (not renamed — there's no source at rest). On read:
if `ir_version < CURRENT_IR_VERSION`, run the upcast chain to current and (optionally) rewrite the row. The daemon hydrates `ir` directly — no
`parseWorkflow` at dispatch. `name` moves to the `(scope, name) → sha` alias
table (orthogonal; can land with or before this).

## Migration (pre-release — clean reset)

No backward-compat obligation. The pragmatic path: bump the DB schema
version, drop + recreate `workflows` with the new columns, and let the next
upload of each workflow re-register it under its IR-sha. Existing `run_state`
rows reference old source-shas; pre-release we accept they're abandoned (or
truncate dev runs). The `dot_source` identifier sweep deferred in
[[dot-retirement-deferrals]] is subsumed — the column ceases to exist.

## Deferred / open

- The `id`-in-hash question above.
- `(scope, name)` alias table — orthogonal lineage; spec separately if not
  folded in here.
- Typebox-first IR schema in `@swarm/types` (one source generates the
  validator + the JSON Schema for editor IntelliSense + the upcast targets).
- `POST /workflows` accepting a pre-built IR (non-YAML clients) — only on
  demand.
