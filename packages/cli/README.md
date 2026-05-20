# `swarm` — CLI reference

The single entry point for running swarm: starts the harness, enqueues
runs, manages providers and schedules, and handles store maintenance.
All commands work against either the global harness (`~/.swarm/swarm.db`)
or an explicit `--db <path>` for CI / power-user setups.

From the monorepo root, every command runs as `bun run swarm <cmd>`.
When installed as a binary (`packages/cli/bin/swarm.ts`), use `swarm <cmd>`.

```sh
swarm                        # list commands
swarm <cmd> --help           # detailed flags for a command
```

## Daily driver

| Command | What it does |
|---|---|
| `swarm harness` | Foreground harness — daemon + HTTP server under one supervisor against `~/.swarm/swarm.db`. Default port 6767. Web bundle auto-builds when sources are newer than `dist/`. The `ready` line prints a clickable hyperlink. |
| `swarm run <workflow> [...args] [--input name=value]` | Upload a workflow, enqueue a run, stream events to stdout. Trailing args feed `$ARGUMENTS`; `--input name=value` (repeatable) binds typed `inputs:`, validated at enqueue. Bare names resolve under `~/.swarm/workflows/<name>.yaml` first, then `<cwd>/.swarm/workflows/<name>.yaml`. Discovers the running harness via `daemon_lock.http_url`. |
| `swarm validate <workflow.yaml>` | Parse + lint a workflow file without executing. |
| `swarm init` | Initialise the current directory as a swarm project (writes `.swarm/config.yaml`). |

## Providers

```sh
swarm providers              # show subcommand help
swarm providers ls           # list configured providers + their default models + a few valid model ids
swarm providers add [name]   # interactively add credentials for a built-in provider
swarm providers add --custom # add a custom OpenAI-compatible endpoint (writes to ~/.swarm/swarm.db)
swarm providers rm <name>    # remove credentials
swarm providers test <name> [model]  # round-trip a tiny request to verify the credentials work
swarm providers login <name> # OAuth login flow for providers that support it (e.g. github-copilot)
swarm providers logout <name>
```

Conceptually swarm separates **inference provider** (where the request
goes) from **model provider** (who trained the weights). See
[`docs/providers.md`](../../docs/providers.md) for the full distinction.

## Schedules

```sh
swarm schedule                                      # show subcommand help
swarm schedule add <workflow> --every <30m|1h|6h|24h> [--input "…"] [--cwd <dir>]
swarm schedule ls [--cwd <dir>]
swarm schedule pause <id>
swarm schedule resume <id>
swarm schedule rm <id>
```

Skip-on-overlap by default. One coalesced catch-up after daemon
downtime; auto-pauses if the workflow file goes missing. See
[`docs/proposals/scheduled-runs.md`](../../docs/proposals/scheduled-runs.md).

## Store maintenance

```sh
swarm db vacuum                # reclaim free pages
swarm db gc-blobs              # drop orphaned artifact blobs
swarm db backup --to <path>    # snapshot via SQLite serialize()
swarm gc                       # garbage-collect run artefacts (worktrees, branches) past retention
swarm gc --branches            # prune `swarm/runs/*` branches past 30-day default
```

## CI / power-user primitives

For setups where the foreground harness isn't a fit (CI runners,
project-local stores, separate executor / HTTP processes):

```sh
swarm daemon --db <path>       # executor only, against an explicit DB
swarm daemon stop              # ask the running daemon to exit
swarm serve  --db <path>       # standalone HTTP + SSE on :3000
```

`swarm run`'s server discovery cascade:
`--url` flag → `<cwd>/.swarm/serve.json` (CI primitive) →
`~/.swarm/swarm.db` `daemon_lock.http_url` (harness) →
`http://localhost:3000` last-resort default.

## Config

Two-layer cascade — global `~/.swarm/config.yaml` (defaults,
auto-title, blocklist, …) overlaid by `<project>/.swarm/config.yaml`.
Legacy `config.jsonc` is read with a deprecation warning for one release—rename to `config.yaml` to silence it.
Project keys win; nested objects merge one level deep.

## See also

- [STATUS.md](../../STATUS.md) — what swarm delivers today
- [docs/SPEC.md](../../docs/SPEC.md) — what swarm is, at a glance
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — schema, invariants, property matrix
- [docs/providers.md](../../docs/providers.md) — inference vs. model provider
- [AGENTS.md](../../AGENTS.md) — conventions for AI agents (and humans) working on this repo
