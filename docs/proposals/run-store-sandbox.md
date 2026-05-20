---
title: Run store sandbox
status: proposed
maturity: sketch
last-reviewed: 2026-05-20
---

# Run store sandbox

> A daemon-provisioned run executes in an isolated worktree but its node
> bodies can still reach the operator's **global coordination store**
> `~/.swarm/swarm.db`. A run implementing a schema migration ran a
> store-opening command against it, migrating the live DB ahead of the
> running harness (db v15 vs code v14) and refusing the next harness
> bind. Prompt guards (`work.yaml` SANDBOX rule) are a band-aid; this is
> the environment-level fix: make the *unsafe* path impossible, not
> merely discouraged.

---

## Why now

The incident: a `work` run tasked with the worktrees schema migration
(step 1 of `worktrees.md`) opened `~/.swarm/swarm.db` from inside its
worktree — via a store-opening `swarm` command or a test on the default
path — and its v15 migration ran against the live store. The running
harness (v14 code) then refused to bind the now-v15 DB
(`schema downgrade refused`), wedging the operator. Recovery required
hand-reversing the migration on the live DB.

Root cause is structural, not a one-off: **the default store path is the
global one**, so the natural thing an agent does while building store
code (`bun run swarm …`, a migration test) hits the operator's live
state. The prompt can ask it not to; it can't *prevent* it.

## Threat model

Accident, not adversary. We are not defending against a run with
arbitrary code execution deciding to corrupt the store — that's out of
scope. We are removing a foot-gun that any well-meaning run can step on:

- **Schema drift** — a migration bumps the live DB ahead of the running
  harness → bind refused (the incident).
- **State pollution** — stray writes / test fixtures land in the
  operator's run history.
- **Cross-run leakage** — a run reading the global store sees every
  other run's state.

## Goals / non-goals

**Goals:**
- A run's node bodies cannot read or write the operator's global
  coordination store.
- The safe default (a per-run throwaway) requires no agent cooperation.
- Defense in depth: env redirection *plus* a hard refusal backstop.

**Non-goals:**
- A general filesystem jail (this is store isolation only).
- Defending against malicious arbitrary-exec runs.
- Changing how the harness/daemon process itself opens the store.

## Mechanism

Two layers.

1. **`SWARM_DB` env override + per-run injection.** Add a `SWARM_DB`
   env var honored by store-path default resolution (the CLI `--db`
   fallback and the store constructor's default). `WorktreeEnvironment`
   injects, into the base env of every `exec()` it runs,
   `SWARM_DB=<worktree>/.swarm/sandbox.db` and `SWARM_SANDBOX=1`. Any
   `swarm` invocation or store-open a node body spawns then resolves to
   the throwaway sandbox, never the global store. The sandbox DB is
   created + migrated fresh on first open and dies with the worktree.

2. **Hard guard (backstop).** When `SWARM_SANDBOX=1`, store-open
   **refuses** to open a known coordination-store path
   (`~/.swarm/swarm.db`, or the CI-primitive `<project>/.swarm/swarm.db`)
   and throws `SandboxViolation` with a clear message. This catches what
   the env default can't: an explicit `--db ~/.swarm/swarm.db`, a
   hard-coded test path, or library code that opens the default
   directly.

The harness/daemon process never sets `SWARM_SANDBOX`, so it opens the
global store normally — only *spawned node-body processes* carry the
flag.

## Where it's enforced

- **Store-path default resolution** (`packages/cli/bin/swarm.ts` `--db`
  fallback + the store constructor default): read `SWARM_DB` when no
  explicit path is given.
- **`packages/workspace/src/worktree-env.ts`** (`WorktreeEnvironment.exec`):
  merge `{ SWARM_DB, SWARM_SANDBOX: "1" }` into the child env. Single
  injection point — covers the `bash` tool, `swarm` CLI, and test
  runners launched inside the run.
- **Store open** (`packages/store`): if `SWARM_SANDBOX === "1"` and the
  resolved path is a known coordination-store path, throw
  `SandboxViolation`.

## Where it falls down

- **In-process opens.** Sub-agents run inline in the daemon process and
  don't inherit the child env — but they're LLM calls that never open
  the coordination store. The guard targets spawned processes, which is
  where the risk is.
- **`bun run ci` inside a run.** A test that opens the default path now
  fails loudly with `SandboxViolation` instead of silently corrupting
  the global DB — *desired*; it surfaces the bad test.
- **Legit swarm-on-swarm** (meta workflows that drive swarm). They must
  pass an explicit sandbox `--db`; the guard refuses only the known
  coordination paths, so a temp path is fine.
- Not a general FS jail — a run can still read/write other files.

## Implementation order

1. `SWARM_DB` honored by store-path default resolution (CLI + store
   constructor). Unit tests.
2. `SWARM_SANDBOX` hard guard in store open; unit test that it refuses a
   coordination-store path under sandbox and allows a temp path.
3. `WorktreeEnvironment.exec` injects the sandbox env; sandbox DB
   lifecycle (fresh create + migrate, disposed with the worktree).
4. Same-PR: an `AGENTS.md` ground-rule note (runs never touch the global
   store); relax the `work.yaml` SANDBOX prompt rule to a backstop
   comment once the env guard lands.

## Open questions

- **Sandbox DB location.** `<worktree>/.swarm/sandbox.db` (self-cleaning,
  visible for debugging) vs an out-of-worktree `mktemp`. Lean
  in-worktree, but then `worktrees.md` snapshots must skip it (it's
  churn, not deliverable) — add to the snapshot ignore set.
- **Guard scope: prefix vs denylist.** "Refuse anything not under the
  worktree" is stricter but may block legit `/tmp` use; "refuse the
  known coordination paths" is targeted. Lean denylist for v1.
- **Interaction with `worktrees.md`.** The sandbox DB is a worktree
  file; ensure the snapshotter excludes it (`.gitignore` or
  `snapshot_max_blob_bytes`/skip-list).
