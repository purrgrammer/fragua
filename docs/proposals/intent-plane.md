---
title: Intent plane — one validate/construct/mint surface, many ports
summary: "Author intent validation, event construction, run-id minting, and the workflow-identity mint into a single shared code surface that the HTTP server, the (future) direct-store-client CLI, and the schedule-dispatcher fiber all call through thin adapters. One audit point, one test suite; no two writers can disagree about what a valid intent is. Foundation for the rest of the CLI-topology roadmap."
status: proposed
maturity: designed
last-reviewed: 2026-05-23
parent: cli-topology.md
---

# Intent plane

> Child of [`cli-topology.md`](cli-topology.md). **Ship first** — it gates every
> other workstream and is a behavior-preserving refactor on its own.

## 1. Problem

Intent validation + construction is currently server-only and split across the
HTTP layer: TypeBox schemas in `packages/server/src/schemas.ts`, validation in
`packages/server/src/store/routes.ts`, run-id minting in
`packages/server/src/store/run-id.ts`, ending in the store writes
`store.appendIntent(runId, event)` / `store.enqueueRun(params)`.

The moment the CLI writes intents directly to the store (the rest of the
roadmap), it must construct and validate them too. If it duplicates that logic,
the CLI and server can drift on what a valid intent is. They must share one
builder.

## 2. Design

A shared application service between the request/argv boundary and the store:

```
              ┌─────────────────────────────────────────────┐
  HTTP req  ─▶│  intent plane                                │
  CLI argv  ─▶│  validate → construct IntentEvent → mint     │──▶ saveWorkflow
  scheduler ─▶│  (workflow-identity mint lives here, §3.1)   │──▶ appendIntent
   fiber      │                                              │──▶ enqueueRun
              └─────────────────────────────────────────────┘
   ports (THREE, not two): HTTP adapter (server route), CLI argv adapter,
   and the schedule-dispatcher fiber (resolves + uploads a workflow at fire
   time, then enqueues — a save-then-enqueue driven by the fiber, not an
   operator command).
```

- **Location — DECIDED: a `@fragua/core` sub-entry (`@fragua/core/intent-plane`).**
  It depends on `@fragua/store`, so it can't be the browser-safe `core` main entry —
  but the precedent is exact: `core/package.json` already exports `"./handler"`, a
  store-pulling sub-entry excluded from the web bundle. The plane has that same shape
  (store-dependent, server/CLI/daemon-only, never bundled). A dedicated package is
  overhead for no gain. The pure half (validate + construct a validated `IntentEvent`)
  is unit-testable in isolation; the commit is the store call.
- **What the plane gains — *author*, not move.** Correcting §1: `server/src/schemas.ts`
  is read-side only (RunSummary, RunDetail, …); there are **no intent-input TypeBox
  schemas to relocate.** Intent bodies are validated today by hand-rolled inline
  `typeof` checks across the ~15 `POST` endpoints in `routes.ts`. The plane work is to
  **author** the intent-input schemas (replacing those inline checks) — more than a
  relocation, and the higher payoff: intent inputs get a real validated contract for
  the first time. Also moving in: `newRunId` (already in `@fragua/store`; the plane
  takes it as the injected minter, §3.3), and the validate-then-construct logic inline
  in `routes.ts`.
- **What the adapters become:** the HTTP route shrinks to *deserialize request →
  `plane.build*(...)` → `plane.commit*(...)`*. The CLI command (later workstreams)
  is the same minus deserialization — *parse argv → `plane.build*(...)` →
  `plane.commit*(...)`*. Adapters never touch the store write API directly (§3).
- **Single audit surface** — the `backend` skill's "one place per domain"
  applied to writes. `ports.ts` already states the direction (*"the only port we
  keep is `WorkflowReader` … everything else reads directly from
  `@fragua/store`"*); this extends it to the write path.

## 3. Decisions owned here

### 3.1 Surface shape — pure `build*` + shared effectful `commit*`

The plane is a **constructed object** with two method families, and **adapters
never call `store.appendIntent` / `store.enqueueRun` / `saveWorkflow` directly** —
only `plane.commit*`. "One audit surface for writes" then becomes a **lint-enforced
invariant** — a discipline test (in the shape of `core/test/handler/discipline.test.ts`
and `store/test/lint.test.ts`) fails the build if a store-write call appears outside
the plane — not a convention asserted in prose.

- `plane.build*(input) → built` — **deterministic given its injected minter**
  (§3.3): TypeBox-validate, construct the `IntentEvent`, mint the run id, compute
  `workflowSha`. Browser-safe; the per-`IntentEvent`-variant test suite lives here.
- `plane.commit*(built) → result` — **effectful**: the store write(s).

Enqueue is **two *independent* ops, not one coupled commit** — correcting an
earlier over-coupling. The HTTP surface proves it: `POST /workflows` (upload) and
`POST /runs` (enqueue) are separate endpoints, and run-enqueue resolves its own
workflow (by `workflowSha`, or by `workflowName` via the `WorkflowReader` port) and
parses the graph itself; the web UI uploads a workflow once and enqueues many runs
against it. So the plane exposes two op pairs:

- `buildSaveWorkflow(source) → { sha, ir, ir_version }` + `commitSaveWorkflow(…)`.
  **This is the single workflow-identity mint chokepoint.** All three of today's
  mint sites — `POST /workflows`, the by-name resolver (`if getWorkflow(sha)==null →
  saveWorkflow`), and the schedule dispatcher — each currently re-do `sha256Hex(source)`
  + `serializeGraph(parseWorkflow(source))` + `saveWorkflow(…, CURRENT_IR_VERSION)`
  independently. They converge here, once. This is exactly the consolidation
  [`workflow-ir.md`](workflow-ir.md) §8.2 requires for move (B): `buildSaveWorkflow`
  *is* the `workflowIdentity(source)` function, so (B)'s source-hash → IR-hash swap
  is a one-line change inside it, not a three-site sweep.
- `buildEnqueue(input) → { runId, intent, runParams }` + `commitEnqueue(…)`. Mint the
  run id in `build` so the adapter returns it immediately (today's `c.json({ runId })`).

The only coupling between them is **referential**: a run's `workflow_sha` FKs onto
`workflows.sha`, so the workflow must be saved before the run is enqueued. There is
**no spanning transaction** — a `saveWorkflow` that lands before an `enqueueRun`
failure leaves a harmless orphan workflow row (GC'd by `gc-blobs`). The caller
sequences the two (the CLI `run` and the dispatcher fiber both do
save-then-enqueue); the order + orphan-is-fine decision is documented once, here.

### 3.2 `run_id` (cli-topology §5.3) — widening shipped

The widening landed in the pre-0.1.0 cleanup; the ULID `newRunId` now lives in
`@fragua/store` so every fact-writer (server route + daemon dispatcher) mints the
same wide form. This proposal **moves the call onto the plane** — `newRunId` is
server-only today, but the CLI mints ids when it writes the enqueue intent
directly, so generation cannot stay behind the HTTP boundary.

### 3.3 Determinism — inject the minter at construction, not its primitives

The plane takes `newRunId: () => RunId` as a **construction dep** (not a per-call
param, not raw `{ clock, random }`):

- **Inject the minter, not its primitives.** `newRunId` already encapsulates both
  nondeterminism sources — `encodeTime(Date.now())` + `randomBytes(10)`
  (`run-id.ts`) — and it is the *only* nondeterminism on the plane path: the store
  stamps event `ts` via `store.now()`, and validation + `workflowSha` are
  content-deterministic. Injecting raw `{ clock, random }` would force the plane to
  re-derive ULIDs, duplicating the Crockford encoding that is a tested
  `@fragua/store` unit. The function seam (executor-pbt §4 determinism) lets the
  PBT harness pass a counter-based minter and stay ULID-agnostic.
- **The uniqueness/import contract lives on the *default* minter.** Production must
  use the full-entropy ULID: run ids are portable identity (db-import) and must not
  collide when stores from different machines merge — that is what the 80 random
  bits buy. Any non-default minter is **test-only** (single virtual store,
  collisions irrelevant). The store backstops either way: `enqueueRun` inserts on
  the `run_state` PK, so a collision throws rather than silently overwriting a
  foreign run.

### 3.4 Validation dialect — the plane is TypeBox; JSON Schema is confined to the LLM tool boundary

Intent validation is TypeBox (the intent-input schemas are **authored** in the plane,
§2 — there are none to relocate); the plane **never imports a JSON-Schema validator**. The repo's *other* schema
dialect — JSON Schema for the synthesized `emit_output` tool
([`structured-outputs.md`](structured-outputs.md)) — is legitimately separate
because it has a different audience: TypeBox is authored in TS for internal
contracts, while JSON Schema is authored in workflow YAML (`outputs:`) and sent to
a provider that speaks JSON Schema natively. This is an audience split, not
accidental fragmentation, so the two are **not** unified. Note TypeBox *is*
JSON-Schema-shaped (`Type.Object(...)` serializes to a JSON Schema object), so if
an internal contract ever needs to cross to the provider boundary it serializes for
free — no second authoring.

### 3.5 `writer` rename

`'web'` → `'client'` (cli-topology §5.2) surfaces here: the plane sets the writer on
constructed intents. Pre-0.1.0, this is **edit-the-CHECK-in-place, not a migration**:
`schema.sql:129` `CHECK (writer IN ('daemon','web'))` → `'client'`, the
`EventWriter = "daemon" | "web"` type in `@fragua/types`, and the store's
intent-append site plus a handful of test fixtures. Bounded, but a contract-enum
touch (CLAUDE.md §1), so it lands *with* the plane, not as an afterthought.

### 3.6 Adapter ↔ plane boundary — deserialization, resolution, defaults

"Deserialization-and-defaults" hides three concerns that split on whether they are
*pure* — and the split, not a single binary choice, is the decision:

- **Transport deserialization** (JSON body vs argv) → **adapter, necessarily.** Two
  different parsers for two formats; there is no shared truth to drift from, so this
  is not real duplication.
- **I/O-bound field resolution** — the CLI deriving `projectId` / `projectName` /
  `cwd` by walking up for `.fragua/config.yaml` → **adapter (CLI only).** The plane is
  pure and cannot hit the filesystem; the HTTP adapter receives these pre-resolved
  over the wire, so this lives in exactly one adapter and is *not* duplicated.
- **Domain defaults + the `inputs:` merge + validation + construction + minting** →
  **plane, once.** `priority ?? 0`, the workflow's declared `inputs:` defaults ⊕
  `--input` overrides, `routing.input` assembly. These are the shared *meaning* of an
  enqueue; duplicating them across adapters is the exact drift this plane exists to
  prevent.

**Decision: the plane fills defaults; the adapter never knows a default value.**
`plane.build` accepts a typed request where **defaultable domain fields are optional**
(`priority?`, `title?`, `input?`, `inputs?`) and **location/identity fields are
required** (`cwd`, `projectId`, `projectName`, the workflow ref — the adapter supplies
them by wire or by I/O resolution). The plane applies the defaults, runs the `inputs:`
merge, validates, constructs, and mints — **pure given the injected minter** (§3.3).
Note this does *not* trade purity for non-duplication: applying defaults is pure, so
"plane stays pure" and "plane fills defaults" both hold. The only thing kept out of
the plane is I/O (CLI project resolution) — which is resolution, not a default, and
appears in one adapter.

## 4. Scope / dependencies / MVP

- **Depends on:** nothing.
- **Wins independently:** yes — a pure internal refactor with no behavior change,
  giving the server a cleaner single-audit write surface even with zero CLI work.
- **MVP = the whole thing.** Atomic, though "author intent schemas" makes it more
  than a relocation. The deliverable is: a `@fragua/core/intent-plane` sub-entry
  (§2) holding a constructed plane with the two op pairs — `buildSaveWorkflow` /
  `commitSaveWorkflow` (the workflow-identity chokepoint, §3.1) and `buildEnqueue` /
  `commitEnqueue` — plus `build*`/`commit*` for the ~13 control intents; `build*` is
  pure given the injected `newRunId` (§3.3), with defaultable fields optional +
  identity/location fields required (§3.6). Intent-input TypeBox schemas **authored**
  (replacing the inline `typeof` checks), the domain defaults / `inputs:` merge moved
  in, the `'web'`→`'client'` writer rename landed (§3.5). Server routes refactored to
  adapters that only deserialize — never touch the store write API directly, never
  apply a default — backed by a **discipline test** failing the build on any
  store-write call outside the plane (§3.1). One test suite covering
  validate/construct for every `IntentEvent` variant (passing a counter-based minter);
  monorepo typecheck + `bun test` green. (The CLI argv adapter and the dispatcher
  routing through the plane are follow-on workstreams; the server refactor + authored
  schemas is the standalone win.)
