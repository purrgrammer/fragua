---
title: JSON IR as the canonical workflow form
status: proposed
maturity: designed
last-reviewed: 2026-05-04
---

# JSON IR as the canonical workflow form

> **Status: proposed.** Pre-release; no backwards-compat constraints.
> Brainstormed 2026-05-04; this doc records the four decisions that came
> out of that session plus the counterarguments that need to land in
> code or in `docs/SPEC.md` before the flip ships.

## Why

The engine already consumes a fully-typed in-memory IR
(`packages/core/src/types/graph.ts` — `Graph { id, directed, attrs,
nodes, edges, subgraphs }`). DOT is just the parser's input format;
nothing downstream of `parseDotSource` cares whether the source was
written by hand or generated. But the IR is invisible to anything
outside the engine:

- **No documented contract.** The shape lives only as TS interfaces in
  `core`. UIs, transformers, programmatic clients, and a future TS
  builder library have nothing concrete to target.
- **Storage is DOT-text-keyed.** `workflows(sha, name, dot_source,
  created_at)` stores the DOT source and re-parses it on every run
  start (`daemon/src/executor.ts:322`,
  `daemon/src/auto-dispatcher.ts:78`). Parser changes silently affect
  replay of old runs.
- **Prompts are inline-only.** Every prompt body lives as a `"""…"""`
  literal in the `.dot` file. No way to share fragments across
  workflows, version prompts independently, or compose them
  programmatically.

The IR is already the right artifact — it just needs a published
schema, a storage flip, and a clear authoring story (DOT stays as
sugar; JSON becomes first-class).

## Decisions

### 1. Flip storage canonicality: JSON IR, not DOT text

Persist the canonical IR; treat DOT as authoring sugar that lowers to
JSON at upload. `.dot` files keep living on disk in
`~/.swarm/workflows/` and `<cwd>/.swarm/workflows/` — that's the
authoring layer, untouched.

`workflows` row becomes:

```sql
CREATE TABLE IF NOT EXISTS workflows (
  sha          TEXT PRIMARY KEY,             -- sha256(canonicalJson(ir))
  name         TEXT NOT NULL,
  ir           TEXT NOT NULL CHECK (json_valid(ir)),
  schema_version INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
) STRICT;
```

`dot_source` is dropped. The IR is round-trippable to DOT (decision
4), so a re-emit endpoint covers human-readable display in the UI.

**Sha stability** rides on canonical JSON: alphabetical key ordering
on `Record`-shaped attrs, deterministic edge order (preserved by the
parser — see invariant below), no whitespace variance. Reuse
`packages/core/src/handler/canonical-stringify.ts`.

**Why TEXT, not BLOB/JSONB.** STRICT tables only allow
INT/REAL/TEXT/BLOB/ANY. `TEXT` + `CHECK (json_valid(...))` is
queryable via `json_extract`, version-portable across SQLite builds,
and KB-scale per row. JSONB is a future optimisation if the workflows
table ever turns hot.

**Why not externalise to `blobs/`.** Workflow IRs are small
(KB-range), hot at run start, and read every dispatch tick. The
existing `blobs` table externalises content to `blobsDir` outside
SQLite for WAL hygiene under large-artifact workloads — read
amplification we don't need for workflow rows.

### 2. Schema authority: Typebox-first

`@sinclair/typebox` is already a stack dep. One source produces three
artefacts:

```ts
// packages/types/src/graph-schema.ts
export const NodeAttrsSchema = Type.Object({ /* … */ });
export const GraphSchema = Type.Object({
  id: Type.String(),
  schemaVersion: Type.Literal(1),
  directed: Type.Literal(true),
  attrs: GraphAttrsSchema,
  nodes: Type.Record(Type.String(), NodeSchema),
  edges: Type.Array(EdgeSchema),
  subgraphs: Type.Array(SubgraphSchema),
});

export type Graph = Static<typeof GraphSchema>;
```

The current `core/src/types/graph.ts` interfaces become
`Static<typeof …>` derivations re-exported from `@swarm/types`. UIs,
the CLI, transformers, and future external clients import
`@swarm/types` and get runtime validation + JSON Schema export from
the same definition.

**Lift target: `@swarm/types`.** It's the cross-package contract
surface (events, skills) and the dep direction (`web → server →
store ← daemon → core ← agent`) makes it the right home — every
package can depend on `@swarm/types`, but `@swarm/core` shouldn't be
a dep of `@swarm/web`.

### 3. Schema version field on the IR itself

Explicit `schemaVersion: 1` literal on the root. Cheap forward-compat:
future parsers reject unknown versions cleanly without sniffing;
upgrade-on-read paths key off it. The row sha alone isn't enough —
two IRs with different `schemaVersion` but otherwise-similar content
would have unrelated shas, but the version field gives the executor a
fast pre-flight check before validation.

### 4. 1:1 DOT/JSON parity for now

DOT is a typed subset eventually (JSON picks up `$ref`/`@include`,
richer condition types, programmatic-only fields), but in this pass
JSON is purely a serialisation of the same DOT-expressible IR. Every
attribute today round-trips both ways. No new features.

This means:

- DOT → JSON via the existing parser (deterministic edge emission)
- JSON → DOT via a new emitter (`packages/core/src/parser/emit.ts`
  or similar) — needed for the UI re-emit endpoint and for the
  `swarm db` introspection commands
- A round-trip test: `parse(emit(parse(dot))) === parse(dot)` for
  every fixture in `packages/core/test/parser/fixtures/`

Subset extensions (`$ref`, programmatic fan-out generators, richer
condition AST) are explicit follow-ups, not part of this pass.

## Pinned invariants

These need to land in code (test) and in `docs/SPEC.md` so future
changes don't break sha stability or replay:

1. **Edge order is semantically significant.** Edge selection resolves
   ties by source order; canonicalisation must NOT sort `edges[]`.
   Parser must emit edges in source order, deterministically. Test
   in `packages/core/test/parser/edge-order.test.ts`.
2. **Attr key order is canonicalised.** `Record<string, …>` attrs are
   stringified with alphabetical key ordering. Without this, two
   semantically-identical DOTs with attrs in different source order
   produce different shas.
3. **Comments are not preserved across round-trip.** Authoring-time
   `.dot` files keep `//` comments on disk; the IR does not carry
   them. This is acceptable (comments are authoring aids, not part
   of the executable artifact) and must be documented so we don't
   get a "where'd my comments go" issue after the flip.
4. **Parser changes do not affect old-run replay.** Replay reads
   stored IR; the parser only runs at upload. This is a quiet
   correctness win over the status quo — worth one paragraph in
   `docs/SPEC.md` §3.

## Touch list

Files that change in the implementation pass:

- **`packages/types/src/`** — new `graph-schema.ts` (Typebox), new
  `graph.ts` re-exporting `Static<…>` types, `index.ts` updated
- **`packages/core/src/types/graph.ts`** — collapses to re-exports
  from `@swarm/types`
- **`packages/core/src/parser/`** — new `emit.ts` (JSON IR → DOT)
- **`packages/store/src/schema.sql`** — `workflows` row shape, schema
  bump v4 → v5
- **`packages/store/src/migrations.ts`** — try-migrate per row (see
  migration plan below)
- **`packages/store/src/workflow-queries.ts`** — `dot_source` → `ir`
  in queries
- **`packages/store/src/types.ts`** — `WorkflowRow.dotSource` →
  `WorkflowRow.ir`
- **`packages/store/src/store.ts`** — `saveWorkflow(sha, name, ir)`
- **`packages/server/src/store/routes.ts`** — upload endpoint accepts
  JSON IR directly OR DOT (lower → validate → store)
- **`packages/server/src/routes/workflows.ts`** — returns JSON IR;
  optional `?format=dot` query for re-emit (UI display path)
- **`packages/daemon/src/executor.ts:322`** — drop `parseDotSource`,
  validate IR against schema, use directly
- **`packages/daemon/src/auto-dispatcher.ts:78,86`** — same
- **`packages/agent/src/workflow-model-validator.ts:46`** — accept
  Graph IR not DOT text
- **`packages/cli/src/commands/run.ts`** — read `.dot` or `.json`;
  lower DOT → JSON client-side before upload
- **`packages/cli/src/commands/validate.ts`** — accept both
  extensions
- **`packages/server/src/adapters/fs-workflow-reader.ts:110`** —
  replace `extractLabel` regex over DOT with `parseDotSource` +
  `attrs.label`. Side cleanup; the regex was always a smell.

## Wire format

After the flip:

- **CLI → daemon:** JSON IR. The CLI parses local `.dot` to JSON
  before upload; the wire is one shape. Daemon's input contract is
  JSON IR full stop.
- **UI → daemon:** JSON IR (workflow editor builds it directly) or
  DOT text (legacy upload form, parsed server-side as a convenience).
  Both paths converge to the same store call.
- **Daemon → UI:** JSON IR for editing/visualisation; DOT via
  `?format=dot` re-emit for display.

## Migration plan

Schema v4 → v5. Sha space changes (sha256(dot_source) → sha256(canonicalJson(ir))),
so `run_state.workflow_sha` references need rewriting in the same
transaction.

Per-row migration:

```ts
for each row in workflows {
  try {
    graph = parseDotSource(row.dot_source);
    ir = canonicalize(graph);
    newSha = sha256Hex(ir);
    INSERT INTO workflows_new(sha, name, ir, schema_version, created_at) VALUES (newSha, name, ir, 1, created_at);
    UPDATE run_state SET workflow_sha = newSha WHERE workflow_sha = row.sha;
  } catch (parseError) {
    log.warn("workflow row %s no longer parses (%s) — runs referencing it will not replay", row.sha, parseError.message);
    // Row is skipped. run_state rows pointing at it become orphans;
    // their replay path will fail explicitly with "workflow not found".
  }
}
DROP TABLE workflows;
ALTER TABLE workflows_new RENAME TO workflows;
```

**Why try-migrate, not nuke-and-replace:** decision 1's stated value
was "see prev versions of a workflow even if they are not in git as
long as they've ran." Nuking destroys that on first deploy. The
try-migrate path costs ~20 LOC and degrades gracefully on parser
drift since insert.

**Failure mode:** a `dot_source` that no longer parses orphans its
runs. They keep their `run_state` rows but can't replay. Logged,
not fatal. Users in this state can re-upload the working DOT to get
a fresh sha; old runs stay as historical events.

## Out of scope (deferred follow-ups)

- **`$ref` / `@include` for prompt files.** Resolution at upload
  time, inlined into the stored IR for replay determinism.
  Separate proposal once the canonical-form flip lands; the
  brainstorm session settled the principle but not the syntax.
- **DOT-superset features.** Programmatic fan-out generators,
  richer condition AST, conditional sub-schemas in JSON. These all
  presuppose the JSON IR is first-class — wait for that.
- **TS workflow-builder library.** A typed builder targeting the
  JSON IR. Strictly a DX layer; not worth scoping until the schema
  is published and we have at least one external consumer asking
  for it.
- **UI workflow editor.** Building/editing workflows directly as
  IR in the dashboard. Requires the schema to be public first.

## Doc updates required (same PR as the flip)

Per AGENTS.md ground rule #1:

- **`docs/SPEC.md` §3** — graph model gains a stored-form section;
  invariant about edge-order determinism and parser-change isolation
- **`docs/ARCHITECTURE.md` §2** — `workflows` row shape change;
  schema v4 → v5 entry in the migration history
- **`.agents/skills/swarm-author/SKILL.md`** — note that DOT is
  authoring sugar; the canonical form is JSON IR; comments don't
  round-trip; reference the published schema
- **`README.md`** — if the quick-tour invocation references DOT
  specifically (`swarm run foo.dot`), update to mention `.json` is
  also accepted
