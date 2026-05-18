---
title: JSON IR as the canonical workflow form
status: proposed
maturity: designed
last-reviewed: 2026-05-18
---

# JSON IR as the canonical workflow form

> **Status: proposed.** Pre-release; no backwards-compat constraints.
> Brainstormed 2026-05-04, refined 2026-05-18. Records five decisions
> plus the counterarguments that need to land in code or in
> `docs/SPEC.md` before the flip ships. See `docs/graph/` for the
> typed Graph<I, O, E> model this proposal is the first concrete step
> toward, and `./fan-in-to-reduce.md` for the parallel `Reduce` kind
> that lands as part of the typed extensions.

## Why

The engine already consumes a fully-typed in-memory IR
(`packages/core/src/types/graph.ts` — `Graph { id, directed, attrs,
nodes, edges, subgraphs }`). DOT is just the parser's input format;
nothing downstream of `parseDotSource` cares whether the source was
written by hand or generated. But the IR is invisible to anything
outside the engine, and the storage shape conflates identity with
content:

- **No documented contract.** The shape lives only as TS interfaces in
  `core`. UIs, transformers, programmatic clients, and the typed
  `@swarm/sdk` builder (Addendum E) have nothing concrete to target.
- **Storage is DOT-text-keyed.** `workflows(sha, name, dot_source,
  created_at)` stores the DOT source and re-parses it on every run
  start (`daemon/src/executor.ts:322`,
  `daemon/src/auto-dispatcher.ts:78`). Parser changes silently affect
  replay of old runs.
- **Identity is conflated with content.** Today's `workflows` row
  carries both the immutable sha-keyed IR *and* the human-facing
  `name`; renames or re-uploads either thrash the row or strand it.
  There's no first-class concept of "version history of `change` in
  this project" — old shas survive only as referenced-by-runs;
  there's no alias-level audit.
- **Prompts are inline-only.** Every prompt body lives as a `"""…"""`
  literal in the `.dot` file. No way to share fragments across
  workflows, version prompts independently, or compose them
  programmatically.

The IR is already the right artifact — it just needs a published
schema, a storage flip, an explicit `(scope, name)` alias layer over
the content-addressed sha key, and a clear authoring story (DOT stays
as sugar; JSON becomes first-class; the typed builder consumes the
same IR).

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

### 4. DOT-expressible IR now; forward-compatible by additive fields

In this pass, JSON IR is a serialisation of the same shape DOT can
author — every current attribute round-trips both ways, no new
features land at the storage flip. But the IR schema is designed so
that the typed extensions described in `docs/graph/` arrive as
**additive optional fields**, not schema-version bumps.

Forward-compatible field plan:

- `inputSchema?: Schema`, `outputSchema?: Schema` on `Node` —
  Typebox JSON Schemas embedded verbatim. Absent → today's
  stringly-typed behaviour (input from `$ARGUMENTS` / substitution,
  output from last assistant message).
- `kind?: NodeKind` on `Node` — the typed discriminator. Seven
  values: `'llm' | 'task' | 'wait' | 'map' | 'reduce' | 'race' | 'subgraph'`.
  Compute kinds (`llm`, `task`); suspend kind (`wait`); composition
  kinds (`map`, `reduce`, `race`, `subgraph`). Absent → derive from
  shape (today's behavior, compute kinds only). There is no
  `Function` kind — user JS reaches runs through `@swarm/sdk`
  extensions (`defineTool` / `defineHook`), not through a graph
  node body.
- `predicate?: PredicateExpr`, `transform?: TransformExpr` on
  `Edge` — see [`docs/graph/expressions.md`](../graph/expressions.md)
  for the AST grammar. SDK desugars single-expression arrows to AST
  at `.compile()` time; multi-statement arrows rejected.
- **All function-typed node attrs become declarative expressions**.
  No TS functions in the IR. The five expression types from
  `docs/graph/expressions.md` cover every previously-function
  field:
  - `LLM.prompt: { system?: TemplateExpr; user: TemplateExpr }` —
    replaces `buildPrompt`.
  - `Task.command: TemplateExpr` — placeholder substitution.
  - `Wait.human.prompt: { question, description? }` of TemplateExpr.
  - `Map.extract: TransformExpr` — must yield an array; bind-time
    type check.
- `parseOutput?: 'tool-call' | 'structured-response'` on
  LLM-shaped nodes — two options only. The earlier
  `fromAssistantText` fallback parser is dropped; restructure with
  a downstream Task that parses prose.
- `outputRetries?: number` on LLM-shaped nodes — cap on
  output-schema-validation retries. Default 1.
- `source: 'human' | 'http' | 'timer'` discriminator on `Wait`-shaped
  nodes (single-source per node, no tagged union). Multi-source
  composition is expressed via `Map(policy: 'first_success')`.
- `reduceKind?: 'function' | 'llm'` on `tripleoctagon` — explicit
  reducer kind for the fan-in (`./fan-in-to-reduce.md`).
- `bounds.policy?: 'stop' | 'warn' | 'pause'` on graph-level
  `bounds`. Maps today's `budget_policy=` knob. Per-kind bounds
  always halt the offending node; policy lives at graph level.

Several Outcome / Node fields that appeared in earlier drafts are
**gone**:

- `retry` on Node and `retriable` on Outcome.err: dropped. Retry is
  graph topology — retarget edges with `retryBudget`.
- `Outcome.paused`: dropped. Paused is a `RunStatus`, not an
  Outcome variant; edges only fire on terminated nodes.
- `Node.thread?` and `Node.bounds?` on the Node interface: moved
  off — `thread` is LLM-only, `bounds` shape is per-kind.
- `Graph.events: { in; out }`: dropped from IR. Runtime infers `E`
  from kinds present; SDK infers for typed-IO consumers.

Forward-compat rules:

- New fields are optional. Old IRs validate against the new schema.
- When both a legacy stringly-typed field and a typed alternative
  are present, the typed one wins; the IR validator warns on the
  duplication (catches half-migrated workflows).
- A non-additive break (rename, delete, type change) bumps
  `schemaVersion` and triggers a migration pass; until then it
  stays at `1`.

This decoupling lets the canonical-form flip ship now (DOT parity,
no behavioral change) and the typed extensions layer on without
further schema-version bumps when they arrive.

Mechanical workflow today:

- DOT → JSON via the existing parser (deterministic edge emission).
- JSON → DOT via a new emitter (`packages/core/src/parser/emit.ts`
  or similar) — needed for the UI re-emit endpoint and `swarm db`
  introspection. Typed-only fields without a DOT analogue (e.g.
  Typebox schemas) emit as a `// typed:` comment block that the
  parser preserves on re-parse for round-trip stability *until* the
  typed extensions can no longer round-trip cleanly, at which point
  DOT becomes read-only for those workflows.
- Round-trip test: `parse(emit(parse(dot))) === parse(dot)` for
  every fixture in `packages/core/test/parser/fixtures/`.

Out-of-scope DOT-superset features that arrive later as additive
fields: `$ref` / `@include` for prompt files, richer condition AST
(see typed predicates above), programmatic fan-out generators.

### 5. `(scope, name)` user-facing identity; sha-referenced underneath

The user resolves workflows by name and scope: `swarm run change`
picks the `change` workflow from the current scope (project cwd or
user-global). Today's `workflows` table conflates identity (the
human alias) and content (the IR sha): every upload creates a new
row with a new sha; the human-facing name is stamped onto each row
and overwritten on re-upload. No first-class alias history, no
way to see "every version of `change` in this project."

Split:

```sql
CREATE TABLE workflows (
  sha            TEXT PRIMARY KEY,             -- sha256(canonicalJson(ir))
  ir             TEXT NOT NULL CHECK (json_valid(ir)),
  schema_version INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE workflow_aliases (
  scope          TEXT NOT NULL,                -- 'user' | <project cwd>
  name           TEXT NOT NULL,                -- e.g. 'change'
  sha            TEXT NOT NULL REFERENCES workflows(sha),
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (scope, name, sha)
) STRICT;

CREATE INDEX workflow_aliases_latest
  ON workflow_aliases(scope, name, last_seen_at DESC);
```

Three properties:

1. **Content-addressed dedup.** Same IR → same sha → one `workflows`
   row. A workflow uploaded from two projects shares the row; storage
   collapses identical content.
2. **Multiple historical aliases per `(scope, name)`.** Each edit
   creates a new sha; the alias table records every `(scope, name,
   sha)` it's ever pointed at. `last_seen_at` orders them; the UI
   can show full version history per `(scope, name)`.
3. **Replay survives renames and deletes.** Old runs reference the
   immutable `workflow_sha`. The `workflows` row is keyed by sha,
   not by `(scope, name)`; renames or deletes of aliases don't
   break replay. The alias table only affects resolution of `swarm
   run <name>` going forward.

Naming `scope`:

- `"user"` is the reserved literal for `~/.swarm/workflows/`.
- Project scopes use the absolute cwd path as the scope literal —
  simple, stable, no extra config; the `cwd` field on `run_state`
  already serves the same identity purpose for project
  disambiguation. A future "project identity" notion (git remote
  URL, project-config UUID) could replace the cwd literal without
  schema change since the column is opaque text.

Resolution:

- `swarm run <name>` from cwd `/foo`: pick `sha` from
  `workflow_aliases WHERE scope='/foo' AND name=?` ordered by
  `last_seen_at DESC LIMIT 1`; fall back to `scope='user'`.
- UI: list `(scope, name)` pairs as workflows; the workflow detail
  page shows version history — every sha ever aliased to this name,
  with first/last-seen timestamps and per-sha run count.

Upload:

```sql
-- Content-addressed; identical IRs collapse to one row.
INSERT OR IGNORE INTO workflows(sha, ir, schema_version, created_at)
  VALUES (?, ?, ?, ?);

-- Alias record; bumped on every upload of this (scope, name, sha).
INSERT INTO workflow_aliases(scope, name, sha, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?)
ON CONFLICT (scope, name, sha) DO UPDATE SET last_seen_at = excluded.last_seen_at;
```

Scope passed by the CLI at upload time — the CLI resolved the
workflow file from a known directory and forwards the path (or
`"user"`) on `POST /workflows`. The server validates the scope is
either `"user"` or an absolute path.

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
5. **`schemaVersion` is sha-load-bearing** (originally Addendum C).
   The version field is part of canonical JSON. Differing versions
   ⇒ different shas, even if the rest of the IR is byte-identical.
   A migration that re-keys workflows must do so in the same
   transaction as the version bump (or accept replay drift for
   in-flight runs).
6. **Alias is many-to-many; sha is the immutable identity.** Renaming
   or deleting a workflow alias doesn't affect the `workflows` row
   keyed by sha. Old runs replay against their pinned sha regardless
   of alias state. The alias table only affects resolution of
   `swarm run <name>` going forward. Tested by: delete every alias
   for a `(scope, name)`, confirm runs that referenced its prior
   shas still replay; recreate the alias with a new sha, confirm
   resolution returns the new one without affecting historical
   replays.

## Touch list

Files that change in the implementation pass:

- **`packages/types/src/`** — new `graph-schema.ts` (Typebox), new
  `graph.ts` re-exporting `Static<…>` types, `index.ts` updated.
  All optional typed-extension fields land here as `Type.Optional(…)`.
- **`packages/core/src/types/graph.ts`** — collapses to re-exports
  from `@swarm/types`.
- **`packages/core/src/parser/`** — new `emit.ts` (JSON IR → DOT).
- **`packages/store/src/schema.sql`** — `workflows` row shape (drop
  `dot_source`, add `ir` + `schema_version`); new `workflow_aliases`
  table for `(scope, name) → sha` history; schema bump v4 → v5.
- **`packages/store/src/migrations.ts`** — try-migrate per row + seed
  the alias table from existing `run_state.cwd` correlations (see
  migration plan below).
- **`packages/store/src/workflow-queries.ts`** — `dot_source` → `ir`
  in queries; new alias resolution + history query family.
- **`packages/store/src/types.ts`** — `WorkflowRow.dotSource` →
  `WorkflowRow.ir`; new `WorkflowAliasRow`.
- **`packages/store/src/store.ts`** — `saveWorkflow(scope, name, sha, ir)`
  (writes `workflows` + upserts `workflow_aliases`);
  `resolveAlias(scope, name)`; `listAliasHistory(scope, name)`.
- **`packages/server/src/store/routes.ts`** — upload endpoint accepts
  JSON IR directly OR DOT (lower → validate → store); takes scope as
  required parameter (`"user"` or absolute cwd path).
- **`packages/server/src/routes/workflows.ts`** — returns JSON IR;
  optional `?format=dot` query for re-emit (UI display path); new
  `/workflows?scope=…` and `/workflows/:scope/:name/history`.
- **`packages/server/src/store/runs-routes.ts`** — `GET /runs/:id`
  projection drops embedded `workflowSource` (Addendum A + G).
- **`packages/daemon/src/executor.ts:322`** — drop `parseDotSource`,
  validate IR against schema, use directly.
- **`packages/daemon/src/auto-dispatcher.ts:78,86`** — same.
- **`packages/agent/src/workflow-model-validator.ts:46`** — accept
  Graph IR not DOT text.
- **`packages/cli/src/commands/run.ts`** — read `.dot` or `.json`;
  lower DOT → JSON client-side before upload; pass scope (resolved
  workflow directory) on `POST /workflows`.
- **`packages/cli/src/commands/validate.ts`** — accept both
  extensions.
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

Schema v4 → v5. Sha space changes (`sha256(dot_source) →
sha256(canonicalJson(ir))`), so `run_state.workflow_sha` references
need rewriting in the same transaction. Alias table seeded from the
existing `(workflows.name, run_state.cwd)` correlation.

Per-row migration:

```ts
// Step 1: build the new workflows table (sha-keyed, content-only).
for each row in workflows {
  try {
    graph = parseDotSource(row.dot_source);
    ir = canonicalize(graph);
    newSha = sha256Hex(ir);
    INSERT OR IGNORE INTO workflows_new(sha, ir, schema_version, created_at)
      VALUES (newSha, ir, 1, row.created_at);
    UPDATE run_state SET workflow_sha = newSha WHERE workflow_sha = row.sha;
    // Remember the rewrite for alias seeding below.
    shaRewrites[row.sha] = { newSha, name: row.name, createdAt: row.created_at };
  } catch (parseError) {
    log.warn("workflow row %s no longer parses (%s) — runs referencing it will not replay", row.sha, parseError.message);
    // Row skipped. run_state rows pointing at it become orphans;
    // their replay path will fail explicitly with "workflow not found".
  }
}

// Step 2: seed workflow_aliases from the run_state.cwd correlation.
// For each successfully-migrated workflow_sha, derive scope from the
// cwd of every run that referenced it; record one alias row per
// (scope, name, newSha).
for each (oldSha, rewrite) in shaRewrites {
  cwds = SELECT DISTINCT cwd FROM run_state WHERE workflow_sha = rewrite.newSha;
  if cwds.length === 0 {
    // No runs ever; treat as user-scope by convention.
    cwds = ["user"];
  }
  for each cwd in cwds {
    scope = isUserGlobalPath(cwd) ? "user" : cwd;
    minRunCreatedAt = SELECT MIN(created_at) FROM run_state WHERE workflow_sha = rewrite.newSha AND cwd = cwd;
    maxRunCreatedAt = SELECT MAX(created_at) FROM run_state WHERE workflow_sha = rewrite.newSha AND cwd = cwd;
    INSERT INTO workflow_aliases(scope, name, sha, first_seen_at, last_seen_at)
      VALUES (scope, rewrite.name, rewrite.newSha,
              minRunCreatedAt ?? rewrite.createdAt,
              maxRunCreatedAt ?? rewrite.createdAt);
  }
}

DROP TABLE workflows;
ALTER TABLE workflows_new RENAME TO workflows;
```

**Why try-migrate, not nuke-and-replace.** Decision 1's stated value
was "see prev versions of a workflow even if they are not in git as
long as they've ran." Nuking destroys that on first deploy. The
try-migrate path costs ~20 LOC and degrades gracefully on parser
drift since insert.

**Why correlate scopes from run_state.cwd.** Today's workflows table
doesn't record scope; it's a CLI-time concept. The closest authoritative
record is which cwds have run each workflow, which lets us seed the
alias table with real scope/name pairings instead of dumping everything
into `"user"`. The seeding is best-effort — a workflow uploaded but
never run lands under `"user"` as a fallback.

**Failure mode.** A `dot_source` that no longer parses orphans its
runs. They keep their `run_state` rows but can't replay. Logged,
not fatal. Users in this state can re-upload the working DOT to get
a fresh sha; old runs stay as historical events.

## Out of scope (deferred follow-ups)

- **`$ref` / `@include` for prompt files.** Resolution at upload
  time, inlined into the stored IR for replay determinism.
  Separate proposal once the canonical-form flip lands; the
  brainstorm session settled the principle but not the syntax.
- **Typed extensions (`docs/graph/`).** Optional fields are
  reserved in the schema (Decision 4); their *use* — typed I/O at
  edges, structured LLM output via terminal output tool, Map /
  Reduce kinds, retarget edges as data, the typed-builder
  authoring surface — lands as a follow-up layer that doesn't
  bump `schemaVersion`. Tracked by `docs/graph/` and Addendum F.
- **Reducer-kind handler fix.** Today's `tripleoctagon` silently
  ignores `prompt=`. Tracked by `./fan-in-to-reduce.md`; lands
  with the typed extensions, not at the storage flip.
- **UI workflow editor.** Building/editing workflows directly as
  IR in the dashboard. Requires the schema to be public first.

## Doc updates required (same PR as the flip)

Per AGENTS.md ground rule #1:

- **`docs/SPEC.md` §3** — graph model gains a stored-form section;
  invariant about edge-order determinism and parser-change isolation;
  `(scope, name)` identity layer and alias-table semantics.
- **`docs/ARCHITECTURE.md` §2** — `workflows` row shape change;
  new `workflow_aliases` table shape and indexes; schema v4 → v5
  entry in the migration history.
- **`docs/ARCHITECTURE.md` §7** — new alias-resolution + history
  endpoints; updated `GET /runs/:id` projection (drops embedded
  `workflowSource`).
- **`.agents/skills/swarm-author/SKILL.md`** — note that DOT is
  authoring sugar; the canonical form is JSON IR; comments don't
  round-trip; reference the published schema. `(scope, name)`
  resolution covered briefly in §2 "Workflow location".
- **`README.md`** — if the quick-tour invocation references DOT
  specifically (`swarm run foo.dot`), update to mention `.json` is
  also accepted.
- **`docs/graph/migration.md`** — update if any workflow's
  translation changes during the implementation pass.

---

## Addendum — 2026-05-17 review

Four points landed during a parallel design review, none of which
change the core design but each of which needs to be reflected in the
implementation PR.

### A. `/runs/:id` projection: drop the embedded `workflowSource`

The current `GET /runs/:id` response embeds `workflowSource: <raw DOT
text>` inline. This surface was caught during the G1 orchestration
because the raw DOT contains unescaped newlines/tabs, breaking strict
JSON consumers (jq fails with `Invalid string: control characters from
U+0000 through U+001F must be escaped`). The flip naturally fixes
this because the wire is JSON IR. Two ways to land it:

1. Replace with `workflowIr` (structured, well-escaped by
   construction).
2. **Drop the embed entirely.** The run already carries
   `workflow_sha`; clients dereference via the workflow endpoint when
   they need the source. Net win: cheaper hot-path projection
   response, no duplicate source bytes per run.

Recommend option 2. The projection is read on every status poll; the
workflow source is read at most once per UI session. Cuts hot-path
payload meaningfully on long-prompted workflows. Listed task #16
(server escape control chars) becomes moot under either option.

### B. JSON IR allows nested objects for fields DOT escapes as strings

The rule applies whenever a node attribute's authored value is
JSON-shaped (e.g. the typed inputs/outputs/context surface when it
lands).

In DOT, any JSON-shaped attribute value must be inline-escaped
(`some_attr = "{\"type\":\"object\",...}"`); in JSON IR the same field
can be a nested object. This is **within 1:1 parity** — DOT authors
keep their string-escape syntax — but it removes a double-escaping
wart in the JSON form that would otherwise persist if the IR matched
DOT character-for-character.

Implementation guidance: any node attribute whose authored value is a
JSON-shaped string should be stored as a parsed object in the IR. The
DOT-to-IR lowering does the parse; the DOT emitter re-stringifies on
the way out. Round-trip stable.

This makes the JSON form strictly more ergonomic for the cases where
DOT's string-only fields are already carrying structured data, and
sets up a clean home for future typed-attr work (see Addendum E).

### C. Pinned invariant: sha is sensitive to `schemaVersion`

Already implied by "canonical JSON includes the version field"
(decision 3) but worth explicit: two IRs identical in content but
differing in `schemaVersion` produce **unrelated shas**. A future
migration that bumps the version on every row therefore re-keys every
workflow. Document so a maintainer doesn't "optimise" by hashing only
the content field.

Add to §Pinned invariants:

> 5. **schemaVersion is sha-load-bearing.** The version field is part
>    of canonical JSON. Differing versions ⇒ different shas, even if
>    the rest of the IR is byte-identical. A migration that re-keys
>    workflows must do so in the same transaction as the version
>    bump (or accept replay drift for in-flight runs).

### D. Web bundle savings

`packages/web/src/lib/parse-workflow.ts` calls `parseDotSource`
client-side to render the graph. After the flip, the UI fetches JSON
IR directly — the 482 LOC parser stops shipping to the browser. Net
positive on initial-render time + bundle size. Worth listing under
§Why as an additional motivator, not a primary one.

### E. Cross-reference: `@swarm/sdk` programmatic-build brainstorm

A sibling brainstorm is in flight (2026-05-17) on a `@swarm/sdk`
TypeScript namespace that builds JSON IR via code — typed
context/inputs/outputs, importable subworkflows, Typebox schemas on
nodes for compile-time wiring checks. That work assumes this proposal
ships first (the published Typebox schema in `@swarm/types` is the
SDK's target). When the brainstorm settles, it lands as its own
proposal (`docs/proposals/swarm-sdk.md` or similar) and the §Out of
scope "TS workflow-builder library" bullet here gets retired.

The SDK direction is *strictly additive* to this proposal — it
consumes the JSON IR schema, doesn't change it. But it's the
motivating reason to push hard on the Typebox-first decision (§2)
since the SDK's value proposition is type inference across the graph,
which requires the schema to be the source of truth.

### G. `/runs/:id` projection: `workflowSource` retires (resolves task #16)

Task #16 ("server: escape control chars in `/runs/:id workflowSource`")
is closed as superseded by this proposal. With JSON IR as the wire
format and the projection change (Addendum A's option 2):

- The projection embeds typed JSON, not raw DOT text. JSON encoding
  handles control chars natively; the escape-control bug cannot
  occur in the new wire shape.
- Following Addendum A's recommendation, the projection drops the
  embedded source entirely. Clients dereference via the workflow
  endpoint when they need source. Hot-path projection payload
  shrinks; long-prompted workflows no longer carry their text on
  every status poll.

No separate work item — lands as part of this proposal's server
touch list.

### F. Cross-reference: `docs/graph/` typed Graph model

A `docs/graph/` directory landed 2026-05-18 describing the typed
`Graph<I, O, E>` model the JSON IR is the canonical form for. It
covers:

- **types.md** — `Graph`, `Node`, `Edge`, `Outcome`, `Bounds`
- **expressions.md** — `TemplateExpr` / `PathExpr` / `TransformExpr`
  / `PredicateExpr` / `BuiltinRef` DSL grammars
- **kinds.md** — five node kinds (`LLM`, `Task`, `Wait`, `Map`,
  `Reduce`); user-authored JS lives in extensions, not graph bodies
- **sdk.md** — `@swarm/sdk` userland surface: graph definition,
  tool / hook definition, pattern library, testing utilities
- **runtime.md** — `Environment`, `BoundGraph`, `Run<I, O, E>`,
  `IO<E>`
- **laws.md** — algebraic + operational invariants, property-test
  templates
- **patterns.md** — Anthropic "Building Effective Agents" patterns
  expressed in the typed model
- **migration.md** — every current workflow translated to the new
  model

The canonical-IR flip described in this proposal is the **first
concrete step** of that larger direction. Once the IR is stable and
the Typebox schema is published in `@swarm/types`, the typed
Node / Edge attribute extensions (LLM structured output, edge DSL,
Map / Reduce kinds, retarget edges as data) layer on without further
schema-version bumps if planned correctly — they're additive fields
on existing IR shapes.

Implications for this proposal:

- §Out of scope's "TS workflow-builder library" bullet retires — the
  SDK direction is now explicit (`docs/graph/runtime.md`, Addendum E
  above).
- `schemaVersion: 1` stays at `1` for the canonical-IR flip; typed
  extensions land as optional fields, bumping to `2` only when a
  non-additive break is needed.
- §Doc updates required gains: `docs/graph/migration.md` if any
  workflow's translation changes during implementation.
