# swarm — pending work

> Known gaps in the implementation. Each item names a current behavior
> and the gap that would close it. Companion to [`SPEC.md`](./SPEC.md)
> (contract) and [`ARCHITECTURE.md`](./ARCHITECTURE.md) (design).
>
> Items in `ARCHITECTURE.md` §13 ("Deferred decisions") are explicit
> non-goals — listed there, not here. This file is for things we *want*
> to do.

## Per-node provider preflight

`POST /runs` checks that the daemon has *some* provider API key set,
not that the specific provider pinned on each `node.attrs.provider` is
reachable. A workflow that hardcodes an unconfigured provider fails at
dispatch (visible via `fact.run_halted`), not at enqueue.

Closing this means folding a per-node provider×credential check into
the enqueue path so misconfigured workflows fail loud, fast, and at
the surface that submitted them.

## Multi-worktree parallel branches

`parallel` (component shape) is v1 "deliberation-only" (regime C):
branches deep-clone routing but share the run's worktree. HITL inside a
parallel branch is coerced to `fail`. Branches that need write
isolation (e.g. each branch builds + tests a candidate patch) need
per-branch worktrees.

Closing this means extending `WorktreeProvisioner` to vend
sub-environments keyed by `(runId, branchId)` and threading the branch
id through `HandlerContext`.

## LLM-evaluated `parallel.fan_in`

`fan-in.ts` ships with a heuristic ranker (attractor §4.9). The
`prompt`-set branch — where the consolidator node uses an LLM to
score-and-pick across branch results — is wired in the spec but not
yet executed by `auto-dispatcher.ts`.

## Auto-retry for retryable provider errors

`fact.run_paused_provider_error` pauses the run on every transport
failure (402, 429, 503, network). 429 / 503 are retryable in
principle and could resume automatically with capped backoff. v1
chose manual-only because an automatic retry storm against a busted
account is worse than waiting for a human; the fact + intent shape
already supports adding the auto-path without a schema change.
