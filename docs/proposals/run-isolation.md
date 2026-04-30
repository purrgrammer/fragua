# Run isolation via worktrees

> **Status:** READY. Per-project worktrees today; the global
> `~/.swarm/worktrees/` location lands with the
> [harness](./harness.md).

## What lands

Every non-ephemeral run gets its own git worktree under
`<project>/.swarm/worktrees/<run_id>`. Sibling-of-`.swarm/`-state,
gitignored by the [project config](./project-config.md) `.gitignore`
template.

Provisioning:

1. `git worktree add .swarm/worktrees/<run_id> <ref>`
2. Capture `git rev-parse HEAD` → `run_state.base_git_sha`
3. Run the project's bootstrap command (`swarm.jsonc` field), if any.
4. Handlers execute against the worktree as `cwd`.

Dispose, on terminal status:

1. `git status --porcelain` in the worktree — if empty, drop the
   worktree, no branch.
2. Else, `git checkout -b swarm/runs/<run_id>` and commit any working
   changes (tracked + untracked); record the branch name on the run.
3. `git worktree remove --force <path>`. Branch persists in the repo.
4. Never `git push`. Local branches only.

## Cleanup contract

Branch-on-dispose creates `refs/heads/swarm/runs/*`. Without cleanup,
this becomes a forest. **Ship the GC alongside, not later**:

```
swarm gc --branches [--older-than <duration>] [--dry-run]
```

Default retention: 30 days. Opt-in (no automatic GC fiber in v0). The
30-day default is the contract — long enough for review, short enough
that "I'll deal with it later" doesn't accumulate.

Without this, branch-on-dispose is a feature whose primary effect after
six weeks is git ref clutter.

## Untracked-files semantics

`git diff --quiet` only checks tracked changes. A run that scattered
tmp files into the worktree would dispose without a branch, leaking the
files into the dispose path's `git worktree remove --force`. Use
`git status --porcelain` so any working-copy delta — tracked or
untracked — produces a branch with the files committed.

This prevents "where did my debug script go" footguns at the cost of
slightly more branch churn for runs that left junk behind.

## Replay

`base_git_sha` lets replay reconstruct the worktree state at run start
even if the worktree directory is long gone. Replay refuses (or
loud-warns) if the SHA is unreachable from `HEAD` and the
`swarm/runs/<run_id>` branch was GC'd.

## What this does not commit to

- `~/.swarm/worktrees/<project_id>/<run_id>` global location. Same
  property; different path. Forward-compatible move when the harness
  lands.
- Automatic GC. Opt-in CLI only.
