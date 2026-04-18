# swarm — conventions for AI agents

> Read this first. If anything here conflicts with the specs, the specs win — update this doc.

## What this is

**swarm** is a universal AI agent orchestrator. Text-first DOT workflows → deterministic state machine → LLM-based agents across any provider → replayable event log.

Authoritative docs (start here before editing a subsystem):

- `docs/SPEC.md` — contracts and invariants
- `docs/PLAN.md` — incremental build plan and the current phase
- `docs/ARCHITECTURE.md` — design rationale

The current phase and its verification bar live in `docs/PLAN.md`. Do not start work outside the current phase without discussion.

## Ground rules

1. **Spec-first.** If you're about to write code that isn't in `docs/SPEC.md` or `docs/PLAN.md`, stop. Either update the spec first or check in with the user.
2. **Tests before declaring done.** No task is complete until the phase's verification bar passes. `bun test` green is table stakes, not success.
3. **No dependencies added silently.** Every new runtime dep goes through `package.json` with an exact version pin and a one-line rationale in the commit message.
4. **Pure core.** `@swarm/core` imports nothing from `node:fs`, `node:child_process`, `node:net`, or anything that touches the outside world. Violation is a build failure.
5. **Events are the source of truth.** Every non-trivial state transition emits a typed event. UI, replay, and cost reports all derive from the event log.
6. **NO INLINE IMPORTS.** All `import` statements live at the top of the file — no `await import(…)` inside functions, no `require(…)` inside conditionals. Dynamic imports hide dependency graphs and break static analysis. Hoist the import and guard the call instead. Rare exception: genuinely-circular module graphs — document the cycle in a comment.
7. **NO SKILL CITATIONS IN CODE.** Skills are loaded on demand (see §Skills below); their prose lives in `SKILL.md`, not in code comments. Don't write `// SKILL.md § Motion — ...`, `/* Skill citations: ... */`, `// Per the design skill: ...`, or any comment that quotes or attributes rules to a skill file. Citations drift the moment the skill is edited and duplicate content the agent re-reads from source. If a rule is worth encoding in code, write it as a bare, load-bearing comment (per rule 8) and let the skill stay the canonical source. Same logic for any external doc — cite sparingly, never reproduce.
8. **NO USELESS COMMENTS.** Default to writing none. A comment earns its place only when it explains a non-obvious WHY — a hidden constraint, a subtle invariant, a workaround whose rationale isn't visible from the surrounding code. Don't describe WHAT the code does (names do that), don't annotate sections with headers, don't leave breadcrumbs referencing tasks/PRs/the current change ("added for X", "used by Y"). If removing the comment wouldn't confuse a future reader, delete it.

## Stack

- **Runtime:** Bun ≥ 1.2 (primary), Node ≥ 20 (compat fallback)
- **Language:** TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- **Schemas:** `@sinclair/typebox`
- **Test runner:** `bun test`
- **Lint / format:** `biome`
- **Agent runtime:** `@mariozechner/pi-agent-core`
- **LLM client:** `@mariozechner/pi-ai`
- **Logging:** `pino` with `{domain}.{action}_{state}` naming
- **Property tests:** `fast-check`
- **Web:** React 18 + Vite 5 + Tailwind 3 + react-router v7, Radix primitives, lucide-react

## Commands

```sh
bun install              # install deps
bun run typecheck        # tsc --noEmit across workspace
bun test                 # all package test suites
bun run lint             # biome check
bun run format           # biome format --write
bun run ci               # typecheck + lint + test (what CI runs)

bun run swarm daemon start             # long-lived supervisor for runs
bun run swarm run <workflow.dot>       # fire-and-forget: POST /jobs → exit 0
bun run swarm validate <workflow.dot>  # parse + lint, no execution
bun run swarm replay <events.jsonl>    # one-shot summary of a past run
```

## Repository layout

```
/Users/bandarra/swarm/
├── docs/                  # SPEC, PLAN, ARCHITECTURE + feature docs
├── packages/
│   ├── core/              # pure orchestrator (no I/O)
│   ├── agent/             # pi-mono wrapper
│   ├── workspace/         # ExecutionEnvironment adapters
│   ├── events/            # EventSink adapters + shared cost accumulator
│   ├── cli/               # single-command entry (run, serve, replay, …)
│   ├── server/            # Hono HTTP + SSE
│   └── web/               # React + Vite dashboard
├── examples/              # demo workflows
├── workflows/             # swarm's own workflows (self-hosting)
└── scripts/               # one-shot maintenance scripts
```

## Commit conventions

- Imperative mood ("add X", not "added X").
- Tag the phase: `[P1] add edge selection 5-step priority`.
- Every non-trivial change updates a test. If infeasible, say so in the commit body.
- `git commit --no-verify` is banned. Fix the hook, don't skip it.

## Feature docs (topic map)

When a task touches a subsystem, read the matching doc in `docs/` before editing:

- `docs/daemon.md` — daemon lifecycle, REST/SSE surface, `.swarm/daemon/` layout, `swarm serve` vs `swarm daemon`, read-side abstractions (`EventSource`, projections, `CheckpointStore`).
- `docs/self-hosting.md` — running workflows through swarm, worktree isolation, `build-feature.dot`, the `<abort>` contract.
- `docs/events.md` — per-step `llm.start` fields, fidelity modes, summariser + auto-title, budgets, schema versioning.
- `docs/run-control.md` — steer / pause / resume / cancel via `control.jsonl`, restart-safety.
- `docs/workflows.md` — parallel branches + `fan_in`, model stylesheet, `local:subagent`.
- `docs/web-ui.md` — routes, dev proxy, metrics, locale-aware formatting helpers.
- `docs/skills.md` — agentskills.io progressive disclosure, per-node scoping, authoring.
- `docs/providers.md` — inference provider vs model provider, API keys, pre-flight check.

If you add a new subsystem, add a pointer here and write the doc.
