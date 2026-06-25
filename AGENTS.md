# fragua — conventions for AI agents

> Read this first. If anything here conflicts with `docs/`, the docs win — update this file.
>
> `CLAUDE.md` is a symlink to this file — edit `AGENTS.md`. Skills live in `.agents/skills/<name>/SKILL.md` and are symlinked into `.claude/skills/<name>`; add both when creating a new skill.

## What this is

**fragua** is a durable AI workflow execution engine. YAML workflows → deterministic state machine → LLM-based agents across any provider → replayable event log on top of a single SQLite store.

Authoritative docs:

- `docs/SPEC.md` — what fragua is, invariants
- `docs/ARCHITECTURE.md` — schema, design, property matrix
- `docs/handler-contract.md` — handler API
- `docs/execution-model.md` — filesystem layout for workflow authors (worktree location, fresh shell per bash call, snapshot delta-suppression, accept/discard)

## Stack

Bun ≥ 1.2 (Node ≥ 22.19 compat — pi-ai / pi-agent-core declare that floor in `engines`) · TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) · `@sinclair/typebox` · `bun:sqlite` (WAL, STRICT, generated columns) · `hono` · `bun test` · `biome` · `@earendil-works/pi-agent-core` + `pi-ai` · `fast-check` · React 18 + Vite 5 + Tailwind 4 (CSS-first, `@theme inline`, no `tailwind.config.ts`) + react-router v7

## Commands

```sh
bun install
bun run typecheck                        # tsc --noEmit across workspace
bun run test                             # all suites: test:node (bun) + test:web (vitest)
bun run test:node                        # node packages only, via `bun test`
bun run test:web                         # @fragua/web only, via vitest (jsdom)
bun test ./packages/<pkg>                # one node package directly (NOT @fragua/web — see below)
bun run lint                             # biome check
bun run format                           # biome format --write
bun run ci                               # lint + typecheck + both test runs, pass-noise filtered

bun run fragua harness                    # default entry point: daemon + HTTP, ~/.fragua/fragua.db, default :6767, auto-builds web bundle
bun run fragua daemon --db <path>         # CI primitive: executor only against an explicit DB
bun run fragua serve  --db <path>         # CI primitive: standalone HTTP + SSE, default :3000
bun run fragua run <workflow|name> [--input "…"]    # upload + enqueue + stream events; bare names resolve against ~/.fragua/workflows/, then <cwd>/.fragua/workflows/
bun run fragua validate <workflow.yaml>   # parse + lint, no execution
bun run fragua db {vacuum,gc-blobs,backup --to <path>,migrate [--dry-run]}
bun run dev:web                          # Vite dev server (:5173), proxies /api/** to harness; run harness first
```

## Codebase map

Dependency direction: `web → server → store ← daemon → core ← agent`. `core`'s main entry is browser-safe (no `node:fs` / `node:child_process`); its store-pulling sub-entries — `./handler`, `./intent-plane` (write plane), `./read-plane` (read plane) — are server-side only and excluded from the browser bundle. `store` is the only coordination surface. **`@fragua/cli` is a direct store-client**: it opens the store and writes/reads through the two planes — it never talks to the HTTP server (only `@fragua/web` does). The planes are the shared surfaces both the server and the CLI route through, so the two clients can't disagree about a write or a read. The one exception is **`fragua ci`**, which *embeds the executor* (it writes `fact.*` itself via `runOne`, not just intents) over an ephemeral store — it still uses the planes for save+enqueue + reads, but it is the engine, not a pure client.

| Package | Entry points | What lives here |
|---|---|---|
| `@fragua/types` | `src/index.ts`, `src/events.ts`, `src/skills.ts` | Shared `AgentMessage` + fragua-event declaration merges; imported by every package (`store`, `daemon`, `agent`, `server`, `web`, `core`, `cli`) |
| `@fragua/store` | `src/store.ts`, `src/schema.sql`, `src/reducers.ts` | SQLite event store; pragmas; migrations; startup sweep |
| `@fragua/core` | `src/handler/types.ts`, `src/engine/{edge-selection,substitution,retry-policy,thread}.ts`, `src/parser/yaml.ts`, `src/intent-plane/`, `src/read-plane/` | Pure types; YAML parser; handler contract; engine reducers; **intent plane** (validate/construct/commit writes) + **read plane** (run summary/detail/steps/messages/events/snapshots/diff/streaming projections) — the shared write/read surfaces |
| `@fragua/daemon` | `src/{entrypoint,executor,supervisor,auto-dispatcher,result-to-facts,recorder,wake-pending,worktree-provisioner,auto-titler}.ts` | Executor + supervisor fibers; intent fold; provisioner; recorder; wake-pending sweeper |
| `@fragua/agent` | `src/{backend,handler-bridge,system-prompt,thread,event-bridge,tool-adapter}.ts` | `PiLlmBackend`; pi-ai → handler bridge; per-run system-prompt builder |
| `@fragua/workspace` | `src/{worktree-env,local-env,tools,run-actions}.ts`, `src/skills/` | `ExecutionEnvironment` adapters; read/write/edit/bash tools; skills discovery; `run-actions.ts` = shared git for accept/discard/diff (`applyAccept`/`applyDiscard` with the state gate folded in, `gitDiff`) called by both the server route and the CLI |
| `@fragua/server` | `src/index.ts`, `src/store/{routes,runs-routes,sse}.ts`, `src/ports.ts`, `src/schemas.ts` | Hono HTTP + SSE **for the Web UI**; routes go through the intent plane (writes) + read plane (reads). `store/{runs-adapter,steps}.ts` are re-export shims → `@fragua/core/read-plane` |
| `@fragua/web` | `src/routes/`, `src/components/`, `src/lib/` | React 18 dashboard. UI primitives: `src/components/ui/` (shadcn + Fragua primitives), `src/components/ai-elements/` (chat UI). See `.agents/skills/frontend/SKILL.md` § UI primitives and `.agents/skills/design/SKILL.md` for token rules. |
| `@fragua/test-utils` | `src/index.ts`, `src/source-hash-gate.ts` | Test-only shared helpers (`sourceHashGate` / `extractDeclarations` / `normalizeSource`) for the source-scan lint tests; `private`, pulled in as a devDependency only |
| `@fragua/cli` | `bin/fragua.ts`, `src/{store-client,executor-deps,env-creds,route-picker}.ts`, `src/commands/` | Direct store-client (no HTTP): `harness` (default) / `daemon` / `serve` / `run` / `runs <verb>` / `ci` / `schedule` / `validate` / `init` / `providers` / `db` / `gc`. `store-client.ts` (`withStoreClient`: open `migrate:false` + build both planes) is the seam; `run`/`runs`/`schedule` write via the intent plane + read via the read plane. `executor-deps.ts` (`buildExecutorDeps`) is the shared executor assembly behind both `daemon` and `ci`; `ci` embeds the executor over an ephemeral store (`env-creds.ts` seeds creds from env) |

Event taxonomy lives in `docs/ARCHITECTURE.md` §3; invariants I1–I10 in `docs/SPEC.md` §4.

Runtime state: `~/.fragua/fragua.db` (the global store the harness binds to by default). Server discovery lives in the store's `server_endpoint` row — written by whoever binds the HTTP listener (the harness's in-process server, or a standalone `fragua serve --db <path>`), cleared on shutdown. `fragua doctor` reads it for liveness and `@fragua/web` for its API origin; the `run`/`runs` verbs DON'T need it — they're store-clients that open the store directly (`--db`, else `~/.fragua/fragua.db`). No `serve.json`, no localhost default. `daemon_lock` is pure liveness (pid + heartbeat). Project IDENTITY is `project_id` — a stable UUIDv7 committed in `<cwd>/.fragua/config.yaml` (the CLI auto-inits one when missing; imports carry theirs) and denormalized NOT NULL onto `run_state` next to the `project_name` display label, so a run attributes to the same project across clones, machines, and imports. There is still no `projects` table; the UI lists projects by grouping `run_state.project_id`. `cwd` remains the run's working directory (where the daemon provisions and executes), not its identity. Worktrees live under each run's `cwd` at `.fragua/worktrees/<run_id>/`.

**Never run `fragua` commands against the live store while developing.** The `daemon` / `serve` / `run` commands all take `--db <path>` (default `~/.fragua/fragua.db`) — when you need to exercise a CLI command to test a change, point it at an ephemeral DB (e.g. `--db "$(mktemp -d)/t.db"`) so a stray write or schema migration can't corrupt the operator's running instance. Prefer the test suite over booting a daemon/server at all.

Config cascade: `~/.fragua/config.yaml` (global — defaults, auto-title, blocklist, concurrency, …) overlaid by `<cwd>/.fragua/config.yaml` (project — bootstrap and any project-specific overrides). Project keys win; nested objects merge one level deep. YAML only.

Skills (domain context loaded on demand) come from two layers: `~/.agents/skills/` (global — `ai-elements`, `shadcn`, plus user-installed skills) and `<repo>/.agents/skills/` (project-internal — `frontend`, `design`, `backend`, `workflows`, `operate`). The daemon scans both at boot. Load before touching any file in a skill's domain.

## Commit conventions

- Imperative mood. Tag the subsystem: `[store] fix OCC race`, `[daemon] trim supervisor tick`.
- Every non-trivial change updates a test. If infeasible, say so in the commit body.
- `git commit --no-verify` is banned. Fix the hook. The pre-commit hook lives at `.githooks/pre-commit` and runs `bun run lint && bun run typecheck` (no test run, ~sub-10s); `bun install` wires it via the `prepare` script (`git config core.hooksPath .githooks`).

## Changelog

`CHANGELOG.md` describes **functionality only** — what changed, how authored workflows are affected. No anecdotes (run ids, dollar costs, "surfaced during X", who found it), no commit hashes (git has them), no internal test-infra notes the user never sees, no release-process narrative. Keep the same Keep-a-Changelog sections (`Added` / `Changed` / `Fixed` / `Removed`) tight; one or two sentences per entry. The commit body is where the *why* and the *how* live; the changelog is the *what*.

## Ground rules

1. **Spec-first.** Code uncovered by `docs/SPEC.md` / `docs/ARCHITECTURE.md` / `docs/handler-contract.md` — stop, update the docs first or check in. Half-baked is fine — mark it (`> Status: in-progress` or `> Status: sketch`). An honest known-rough section beats silence; we revisit as the design firms up.

   **Enum-literal consumers.** Adding or removing a literal in a contract union (`RunStatus`, `HaltReason`, `IntentEvent['type']`, `FactEvent['type']`, etc.) requires a grep across `packages/` for every consumer — many use string-literal sets that don't trip TypeScript exhaustiveness checks. For `RunStatus` and `HaltReason` this is mechanized: the runtime tuples `RUN_STATUSES` / `HALT_REASONS` in `@fragua/types` are the source of truth (the unions derive from them), importable consumers derive or `satisfies`-check against them, and the `enum-consumers` lint tests (`store`, `core`, `cli`, `web`, plus the `?status=` round-trip in `server`) pin the non-derivable sites — the SQL `WHERE status IN (…)` clauses and `schema.sql` CHECK are covered by source scan in `packages/store/test/enum-consumers.lint.test.ts`. For every other union the manual sweep still applies: the typecheck pass is necessary but not sufficient — when in doubt, `rg '"<old-literal>"' packages/` and update each.
2. **Tests before done.** `bun run test` green (both `test:node` + `test:web` — bare `bun test` skips the web suite) + monorepo typecheck clean are table stakes.
3. **No silent deps.** Every runtime dep through `package.json` with an exact pin and a one-line rationale in the commit message.
4. **One coordination surface.** `@fragua/store` is the only place state transitions land. No filesystem coordination (JSONL, checkpoint files, `fs.watch`, unix sockets).
5. **Events are truth.** Every state transition is `intent.*` (writer: web) or `fact.*` (writer: daemon). The `run_state` projection is updated in the same transaction.
6. **NO INLINE IMPORTS.** All `import`s at file top — no `await import(…)` inside functions. Hoist + guard the call. Rare exception for genuinely-circular module graphs; document the cycle with an `// inline-import-allow: <reason>` marker on (or directly above) the line. Test files (`*.test.ts(x)`) are exempt — mock isolation requires import-after-mock. Enforced by `packages/server/test/inline-import-discipline.test.ts`.
7. **NO SKILL CITATIONS IN CODE.** Don't write `// SKILL.md § Motion — ...` or attribute rules to skill files. Skills load on demand; citations drift the moment the skill is edited.
8. **NO USELESS COMMENTS.** Default to none. A comment earns its place by explaining a non-obvious WHY. Don't describe WHAT (names do that), don't annotate sections, don't reference tasks/PRs.
9. **Handlers route I/O through `ctx`.** No bare `fetch` / `node:fs` / `node:child_process` inside `packages/core/src/handler/handlers/`. Enforced by `packages/core/test/handler/discipline.test.ts`.
10. **Write transactions are pure SQL.** No `await` / `JSON.stringify` inside `db.transaction(...)`. Enforced by `packages/store/test/lint.test.ts` (I1).
11. **Emit the newest contract version; FOLD all versions.** "No backwards-compat" governs EMISSION and the authored/produced format — make clean cuts on what we *write* (drop old emit paths, old API shapes), and don't litter code with "replaces the old reducer", "previously…". Git is the history. It does NOT govern folding the immutable, append-only event log: the reducer + read-plane MUST fold the full range `[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` forever. A fact type retired from emission stays a legacy, read-only `FactEvent` union member + fold case (marked LEGACY in JSDoc) until its payload is genuinely unrecoverable — only THEN does `MIN_COMPATIBLE_CONTRACT_VERSION` rise. **Never bump `MIN_COMPATIBLE` in lockstep with `EVENT_CONTRACT_VERSION` as a cleanup** — that gates (bricks) every in-flight run pinned at a lower version. This rule exists because that exact mistake gated 200+ live runs.
12. **Skills load through the `skill` tool.** The catalogue advertises `skill({ name, arguments })`; `$ARGUMENTS` substitution + frontmatter parsing happen in the tool, not in the agent's prose interpretation of SKILL.md. The tool is force-included by the llm backend even when a node's `allowed-tools` / `denied-tools` would exclude it — see `packages/agent/src/backend.ts`.
13. **Two substitution tokens.** `${{ inputs.<name>[.<field>...] }}` — typed run inputs declared in `inputs:` (defaults ⊕ `--input name=value`; the only run input surface is typed `routing.inputs`, no free-form positional input). Object / array inputs are dot-read into their record fields; dotted reads into structured inputs are **lenient** — an unresolvable path collapses to `""` (unlike the fail-closed output refs below), and the validator (E030) rejects a dotted sub-reference into a *scalar* input since it can never resolve. `${{ outputs.<producer>.<field>[.<sub>] }}` — typed step outputs emitted by an upstream `llm` step. A bare `$name` or `${…}` is literal text. An `llm` step declares typed `outputs:` over the small type grammar shared with `inputs:` (scalars / `choice` / records via `fields` / arrays via `items`; no recursion, no `$ref`) and emits via the force-included `emit_output` tool; `outputs:` is llm-only and mutually exclusive with `routes:`. All three kinds **consume** outputs (`llm` in `prompt:`, `tool` in `run:`, `human` in `text:`); `tool`/`human` never produce them. **Reads fail closed** — an unpopulated `${{ outputs.X.f }}` is a node failure, never a silent `""`; the validator hard-errors on broken refs (E035) and warns on not-run-on-every-path (W015). Conversation still flows through a shared `thread:` (SPEC §3.3, §3.8); a receiving step may set `summary: low|medium|high` for a summariser-compressed view. Tool nodes are side-effect-only — exit code decides `outcome=success|fail`. See [`docs/proposals/structured-outputs.md`](docs/proposals/structured-outputs.md).
