# swarm

A universal AI agent orchestrator. Declarative DOT workflows drive multi-provider agents through a deterministic state machine with complete replayable audit trails.

## What swarm delivers today

This is the honest, current state. Anything not in this list, or
explicitly listed below as **not yet**, is not built. For what's
coming, see [`docs/proposals/`](docs/proposals/README.md).

**Runtime**

- Single-machine — one daemon + HTTP server per project directory; SQLite is the only coordination surface
- Event store with intent/fact split, OCC on facts, content-addressed blobs on disk
- 8 node kinds: `start`, `exit`, `codergen` (LLM agent), `conditional`, `wait.human`, `tool` (graph-level shell), `parallel`, `parallel.fan_in`
- Replayable **control plane** (state machine, edge selection, intent fold). LLM bodies are best-effort and depend on provider determinism
- Project config + identity in `<project>/.swarm/config.jsonc` — JSONC, UUIDv7 id, TypeBox-validated; `swarm init` mints it

**Agents**

- 12+ inference providers via [`pi-ai`](https://github.com/badlogic/pi-mono): anthropic, openai, google, openrouter, vercel-ai-gateway, bedrock, vertex, groq, cerebras, xai, mistral, …
- Per-run git worktree (`<project>/.swarm/worktrees/<run_id>/`) with branch-on-dispose preservation when the working tree has a delta — see [`docs/proposals/worktree-design.md`](docs/proposals/worktree-design.md) for the rough edges
- Inline tool hooks: post-edit typecheck/lint diagnostics injected back into the same agent turn

**Operator surface**

- Web UI on `:3000` with live SSE feeds (per-run + global)
- Steering, pause, cancel, HITL input, resume, unquarantine, priority bump — all via intents
- Per-node + per-run cost/token budgets with `warn` / `stop` policies
- Automatic retries inside workflows via backward conditional edges + `max_retries`
- HITL via `wait.human` nodes returning `yield_hitl { label, options[] }`
- Auto-titler runs once per run (cost-bounded summariser)
- Daemon-events audit log (process lifecycle, sweeps, GC, leak detection, worktree provisioning)
- Doc-vs-code drift CI lint enforces AGENTS.md rule #1 — `bun run lint:docs` cross-checks `schema.sql` / `swarm-events.ts` / `handler/types.ts` / proposal index against `docs/`
- Bounded OCC retry loop with structured occ_exhausted halt — fact-append contention storms halt cleanly with a structured `occContext` payload instead of spinning, with 1–16 ms exponential backoff between retries
- Auto-retry for transient LLM provider errors — 408/429/5xx/529/network classified as auto-retry with full-jitter exponential backoff (or honoured `Retry-After` header); 4xx auth/billing/schema errors fall through to manual `paused` (reason: `provider_error`); chain capped at 5 attempts / 5 cumulative minutes before `provider_exhausted` halt
- Self-review workflow (`bun run swarm run introspect`) — read-only periodic audit of architecture, doc-vs-code drift, proposal hygiene, and operational health; see [`docs/proposals/introspection-workflow.md`](docs/proposals/introspection-workflow.md)

## What swarm does not deliver today

- **Multi-machine deployment** — single SQLite is the coordination surface; no story for multiple daemons across machines
- **Global harness** (one daemon per machine across projects) — currently one daemon per project directory; in design ([`harness`](docs/proposals/harness.md))
- **Per-branch worktrees in `parallel`** — branches share the run's single worktree, so they're read-only "deliberation only"; tracked in [`PENDING.md`](docs/PENDING.md) and [`worktree-design`](docs/proposals/worktree-design.md)
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

# Typical: harness supervises daemon + HTTP server in one foreground process,
# binding ~/.swarm/swarm.db so every project shares one DB.
bun run swarm harness

# Or, as separate CI primitives against a project-local store:
#   bun run swarm serve  --db .swarm/swarm.db          # HTTP surface (intents, reads, SSE) on :3000
#   bun run swarm daemon --db .swarm/swarm.db --llm-provider anthropic --llm-model claude-sonnet-4-5

# Then: upload a workflow, enqueue, stream events
bun run swarm run examples/hello.dot
```

The harness binds `~/.swarm/swarm.db` and serves the Web UI on <http://localhost:6767>. The CI primitive (`swarm daemon --db <path>` + `swarm serve --db <path>`) targets a project-local store and serves on <http://localhost:3000>.

Maintenance:

```sh
bun run swarm validate workflow.dot      # parse + lint a DOT file
bun run swarm db vacuum                  # reclaim free pages
bun run swarm db gc-blobs                # drop orphaned artifact blobs
bun run swarm db backup --to backup.db   # snapshot via SQLite serialize()
```

## Stack

Built on [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) (unified LLM client, 15+ providers) and [`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono/tree/main/packages/agent) (agent runtime). Store + daemon + server + handler contract are swarm's own.

## License

MIT.
