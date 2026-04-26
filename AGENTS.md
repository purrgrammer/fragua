# swarm — conventions for AI agents

> Read this first. If anything here conflicts with `docs/`, the docs win — update this file.

## What this is

**swarm** is a universal AI agent orchestrator. Text-first DOT workflows → deterministic state machine → LLM-based agents across any provider → replayable event log on top of a single SQLite store.

Authoritative docs:

- `docs/SPEC.md` — what swarm is, invariants
- `docs/ARCHITECTURE.md` — schema, design, property matrix
- `docs/handler-contract.md` — handler API
- `docs/PENDING.md` — known gaps and deferred work

## Stack

Bun ≥ 1.2 (Node ≥ 20 compat) · TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) · `@sinclair/typebox` · `bun:sqlite` (WAL, STRICT, generated columns) · `hono` · `bun test` · `biome` · `@mariozechner/pi-agent-core` + `pi-ai` · `fast-check` · React 18 + Vite 5 + Tailwind 3 + react-router v7

## Commands

```sh
bun install
bun run typecheck                        # tsc --noEmit across workspace
bun test                                 # all package suites
bun run lint                             # biome check
bun run format                           # biome format --write
bun run ci                               # lint + typecheck + tests, pass-noise filtered

bun run swarm daemon                     # executor against .swarm/swarm.db
bun run swarm serve                      # HTTP + SSE
bun run swarm run <workflow.dot>         # upload + enqueue + stream events
bun run swarm validate <workflow.dot>    # parse + lint, no execution
bun run swarm db {vacuum,gc-blobs,backup --to <path>}
```

## Codebase map

Dependency direction: `web → server → store ← daemon → core ← agent`. `core` is pure (no `node:fs` / `node:child_process`); `store` is the only coordination surface.

| Package | Entry points | What lives here |
|---|---|---|
| `@swarm/store` | `src/store.ts`, `src/schema.sql`, `src/reducers.ts` | SQLite event store; pragmas; migrations; startup sweep |
| `@swarm/core` | `src/handler/types.ts`, `src/engine/{edge-selection,substitution,fan-in,retry-policy}.ts`, `src/parser/` | Pure types; DOT parser; handler contract; engine reducers |
| `@swarm/daemon` | `src/{executor,supervisor,auto-dispatcher,result-to-facts,wake-pending,worktree-provisioner,auto-titler}.ts` | Executor + supervisor fibers; intent fold; provisioner |
| `@swarm/agent` | `src/{backend,handler-bridge,system-prompt,fidelity,event-bridge,tool-adapter}.ts` | `PiCodergenBackend`; pi-ai → handler bridge; per-run system-prompt builder |
| `@swarm/workspace` | `src/{worktree-env,local-env,tools}.ts`, `src/skills/` | `ExecutionEnvironment` adapters; read/write/edit/bash tools; skills discovery |
| `@swarm/server` | `src/store/{routes,runs-routes,runs-adapter,steps}.ts` | Hono HTTP + SSE; intent endpoints; run/messages/events/steps reads |
| `@swarm/web` | `src/routes/`, `src/components/`, `src/lib/` | React 18 dashboard |
| `@swarm/cli` | `bin/swarm.ts`, `src/commands/` | `daemon` / `serve` / `run` / `validate` / `db` |

Event taxonomy lives in `docs/ARCHITECTURE.md` §3; invariants I1–I10 in `docs/SPEC.md` §4.

## Commit conventions

- Imperative mood. Tag the subsystem: `[store] fix OCC race`, `[daemon] trim supervisor tick`.
- Every non-trivial change updates a test. If infeasible, say so in the commit body.
- `git commit --no-verify` is banned. Fix the hook.

## Ground rules

1. **Spec-first.** Code uncovered by `docs/SPEC.md` / `docs/ARCHITECTURE.md` / `docs/handler-contract.md` — stop, update the docs first or check in.
2. **Tests before done.** `bun test` green + monorepo typecheck clean are table stakes.
3. **No silent deps.** Every runtime dep through `package.json` with an exact pin and a one-line rationale in the commit message.
4. **One coordination surface.** `@swarm/store` is the only place state transitions land. No filesystem coordination (JSONL, checkpoint files, `fs.watch`, unix sockets).
5. **Events are truth.** Every state transition is `intent.*` (writer: web) or `fact.*` (writer: daemon). The `run_state` projection is updated in the same transaction.
6. **NO INLINE IMPORTS.** All `import`s at file top — no `await import(…)` inside functions. Hoist + guard the call. Rare exception for genuinely-circular module graphs; document the cycle.
7. **NO SKILL CITATIONS IN CODE.** Don't write `// SKILL.md § Motion — ...` or attribute rules to skill files. Skills load on demand; citations drift the moment the skill is edited.
8. **NO USELESS COMMENTS.** Default to none. A comment earns its place by explaining a non-obvious WHY. Don't describe WHAT (names do that), don't annotate sections, don't reference tasks/PRs.
9. **Handlers route I/O through `ctx`.** No bare `fetch` / `node:fs` / `node:child_process` inside `packages/core/src/handler/handlers/`. Enforced by `packages/core/test/handler/discipline.test.ts`.
10. **Write transactions are pure SQL.** No `await` / `JSON.stringify` inside `db.transaction(...)`. Enforced by `packages/store/test/lint.test.ts` (I1).
11. **No prior-state references.** Pre-release; no backwards-compat. Don't write "replaces the old reducer", "previously…", "legacy". Git is the history.
