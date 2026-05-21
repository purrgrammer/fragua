# `fragua` — CLI reference

The single entry point for running fragua: starts the harness, enqueues
runs, manages providers and schedules, and handles store maintenance.
All commands work against either the global harness (`~/.fragua/fragua.db`)
or an explicit `--db <path>` for CI / power-user setups.

From the monorepo root, every command runs as `bun run fragua <cmd>`.
When installed as a binary (`packages/cli/bin/fragua.ts`), use `fragua <cmd>`.

```sh
fragua                        # list commands
fragua <cmd> --help           # detailed flags for a command
```

## Daily driver

| Command | What it does |
|---|---|
| `fragua harness` | Foreground harness — daemon + HTTP server under one supervisor against `~/.fragua/fragua.db`. Default port 6767. Web bundle auto-builds when sources are newer than `dist/`. The `ready` line prints a clickable hyperlink. |
| `fragua run <workflow> [...args] [--input name=value]` | Upload a workflow, enqueue a run, stream events to stdout. Trailing args feed `$ARGUMENTS`; `--input name=value` (repeatable) binds typed `inputs:`, validated at enqueue. Bare names resolve under `~/.fragua/workflows/<name>.yaml` first, then `<cwd>/.fragua/workflows/<name>.yaml`. Discovers the running harness via `daemon_lock.http_url`. |
| `fragua validate <workflow.yaml>` | Parse + lint a workflow file without executing. |
| `fragua init` | Initialise the current directory as a fragua project (writes `.fragua/config.yaml`). |

## Providers

```sh
fragua providers              # show subcommand help
fragua providers ls           # list configured providers + their default models + a few valid model ids
fragua providers add [name]   # interactively add credentials for a built-in provider
fragua providers add --custom # add a custom OpenAI-compatible endpoint (writes to ~/.fragua/fragua.db)
fragua providers rm <name>    # remove credentials
fragua providers test <name> [model]  # round-trip a tiny request to verify the credentials work
fragua providers login <name> # OAuth login flow for providers that support it (e.g. github-copilot)
fragua providers logout <name>
```

Conceptually fragua separates **inference provider** (where the request
goes) from **model provider** (who trained the weights). See
[`docs/providers.md`](../../docs/providers.md) for the full distinction.

## Schedules

```sh
fragua schedule                                      # show subcommand help
fragua schedule add <workflow> --every <30m|1h|6h|24h> [--input "…"] [--cwd <dir>]
fragua schedule ls [--cwd <dir>]
fragua schedule pause <id>
fragua schedule resume <id>
fragua schedule rm <id>
```

Skip-on-overlap by default. One coalesced catch-up after daemon
downtime; auto-pauses if the workflow file goes missing.

## Store maintenance

```sh
fragua db vacuum                # reclaim free pages
fragua db gc-blobs              # drop orphaned artifact blobs
fragua db backup --to <path>    # snapshot via SQLite serialize()
fragua gc                       # garbage-collect run artefacts (worktrees, branches) past retention
fragua gc --branches            # prune `fragua/runs/*` branches past 30-day default
```

## CI / power-user primitives

For setups where the foreground harness isn't a fit (CI runners,
project-local stores, separate executor / HTTP processes):

```sh
fragua daemon --db <path>       # executor only, against an explicit DB
fragua daemon stop              # ask the running daemon to exit
fragua serve  --db <path>       # standalone HTTP + SSE on :3000
```

`fragua run`'s server discovery cascade:
`--url` flag → `<cwd>/.fragua/serve.json` (CI primitive) →
`~/.fragua/fragua.db` `daemon_lock.http_url` (harness) →
`http://localhost:3000` last-resort default.

## Config

Two-layer cascade — global `~/.fragua/config.yaml` (defaults,
auto-title, blocklist, …) overlaid by `<project>/.fragua/config.yaml`.
Legacy `config.jsonc` is read with a deprecation warning for one release—rename to `config.yaml` to silence it.
Project keys win; nested objects merge one level deep.

## See also

- [STATUS.md](../../STATUS.md) — what fragua delivers today
- [docs/SPEC.md](../../docs/SPEC.md) — what fragua is, at a glance
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) — schema, invariants, property matrix
- [docs/providers.md](../../docs/providers.md) — inference vs. model provider
- [AGENTS.md](../../AGENTS.md) — conventions for AI agents (and humans) working on this repo
