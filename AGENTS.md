# swarm — conventions for AI agents

> Read this first. If anything here conflicts with the docs, the docs win — update this file.

## What this is

**swarm** is a universal AI agent orchestrator. Text-first DOT workflows → deterministic state machine → LLM-based agents across any provider → replayable event log on top of a single SQLite store.

Authoritative docs (start here before editing a subsystem):

- `docs/SPEC.md` — what swarm is, at a glance
- `docs/ARCHITECTURE.md` — design, schema, invariants, property matrix
- `docs/handler-contract.md` — how to write a handler

## Ground rules

1. **Spec-first.** If you're about to write code that isn't covered by `docs/SPEC.md`, `docs/ARCHITECTURE.md`, or `docs/handler-contract.md`, stop. Either update the docs first or check in with the user.
2. **Tests before declaring done.** `bun test` green + monorepo typecheck clean are table stakes.
3. **No dependencies added silently.** Every new runtime dep goes through `package.json` with an exact version pin and a one-line rationale in the commit message.
4. **One coordination surface.** The SQLite store (`@swarm/store`) is the only place state transitions are recorded. Do not introduce filesystem coordination (JSONL, checkpoint files, `fs.watch`, unix sockets).
5. **Events are the source of truth.** Every state transition is either an `intent.*` (writer: web) or `fact.*` (writer: daemon). Projections (`run_state` row) are updated in the same transaction.
6. **NO INLINE IMPORTS.** All `import` statements live at the top of the file — no `await import(…)` inside functions, no `require(…)` inside conditionals. Dynamic imports hide dependency graphs and break static analysis. Hoist the import and guard the call instead. Rare exception: genuinely-circular module graphs — document the cycle in a comment.
7. **NO SKILL CITATIONS IN CODE.** Skills are loaded on demand; their prose lives in `SKILL.md`, not in code comments. Don't write `// SKILL.md § Motion — ...`, `/* Skill citations: ... */`, `// Per the design skill: ...`, or any comment that quotes or attributes rules to a skill file. Citations drift the moment the skill is edited and duplicate content the agent re-reads from source.
8. **NO USELESS COMMENTS.** Default to writing none. A comment earns its place only when it explains a non-obvious WHY. Don't describe WHAT the code does (names do that), don't annotate sections with headers, don't leave breadcrumbs referencing tasks/PRs ("added for X", "used by Y"). If removing the comment wouldn't confuse a future reader, delete it.
9. **Handlers route I/O through `ctx`.** No bare `fetch`, no `node:fs` / `node:child_process` inside `packages/core/src/handler/handlers/`. Enforced by `packages/core/test/handler/discipline.test.ts`.
10. **Write transactions are pure SQL.** No `await` or `JSON.stringify` inside a `db.transaction(...)` or a `BEGIN IMMEDIATE`/`COMMIT` pair. Enforced by `packages/store/test/lint.test.ts` (invariant I1).

## Stack

- **Runtime:** Bun ≥ 1.2 (primary), Node ≥ 20 (compat)
- **Language:** TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- **Schemas:** `@sinclair/typebox`
- **Store:** `bun:sqlite` via `@swarm/store` (WAL, STRICT tables, generated columns)
- **HTTP:** `hono`
- **Test runner:** `bun test`
- **Lint / format:** `biome`
- **Agent runtime:** `@mariozechner/pi-agent-core`
- **LLM client:** `@mariozechner/pi-ai`
- **Property tests:** `fast-check`
- **Web:** React 18 + Vite 5 + Tailwind 3 + react-router v7

## Commands

```sh
bun install                          # install deps
bun run typecheck                    # tsc --noEmit across workspace
bun test                             # all package test suites
bun run lint                         # biome check
bun run format                       # biome format --write
bun run ci                           # typecheck + lint + test (what CI runs)

bun run swarm daemon                 # run the executor against .swarm/swarm.db
bun run swarm serve                  # HTTP + SSE server
bun run swarm run <workflow.dot>     # upload + enqueue + stream events
bun run swarm validate <workflow.dot># parse + lint, no execution
bun run swarm db vacuum              # reclaim free pages
bun run swarm db gc-blobs            # drop orphan artifact blobs
bun run swarm db backup --to path.db # snapshot via SQLite serialize()
```

## Repository layout

```
/Users/bandarra/swarm/
├── docs/                  # SPEC, ARCHITECTURE, handler-contract, providers
├── packages/
│   ├── store/             # SQLite event store (the coordination surface)
│   ├── core/              # parser + pure types + handler contract
│   ├── daemon/            # executor fiber, supervisor, auto-dispatcher
│   ├── agent/             # pi-* wrapper + makeCodergenHandler bridge
│   ├── workspace/         # ExecutionEnvironment adapters
│   ├── server/            # Hono HTTP + SSE
│   ├── cli/               # swarm daemon / serve / run / validate / db
│   └── web/               # React + Vite dashboard
├── examples/              # demo workflows
└── workflows/             # swarm's own workflows
```

The dependency graph flows one way:

```
web → server → store ← daemon → core → handler
                                  ↑
                               agent (PiCodergenBackend → makeCodergenHandler)
```

`core` is pure (no `node:fs`, `node:child_process`, etc.). `store` is the coordination point. Everything else talks to one of those.

## Commit conventions

- Imperative mood ("add X", not "added X").
- Tag the subsystem: `[store] fix OCC race`, `[daemon] trim supervisor tick`.
- Every non-trivial change updates a test. If infeasible, say so in the commit body.
- `git commit --no-verify` is banned. Fix the hook, don't skip it.

## Property-test matrix

24 invariants in `docs/ARCHITECTURE.md` §10, all green. Before changing store semantics or the intent/fact split, grep for the P# in tests and make sure the new code keeps those green.
