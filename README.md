# fragua

> Cuando los niños en la escuela \
> estudiaban pa' el mañana, \
> mi niñez era la fragua: \
> yunque, clavo y alcayata.
>
> — Camarón de la Isla

a local dark software forge

- provider-agnostic (15+ inference backends via [`pi-ai`](https://github.com/badlogic/pi-mono))
- models à la carte per step
- cost-control
- superb observability

built on the assumption that the **control plane** is worth being deterministic even when the LLM bodies are not.

## why you might care

- **survives crashes & provider hiccups.** intent/fact split with OCC; transient errors (408/429/5xx/network) auto-retry; recoverable failures (budget caps, loop/goal ceilings, watchdog timeouts) pause instead of dying. raise the cap, resume. daemon restart picks up mid-flight runs.
- **same workflow, any provider.** per-step `provider` / `model` overrides, pre-flighted against pi-ai's registry — bad combos fail in milliseconds, not after 30 retries.
- **operator surface, not an afterthought.** live web UI on `:6767`: per-run + global SSE, run-scoped file tree + git-aware diff, transcripts, cost panels, steering + HITL — all driven by intents on the event log.
- **schedules built in.** fire on a fixed interval (`30m`…`7d`) with skip / queue / concurrent overlap, late-fire catch-up, per-schedule run history.
- **workflows are text.** plain YAML. diff them, version them, code-review them. no DSL.

## quickstart

```sh
bun install
bun run build:bin              # compiles dist/fragua (web UI embedded)
export PATH="$PWD/dist:$PATH"   # or symlink dist/fragua into /usr/local/bin

fragua providers add            # pick a provider, paste a key
fragua harness                  # daemon + HTTP on :6767, Ctrl-C to stop
fragua run work --input task="add a touch tool to @fragua/workspace"
```

> hacking on fragua itself? skip the build — `bun run fragua <args…>` hits the same entry point. `fragua` and `bun run fragua` are interchangeable.

run discovery is automatic (via the global DB), so `fragua run` works from any directory. point it at a `.yaml` path or a bare name resolved under `~/.fragua/workflows/` then `<cwd>/.fragua/workflows/`. inputs: `-i name=value` (repeatable, `@path` reads a file, `@-` reads stdin). `--title` names the run, `--no-follow` prints the id and exits.

## workflows

ships under `.fragua/workflows/` — run from the repo, or copy into `~/.fragua/workflows/` to use anywhere.

| workflow | what it does |
|---|---|
| `work`    | triage → (plan / reproduce) → implement → review → CI. leaves the change in the worktree to accept. |
| `review`  | scope a PR / diff → structured review, with a gated apply tail. |
| `analyze` | cost / token / latency analytics over recorded runs. |
| `drift`   | audit fragua's own arch / spec / skill docs against the code. |

author your own; `fragua validate <file>` parses + lints before you run. the `workflows` skill is the authoring guide.

## skills

domain context loaded on demand by the agents a workflow runs. live under `.agents/skills/` (symlinked into `.claude/skills/`).

| skill | loaded when you're… |
|---|---|
| `workflows`  | authoring or editing a workflow YAML |
| `operate`    | driving a live run — enqueue, watch, steer, pause, resume, HITL |
| `postmortem` | debugging a finished or stuck run from the event log |
| `backend`    | touching `packages/{server,store,core,agent}` |
| `frontend`   | touching the React dashboard under `packages/web/src` |
| `design`     | touching styles, theme tokens, or layout in `packages/web` |

## command reference

**providers & models** — `fragua providers <action>`

```sh
fragua providers add [provider]          # add credentials; --custom for OpenAI-compatible
fragua providers ls                      # configured providers + default models
fragua providers rm | test | login | logout <provider>
fragua providers {ls,add,rm,edit}-model  <provider> <id> [flags]
```

`add-model` / `edit-model` flags: `--name`, `--context-window`, `--max-tokens`, `--reasoning`, `--input text,image`, `--cost-input`, `--cost-output`, `-y`.

**create runs** — `fragua run <workflow>`

```sh
fragua run <workflow> [-i name=value]… [--title <t>] [--priority <n>] [--no-follow]
                     [--url <url>] [--cwd <dir>] [--db <path>]
```

**operate on runs** — `fragua runs <verb> <runId>` (plural operates; singular creates)

```sh
fragua runs inbox                                   # runs needing attention
fragua runs ls [--status running,paused_human] [--limit N]

# disposition — nothing touches your git until you ask
fragua runs diff    <runId> [--against base|previous|<idx>] [--snap <idx>]
fragua runs accept  <runId>                         # replay commits onto your branch + stage the tail
fragua runs discard <runId>                         # drop the run's fragua refs

# lifecycle
fragua runs respond <runId> [route] [--note "…"]    # answer a HITL gate
fragua runs resume  <runId> [--note "…"]
fragua runs unquarantine <runId> --resolution treat_as_done|retry|cancel
fragua runs cancel  <runId> [--reason "…"]
```

**schedules** — `fragua schedule <action>`

```sh
fragua schedule add <workflow> --every 1h [--input "…"] [--on-overlap skip|queue|concurrent] [--no-fire-on-create]
fragua schedule list | pause <id> | resume <id> | rm <id>
```

`--every` accepts `30m | 1h | 6h | 24h | 3d | 7d`.

**server / daemon primitives**

```sh
fragua harness [--port <n>] [--db <path>]                 # daemon + HTTP under one supervisor (:6767)
fragua serve   [--port <n>] [--cwd <dir>] [--db <path>]   # HTTP + SSE only; writes <db-dir>/serve.json
fragua daemon  start [--concurrency <n>] [--provider <name>] [--model <id>] [--cwd <dir>] [--db <path>]
fragua daemon  stop                                       # SIGTERM the daemon holding the store lock
```

discovery cascade: `--url` → `<cwd>/.fragua/serve.json` → `~/.fragua/fragua.db` `daemon_lock.http_url` → `http://localhost:3000`.

**maintenance & authoring**

```sh
fragua validate <workflow.yaml>          # parse + lint, no execution
fragua init [--cwd <path>]               # write <cwd>/.fragua/config.yaml
fragua gc --snapshots [--older-than 30d] [--dry-run]
fragua db {vacuum, gc-blobs [--limit N], backup --to <path>}
```

**developing on the repo**

```sh
bun run {typecheck, lint, format, ci}   # ci = lint + typecheck + tests
bun test                                # all package suites
bun run dev:web                         # Vite dev server (:5173), proxies /api to a running harness
bun run build:bin                       # compile dist/fragua
```

## status & docs

- **[STATUS.md](STATUS.md)** — what's working today, what's not yet
- **[docs/SPEC.md](docs/SPEC.md)** — what fragua is
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — schema, invariants, property matrix
- **[docs/handler-contract.md](docs/handler-contract.md)** — writing handlers
- **[docs/providers.md](docs/providers.md)** — providers + credential setup
- **[AGENTS.md](AGENTS.md)** — conventions for agents (and humans)

## stack

Bun ≥ 1.2 · TypeScript strict · SQLite (WAL + STRICT) · Hono · React 18 + Vite 5 + Tailwind 4. LLM layer is [`pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) (15+ providers) + [`pi-agent-core`](https://github.com/badlogic/pi-mono/tree/main/packages/agent). store, daemon, server, and handler contract are fragua's own.

## license

MIT.
