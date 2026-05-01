---
title: Project tools, hooks, skills
status: proposed
maturity: sketch
last-reviewed: 2026-05-01
---

# Project tools, hooks, skills

> The biggest trust-boundary risk in the globalization plan. Cannot
> ship until the [credentials threat model](./credentials.md) is
> resolved — a malicious project hook running in the daemon's address
> space can read every other project's secrets.

## Shape

Three categories with three trust models:

| Category | Location | Trust |
|---|---|---|
| Built-in tools | shipped with swarm | high (audited) |
| Project tools | `<project>/.swarm/tools/*.ts` | medium (committed code) |
| Project hooks | `<project>/.swarm/hooks/{pre,post}-*.ts` | medium (committed code) |
| Skills (cascading) | `~/.swarm/skills/`, `<project>/.agents/skills/` | text-only |

Project tools and hooks are loaded from disk and run in **the daemon's
Bun runtime**.

Hooks fire as side effects of fact events, not inside reducers.
Reducer purity (I3, I8) preserved.

Tools route I/O through `ctx`, like built-in handlers. The discipline
test that forbids bare `fetch` / `node:child_process` in built-in
handlers extends to project tools at load time (warn on first
detection, deny on subsequent calls).

## The trust boundary problem

"Trust like git hooks" works when the daemon is single-project. Under
the harness, the daemon is `~/.swarm/`-scoped: a malicious project's
hook can read every other project's events, messages, blobs, and
[decrypt provider credentials](./credentials.md). The blast radius is
the entire machine, not the project the user opted into.

The discipline test catches *accidental* `fetch` / `child_process`. It
does not catch malicious code that imports `bun:sqlite`, opens
`~/.swarm/swarm.db`, and exfiltrates everything.

## Open questions

- **Sandbox model**: worker-process isolation, deno-style permissions,
  `--no-tools` mode? Trade-offs in IPC overhead vs. safety.
- **Network egress**: explicit `tools.networkAllowed` flag in project
  config? Default deny, opt-in per project?
- **Cross-project read access**: should tools see *only* their own
  project's `~/.swarm/` data? If so, the daemon enforces, not the
  filesystem.

## Replay determinism

Once project extensions exist, `workflow_sha` alone is not enough. The
runs table's `project_context_sha` (added with [schema
additions](./schema-additions.md)) gets populated: sha256 of the
project's tools + hooks + skills tree at run start. Replay refuses (or
loud-warns) if the current tree disagrees.

This is the load-bearing reason `project_context_sha` lands in the
schema *now*, not when this subproject ships. Impossible to retrofit.

## Skills cascade

Local-only first: `<project>/.agents/skills/`. The
`~/.swarm/skills/` cascade introduces merge semantics and conflict
rules that are easy to get wrong. Ship the cascade once the merge rule
has soaked.

## What this does not commit to

- Memory system and the `memory.*` built-in tool. Picked implementation
  deferred.
- Pluggable memory backends. Build one before extracting an interface.
- Global user tools at `~/.swarm/tools/`. Cross-project blast radius;
  postponed.
