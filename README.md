# swarm

A universal AI agent orchestrator. Declarative DOT workflows drive multi-provider agents through a deterministic state machine with complete replayable audit trails.

## Documentation

- **[SPEC.md](docs/SPEC.md)** — what swarm is, at a glance
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — authoritative design (schema, invariants, property matrix)
- **[handler-contract.md](docs/handler-contract.md)** — practical guide for writing handlers
- **[providers.md](docs/providers.md)** — supported LLM providers + credential setup
- **[AGENTS.md](AGENTS.md)** — conventions for AI agents working on this repo

## Quick tour

```sh
bun install

# Terminal 1: HTTP surface (intents, reads, SSE)
bun run swarm serve

# Terminal 2: executor (real LLM)
bun run swarm daemon --provider anthropic --model claude-opus-4-7

# Terminal 3: upload a workflow, enqueue, stream events
bun run swarm run examples/hello.dot
```

The store lives at `.swarm/swarm.db`. Web UI is at <http://localhost:3000>.

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
