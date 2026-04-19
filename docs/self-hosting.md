# Self-hosting

swarm can implement its own new features. To drive a feature change through the harness:

```sh
# Default: Claude Haiku via ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY=sk-...
bun run packages/cli/bin/swarm.ts run workflows/build-feature.dot \
  --input="add a local:list_dir tool that lists files in a directory"

# OpenRouter (one key → 300+ models across every major provider)
export OPENROUTER_API_KEY=sk-or-...
bun run packages/cli/bin/swarm.ts run workflows/build-feature.dot \
  --provider openrouter --model "anthropic/claude-opus-4.7" \
  --input="..."

# Any of: openai, google, groq, cerebras, xai, mistral, vercel-ai-gateway,
# github-copilot, amazon-bedrock, google-vertex — see `swarm providers`.

# Replay the run afterwards
bun run packages/cli/bin/swarm.ts replay .swarm/runs/<id>/events.jsonl
```

## Abort contract

If an agent-backed node decides its task is unreachable (missing target, contradictory constraints, external blocker) it emits `<abort>short reason</abort>` in its final message. The backend turns that into a non-retryable `fail` outcome; workflows wire `condition="outcome=fail"` edges to terminate the run immediately instead of forwarding to downstream no-op steps. See `docs/SPEC.md §3.7`.

## Worktree isolation

`--worktree` spawns a git worktree under `.swarm/worktrees/<run-id>/` on a branch named `swarm/<run-id>`. The agent runs entirely inside it; your working copy and current branch stay untouched. On success, `git checkout swarm/<run-id>` to review + merge; on failure (or always if you want post-mortem access) add `--keep-worktree`:

```sh
bun run packages/cli/bin/swarm.ts run workflows/add-tool.dot \
  --input="add local:touch tool" \
  --worktree
```

Each worktree is a clean checkout: no symlinks, no shared `node_modules`. To prepare dependencies the project declares a bootstrap command in `.swarm/config.yaml`:

```yaml
project:
  bootstrap: "bun install --frozen-lockfile"   # swarm itself
  # or: bootstrap: "pnpm install"
  # or: bootstrap: "pip install -r requirements.txt"
  # or: bootstrap: "./scripts/bootstrap.sh"
  # or: (omitted — source-only projects skip the install step)
```

The command runs inside the fresh worktree after `git worktree add` and before the first node fires. Non-zero exit fails the run. This is stack-agnostic by design — swarm makes no assumptions about bun, npm, or any package manager.

Concurrent runs are fully isolated: each gets its own `node_modules` (or equivalent), so `bun install` / `pnpm install` in one worktree can't mutate another's state.

The agent's system prompt always starts with a `<run-environment>` block listing the worktree path, run id, log dir, and whether the bootstrap command ran — so agents don't need to introspect their cwd.

## Flagship workflow

`workflows/build-feature.dot` — explore → plan → implement_and_review → verify → update_docs → commit → merge. The final `merge` node rebases the worktree branch onto main and fast-forwards main via a compare-and-swap on `refs/heads/main`, so concurrent parallel runs serialize safely (loser re-rebases). Skips cleanly when the run is not inside a linked worktree (i.e. you invoked without `--worktree`).

Related: `.swarm/config.yaml` — per-project defaults + workflow shortcuts.
