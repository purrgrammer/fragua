# swarm — conventions for AI agents

> Read this first. If anything here conflicts with `docs/`, the docs win — update this file.
>
> `CLAUDE.md` is a symlink to this file — edit `AGENTS.md`. Skills live in `.agents/skills/<name>/SKILL.md` and are symlinked into `.claude/skills/<name>`; add both when creating a new skill.

## What this is

**swarm** is a universal AI agent orchestrator. Text-first DOT workflows → deterministic state machine → LLM-based agents across any provider → replayable event log on top of a single SQLite store.

Authoritative docs:

- `docs/SPEC.md` — what swarm is, invariants
- `docs/ARCHITECTURE.md` — schema, design, property matrix
- `docs/handler-contract.md` — handler API
- `docs/proposals/` — known gaps and deferred work, organised by status × maturity

## Stack

Bun ≥ 1.2 (Node ≥ 20 compat) · TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) · `@sinclair/typebox` · `bun:sqlite` (WAL, STRICT, generated columns) · `hono` · `bun test` · `biome` · `@mariozechner/pi-agent-core` + `pi-ai` · `fast-check` · React 18 + Vite 5 + Tailwind 4 (CSS-first, `@theme inline`, no `tailwind.config.ts`) + react-router v7

## Commands

```sh
bun install
bun run typecheck                        # tsc --noEmit across workspace
bun test                                 # all package suites
bun run lint                             # biome check
bun run format                           # biome format --write
bun run ci                               # lint + typecheck + tests, pass-noise filtered

bun run swarm harness                    # default entry point: daemon + HTTP, ~/.swarm/swarm.db, default :6767, auto-builds web bundle
bun run swarm daemon --db <path>         # CI primitive: executor only against an explicit DB
bun run swarm serve  --db <path>         # CI primitive: standalone HTTP + SSE, default :3000
bun run swarm run <workflow|name> [--input "…"]    # upload + enqueue + stream events; bare names resolve against ~/.swarm/workflows/, then <cwd>/.swarm/workflows/
bun run swarm validate <workflow.dot>    # parse + lint, no execution
bun run swarm db {vacuum,gc-blobs,backup --to <path>}
bun run dev:web                          # Vite dev server (:5173), proxies /api/** to harness; run harness first
```

## Codebase map

Dependency direction: `web → server → store ← daemon → core ← agent`. `core`'s main entry is browser-safe (no `node:fs` / `node:child_process`); the `./handler` sub-entry pulls in `@swarm/store` for server-side use and is intentionally excluded from the browser bundle. `store` is the only coordination surface.

| Package | Entry points | What lives here |
|---|---|---|
| `@swarm/types` | `src/index.ts`, `src/swarm-events.ts`, `src/agents.ts`, `src/skills.ts`, `src/events.ts` | Shared `AgentMessage` + swarm-event declaration merges; imported by every package (`store`, `daemon`, `agent`, `server`, `web`, `core`, `cli`) |
| `@swarm/store` | `src/store.ts`, `src/schema.sql`, `src/reducers.ts` | SQLite event store; pragmas; migrations; startup sweep |
| `@swarm/core` | `src/handler/types.ts`, `src/engine/{edge-selection,substitution,retry-policy}.ts`, `src/parser/` | Pure types; DOT parser; handler contract; engine reducers |
| `@swarm/daemon` | `src/{entrypoint,executor,supervisor,auto-dispatcher,result-to-facts,recorder,wake-pending,worktree-provisioner,auto-titler}.ts` | Executor + supervisor fibers; intent fold; provisioner; recorder; wake-pending sweeper |
| `@swarm/agent` | `src/{backend,handler-bridge,system-prompt,fidelity,event-bridge,tool-adapter}.ts` | `PiCodergenBackend`; pi-ai → handler bridge; per-run system-prompt builder |
| `@swarm/workspace` | `src/{worktree-env,local-env,tools}.ts`, `src/skills/`, `src/agents/` | `ExecutionEnvironment` adapters; read/write/edit/bash tools; skills + agent-definition discovery |
| `@swarm/server` | `src/index.ts`, `src/store/{routes,runs-routes,runs-adapter,steps,sse}.ts`, `src/ports.ts`, `src/schemas.ts` | Hono HTTP + SSE; intent endpoints; run/messages/events/steps reads |
| `@swarm/web` | `src/routes/`, `src/components/`, `src/lib/` | React 18 dashboard. UI primitives: `src/components/ui/` (shadcn + Swarm primitives), `src/components/ai-elements/` (chat UI). See `.agents/skills/frontend/SKILL.md` § UI primitives and `.agents/skills/design/SKILL.md` for token rules. |
| `@swarm/cli` | `bin/swarm.ts`, `src/commands/` | `harness` (default) / `daemon` / `serve` / `run` / `validate` / `init` / `providers` / `db` / `gc` |

Event taxonomy lives in `docs/ARCHITECTURE.md` §3; invariants I1–I10 in `docs/SPEC.md` §4.

Runtime state: `~/.swarm/swarm.db` (the global store the harness binds to by default; `daemon_lock.{http_url, http_port, harness_version}` carry the running URL — that's how `swarm run` discovers the harness, no JSON file). The CI primitive (`swarm daemon --db <path>` + `swarm serve --db <path>`) writes its serve URL to `<cwd>/.swarm/serve.json`; `swarm run` falls back to that when no harness lock is present. `cwd` on `run_state` is the only project identifier — there is no `projects` table; the UI lists projects via `SELECT DISTINCT cwd`. Worktrees live under each run's `cwd` at `.swarm/worktrees/<run_id>/`.

Config cascade: `~/.swarm/config.jsonc` (global — defaults, autoTitle, blocklist, concurrency, …) overlaid by `<cwd>/.swarm/config.jsonc` (project — bootstrap and any project-specific overrides). Project keys win; nested objects merge one level deep.

Skills (domain context loaded on demand) come from two layers: `~/.agents/skills/` (global — `ai-elements`, `shadcn`, plus user-installed skills) and `<repo>/.agents/skills/` (project-internal — `frontend`, `design`, `backend`, `swarm-author`, `swarm-debug`, `swarm-run`). The daemon scans both at boot. Load before touching any file in a skill's domain.

Named sub-agent profiles live alongside skills under `.agents/agents/` (project) and `~/.agents/agents/` (user); `.claude/agents/` is scanned as a cross-client fallback. Each profile is a flat `.md` file with YAML frontmatter (`name`, `description`, optional `model` / `provider` / `allowed_tools`); the body becomes the sub-agent's system prompt. Project beats user on collisions. The daemon scans them at boot and the catalogue lands on every codergen call whose tool pool includes `agent` — see [`docs/proposals/agent-definitions.md`](docs/proposals/agent-definitions.md).

## Commit conventions

- Imperative mood. Tag the subsystem: `[store] fix OCC race`, `[daemon] trim supervisor tick`.
- Every non-trivial change updates a test. If infeasible, say so in the commit body.
- `git commit --no-verify` is banned. Fix the hook.

## Ground rules

1. **Spec-first.** Code uncovered by `docs/SPEC.md` / `docs/ARCHITECTURE.md` / `docs/handler-contract.md` — stop, update the docs first or check in. Same-PR obligations when load-bearing contract files change:

   | If you touch | Update in the same PR |
   |---|---|
   | `packages/store/src/schema.sql` | `ARCHITECTURE.md` §2 (schema) |
   | `packages/types/src/swarm-events.ts` — status / intent / fact / halt / quarantine types, or `DaemonEvent` literals | `ARCHITECTURE.md` §3 (event taxonomy); `SPEC.md` §3.4 if status enum changed; `.agents/skills/swarm-debug/SKILL.md` — §4.1 for new informational fact types, §8 for new halt/quarantine reasons or paused statuses, §8.1 for new schedule daemon-events, §8.2 for new subagent observability events; `STATUS.md` ("What swarm delivers today" / "What swarm does not deliver today") if a new status / intent / fact carries user-visible behaviour the doc claims |
   | `packages/core/src/handler/types.ts` | `handler-contract.md` |
   | `packages/core/src/handler/intent-fold.ts` | `docs/intent-fold.md` |
   | `packages/core/src/engine/validator.ts` — error/warning codes (E001–E0NN, W001–W0NN) | `.agents/skills/swarm-author/SKILL.md` validator-codes table |
   | `packages/server/src/store/routes.ts` / `runs-routes.ts` — operator endpoint shapes | `.agents/skills/swarm-run/SKILL.md` cheat sheet; `ARCHITECTURE.md` §7 |
   | `packages/store/src/schema.sql` — blobs / artifacts layout | `.agents/skills/swarm-debug/SKILL.md` §7 (artifact read path) |
   | `packages/cli/bin/swarm.ts` (new entry point) or `packages/cli/src/commands/*` (default-changing flag, renamed flag, or new subcommand) | `README.md` (Quick tour: command invocations, default ports, storage paths) |

   Half-baked is fine — mark it (`> Status: in-progress` or `> Status: sketch`). An honest known-rough section beats silence; we revisit as the design firms up.

   **Enum-literal consumers.** Adding or removing a literal in a contract union (`RunStatus`, `HaltReason`, `IntentEvent['type']`, `FactEvent['type']`, etc.) requires a grep across `packages/` for every consumer — many use string-literal sets (`Set<RunStatus>`, hardcoded `WHERE status IN (…)` SQL, label maps in `web/src/lib/humanize.ts`, allowed-status arrays in `server/src/store/runs-routes.ts:VALID_STATUSES`) that don't trip TypeScript exhaustiveness checks. The typecheck pass is necessary but not sufficient — when in doubt, `rg '"<old-literal>"' packages/` and update each.

   **Common drift patterns.** Three patterns the introspect workflow keeps re-finding — worth a 30-second self-check before merging:

   - **Status-enum changes that don't propagate to STATUS.md.** A new `RunStatus` literal (or a renamed one — e.g. `paused_provider_error` → unified `paused{reason}`) lands in `swarm-events.ts` + ARCH §3 + the schema CHECK, but `STATUS.md`'s "What swarm delivers today" still describes the old shape. `rg '<old-literal>' STATUS.md README.md docs/` before merging.
   - **Route additions that don't update ARCH §7.** A new `app.post("/runs/:id/<verb>", …)` in `routes.ts` ships without the corresponding row in §7's web-server routes table. §7 is the operator's index — if it's not there, the route is invisible.
   - **CLI default-changing flags that don't update README.** Renaming `--provider` → `--llm-provider`, changing a default port (3000 → 6767), or adding a new subcommand leaves the README quick-tour pointing at the wrong invocation. The quick-tour is the first thing new users copy verbatim.
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
12. **Skills load through the `skill` tool.** The catalogue advertises `skill({ name, arguments })`; `$ARGUMENTS` substitution + frontmatter parsing happen in the tool, not in the agent's prose interpretation of SKILL.md. The tool is force-included by the codergen backend even when a node's `allowed_tools` / `denied_tools` would exclude it — see `packages/agent/src/backend.ts`.
13. **No `$node.output` / `${context.*}` substitution in workflows.** The only substitution token is `$ARGUMENTS`. Cross-node data transfer goes through shared `thread_id="…"` + `fidelity=` (SPEC §3.3, §3.8). Tool nodes are side-effect-only — exit code decides `outcome=success|fail`, stdout/stderr are kept for debugging but do not feed downstream nodes. Workflows that need to run a script and reason about its output should call the script from inside a codergen's `bash` tool.
