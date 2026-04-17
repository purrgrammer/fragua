# swarm

A universal AI agent orchestrator. Declarative DOT workflows drive multi-provider agents through a deterministic state machine with complete replayable audit trails.

**Status:** early design / scaffolding. See `docs/PLAN.md` for the current phase.

## Documentation

- **[SPEC.md](docs/SPEC.md)** — what swarm is
- **[PLAN.md](docs/PLAN.md)** — the phased build plan
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — design decisions and rationale
- **[AGENTS.md](AGENTS.md)** — conventions for AI agents working on this repo

## Quick tour (once Phase 2 ships)

```sh
bun install
bun run swarm run examples/hello.dot
bun run swarm replay .swarm/runs/<id>/events.jsonl
```

## Stack

Built on [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) (unified LLM client, 15+ providers) and [`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono/tree/main/packages/agent) (agent runtime). Follows the [Attractor](https://github.com/strongdm/attractor) specification for the orchestrator layer.

## License

MIT.
