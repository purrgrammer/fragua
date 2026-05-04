# swarm

A universal AI agent orchestrator. Declarative DOT workflows drive multi-provider agents through a deterministic state machine with complete replayable audit trails.

## What swarm delivers today

This is the honest, current state. Anything not in this list, or
explicitly listed below as **not yet**, is not built. For what's
coming, see [`docs/proposals/`](docs/proposals/README.md).

**Runtime**

- Foreground harness — daemon + HTTP under one supervisor (`swarm harness`) per machine, against a global `~/.swarm/swarm.db`; SQLite is the only coordination surface
- Project-aware run schema (cwd + workflow metadata + harness URL columns) — `run_state.cwd` keys runs to project roots, `daemon_lock.{http_url, http_port, harness_version}` carry the running URL so CLIs discover the harness via the DB itself (no JSON rendezvous file in the default install)
- Event store with intent/fact split, OCC on facts, content-addressed blobs on disk
- 8 node kinds: `start`, `exit`, `codergen` (LLM agent), `conditional`, `wait.human`, `tool` (graph-level shell), `parallel`, `parallel.fan_in`
- Replayable **control plane** (state machine, edge selection, intent fold). LLM bodies are best-effort and depend on provider determinism
- Two-layer config cascade — global `~/.swarm/config.jsonc` (defaults, autoTitle, blocklist, …) overlaid by `<project>/.swarm/config.jsonc` (project-specific bootstrap). Project keys win; nested objects merge one level deep

**Agents**

- 12+ inference providers via [`pi-ai`](https://github.com/badlogic/pi-mono): anthropic, openai, google, openrouter, vercel-ai-gateway, bedrock, vertex, groq, cerebras, xai, mistral, …
- Per-run git worktree under the run's `cwd` (`<project>/.swarm/worktrees/<run_id>/`) with branch-on-dispose preservation when the working tree has a delta. Each run's `cwd` is captured on `run_state` so a single harness can drive runs from any project directory — see [`docs/proposals/worktree-design.md`](docs/proposals/worktree-design.md) for the rough edges
- Inline tool hooks: post-edit typecheck/lint diagnostics injected back into the same agent turn

**Operator surface**

- Web UI on `:6767` (default; configurable via `web.port` or `--port`) with live SSE feeds (per-run + global). The harness auto-builds the web bundle when sources are newer than `dist/` and prints a clickable OSC 8 hyperlink on the `ready` line
- Projects are emergent — a project is a distinct `run_state.cwd`. `/projects` lists every directory swarm has ever run from with run rollups; `/projects/:cwdEnc` adds a `.gitignore`-honored file tree + blob viewer; `/analytics` carries a per-project filter
- Run-scoped file tree + git-aware diff on every run (`/runs/:id/tree`, `/runs/:id/blob`, `/runs/:id/changes`) — survives worktree disposal via the preserved `swarm/runs/<id>` branch
- Workflow listing aggregates `~/.swarm/workflows/` (global) with every project cwd's `.swarm/workflows/`; cross-source name collisions disambiguate by `cwd`
- Steering, pause, cancel, HITL input, resume, unquarantine, priority bump — all via intents
- Bare-name workflow resolution — global then local: `~/.swarm/workflows/<name>.dot` first, then `<cwd>/.swarm/workflows/<name>.dot`; anything path-shaped resolves verbatim
- One-off migration script for the swarm repo's pre-harness DB (`scripts/migrate-pre-harness.ts`) — ran on this repo on 2026-05-04, deletable once the global DB has soaked
- Per-node + per-run cost/token budgets with `warn` / `stop` / `pause` policies (default `pause`); Recoverable pause unification collapses the operator-resumable family to a single non-terminal `paused` status with reason-discriminated `fact.run_paused` (`operator` | `provider_error` | `payment_required` | `budget`); on a budget hit the operator raises the cap via `intent.budget_adjusted` (`POST /runs/:id/budget`, stored at `routing.budget_override.<scope>.<metric>`) and resumes, instead of losing upstream work to a terminal halt
- Automatic retries inside workflows via backward conditional edges + `max_retries`
- HITL via `wait.human` nodes returning `yield_hitl { label, options[] }`
- Auto-titler runs once per run (cost-bounded summariser)
- Daemon-events audit log (process lifecycle, sweeps, GC, leak detection, worktree provisioning)
- Doc-vs-code drift CI lint enforces AGENTS.md rule #1 — `bun run lint:docs` cross-checks `schema.sql` / `swarm-events.ts` / `handler/types.ts` / proposal index against `docs/`
- Bounded OCC retry loop with structured occ_exhausted halt — fact-append contention storms halt cleanly with a structured `occContext` payload instead of spinning, with 1–16 ms exponential backoff between retries
- Auto-retry for transient LLM provider errors — 408/429/5xx/529/network classified as auto-retry with full-jitter exponential backoff (or honoured `Retry-After` header) and projected to `paused_provider_retry`; 4xx auth/billing/schema errors fall through to manual `paused` (with `reason: "provider_error"` or `"payment_required"` on `fact.run_paused`); chain capped at 5 attempts / 5 cumulative minutes before `provider_exhausted` halt
- Self-review workflow (`bun run swarm run introspect`) — read-only periodic audit of architecture, doc-vs-code drift, proposal hygiene, and operational health; see [`docs/proposals/introspection-workflow.md`](docs/proposals/introspection-workflow.md)
- Parallel branch outputs — substitution + UI awareness: `$<branchId>.output` resolves downstream of a fan-out (per-branch `fact.node_started` / `fact.node_completed` carry `parentNodeId`/`parallelIndex`/`score`); web graph lights up every running branch alongside its parent component and accents the fan_in winner; conversation tab strip per concurrently-running branch; step + cost panels indent branch rows under their parent with summed totals — see [`docs/proposals/parallel-branch-outputs.md`](docs/proposals/parallel-branch-outputs.md)

## What swarm does not deliver today

- **Multi-machine deployment** — single SQLite is the coordination surface; no story for multiple daemons across machines
- **Per-branch worktrees in `parallel`** — branches share the run's single worktree, so they're read-only "deliberation only"; tracked in [`worktree-design`](docs/proposals/worktree-design.md)
- **Token auth on the harness API** — localhost-only, no auth in v0; revisit for shared/remote/browser-hostile cases ([`token-auth`](docs/proposals/token-auth.md))
- **Watchdog for stuck-but-alive daemons** — resumability covers crash-restart but not fiber deadlock; planned heartbeat metric, deferred until foreground harness UX has soaked
- **Postgres or non-SQLite backing** — `IEventStore` is synchronous; not a drop-in port
- **Workflow hot-reload for in-flight runs** — `workflow_sha` is pinned at enqueue time
- **Schema auto-migration across breaking bumps** — runs pin `schema_version`; out-of-range pins halt with `reason: "schema_drift"` rather than upgrading
- **Per-project credential isolation, project extensions, file-server, rate-limit fairness** — design-stage, see [`docs/proposals/`](docs/proposals/README.md)

## Documentation

- **[SPEC.md](docs/SPEC.md)** — what swarm is, at a glance
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — authoritative design (schema, invariants, property matrix)
- **[handler-contract.md](docs/handler-contract.md)** — practical guide for writing handlers
- **[providers.md](docs/providers.md)** — supported LLM providers + credential setup
- **[proposals/README.md](docs/proposals/README.md)** — what's coming (tagged by status × maturity)
- **[AGENTS.md](AGENTS.md)** — conventions for AI agents working on this repo

## Quick tour

```sh
bun install

# Terminal 1: foreground harness — daemon + HTTP under one supervisor.
# Default DB ~/.swarm/swarm.db, default port 6767, web bundle auto-built.
bun run swarm harness

# Terminal 2: any directory — enqueue a workflow against the running harness.
# Bare names resolve under ~/.swarm/workflows/<name>.dot, falling back to
# <cwd>/.swarm/workflows/<name>.dot. The CLI discovers the harness URL via
# daemon_lock.http_url in the global DB.
bun run swarm run change --input="rename foo() to bar() in packages/core"
```

The harness URL is printed on the `ready` line as a clickable hyperlink. Default origin is <http://localhost:6767>; override with `--port` or `web.port` in `~/.swarm/config.jsonc`. The CI primitive (`swarm daemon --db <path>` + `swarm serve --db <path>`) targets a project-local store and serves on <http://localhost:3000>.

Power-user / CI primitives:

```sh
bun run swarm daemon --db <path>         # executor only, against an explicit DB
bun run swarm serve  --db <path>         # standalone HTTP + SSE
bun run swarm validate workflow.dot      # parse + lint a DOT file
bun run swarm db vacuum                  # reclaim free pages
bun run swarm db gc-blobs                # drop orphaned artifact blobs
bun run swarm db backup --to backup.db   # snapshot via SQLite serialize()
```

`swarm run`'s discovery cascade: `--url` flag → `<cwd>/.swarm/serve.json` (CI primitive) → `~/.swarm/swarm.db` `daemon_lock.http_url` (harness) → `http://localhost:3000` last-resort default.

## Stack

Built on [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) (unified LLM client, 15+ providers) and [`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono/tree/main/packages/agent) (agent runtime). Store + daemon + server + handler contract are swarm's own.

## License

MIT.
