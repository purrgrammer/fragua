# swarm — conventions for AI agents

> Read this first. If anything here conflicts with the specs, the specs win — update this doc.

## What is this repo

**swarm** is a universal AI agent orchestrator. See `docs/SPEC.md` for what the system is and `docs/PLAN.md` for the incremental build plan. `docs/ARCHITECTURE.md` captures deeper design rationale.

The current phase and its verification bar live in `docs/PLAN.md`. Do not start work outside the current phase without discussion.

## Ground rules

1. **Spec-first.** If you're about to write code that isn't in `docs/SPEC.md` or `docs/PLAN.md`, stop. Either update the spec first or check in with the user.
2. **Tests before declaring done.** No task is complete until the phase's verification bar passes. `bun test` green is table stakes, not success.
3. **No dependencies added silently.** Every new runtime dep goes through `package.json` with an exact version pin and a one-line rationale in the commit message.
4. **Pure core.** `@swarm/core` imports nothing from `node:fs`, `node:child_process`, `node:net`, or anything that touches the outside world. Violation is a build failure.
5. **Events are the source of truth.** Every non-trivial state transition emits a typed event. UI, replay, and cost reports all derive from the event log.

## Stack

- **Runtime:** Bun ≥ 1.2 (primary), Node ≥ 20 (compat fallback)
- **Language:** TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- **Schemas:** `@sinclair/typebox`
- **Test runner:** `bun test`
- **Lint / format:** `biome` (single tool, replaces eslint + prettier)
- **Agent runtime:** `@mariozechner/pi-agent-core`
- **LLM client:** `@mariozechner/pi-ai`
- **Logging:** `pino` with `{domain}.{action}_{state}` naming
- **Property-based tests:** `fast-check`

## Commands

```sh
bun install              # install deps
bun run typecheck        # tsc --noEmit across workspace
bun test                 # run all package test suites
bun run lint             # biome check
bun run format           # biome format --write
bun run ci               # typecheck + lint + test (what CI runs)

bun run swarm run <workflow.dot>       # once @swarm/cli exists (Phase 2+)
bun run swarm validate <workflow.dot>
bun run swarm replay <events.jsonl>
```

## Repository layout

```
/Users/bandarra/swarm/
├── docs/                  # SPEC.md, PLAN.md, ARCHITECTURE.md
├── packages/
│   ├── core/              # pure orchestrator (no I/O)
│   ├── agent/             # pi-mono wrapper
│   ├── workspace/         # ExecutionEnvironment adapters
│   ├── events/            # EventSink adapters
│   └── cli/               # single-command entry
├── examples/              # demo workflows
├── workflows/             # swarm's own workflows (self-hosting)
└── .swarm/runs/           # runtime event logs (gitignored)
```

## Reference material (not committed)

Three repos live at the swarm root for research:
- `attractor/` — the NLSpecs we implement (orchestrator, agent loop, LLM client)
- `Archon/` — prior-art YAML-based harness we learn from
- `pi-mono/` — the packages we adopt

If any are missing, re-clone:
```sh
git clone https://github.com/strongdm/attractor.git
git clone https://github.com/coleam00/Archon.git
git clone https://github.com/badlogic/pi-mono.git
```

## Commit conventions

- Commit messages use imperative mood ("add X", not "added X").
- Tag the phase in the subject: `[P1] add edge selection 5-step priority`.
- Every non-trivial change updates a test. If the change is infeasible to test, say so explicitly in the commit body.
- `git commit --no-verify` is banned. Fix the hook, don't skip it.

## Self-hosting

swarm can implement its own new features. To drive a feature change through the harness:

```sh
# Phase 2 default: real Claude Haiku via ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY=sk-...
bun run packages/cli/bin/swarm.ts run workflows/build-feature.dot \
  --input="add a local:list_dir tool that lists files in a directory"

# Replay the run afterwards
bun run packages/cli/bin/swarm.ts replay .swarm/runs/<id>/events.jsonl
```

Related:
- `examples/hello.dot` — tiny smoke workflow (greet + verify)
- `workflows/build-feature.dot` — plan → implement → verify → summarize
- `.swarm/config.yaml` — per-project defaults + workflow shortcuts

The agent writing code on swarm's behalf has full access to `local:read_file`, `local:write_file`, and `local:bash`. The command blocklist in `.swarm/config.yaml` refuses the most dangerous patterns even in unsafe mode. Everything emitted to `.swarm/runs/<id>/events.jsonl` is an immutable audit trail.
