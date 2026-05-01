---
title: Handler discipline rails for extension code
status: proposed
maturity: sketch
last-reviewed: 2026-05-01
---

# Handler discipline rails for extension code

> The structural lint enforcing the handler contract (no `node:fs` /
> `node:child_process` / bare `fetch`; no `await` inside `db.transaction(...)`)
> is scoped to `packages/core/src/handler/handlers/`. The agent backend
> (`packages/agent/src/backend.ts`) and any future user-supplied handler
> or tool fall outside that scope. Once a third-party handler ships,
> the I1 / I4 invariants depend on review, not lint.

## Shape

Extend lint coverage to three additional surfaces:

1. **Agent backend** (`packages/agent/src/`) — the codergen handler routes through pi-agent-core, which does call `fetch`. That's the correct boundary; lint should explicitly allow the documented bridge points (`backend.ts`, `event-bridge.ts`, `tool-adapter.ts`) and reject any *new* bare `fetch` / `node:fs` / `node:child_process` outside them.

2. **User-supplied handlers** (registered via `dispatcher.register()`) — at registration time, parse the source file (Bun has the AST) and lint for the same forbidden imports / patterns. Reject registration if it fails. A `--unsafe-handler` flag for power users who explicitly opt out, with a startup banner naming each unsafe handler so it's not silent.

3. **User-supplied tools** (registered via `ToolRegistry.register()`) — same shape. Tools are arguably more dangerous because they execute inside a codergen turn at the LLM's behest, not under explicit handler invocation.

## Why this is load-bearing

The handler contract is enforced **structurally** (lint) for in-tree code. Out-of-tree extension is the obvious next direction:

- [project-extensions](./project-extensions.md) — user tools in the daemon's runtime
- [credentials in DB](./credentials.md) — secrets accessible via `db.query` from any code in-process
- the harness scenario where one daemon serves many projects

The moment any of those ship, the contract degrades from "structural" to "convention." That's exactly the scenario AGENTS.md ground rule #1 was designed to catch elsewhere.

## Open questions

- **AST-at-registration cost.** Parsing source on every registration is fine for daemon-startup load; if hot-reload of project tools ever lands, this becomes a per-edit cost.
- **Bypass for legitimately-mutable tools.** A custom `git` tool *needs* `child_process`. Whitelist via tool descriptor (`{ requiresProcess: true }`) and surface in tool-registration logs.
- **Lint or runtime guard?** Lint is preferable (caught at registration); runtime guard requires hooking into Bun's module loader. Start with lint.

## What this does not commit to

- **Sandboxing.** That's [project-extensions](./project-extensions.md) territory.
- **Capability-based permissions.** Same — different layer.
- **Replacing the existing lint.** Adds a new surface; doesn't change the in-tree rules.
