# Git-object file server

> **Status:** DESIGN. Aspirational. Defer until the multi-project view
> exists; path-walking reads are fine until then.

## Shape

The harness exposes content-addressed file reads; the daemon never
walks filesystems for the UI:

```
GET /api/projects/:id/tree/:ref/*path     # ref ∈ sha | branch | "WORKTREE" | "BASE"
GET /api/projects/:id/blob/:sha           # raw blob, immutable, cacheable forever
GET /api/projects/:id/diff/:from/:to      # patch
```

`WORKTREE` resolves to the run's worktree state at the requested time
(uses `git ls-files` + index overlay). `BASE` resolves per-run to
`base_git_sha`. Both are virtual refs; their resolution lives in the
server, not git.

Implementation: one long-lived `git cat-file --batch` process per
project, lazily started.

## What this gives

- `.gitignore` honored without a separate config layer.
- Blob URL never invalidates — perfect HTTP caching.
- Run views survive worktree dispose (the SHAs are still reachable via
  `swarm/runs/<id>`).
- LFS pointers visible as pointers; UI decides whether to resolve.

## Why defer

This is the most ambitious piece of the proposal and the one with the
weakest UX urgency. Today's path-walking reads work. The replacement
becomes valuable only once:

- Multiple projects exist (so cross-project caching matters).
- Worktrees dispose routinely (so SHAs outlive directories).
- The UI does meaningful diff/blob fetches (so `cat-file --batch`
  amortizes).

None of those conditions are true on the current per-cwd model. Land
the [harness](./harness.md) and [run isolation](./run-isolation.md)
and let the use case force the design.

## What this depends on

- [Harness](./harness.md) (the file server is a harness endpoint).
- [Run isolation](./run-isolation.md) for `base_git_sha` and the
  `swarm/runs/<id>` namespace.

## Open questions

- LFS handling: pointer-passthrough vs. resolution policy?
- Permission model for the API. Today's discovery-token gates
  everything. Per-project tokens? Read-only tokens?
- Multi-repo projects (submodules, monorepos). Subpath dispatch is a
  workflow-input concern, but the file server has to traverse them.
