// WorktreeProvisioner — maps runId → ExecutionEnvironment.
//
// The executor calls `ensure(runId)` before dispatching the run's first
// node. On success, every turn's HandlerContext carries the same env
// so handlers + agents operate inside an isolated `git worktree`
// linked branch. On terminal status, the executor calls `dispose(runId)`
// to tear the worktree + branch down.
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
//     the comment there) — re-initialising an existing worktree must
//     not double-create the branch.
//   - Failure mode: `ensure` throws when `init()` rejects. The executor
//     catches and emits a `fact.run_halted` with `reason=error`,
//     `detail=worktree_provision_failed: ...`. The run can be
//     inspected via intent.unquarantine or manually cleaned up.
//   - Dispose uses `WorktreeEnvironment.dispose()` which is a best-
//     effort cleanup: it tolerates already-removed worktrees and
//     branches (user may have merged + deleted them out of band).

import type { ExecutionEnvironment } from "@swarm/core";
import { type BootstrapSpec, LocalEnvironment, WorktreeEnvironment } from "@swarm/workspace";

export interface WorktreeProvisionerOptions {
  /** Repo root. Defaults to `process.cwd()`. */
  repoRoot?: string;
  /** Shell command (or callback) run inside each fresh worktree before
   * the first node fires. Missing = no-op. */
  bootstrap?: BootstrapSpec;
  /** Directory under `repoRoot` where worktrees live. Default
   * `.swarm/worktrees`. Each run gets a `<worktreesDir>/<run-id>` dir. */
  worktreesDir?: string;
  /** Keep worktrees around after dispose — useful for post-mortems.
   * Default false. */
  keepAfterDispose?: boolean;
  /** Override factory for tests — produces an `ExecutionEnvironment`
   * given a runId. Short-circuits the real git-worktree path. */
  factory?: (runId: string) => Promise<ExecutionEnvironment>;
  /** Forward into each fresh worktree as `bootstrapTimeoutMs`. */
  bootstrapTimeoutMs?: number;
  /** Forward into each fresh worktree's LocalEnvironment as
   * `defaultTimeoutMs` — used when a handler's shell call doesn't
   * pass its own `timeoutMs`. */
  defaultShellTimeoutMs?: number;
}

export interface Provisioner {
  ensure(runId: string): Promise<ExecutionEnvironment>;
  dispose(runId: string): Promise<void>;
  envFor(runId: string): ExecutionEnvironment | undefined;
}

export class WorktreeProvisioner implements Provisioner {
  private readonly repoRoot: string;
  private readonly bootstrap: BootstrapSpec | undefined;
  private readonly worktreesDir: string;
  private readonly keepAfterDispose: boolean;
  private readonly factory: ((runId: string) => Promise<ExecutionEnvironment>) | undefined;
  private readonly bootstrapTimeoutMs: number | undefined;
  private readonly defaultShellTimeoutMs: number | undefined;
  private readonly envs = new Map<string, ExecutionEnvironment>();
  private readonly inflight = new Map<string, Promise<ExecutionEnvironment>>();

  constructor(opts: WorktreeProvisionerOptions = {}) {
    this.repoRoot = opts.repoRoot ?? process.cwd();
    if (opts.bootstrap !== undefined) this.bootstrap = opts.bootstrap;
    this.worktreesDir = opts.worktreesDir ?? ".swarm/worktrees";
    this.keepAfterDispose = opts.keepAfterDispose ?? false;
    if (opts.factory !== undefined) this.factory = opts.factory;
    if (opts.bootstrapTimeoutMs !== undefined) this.bootstrapTimeoutMs = opts.bootstrapTimeoutMs;
    if (opts.defaultShellTimeoutMs !== undefined) this.defaultShellTimeoutMs = opts.defaultShellTimeoutMs;
  }

  async ensure(runId: string): Promise<ExecutionEnvironment> {
    const cached = this.envs.get(runId);
    if (cached) return cached;
    const pending = this.inflight.get(runId);
    if (pending) return pending;

    const promise = this.create(runId);
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
    if (env instanceof WorktreeEnvironment) {
      await env.dispose();
    }
  }

  envFor(runId: string): ExecutionEnvironment | undefined {
    return this.envs.get(runId);
  }

  private async create(runId: string): Promise<ExecutionEnvironment> {
    if (this.factory) return this.factory(runId);
    const opts: ConstructorParameters<typeof WorktreeEnvironment>[0] = {
      runId,
      repoRoot: this.repoRoot,
      worktreesDir: this.worktreesDir,
      keepAfterDispose: this.keepAfterDispose,
    };
    if (this.bootstrap !== undefined) opts.bootstrap = this.bootstrap;
    if (this.bootstrapTimeoutMs !== undefined) opts.bootstrapTimeoutMs = this.bootstrapTimeoutMs;
    if (this.defaultShellTimeoutMs !== undefined) opts.defaultTimeoutMs = this.defaultShellTimeoutMs;
    const env = new WorktreeEnvironment(opts);
    await env.init();
    return env;
  }
}

/** Fallback provisioner that always hands back a shared LocalEnvironment
 * rooted at `process.cwd()`. Useful for tests + daemons that don't
 * want isolation (ephemeral stub runs, legacy workflows). `dispose`
 * is a no-op because there's no per-run state to tear down. */
export class LocalEnvironmentProvisioner implements Provisioner {
  private readonly shared: ExecutionEnvironment;

  constructor(cwd: string = process.cwd(), opts: { defaultShellTimeoutMs?: number } = {}) {
    const envOpts: ConstructorParameters<typeof LocalEnvironment>[0] = { cwd };
    if (opts.defaultShellTimeoutMs !== undefined) envOpts.defaultTimeoutMs = opts.defaultShellTimeoutMs;
    this.shared = new LocalEnvironment(envOpts);
  }

  async ensure(_runId: string): Promise<ExecutionEnvironment> {
    return this.shared;
  }

  async dispose(_runId: string): Promise<void> {
    // no-op: LocalEnvironment is shared, not per-run.
  }

  envFor(_runId: string): ExecutionEnvironment | undefined {
    return this.shared;
  }
}
