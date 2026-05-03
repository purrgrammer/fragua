---
title: Project config extensions
status: deferred
maturity: sketch
last-reviewed: 2026-05-03
---

# Project config extensions

> Deferred. In the harness-by-default model, projects are emergent —
> any directory `swarm run` has executed in shows up under the global
> daemon's purview. There's no `swarm init`-style enrollment for new
> users, no `<project>/.swarm/config.jsonc` minted by default, and so
> no per-project knobs to override.
>
> The shipped [project-config](./project-config.md) file remains
> readable for repos that already initialised one (notably the swarm
> repo itself). It just isn't extended.

## What's project-local today

- `config.bootstrap` — the per-worktree shell command (`bun install
  --frozen-lockfile`, `pnpm install`, `pip install -r requirements.txt`,
  …). Project-specific by nature: the command depends on the project's
  stack. Stays in `<project>/.swarm/config.jsonc`.

## What's global

`~/.swarm/config.jsonc` is the user-preference layer. Project config
overlays it; project keys win, nested objects merge one level deep.

- `defaults.{llm_provider, llm_model, permissions, summariser}` — LLM
  + permission preferences.
- `autoTitle`, `blocklist`, `concurrency`, `maxLoops`,
  `maxQueuedRuns`, `abortLoopCeiling`, `maxLeakedHandlers`.
- `blobGc`, `skills`, `timeouts` — daemon behavior.

## What's NOT happening for now

- Per-project LLM defaults (`defaults.llm_provider` /
  `defaults.llm_model`). Global-only.
- Per-project summariser config. Global-only.
- Per-project blocklist. Global-only.
- Per-project `autoTitle` toggle. Global-only.
- Per-project concurrency. Global-only.
- Per-project workflows directory (`<project>/.swarm/workflows/`).
  See [workflow-resolution](./workflow-resolution.md).

## When this becomes load-bearing

- Project A wants different LLM defaults than project B (e.g., OSS
  contributor's repo on a free model vs. work repo on Anthropic).
- Bootstrap commands diverge (different node/bun/python versions
  per repo).
- Concurrency fairness needs per-project caps.

At that point, the cascade resolves at run-provision time: project
config layered over global config.

## Two paths, when the time comes

Path → JSONC mapping is awkward without an enrollment step. Two
options:

1. **Mint a UUID on first `swarm init` and key project config off
   that.** Same as the shipped behavior. Predictable. Adds an
   enrollment step.
2. **Path-keyed config in the global DB** (`project_config` table:
   `cwd → JSONB`). No file in the project repo. No enrollment.
   Brittle on path changes (rename, symlink); overrides aren't
   visible in the project's git history.

Option 1 is the safer default when this returns. Option 2 is
interesting but trades file-based ergonomics for none-ness.

## Why not now

Path-only emergent projects cover the single-user-laptop case. The
config knobs above are real but not blocking. Wait for the second
project that actually needs different defaults; let the use case
force the design.
