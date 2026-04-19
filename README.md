# swarm

A universal AI agent orchestrator. Declarative DOT workflows drive multi-provider agents through a deterministic state machine with complete replayable audit trails.

**Status:** early design / scaffolding. See `docs/PLAN.md` for the current phase.

## Documentation

- **[REARCHITECTURE.md](docs/REARCHITECTURE.md)** — **authoritative** design (DB-backed, event-sourced, OCC)
- **[SPEC.md](docs/SPEC.md)** — what swarm is (conceptual)
- **[AGENTS.md](AGENTS.md)** — conventions for AI agents working on this repo

Older docs under `docs/` (ARCHITECTURE, daemon, events, run-control, web-ui, PLAN) describe the file-based coordination surfaces that the rearchitecture replaced. They remain as historical context; trust REARCHITECTURE.md when they disagree.

## Quick tour

```sh
bun install
bun run swarm serve           # starts HTTP + SSE server on :3000
bun run swarm validate <file> # parse + lint a .dot workflow
```

The store lives at `.swarm/swarm.db`. The daemon (future `bun run swarm daemon`) executes runs by claiming queued rows; the web UI reads the projection directly via Hono routes.

## Stack

Built on [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) (unified LLM client, 15+ providers) and [`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono/tree/main/packages/agent) (agent runtime). Follows the [Attractor](https://github.com/strongdm/attractor) specification for the orchestrator layer.

## License

MIT.
