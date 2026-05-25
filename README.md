# fragua

> Cuando los niños en la escuela \
> estudiaban pa' el mañana, \
> mi niñez era la fragua: \
> yunque, clavo y alcayata.
>
> — Camarón de la Isla

durable, portable execution for engineering workflows. drive LLM agents with a deterministic control plane, humans in the loop, full event-log audit, and a live operator dashboard. runs on your laptop and on CI.

- declarative YAML workflows
- survives crashes, provider outages, and transient errors
- provider-agnostic
- models à la carte per step
- cost-control
- superb observability
- a run is a portable artifact

built on the assumption that the **control plane** is worth being deterministic even when the LLM bodies are not.

## what you get

- **workflows are text.** plain YAML. diff them, version them, code-review them. no DSL.
- **survives crashes & provider hiccups.** intent/fact split with OCC; transient errors (408/429/5xx/network) auto-retry; recoverable failures (budget caps, loop/goal ceilings, watchdog timeouts, engine incompatibility) pause instead of dying. raise the cap, resume. daemon restart picks up mid-flight runs.
- **same workflow, any provider.** per-step `provider` / `model` overrides, pre-flighted against pi-ai's registry — bad combos fail in milliseconds, not after 30 retries.
- **operator surface, not an afterthought.** live web UI on `:6767`: per-run + global SSE, run-scoped file tree + git-aware diff, transcripts, cost panels, steering + HITL — all driven by intents on the event log.
- **schedules built in.** fire on a fixed interval (`30m`…`7d`) with skip / queue / concurrent overlap, late-fire catch-up, per-schedule run history.
- **a run is a portable artifact.** the event log, messages, canonical workflow IR and a git-bundle of the worktree snapshots together are self-contained and portable. share them, replay them, debug them on another machine.

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
| `operate`    | driving **or debugging** a run — enqueue, tail, steer, HITL, land, and the failure-mode forensics |
| `backend`    | touching `packages/{server,store,core,agent}` |
| `frontend`   | touching the React dashboard under `packages/web/src` |
| `design`     | touching styles, theme tokens, or layout in `packages/web` |

## commands

The essentials below; the **[full CLI reference](docs/cli.md)** has every verb, flag, and the exit-code taxonomy.

```sh
fragua providers add            # add a provider credential (--custom for OpenAI-compatible)
fragua harness                  # daemon + HTTP on :6767 (Ctrl-C to stop)

fragua run <workflow> -i task="…"   # save + enqueue + follow (--no-follow to detach)
fragua runs inbox                   # runs needing an operator decision
fragua runs status <id>             # one run: lifecycle + outcome + the why
fragua runs tail   <id>             # follow an existing run's event log
fragua runs respond <id> [route]    # answer a HITL gate
fragua runs accept  <id>            # land a finished run's commits onto your branch

fragua ci <workflow>            # one-shot: run to terminal, exit code = outcome (CI)
fragua schedule add <wf> --every 1h
fragua validate <workflow.yaml>
```

A followed run's exit code reflects its outcome — `0` completed, non-zero by halt / pause / quarantine reason (the [CLI reference](docs/cli.md#exit-codes) has the full map). The CLI is a direct store-client: these work from any directory against `~/.fragua/fragua.db`, daemon up or down.

## status & docs

- **[STATUS.md](STATUS.md)** — what's working today, what's not yet
- **[docs/cli.md](docs/cli.md)** — the full CLI reference + exit-code taxonomy
- **[docs/SPEC.md](docs/SPEC.md)** — what fragua is
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — schema, invariants, property matrix
- **[docs/handler-contract.md](docs/handler-contract.md)** — writing handlers
- **[docs/providers.md](docs/providers.md)** — providers + credential setup
- **[AGENTS.md](AGENTS.md)** — conventions for agents (and humans)

## stack

Bun ≥ 1.2 · TypeScript strict · SQLite (WAL + STRICT) · Hono · React 18 + Vite 5 + Tailwind 4. LLM layer is [`pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) (15+ providers) + [`pi-agent-core`](https://github.com/badlogic/pi-mono/tree/main/packages/agent). store, daemon, server, and handler contract are fragua's own.

## license

MIT.
