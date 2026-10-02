// WorktreeProvisioner — maps runId → ExecutionEnvironment.
//
// The executor calls `ensure(runId)` before dispatching the run's first
// node. On success, every turn's HandlerContext carries the same env
// so handlers + agents operate inside an isolated `git worktree` on a
// detached HEAD. On terminal status, the executor calls `dispose(runId)`
// to remove the worktree.
//
// Design points:
//
//   - The provisioner owns the `Map<runId, ExecutionEnvironment>`; the
//     executor doesn't hold state. That keeps the executor testable
//     with a stub provisioner and lets a future multi-executor daemon
//     share a single map.
//   - `ensure` is idempotent: the same runId returns the same env.
//     After a daemon crash the map restarts empty, so the provisioner
//     hands `WorktreeEnvironment.init()` the resume-aware path (see
//     the comment there) — re-initialising reuses an existing worktree
//     rather than failing on `git worktree add`.
//   - Failure mode: `ensure` throws when `init()` rejects. The executor
//     catches and emits a `fact.run_terminated{errored}` with `reason=error`,
//     `detail=worktree_provision_failed: ...`. The run can be
//     inspected via intent.unquarantine or manually cleaned up.
//   - Dispose uses `WorktreeEnvironment.dispose()` which is a best-
//     effort cleanup: it tolerates an already-removed worktree (e.g.
//     removed out of band).
//   - Per-run worktree-vs-local fallback: the daemon serves runs from
//     many cwds. `create()` checks `isGitRepo(<run cwd>)` per run;
//     non-git cwds get a `LocalEnvironment` rooted at the run's own
//     cwd, not at the daemon's startup pwd. That keeps the daemon
//     startable from anywhere while still honouring each run's cwd.

import { spawn } from "node:child_process";
import type { ExecutionEnvironment } from "@fragua/core";
import { type BootstrapSpec, LocalEnvironment, WorktreeEnvironment } from "@fragua/workspace";
import { captureSnapshot, resolveSnapshotParent, type SnapshotBoundary, type SnapshotResult } from "./snapshotter.ts";

/** Bootstrap pair resolved for a single run against its project root.
 * Used to honour `<run.cwd>/.fragua/config.yaml` when a single daemon
 * serves runs from many projects. */
export interface ResolvedRunBootstrap {
  bootstrap?: BootstrapSpec;
  bootstrapTimeoutMs?: number;
}

/** Env allow-list pair resolved for a single run against its project root.
 * Mirrors `ResolvedRunBootstrap`: lets one daemon apply each project's own
 * `bash.env-passthrough` (merged over global) to the runs it serves, instead
 * of a single allow-list fixed at daemon-launch cwd. `names` is the operator/CI
 * allow-list ADDITIONS on top of the built-in baseline (PATH/HOME/…). */
export interface ResolvedRunEnvAllow {
  names?: ReadonlySet<string>;
  predicate?: (name: string) => boolean;
}

export interface WorktreeProvisionerOptions {
  /** Shell command (or callback) run inside each fresh worktree before
   * the first node fires. Missing = no-op.
   *
   * Used only when no `resolveRunBootstrap` is supplied (e.g. tests
   * bypassing the CLI wiring). The CLI path passes a resolver and
   * leaves this unset — bootstrap is then **project-local or
   * nothing**: read from `<run.cwd>/.fragua/config.yaml` for each
   * fresh worktree, with no daemon-startup-cwd fallback. */
  bootstrap?: BootstrapSpec;
  /** Directory (relative to each run's cwd) where worktrees live. Default
   * `.fragua/worktrees`. Each run gets a `<worktreesDir>/<run-id>` dir. */
  worktreesDir?: string;
  /** Keep worktrees around after dispose — useful for post-mortems.
   * Default false. */
  keepAfterDispose?: boolean;
  /** Override factory for tests — produces an `ExecutionEnvironment`
   * given a runId. Short-circuits the real git-worktree path. */
  factory?: (runId: string) => Promise<ExecutionEnvironment>;
  /** Forward into each fresh worktree as `bootstrapTimeoutMs`. Used
   * only when no `resolveRunBootstrap` is supplied — same back-compat
   * caveat as `bootstrap`. */
  bootstrapTimeoutMs?: number;
  /** Forward into each fresh worktree's LocalEnvironment as
   * `defaultTimeoutMs` — used when a handler's shell call doesn't
   * pass its own `timeoutMs`. */
  defaultShellTimeoutMs?: number;
  /** Resolve per-run bootstrap config against the run's project root.
   * Called once per fresh worktree right before `WorktreeEnvironment`
   * is constructed. Authoritative when set: its return value is used
   * verbatim, with no fallback to the constructor `bootstrap` /
   * `bootstrapTimeoutMs`. Returning `{}` means "no bootstrap" for
   * this run. Lets one daemon honour `<project>/.fragua/config.yaml`
   * for runs from many projects, with no global default leaking in. */
  resolveRunBootstrap?: (cwd: string) => Promise<ResolvedRunBootstrap>;
  /** Set by `fragua ci` (from `--allow-env`) and, as the fallback when no
   * `resolveRunEnvAllow` is supplied, by `fragua daemon` / harness (from
   * `bash.env-passthrough`, via `daemonEnvAllow`). The operator/CI allow-list
   * ADDITIONS on top of the built-in baseline, forwarded into each fresh
   * `LocalEnvironment` / `WorktreeEnvironment` so the bash-tool subprocess
   * inherits only the baseline plus these names. */
  envAllowNames?: ReadonlySet<string>;
  /** Set alongside `envAllowNames` by the same writers. Applied at SPAWN TIME
   * over the live `process.env` so a name that can't be enumerated ahead of time
   * is still admitted when it returns true. */
  envAllowPredicate?: (name: string) => boolean;
  /** Resolve the per-run env allow-list against the run's project root. Called
   * once per fresh environment right before it is constructed. Authoritative
   * when set: its return replaces the constructor `envAllowNames` /
   * `envAllowPredicate`. Lets one daemon honour each project's
   * `bash.env-passthrough` (`<run.cwd>/.fragua/config.yaml` merged over global)
   * for runs from many projects, exactly as `resolveRunBootstrap` does for
   * `bootstrap`. */
  resolveRunEnvAllow?: (cwd: string) => Promise<ResolvedRunEnvAllow>;
  /** Forwarded into each fresh `WorktreeEnvironment` as its bootstrap-failure
   * escape-hatch label. The daemon passes `bash.env-passthrough in
   * .fragua/config.yaml`; `fragua ci` passes `--allow-env`. Lets the workspace
   * layer name the right re-admit surface without knowing CLI config keys. */
  envPassthroughHint?: string;
}

export interface ProvisionOpts {
  /** Project root the run was enqueued from. Overrides the
   * provisioner's default repoRoot. Required for runs from cwds
   * outside the daemon's home repo (multi-project model). When
   * omitted, the provisioner uses its constructor default. */
  cwd?: string;
  /** Pinned base commit sha (from `fragua run --base <ref>`, resolved at
   * enqueue). When set, the worktree is provisioned detached at this sha
   * (`git worktree add --detach <path> <sha>`) instead of the cwd's live
   * HEAD. Omitted = default (cwd HEAD at provision time). */
  baseRef?: string;
}

export interface Provisioner {
  ensure(runId: string, opts?: ProvisionOpts): Promise<ExecutionEnvironment>;
  /** Tear down the run's environment (worktree removal for worktree
   * backends). Recoverability is structural via the terminal snapshot the
   * executor captures before calling this — dispose creates no refs. */
  dispose(runId: string): Promise<void>;
  envFor(runId: string): ExecutionEnvironment | undefined;
  /** HEAD sha captured at provision time for runs backed by a worktree.
   * `null` for runs the provisioner doesn't track or for non-worktree
   * envs (LocalEnvironment). */
  baseGitSha(runId: string): string | null;
  /** Branch short name of the source repo HEAD at provision — the
   * post-run merge/commit target default.
   * `null` for non-worktree envs or a detached/tag/unborn source HEAD. */
  baseGitRef(runId: string): string | null;
  /** Capture a worktree snapshot at a boundary.
   * Returns the result, or `null` when delta-suppressed (unchanged tree on a
   * `step` boundary) or when the run isn't worktree-backed (bare cwd). Moves
   * the run's tip ref forward and advances the in-memory lineage cursor. */
  snapshot(runId: string, boundary: SnapshotBoundary): Promise<SnapshotResult | null>;
}

export class WorktreeProvisioner implements Provisioner {
  private readonly bootstrap: BootstrapSpec | undefined;
  private readonly worktreesDir: string;
  private readonly keepAfterDispose: boolean;
  private readonly factory: ((runId: string) => Promise<ExecutionEnvironment>) | undefined;
  private readonly bootstrapTimeoutMs: number | undefined;
  private readonly defaultShellTimeoutMs: number | undefined;
  private readonly resolveRunBootstrap: ((cwd: string) => Promise<ResolvedRunBootstrap>) | undefined;
  private readonly envAllowNames: ReadonlySet<string> | undefined;
  private readonly envAllowPredicate: ((name: string) => boolean) | undefined;
  private readonly resolveRunEnvAllow: ((cwd: string) => Promise<ResolvedRunEnvAllow>) | undefined;
  private readonly envPassthroughHint: string | undefined;
  private readonly envs = new Map<string, ExecutionEnvironment>();
  private readonly inflight = new Map<string, Promise<ExecutionEnvironment>>();
  /** Lineage cursor per run: the last recorded snapshot's commit + tree shas.
   * `commitSha` parents the next snapshot; `treeSha` drives delta-suppression.
   * Empty after a daemon restart — `snapshot()` then falls back to the tip ref
   * (resolveSnapshotParent) so the chain stays connected. */
  private readonly snapshotCursor = new Map<string, { commitSha: string; treeSha: string }>();

  constructor(opts: WorktreeProvisionerOptions = {}) {
    if (opts.bootstrap !== undefined) this.bootstrap = opts.bootstrap;
    this.worktreesDir = opts.worktreesDir ?? ".fragua/worktrees";
    this.keepAfterDispose = opts.keepAfterDispose ?? false;
    if (opts.factory !== undefined) this.factory = opts.factory;
    if (opts.bootstrapTimeoutMs !== undefined) this.bootstrapTimeoutMs = opts.bootstrapTimeoutMs;
    if (opts.defaultShellTimeoutMs !== undefined) this.defaultShellTimeoutMs = opts.defaultShellTimeoutMs;
    if (opts.resolveRunBootstrap !== undefined) this.resolveRunBootstrap = opts.resolveRunBootstrap;
    if (opts.envAllowNames !== undefined) this.envAllowNames = opts.envAllowNames;
    if (opts.envAllowPredicate !== undefined) this.envAllowPredicate = opts.envAllowPredicate;
    if (opts.resolveRunEnvAllow !== undefined) this.resolveRunEnvAllow = opts.resolveRunEnvAllow;
    if (opts.envPassthroughHint !== undefined) this.envPassthroughHint = opts.envPassthroughHint;
  }

  /** Resolve the env allow-list pair for a fresh environment at `cwd`. When
   * `resolveRunEnvAllow` is set its return is authoritative — no fallback to the
   * constructor `envAllowNames` / `envAllowPredicate`, so each project served by
   * one daemon gets its own `bash.env-passthrough`. When unset, the constructor
   * values are returned. Exposed for tests. */
  async resolveEnvAllowFor(cwd: string): Promise<ResolvedRunEnvAllow> {
    if (this.resolveRunEnvAllow !== undefined) {
      return await this.resolveRunEnvAllow(cwd);
    }
    const out: ResolvedRunEnvAllow = {};
    if (this.envAllowNames !== undefined) out.names = this.envAllowNames;
    if (this.envAllowPredicate !== undefined) out.predicate = this.envAllowPredicate;
    return out;
  }

  /** Resolve the bootstrap pair for a fresh worktree at `cwd`. When
   * `resolveRunBootstrap` is set its return is authoritative — no
   * fallback to constructor `bootstrap` / `bootstrapTimeoutMs`, so
   * a project with no `.fragua/config.yaml` bootstrap field gets
   * **no** bootstrap (not the daemon-startup-cwd's default). When
   * unset, the constructor values are returned. Exposed for tests. */
  async resolveBootstrapFor(cwd: string): Promise<ResolvedRunBootstrap> {
    if (this.resolveRunBootstrap !== undefined) {
      return await this.resolveRunBootstrap(cwd);
    }
    const out: ResolvedRunBootstrap = {};
    if (this.bootstrap !== undefined) out.bootstrap = this.bootstrap;
    if (this.bootstrapTimeoutMs !== undefined) out.bootstrapTimeoutMs = this.bootstrapTimeoutMs;
    return out;
  }

  async ensure(runId: string, opts: ProvisionOpts = {}): Promise<ExecutionEnvironment> {
    const cached = this.envs.get(runId);
    if (cached) return cached;
    const pending = this.inflight.get(runId);
    if (pending) return pending;

    const promise = this.create(runId, opts);
    this.inflight.set(runId, promise);
    try {
      const env = await promise;
      this.envs.set(runId, env);
      return env;
    } finally {
      this.inflight.delete(runId);
    }
  }

  async dispose(runId: string): Promise<void> {
    const env = this.envs.get(runId);
    if (!env) return;
    this.envs.delete(runId);
    this.snapshotCursor.delete(runId);
    if (env instanceof WorktreeEnvironment) {
      await env.dispose();
    }
  }

  envFor(runId: string): ExecutionEnvironment | undefined {
    return this.envs.get(runId);
  }

  baseGitSha(runId: string): string | null {
    const env = this.envs.get(runId);
    if (env instanceof WorktreeEnvironment) return env.baseGitSha;
    return null;
  }

  baseGitRef(runId: string): string | null {
    const env = this.envs.get(runId);
    if (env instanceof WorktreeEnvironment) return env.baseGitRef;
    return null;
  }

  async snapshot(runId: string, boundary: SnapshotBoundary): Promise<SnapshotResult | null> {
    const env = this.envs.get(runId);
    if (!(env instanceof WorktreeEnvironment)) return null; // bare cwd → no snapshots
    const baseGitSha = env.baseGitSha ?? "";
    const cursor = this.snapshotCursor.get(runId);
    const parentSnap = cursor?.commitSha ?? (await resolveSnapshotParent(env.worktreePath, runId, baseGitSha));
    const result = await captureSnapshot({
      worktree: env.worktreePath,
      runId,
      baseGitSha,
      parentSnap,
      boundary,
      prevTreeSha: cursor?.treeSha ?? null,
    });
    if (result !== null) {
      this.snapshotCursor.set(runId, { commitSha: result.commitSha, treeSha: result.treeSha });
    }
    return result;
  }

  private async create(runId: string, provisionOpts: ProvisionOpts): Promise<ExecutionEnvironment> {
    if (this.factory) return this.factory(runId);
    const repoRoot = provisionOpts.cwd;
    if (repoRoot == null) {
      // A run with no cwd has no project to provision against. Never fall back
      // to the daemon's own dir — that would execute the run in the operator's
      // checkout. Fail; the executor turns this into a clean fact.run_terminated{errored}.
      throw new Error("worktree provision: run has no cwd (imported / ephemeral runs must carry a cwd)");
    }

    const envAllow = await this.resolveEnvAllowFor(repoRoot);

    if (!(await isGitRepo(repoRoot))) {
      const localOpts: ConstructorParameters<typeof LocalEnvironment>[0] = { cwd: repoRoot };
      if (this.defaultShellTimeoutMs !== undefined) localOpts.defaultTimeoutMs = this.defaultShellTimeoutMs;
      if (envAllow.names !== undefined) localOpts.envAllowNames = envAllow.names;
      if (envAllow.predicate !== undefined) localOpts.envAllowPredicate = envAllow.predicate;
      return new LocalEnvironment(localOpts);
    }

    const { bootstrap, bootstrapTimeoutMs } = await this.resolveBootstrapFor(repoRoot);
    const opts: ConstructorParameters<typeof WorktreeEnvironment>[0] = {
      runId,
      repoRoot,
      worktreesDir: this.worktreesDir,
      keepAfterDispose: this.keepAfterDispose,
    };
    if (provisionOpts.baseRef !== undefined) opts.baseRef = provisionOpts.baseRef;
    if (bootstrap !== undefined) opts.bootstrap = bootstrap;
    if (bootstrapTimeoutMs !== undefined) opts.bootstrapTimeoutMs = bootstrapTimeoutMs;
    if (this.defaultShellTimeoutMs !== undefined) opts.defaultTimeoutMs = this.defaultShellTimeoutMs;
    if (envAllow.names !== undefined) opts.envAllowNames = envAllow.names;
    if (envAllow.predicate !== undefined) opts.envAllowPredicate = envAllow.predicate;
    if (this.envPassthroughHint !== undefined) opts.envPassthroughHint = this.envPassthroughHint;
    const env = new WorktreeEnvironment(opts);
    await env.init();
    return env;
  }
}

function isGitRepo(cwd: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("close", (code) => resolvePromise(code === 0));
    child.on("error", () => resolvePromise(false));
  });
}
