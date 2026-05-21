# swarm

A team's git-native library of agentic workflows that compounds as
people contribute. You write workflows in plain YAML
(GitHub-Actions-style `steps:`) — LLM calls, shell commands, or
human-in-the-loop gates — commit them to your repo, and run them two
ways: **locally** while you develop them, and in **CI** fired by
triggers (a PR opening, a schedule, a failed build) for jobs like PR
review, dependency / vulnerability fixes, security audits, automatic
CI fixes, and docs/repo-drift checks. Every run is recorded to a
SQLite event log you can replay, steer, pause, or resume — and in CI
ships as a downloadable, secret-free audit artifact.

Provider-agnostic (15+ inference backends via [`pi-ai`](https://github.com/badlogic/pi-mono)),
models à la carte per step, cost-controlled, and built on the
assumption that the **control plane** is worth being deterministic
even when the LLM bodies are not. **Local and CI are the targets** — it
is deliberately *not* a multi-tenant server.

## Why you might care

- **Multi-step LLM work that survives crashes and provider hiccups.**
  Intent/fact event split with OCC; transient provider errors
  (408/429/5xx/network) auto-retry; recoverable failures — provider
  errors, payment-required, budget caps, retry / loop / goal-gate
  ceilings, provider exhaustion, watchdog timeouts — pause instead
  of dying. Operators raise the cap (or fix the config) and resume;
  daemon restart resumes mid-flight runs to the last completed turn.
- **Same workflow, any provider.** Per-node `provider` / `model`
  overrides; pre-flight against pi-ai's registry so bad combos fail in
  milliseconds, not after 30 retries.
- **Operator surface that isn't an afterthought.** Live web UI on
  `:6767` with per-run + global SSE feeds, run-scoped file tree +
  git-aware diff, conversation transcripts, cost panels, steering
  and HITL controls — all driven by intents on the same event log.
- **Schedules built in.** Fire a workflow on a fixed interval
  (`30m` / `1h` / `6h` / `24h` / `3d` / `7d`) with skip / queue /
  concurrent overlap policy, late-fire catch-up, and a per-schedule
  run-history stripe.
- **Workflows are text.** Diff them, version them, code-review them.
  No DSL to learn beyond YAML.

## Get started

A first run is four steps: **build the CLI → add a provider → launch
the harness → queue a run.**

### 1. Build the `swarm` CLI

```sh
bun install
bun run build:bin                       # compiles dist/swarm (web UI embedded)

# put it on your PATH — pick one:
export PATH="$PWD/dist:$PATH"           # this shell only (add to your shell rc to persist)
# ln -s "$PWD/dist/swarm" /usr/local/bin/swarm    # system-wide
```

> **Working on swarm itself?** Skip the build and run the CLI straight
> from source with `bun run swarm <args…>` — it forwards to the same
> entry point. Everywhere below, `swarm` and `bun run swarm` are
> interchangeable.

### 2. Add an LLM provider

You need credentials for at least one provider before anything runs.

```sh
swarm providers add                     # pick a provider, paste a key (interactive)
swarm providers ls                      # list configured providers + default models
```

See [`docs/providers.md`](docs/providers.md) for the full list and how
the inference-provider vs. model-provider split works.

### 3. Launch the harness

The harness supervises the execution daemon + HTTP server as one
foreground process. Default DB `~/.swarm/swarm.db`, default port 6767,
web bundle served from the binary.

```sh
swarm harness                           # Ctrl-C to stop
```

It prints its URL on the `ready` line — open
<http://localhost:6767> to watch runs live, steer them, pause them, or
answer a HITL gate.

### 4. Queue a run

In a second terminal, point at a `.yaml` file by path, or at a bare
name once you've authored workflows under `~/.swarm/workflows/<name>.yaml`
(resolved first) or `<cwd>/.swarm/workflows/<name>.yaml`. The CLI
discovers the running harness through the global DB, so it works from
any directory.

```sh
swarm run work --input task="add a touch tool to @swarm/workspace"
swarm run path/to/your-workflow.yaml -i env=prod -i ticket=BUG-1
```

Pass workflow inputs with `-i` / `--input name=value` (repeat the flag
for several), validated against the workflow's `inputs:` block. A value
of `@path` reads a file, `@-` reads stdin. `--title` names the run;
without it the title is auto-summarised. `--no-follow` prints the run
id and exits instead of streaming.

## Workflows

This repo ships a small set under `.swarm/workflows/` — run them from
the repo cwd, or copy the ones you want into `~/.swarm/workflows/` to
use them anywhere:

| Workflow | What it does |
|---|---|
| `work`    | Triage a task → (plan / reproduce) → implement → review → CI. Leaves the change in the run's worktree to accept. |
| `review`  | Scope a PR / diff and produce a structured review, with a gated apply tail. |
| `analyze` | Cost / token / latency analytics over recorded runs. |
| `drift`   | Audit swarm's own architecture / spec / skill docs against the code and report drift. |

Author your own with `swarm validate <file>` to parse + lint before
running. The `workflows` skill (below) is the authoring guide.

## Skills

Skills are domain context loaded on demand by the agents a workflow
runs. The project-internal set lives under `.agents/skills/` (and is
symlinked into `.claude/skills/` for cross-client use):

| Skill | Loaded when you're… |
|---|---|
| `workflows`  | authoring or editing a workflow YAML |
| `operate`    | driving a live run — enqueue, watch, steer, pause, resume, HITL, unquarantine |
| `postmortem` | debugging a finished or stuck run from the event log |
| `backend`    | touching `packages/{server,store,core,agent}` (store methods, routes, reducers, daemon) |
| `frontend`   | touching the React dashboard under `packages/web/src` |
| `design`     | touching styles, theme tokens, or layout in `packages/web` |

## Command reference

### Providers & models — `swarm providers <action>`

```sh
swarm providers                         # subcommand help
swarm providers add [provider]          # add credentials (interactive); --custom for an OpenAI-compatible provider
swarm providers ls                      # list configured providers + default models
swarm providers rm <provider>
swarm providers test <provider> [model] # smoke a credential against the live API
swarm providers login  <provider>       # OAuth-style login flow
swarm providers logout <provider>
swarm providers ls-models   <provider>                  # list models on a custom provider
swarm providers add-model   <provider> <id> [flags]     # append a model entry
swarm providers rm-model    <provider> <id> [--yes]
swarm providers edit-model  <provider> <id> [flags]     # update fields on an existing entry
```

`add-model` / `edit-model` flags: `--name`, `--context-window`,
`--max-tokens`, `--reasoning`, `--input text,image`, `--cost-input`,
`--cost-output`, `--yes`/`-y`.

### Creating runs — `swarm run <workflow>`

```sh
swarm run <workflow> [-i name=value]…  [--title <t>] [--priority <n>] [--no-follow]
                     [--url <url>] [--cwd <dir>] [--db <path>]
```

### Operating on runs — `swarm runs <verb> <runId>`

`swarm run <workflow>` (singular) *creates* a run; `swarm runs`
(plural) *operates* on one — disposition, lifecycle, and listing all
hang off it.

```sh
# Listing
swarm runs inbox                                   # runs needing attention (2 sections)
swarm runs ls [--status running,paused_human] [--limit N]

# Disposition — a finished run's recoverable work (nothing touches your
# git branches until you ask)
swarm runs diff    <runId> [--against base|previous|<idx>] [--snap <idx>]
swarm runs accept  <runId>                         # replay the run's commits onto your branch + stage the tail
swarm runs discard <runId>                         # drop the run's swarm refs

# Lifecycle — unblock a stuck run
swarm runs respond <runId> [route] [--note "…"]    # answer a HITL gate (interactive without a route)
swarm runs resume  <runId> [--note "…"]
swarm runs unquarantine <runId> --resolution treat_as_done|retry|cancel
swarm runs cancel  <runId> [--reason "…"]
```

### Schedules — `swarm schedule <action>`

```sh
swarm schedule add <workflow> --every 1h [--input "…"] [--on-overlap skip|queue|concurrent] [--no-fire-on-create]
swarm schedule list                     # schedules + recent-run stripes (alias: ls)
swarm schedule pause  <id>
swarm schedule resume <id>
swarm schedule rm     <id>
```

`--every` accepts `30m | 1h | 6h | 24h | 3d | 7d`.

### Server / daemon primitives

```sh
swarm harness [--port <n>] [--db <path>]            # daemon + HTTP under one supervisor (default :6767)
swarm serve   [--port <n>] [--cwd <dir>] [--db <path>]   # HTTP + SSE only; writes <db-dir>/serve.json
swarm daemon  start [--concurrency <n>] [--provider <name>] [--model <id>] [--cwd <dir>] [--db <path>]
swarm daemon  stop                                  # SIGTERM the daemon holding the store lock
```

`swarm run`'s discovery cascade: `--url` flag →
`<cwd>/.swarm/serve.json` (a `serve` instance) →
`~/.swarm/swarm.db` `daemon_lock.http_url` (a harness) →
`http://localhost:3000` last-resort default.

### Maintenance & authoring

```sh
swarm validate <workflow.yaml>          # parse + lint, no execution
swarm init [--cwd <path>]               # write <cwd>/.swarm/config.yaml
swarm gc --snapshots [--older-than 30d] [--dry-run]   # reclaim worktree snapshot refs
swarm db vacuum                         # reclaim free pages
swarm db gc-blobs [--limit N]           # drop orphaned artifact blobs
swarm db backup --to backup.db          # snapshot via SQLite serialize()
```

### Developing on the repo

```sh
bun run typecheck                       # tsc --noEmit across the workspace
bun run lint                            # biome check
bun run format                          # biome format --write
bun test                                # all package suites
bun run ci                              # lint + typecheck + tests
bun run dev:web                         # Vite dev server (:5173), proxies /api to a running harness
bun run build:bin                       # compile dist/swarm
```

## Status & docs

- **[STATUS.md](STATUS.md)** — what's working today, what's not yet
- **[docs/SPEC.md](docs/SPEC.md)** — what swarm is, at a glance
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — design (schema, invariants, property matrix)
- **[docs/handler-contract.md](docs/handler-contract.md)** — writing handlers
- **[docs/providers.md](docs/providers.md)** — supported LLM providers + credential setup
- **[AGENTS.md](AGENTS.md)** — conventions for AI agents (and humans) working on this repo

## Stack

Bun ≥ 1.2, TypeScript strict, SQLite (WAL + STRICT), Hono, React 18 +
Vite 5 + Tailwind 4 for the dashboard. Built on
[`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai)
(unified LLM client, 15+ providers) and
[`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono/tree/main/packages/agent)
(agent runtime). Store, daemon, server, and handler contract are
swarm's own.

## License

MIT.
