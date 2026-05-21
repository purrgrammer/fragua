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
is deliberately *not* a multi-tenant server (see
[`docs/deployment.md`](docs/deployment.md)).

## Why you might care

- **Multi-step LLM work that survives crashes and provider hiccups.**
  Intent/fact event split with OCC; transient provider errors
  (408/429/5xx/network) auto-retry; recoverable failures — provider
  errors, payment-required, budget caps, retry / loop / goal-gate
  ceilings, provider exhaustion, watchdog timeouts — pause instead
  of dying. Operators raise the cap (or fix the config) and resume;
  daemon restart resumes mid-flight runs to the last completed turn.
- **Same workflow, any provider.** Per-node `llm_provider` /
  `llm_model` overrides; pre-flight against pi-ai's registry so bad
  combos fail in milliseconds, not after 30 retries.
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

## Quick tour

### Before you start

You need credentials for at least one LLM provider. The fastest path:

```sh
bun run swarm providers add       # pick a provider, paste a key
bun run swarm providers           # list configured providers + their default models
bun run swarm providers ls-models <provider>            # list models declared under a custom provider
bun run swarm providers add-model <provider> <id>       # append one model entry (flags: --context-window --max-tokens --reasoning --input --cost-input --cost-output --yes)
bun run swarm providers rm-model <provider> <id>        # remove one model entry
bun run swarm providers edit-model <provider> <id>      # update one or more fields on an existing entry (same flags as add-model)
```

See [`docs/providers.md`](docs/providers.md) for the full list and
how the inference-provider vs. model-provider split works.

### Run

```sh
bun install

# Terminal 1 — foreground harness: daemon + HTTP under one supervisor.
# Default DB ~/.swarm/swarm.db, default port 6767, web bundle auto-built.
bun run swarm harness

# Terminal 2 — point at a .yaml file by path, or by bare name once you've
# authored workflows under ~/.swarm/workflows/<name>.yaml (resolved first)
# or <cwd>/.swarm/workflows/<name>.yaml. The CLI discovers the running
# harness via the global DB — works from any directory.
# Pass workflow inputs with -i/--input name=value — repeat the flag for
# several (one name=value each), validated against the inputs: block. A
# value of @path reads a file, @- reads stdin. --title names the run;
# without it the title is auto-summarised.
bun run swarm run path/to/your-workflow.yaml -i env=prod -i ticket=BUG-1
bun run swarm run work --input task=@task.md --title "Touch tool"
```

This repo ships a small set of workflows under `.swarm/workflows/`
(`work.yaml`, `review.yaml`, `analyze.yaml`, …) — run them with
`bun run swarm run work --input task="…"` from the swarm repo cwd, or
copy the ones you want into `~/.swarm/workflows/` to use them anywhere.

The harness prints its URL on the `ready` line as a clickable
hyperlink — open <http://localhost:6767> to watch the run live, steer
it, pause it, or feed it a HITL response.

### Power-user / CI primitives

```sh
bun run swarm daemon --db <path>         # executor only, against an explicit DB
bun run swarm serve  --db <path>         # standalone HTTP + SSE
bun run swarm validate workflow.yaml      # parse + lint a workflow file, no execution
bun run swarm schedule add <workflow> --every 1h --input "…"   # fire on an interval
bun run swarm schedule list              # show schedules + recent-run stripes
bun run swarm db vacuum                  # reclaim free pages
bun run swarm db gc-blobs                # drop orphaned artifact blobs
bun run swarm db backup --to backup.db   # snapshot via SQLite serialize()
```

`swarm run`'s discovery cascade: `--url` flag → `<cwd>/.swarm/serve.json`
(CI primitive) → `~/.swarm/swarm.db` `daemon_lock.http_url` (harness) →
`http://localhost:3000` last-resort default.

### Operating on runs — `swarm runs <verb> <runId>`

`swarm run <workflow>` (singular) *creates* a run; `swarm runs` (plural)
*operates* on one — disposition, lifecycle, and listing all hang off it
so the top-level stays small.

```sh
# Listing
bun run swarm runs inbox                                         # what needs me (2 sections)
bun run swarm runs ls [--status running,paused_human] [--limit N]

# Disposition — a finished run's recoverable work (nothing touches your
# git branches until you ask): no checkout, nothing in `git branch` unbidden.
bun run swarm runs diff    <runId> [--against base|previous|<idx>]
bun run swarm runs branch  <runId> <branch> [--force]               # committed history → a branch
bun run swarm runs commit  <runId> -m "msg" [--onto <branch>]       # full tree (incl. dirt) → one commit
bun run swarm runs merge   <runId> [--no-ff|--squash] [--into <branch>]   # ff by default; target defaults to base ref
bun run swarm runs discard <runId>                                  # drop the run's swarm refs

# Lifecycle — unblock a stuck run
bun run swarm runs respond <runId> [route] [--note "…"]             # answer a HITL gate (interactive without a route)
bun run swarm runs resume  <runId>
bun run swarm runs unquarantine <runId> --resolution treat_as_done|retry|cancel
bun run swarm runs cancel  <runId> [--reason "…"]
```

## Status & docs

- **[STATUS.md](STATUS.md)** — what's working today, what's not yet
- **[docs/SPEC.md](docs/SPEC.md)** — what swarm is, at a glance
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — design (schema, invariants, property matrix)
- **[docs/handler-contract.md](docs/handler-contract.md)** — writing handlers
- **[docs/providers.md](docs/providers.md)** — supported LLM providers + credential setup
- **[docs/proposals/](docs/proposals/README.md)** — what's coming (tagged by status × maturity)
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
