---
title: Project config file
summary: "<project>/.swarm/config.yaml"
status: shipped
maturity: specified
last-reviewed: 2026-05-01
---

# Project config file

> Project-scoped only. Cascading global config (`~/.swarm/config.yaml`)
> is still part of the [harness](./harness.md) subproject.

## What landed

`<project>/.swarm/config.yaml` — the single config + identity file:

```jsonc
{
  "version": 1,
  "id": "019de01e-5ccd-7010-9184-defb237e74db",   // UUIDv7 minted by `swarm init`
  "name": "swarm",
  "bootstrap": "bun install --frozen-lockfile",
  "defaults": { "provider": "ppq", "model": "claude-sonnet-4.6", /* … */ },
  "autoTitle": true,
  "blocklist": [ /* … */ ]
  // every existing knob from the YAML predecessor, camelCased
}
```

- **Filename**: `config.yaml` (not `swarm.jsonc` from the original
  proposal — `swarm` is already the directory prefix; doubling it
  added no signal).
- **Format**: JSONC via `jsonc-parser@3.3.1` (pinned). Comments + trailing
  commas, no Norway problem, predictable parsing.
- **Naming**: every key camelCase. The legacy `auto_title: on` Norway-trap
  is now `"autoTitle": true`.
- **Validation**: TypeBox schemas in `packages/cli/src/config.ts` —
  `additionalProperties: false` so typos throw at load time instead of
  silently mis-routing.
- **Identity**: `id` is a UUIDv7 (sortable, RFC 9562, no dep — 10-line
  helper in `@swarm/core/uuid`). `name` is advisory (display only;
  routing always keys on `id`).

`swarm init`:

- mints the UUIDv7
- writes `.swarm/config.yaml`
- creates `.swarm/workflows/`
- idempotently merges runtime patterns into `.gitignore`
- pre-registers the project in the daemon's `projects` display cache
  (opens / creates `.swarm/swarm.db` and calls `upsertProject`) so the
  project shows up in `swarm projects ls` / the UI immediately,
  without waiting for first run
- hard-fails on non-git directories (with hint to run `git init`)
- refuses to re-init when `.swarm/config.yaml` is reachable from `HEAD`

`enqueueRun` UPSERTs the same row (last-runner wins) so the cache
re-syncs on every run — init's pre-registration is a fast-path for
post-init UX, not a correctness requirement.

## Deliberate cuts vs the original proposal

| Item | Decision | Why |
|---|---|---|
| Migration framework for the config schema | Cut | Pre-release; no DB to migrate. Write v1, ship v1. |
| `$schema` URL field | Cut | `swarm.dev` doesn't exist. Workspace settings + JSON Schema generation are deferred until there's a hosting story. |
| `swarm config show --origin` | Deferred | Tautological with one config file. Useful when the global cascade lands. |
| Interactive `git init` prompt | Simplified | Hard-fails with a one-line tip instead. "Magic init breaks reproducibility" — the proposal's own argument applied to the prompt itself. |
| `concurrency.perProject` | Cut | Premature; the existing `concurrency` (top-level integer) covers the v0 daemon. The nested form lands when there's an actual per-project knob to differentiate from a global one. |

## Additions beyond the proposal

These weren't in the original v0 but landed in the same arc:

- **`projects` display cache** (table + `Project` type in `@swarm/types`,
  `listProjects` / `getProject` / `upsertProject` on `IEventStore`).
  UPSERT on every `POST /runs` keyed off the request body's
  `projectId` + `projectName` + `projectRoot`. Last-runner wins. Load-bearing
  for UI labels under the eventual harness — a daemon serving many
  projects can't read every clone's `config.yaml`.
- **Workflow directory resolution** (`.swarm/workflows/<name>.dot` glob
  via bare-name) shipped as a paired ship with `swarm run` and
  `swarm validate`. See [workflow-resolution](./workflow-resolution.md).
- **Run wiring** (`run_state.project_id` column populated end-to-end
  from CLI → server → store, on every `enqueueRun`).

## Init policy

`swarm init` on a non-git directory hard-fails. Templates are below.

`.gitignore` block (idempotently merged into existing `.gitignore`):

```
# swarm runtime — never commit these
.swarm/runs/
.swarm/worktrees/
.swarm/swarm.db*
.swarm/daemon/
.swarm/credentials.jsonc
.swarm/serve.json

# swarm — always commit these (negative patterns for clarity)
!.swarm/config.yaml
!.swarm/workflows/
```

## What this does not commit to

Still deferred (now part of the [harness](./harness.md) subproject):

- `~/.swarm/config.yaml` (global file).
- Credentials block — the [credentials](./credentials.md) subproject.
- Cascading semantics. `swarm config show --origin` lands with the cascade.
- JSON Schema served at a public URL for editor IntelliSense — local
  workspace settings are the v0 fallback.
