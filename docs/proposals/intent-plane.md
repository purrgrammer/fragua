---
title: Intent plane — one validate/construct/mint surface, two ports
summary: "Extract intent validation, event construction, and run-id minting into a single shared code surface that both the HTTP server and the (future direct-store-client) CLI call through thin adapters. One audit point, one test suite; the CLI and server cannot disagree about what a valid intent is. Foundation for the rest of the CLI-topology roadmap."
status: proposed
maturity: designed
last-reviewed: 2026-05-22
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
              ┌─────────────────────────────────────────┐
  HTTP req ──▶│  intent plane                            │
  argv     ──▶│  validate → construct IntentEvent → mint │──▶ store.appendIntent
              │                                           │──▶ store.enqueueRun
              └─────────────────────────────────────────┘
   ports: HTTP adapter (server route), argv adapter (cli command)
```

- **Location.** A shared module that depends on `@fragua/store` — therefore *not*
  the browser-safe `@fragua/core` main entry (it must be excluded from the web
  bundle, like the existing `core/handler` sub-entry). Candidates: a `core`
  sub-entry, or a small dedicated package. The pure half (validate + build a
  validated `IntentEvent`) is browser-safe and unit-testable in isolation; the
  append is the store call.
- **What moves in:** the TypeBox intent schemas (from `server/src/schemas.ts`);
  `newRunId` (from `server/src/store/run-id.ts` — see decision below); the
  validate-then-construct logic currently inline in `routes.ts`.
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

The enqueue path is **two writes, not one append** (cli-store-client §2):
`saveWorkflow(sha, …)` then `enqueueRun(…)`. Order is load-bearing —
`run_state.workflow_sha` FKs onto `workflows.sha`, so the workflow row must land
first. There is **no spanning transaction**: a `saveWorkflow` that succeeds before
an `enqueueRun` failure leaves an orphan content-addressed blob, which is harmless
(GC'd by `gc-blobs`). This ordering + orphan-is-fine decision lives in
`commitEnqueue`, made once — not deferred to whoever writes the first adapter. Mint
the run id in `build` so the adapter has it to return immediately (today's
`c.json({ runId })`); `commit` consumes it.

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

Intent validation stays TypeBox (the schemas move in from `server/src/schemas.ts`);
the plane **never imports a JSON-Schema validator**. The repo's *other* schema
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

`'web'` → `'client'` (cli-topology §5.2) surfaces here: the plane sets the writer
on constructed intents. Coordinate the schema CHECK migration with this change.

## 4. Scope / dependencies / MVP

- **Depends on:** nothing.
- **Wins independently:** yes — a pure internal refactor with no behavior change,
  giving the server a cleaner single-audit write surface even with zero CLI work.
- **MVP = the whole thing.** Small and atomic. The deliverable is: module exists
  as a constructed plane with `build*` (pure given the injected `newRunId`) +
  `commit*` (store writes); schemas + `newRunId` moved in; server routes refactored
  to adapters that never touch the store write API directly; a **discipline test**
  failing the build on any store-write call outside the plane (§3.1); one test
  suite covering validate/construct for every `IntentEvent` variant (passing a
  counter-based minter); monorepo typecheck + `bun test` green.
