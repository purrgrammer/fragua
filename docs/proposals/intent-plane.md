---
title: Intent plane — one validate/construct/mint surface, two ports
summary: "Extract intent validation, event construction, and run-id minting into a single shared code surface that both the HTTP server and the (future direct-store-client) CLI call through thin adapters. One audit point, one test suite; the CLI and server cannot disagree about what a valid intent is. Foundation for the rest of the CLI-topology roadmap."
status: proposed
maturity: designed
last-reviewed: 2026-05-21
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
  `plane.build(...)` → `store.append*`*. The CLI command (later workstreams) is
  the same minus deserialization — *parse argv → `plane.build(...)` →
  `store.append*`*.
- **Single audit surface** — the `backend` skill's "one place per domain"
  applied to writes. `ports.ts` already states the direction (*"the only port we
  keep is `WorkflowReader` … everything else reads directly from
  `@fragua/store`"*); this extends it to the write path.

## 3. Decisions owned here

- **`newRunId` moves onto the plane.** It is server-only today; the CLI mints
  ids when it writes the enqueue intent directly, so generation cannot stay
  behind the HTTP boundary.
- **Widen `run_id`** (cli-topology §5.3) — **shipped**. The widening landed in
  the pre-0.1.0 cleanup; the ULID `newRunId` now lives in `@fragua/store` so
  every fact-writer (server route + daemon dispatcher) mints the same wide form.
- **`writer` rename** (`'web'` → `'client'`, cli-topology §5.2) surfaces here:
  the plane sets the writer on constructed intents. Coordinate the schema CHECK
  migration with this change.

## 4. Scope / dependencies / MVP

- **Depends on:** nothing.
- **Wins independently:** yes — a pure internal refactor with no behavior change,
  giving the server a cleaner single-audit write surface even with zero CLI work.
- **MVP = the whole thing.** Small and atomic. The deliverable is: module exists,
  schemas + `newRunId` moved in, server routes refactored to adapters, one test
  suite covering validate/construct for every `IntentEvent` variant, monorepo
  typecheck + `bun test` green.
