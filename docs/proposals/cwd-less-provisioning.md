---
title: Worktree provisioner falls back to the daemon's own cwd for cwd-less runs
summary: "A run with no `run_state.cwd` (an imported run, or an API enqueue without cwd) is provisioned against the daemon's OWN startup directory (`process.cwd()`), so it executes in the operator's checkout rather than failing cleanly. Surfaced by run-bundle import; imports are now safe (neutralized to `cancelled`), so the remaining exposure is non-import cwd-less runnable runs. Fix is a small daemon change + a verification, tracked for its own PR."
status: bug
maturity: triaged
last-reviewed: 2026-05-26
parent: db-import.md
---

# cwd-less provisioning falls back to the daemon's own dir

> Status: **tracked for a separate PR.** Surfaced while building run-bundle
> import; not fixed on the `run-bundle-import` branch (different blast radius).

## The bug

The worktree provisioner resolves a run with no cwd to the daemon's **own
startup directory**:

- `packages/daemon/src/worktree-provisioner.ts`
  - `this.repoRoot = opts.repoRoot ?? process.cwd()` (constructor)
  - `const repoRoot = provisionOpts.cwd ?? this.repoRoot` (`create()`)
- `packages/daemon/src/executor.ts` — `if (state.cwd != null) provisionOpts.cwd = state.cwd;`
  (omits cwd entirely when `state.cwd == null`).

So when a **runnable** run has `run_state.cwd == null`, `create()` provisions a
worktree (or a `LocalEnvironment`) rooted at the daemon's `process.cwd()` — the
arbitrary directory the operator happened to launch `fragua harness` from,
typically their own project checkout. The run's tools/commits then land in that
repo. This contradicts the provisioner's own documented contract ("non-git cwds
get a `LocalEnvironment` rooted at the run's own cwd, **not** at the daemon's
startup pwd … keeps the daemon startable from anywhere while still honouring
each run's cwd").

## Scope / current exposure

- **Imports are NOT exposed.** `importRunBundle` neutralizes a non-terminal
  status to `cancelled` (db-import §4), so an imported run is never claimed or
  resumed → never reaches provisioning.
- **`accept` / `discard` / `diff` are NOT exposed.** `run-actions.ts` gates on
  `cwd == null` and refuses with `no_worktree`.
- **Remaining exposure:** a non-import **runnable** cwd-less run. In practice
  `fragua run` always sets `cwd` and the web requires it; the reachable path is
  an API `POST /runs` carrying `workflowSha` with no `cwd`. Narrow, but real —
  such a run would execute in the daemon's startup dir instead of failing.

## Fix

In `create()` (or at the executor seam), when there is no run cwd, **fail
provisioning** with a clear error instead of falling back to `this.repoRoot`.
The executor already converts a provision failure into a clean
`fact.run_halted{reason:"error", detail:"worktree_provision_failed: …"}`, so the
run halts safely rather than running in the wrong place.

```ts
// worktree-provisioner.ts create()
const repoRoot = provisionOpts.cwd;
if (repoRoot == null) {
  throw new Error("run has no cwd; cannot provision a worktree (specify cwd at enqueue)");
}
```

## Verify before landing

1. Confirm `fragua ci` / `buildExecutorDeps` does not rely on the cwd-less →
   `repoRoot` fallback (ci builds its own executor deps; check whether its runs
   carry a cwd or depend on the provisioner default).
2. Confirm no legitimate client enqueues a runnable cwd-less run expecting the
   "daemon home project" behaviour; if that behaviour is wanted, it should be an
   explicit, named default rather than `process.cwd()`.
3. Add a daemon test: a queued run with `cwd == null` halts with a clear
   provision error and never touches the daemon's working directory.
