---
title: Run isolation via worktrees
status: shipped
maturity: specified
last-reviewed: 2026-05-06
---

# Run isolation via worktrees

> Per-project worktrees today (`<project>/.swarm/worktrees/<run_id>`);
> the global `~/.swarm/worktrees/` location lands with the
> [harness](./harness.md). See
> [worktree-design](./worktree-design.md) for the broader story —
> this proposal covers what's in the tree today and the GC contract
> still owed.

## What landed

- `WorktreeProvisioner.ensure` / `dispose`
  (`packages/daemon/src/worktree-provisioner.ts`).
- Branch survival on dispose when the worktree has any working-copy
  delta.
- `fact.run_branched` emitted post-terminal so the branch name is
  recoverable from the event log.
- `run_state.base_git_sha` and `run_state.branch` columns.

## Outstanding

All scope owned by this proposal has shipped. Branch GC landed as
`swarm gc --branches` (`packages/cli/src/commands/gc.ts`) with the
30-day default retention contract specified below.

The broader design questions — paused-run base-drift, per-branch
isolation in `parallel` nodes, editor co-occupancy — are owned by
[worktree-design](./worktree-design.md), which catalogues the open
trade-offs without committing to a direction.

## Shape

Every non-ephemeral run gets its own git worktree under
`<project>/.swarm/worktrees/<run_id>`. Sibling-of-`.swarm/`-state,
gitignored by the [project config](./project-config.md) `.gitignore`
template.

Provisioning:

1. `git worktree add .swarm/worktrees/<run_id> <ref>`
2. Capture `git rev-parse HEAD` → `run_state.base_git_sha`
3. Run the project's bootstrap command (`config.jsonc` `bootstrap` field), if any.
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
