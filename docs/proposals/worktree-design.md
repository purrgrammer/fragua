---
title: Worktree design
status: proposed
maturity: sketch
last-reviewed: 2026-05-01
---

# Worktree design

> **Status:** sketch. The current state ships and works, but the model
> has uncomfortable edges — branch GC, paused-run lifetime, parallel
> isolation, user/editor co-occupancy. This doc enumerates them so we
> can pick a direction. Not a commitment to any of the options below.
>
> Sibling: [run-isolation](./run-isolation.md) is the implementation
> proposal for the per-project worktree layout. This doc is the
> *broader* story — what worktrees are for, why the current shape is
> rough, and what we might do.

---

## What worktrees are for in swarm

Each non-ephemeral run gets its own git worktree. This buys us:

1. **Run isolation.** Two concurrent runs against the same project
   never step on each other's `.ts` edits.
2. **Replay reproducibility.** `base_git_sha` is recorded at provision
   time, so a future replay can reconstruct the starting tree even
   after the worktree directory is gone.
3. **Work survival.** When a run terminates with a non-empty
   `git status --porcelain`, dispose preserves it on a
   `swarm/runs/<run_id>` branch — agents commit there, the user can
   review/cherry-pick later.
4. **Editor sanity.** The user can keep editing the project's primary
   working tree while the agent runs.

---

## Current state (what's built today)

| Surface | Where | Behavior |
|---|---|---|
| Provisioner | `packages/daemon/src/worktree-provisioner.ts` | `ensure(runId)` creates the worktree before the first dispatch; `dispose(runId, ctx)` runs at terminal cleanup |
| Layout | `<project>/.swarm/worktrees/<run_id>/` | Sibling of `.swarm/swarm.db` |
| Base sha | `run_state.base_git_sha` | HEAD sha of the worktree at provision time |
| Branch survival | `dispose()` checks `git status --porcelain` | Non-empty → commit to `swarm/runs/<run_id>` and preserve the ref; empty → drop |
| Persisted branch | `run_state.branch` | NULL when clean; populated when preserved |
| Post-terminal fact | `fact.run_branched { branch }` | Emitted AFTER the terminal status fact |
| Run start fact | `fact.run_started { baseGitSha? }` | Carries the provisioned sha |
| Parallel | `component` shape branches share the run's single worktree | Read-only "deliberation only" — `allowed_tools` filter enforced |
| HITL pause | Worktree dir survives across pauses | Reused on resume; same `runId` → same dir |
| Crash recovery | Startup sweep requeues `running` runs | Worktree dir presence is not asserted; provisioner's `ensure` is idempotent |

---

## What's not great

### B1 — No branch GC story

`swarm/runs/<run_id>` refs accumulate forever. After a few weeks of
heavy use, `git branch | wc -l` is a mess. The CLI hint
`swarm gc --branches` exists in code comments but is not implemented.

**Pain.** Every long-running project will hit this within months.

### B2 — Worktree dir lifetime decoupled from branch lifetime

After dispose:
- Working tree had delta → branch preserved, worktree dir... removed?
  kept? (need to verify against `worktree-provisioner.ts`).
- Working tree clean → no branch, worktree dir presumably removed.

Either way, the user has to learn this two-axis matrix to reason
about what's recoverable.

**Pain.** Surprise when "I thought my work was saved" turns into "the
worktree dir got nuked but the branch is fine; you wanted the branch
not the worktree."

### B3 — Paused-run drift

A run goes `paused_hitl` for three days. The user keeps working on
`main`; HEAD moves. The paused run resumes, its worktree is still on
the old `base_git_sha`. The agent's edits will diverge from main when
the user later tries to merge `swarm/runs/<run_id>`.

There's no story for "rebase on resume" or "warn that base is stale."

**Pain.** Long-paused runs land patches against an obsolete tree.

### B4 — Per-branch isolation in `parallel` is missing

The PENDING.md item — branches share the worktree, so a workflow that
wants to "explore 3 candidate patches in parallel and test each one"
can't actually compile/test each branch independently. Branches are
forced to be read-only deliberation.

**Pain.** Cuts off a major use case for parallel.

### B5 — Co-occupancy with the user's editor

Nothing stops a user from opening the run's worktree in VS Code while
the agent is mid-edit. Editor's auto-save vs agent's writes is a race;
agent's git commit may capture the user's half-edit.

**Pain.** Subtle; only bites users who reach for the worktree dir as
a viewing surface (which is natural — it's a real working tree).

### B6 — Crash gap on the dir, not just the DB

Startup sweep requeues `running` rows. But the worktree dir might be
in a half-committed state if the agent crashed mid-`git commit`. The
provisioner's `ensure` is idempotent for "does the dir exist + is it
on the right branch," but not for "is the index clean."

**Pain.** Operator must inspect the worktree manually after a crash;
no automated diagnostic.

### B7 — ARCH §0 says "no filesystem coordination"

> "No filesystem coordination (JSONL, checkpoint files, `fs.watch`,
> unix sockets)."

Worktrees are filesystem state per run. They're not coordination
*between processes* (only the daemon writes), so the rule isn't
violated in spirit. But it's worth being explicit: worktrees are
output, not coordination.

**Pain.** Conceptual clarity, not behavior.

### B8 — Disk pressure

Big project, dozens of preserved worktrees, each with `node_modules` /
build artefacts. `du -sh .swarm/worktrees/` becomes a bigger number
than the actual repo.

**Pain.** Real cost on machines without much disk.

---

## Open questions

1. **Should preserve-on-delta be the default, or opt-in?** Preserve-by-default
   is what we have. Operators who don't want the branch noise can't easily
   opt out. A `routing.preserve_branch=false` flag would let workflows pick.
2. **GC policy.** Time-based (`older than 30d`)? Count-based (`keep last 50`)?
   Status-based (`only failed`)?
3. **Stale-base detection.** On resume from a multi-day pause, do we
   `git fetch && git rebase`? `warn but proceed`? `halt with reason`?
4. **Per-branch parallel isolation.** Spawn a worktree per branch
   (cost: filesystem fanout) vs. virtualize via git's index trickery
   (cost: complexity). Which?
5. **Editor conflict.** Detect (lockfile? `fs.watch` for external
   writes?), or accept and document?

---

## Possible directions (NOT commitments)

These are mutually exclusive sketches; pick one or none.

### D1 — Ephemeral by default, preserve on opt-in

Worktrees and their branches are deleted on dispose unless the
workflow opts in (`routing.preserve_branch=true`, or a node attr).
Cuts B1 / B8 in one stroke; loses B-side work survival for users who
forget to opt in.

### D2 — Keep current default, add explicit GC

`swarm gc --branches --older-than 30d --status failed`. Solves B1
without changing the semantic. Doesn't address B3 / B4 / B5.

### D3 — Worktree-per-branch in parallel, behind a `regime` attr

```dot
explore [
  shape  = component
  regime = "build"   // vs. default "deliberation"
]
```

`build` regime spawns a worktree per branch under
`.swarm/worktrees/<run_id>/<branch_id>/`, dispose merges or discards.
Solves B4. Increases the surface area of B1 / B8 unless paired with D1.

### D4 — Tighter resume semantics: rebase-on-wake

On resume from `paused_hitl` / `paused_provider_error`, the executor
emits a `worktree.rebased` observability event after either rebasing
the worktree onto current `main` (clean tree) or warning + skipping
(dirty tree). Solves B3 partially; doesn't solve B6.

---

## Recommendation (working assumption, low-conviction)

D2 + D4 short-term: keep the current model, add `swarm gc --branches`
and rebase-on-wake. Defer D1 / D3 until we feel the pain harder. This
keeps blast radius small while removing the loudest annoyances (B1,
B3).

Open to redirection. The real question is whether D3 (parallel-build)
is worth the complexity given how rarely "explore N candidate patches
in parallel" actually shows up in real workflows.
