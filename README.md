# swarm

A universal AI agent orchestrator. You write workflows in plain
[DOT](https://graphviz.org/doc/info/lang.html) — nodes are LLM calls,
shell commands, conditionals, parallel branches, human-in-the-loop
gates — and swarm runs them through a deterministic state machine
against any LLM provider, with every step recorded to a SQLite event
log you can replay, steer, pause, or resume.

It's local-first (one process, one SQLite file under `~/.swarm/`),
provider-agnostic (15+ inference backends via [`pi-ai`](https://github.com/badlogic/pi-mono)),
and built on the assumption that the **control plane** is worth being
deterministic even when the LLM bodies are not.

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
  No DSL to learn beyond DOT.

## Quick tour

### Before you start

You need credentials for at least one LLM provider. The fastest path:

```sh
export ANTHROPIC_API_KEY=...      # or OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, ...
```

Or run the interactive setup, which writes to `~/.swarm/`:

```sh
bun run swarm providers add       # pick a provider, paste a key
bun run swarm providers           # list configured providers + their default models
```

See [`docs/providers.md`](docs/providers.md) for the full list and
how the inference-provider vs. model-provider split works.

### Run

```sh
bun install

# Terminal 1 — foreground harness: daemon + HTTP under one supervisor.
# Default DB ~/.swarm/swarm.db, default port 6767, web bundle auto-built.
bun run swarm harness

# Terminal 2 — point at a .dot file by path, or by bare name once you've
# authored workflows under ~/.swarm/workflows/<name>.dot (resolved first)
# or <cwd>/.swarm/workflows/<name>.dot. The CLI discovers the running
# harness via the global DB — works from any directory.
bun run swarm run path/to/your-workflow.dot --input "…"
```

This repo ships a small set of workflows under `.swarm/workflows/`
(`change.dot`, `analyze.dot`, `ci-gate.dot`, `showcase.dot`, …) — run
them with `bun run swarm run change --input "…"` from the swarm repo
cwd, or copy the ones you want into `~/.swarm/workflows/` to use them
anywhere.

The harness prints its URL on the `ready` line as a clickable
hyperlink — open <http://localhost:6767> to watch the run live, steer
it, pause it, or feed it a HITL response.

### Power-user / CI primitives

```sh
bun run swarm daemon --db <path>         # executor only, against an explicit DB
bun run swarm serve  --db <path>         # standalone HTTP + SSE
bun run swarm validate workflow.dot      # parse + lint a DOT file, no execution
bun run swarm schedule add <workflow> --every 1h --input "…"   # fire on an interval
bun run swarm schedule list              # show schedules + recent-run stripes
bun run swarm db vacuum                  # reclaim free pages
bun run swarm db gc-blobs                # drop orphaned artifact blobs
bun run swarm db backup --to backup.db   # snapshot via SQLite serialize()
```

`swarm run`'s discovery cascade: `--url` flag → `<cwd>/.swarm/serve.json`
(CI primitive) → `~/.swarm/swarm.db` `daemon_lock.http_url` (harness) →
`http://localhost:3000` last-resort default.

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
