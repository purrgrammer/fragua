// WorktreeEnvironment — ExecutionEnvironment backed by a short-lived
// `git worktree`. Each session gets its own branch so agents don't mutate
// the user's working copy and concurrent runs don't step on each other.
//
// Layout:
//   <repoRoot>/.swarm/worktrees/<run-id>/   ← the worktree
//   branch: swarm/<run-id>                    ← tracking branch
//
// Full isolation: untracked/ignored paths (node_modules, .env, etc.) are NOT
// shared with the main repo. If the project needs dependencies installed,
// set `.swarm/config.yaml` project.bootstrap to the appropriate command
// (e.g. `bun install --frozen-lockfile`, `pnpm install`, `pip install -r
// requirements.txt`). The command runs inside the fresh worktree before the
// first node executes; a non-zero exit fails the run.

import { spawn } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { LocalEnvironment, type LocalEnvironmentOptions } from "./local-env.ts";
import type { DirEntry, ExecResult, ExecutionEnvironment } from "./types.ts";

/** A shell command string, or a callback given the partially-initialized
 * environment to run whatever bootstrap logic the host needs. Either form
 * runs inside the worktree as its cwd. */
export type BootstrapSpec = string | ((env: ExecutionEnvironment) => Promise<void>);

export interface WorktreeEnvironmentOptions extends Omit<LocalEnvironmentOptions, "cwd"> {
  /** The repo that owns the worktree. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Opaque session identifier — becomes branch suffix + worktree dirname. */
  runId: string;
  /** Directory under repoRoot where worktrees live. Default `.swarm/worktrees`. */
  worktreesDir?: string;
  /** Starting branch/commit for the worktree. Default current HEAD. */
  baseRef?: string;
  /** Keep the worktree + branch after dispose() (for post-mortem). Default false. */
  keepAfterDispose?: boolean;
  /** Per-worktree dependency install. Stack-agnostic — pass whatever the
   * project needs (`bun install --frozen-lockfile`, `pnpm install`, a
   * custom script, or a callback). Missing = no-op. */
  bootstrap?: BootstrapSpec;
  /** Timeout for the bootstrap command. Default 10 minutes. */
  bootstrapTimeoutMs?: number;
}

export class WorktreeEnvironment implements ExecutionEnvironment {
  private readonly repoRoot: string;
  readonly runId: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly bootstrapRan: boolean = false;
  readonly bootstrapCommand: string | undefined;
  private readonly baseRef: string | undefined;
  private readonly keepAfterDispose: boolean;
  private readonly bootstrap: BootstrapSpec | undefined;
  private readonly bootstrapTimeoutMs: number;
  private readonly local: LocalEnvironment;
  private initialized = false;
  private disposed = false;

  constructor(opts: WorktreeEnvironmentOptions) {
    this.repoRoot = resolve(opts.repoRoot ?? process.cwd());
    this.runId = opts.runId;
    this.branch = `swarm/${opts.runId}`;
    const dir = opts.worktreesDir ?? ".swarm/worktrees";
    this.worktreePath = isAbsolute(dir) ? join(dir, opts.runId) : join(this.repoRoot, dir, opts.runId);
    if (opts.baseRef !== undefined) this.baseRef = opts.baseRef;
    this.keepAfterDispose = opts.keepAfterDispose ?? false;
    if (opts.bootstrap !== undefined) this.bootstrap = opts.bootstrap;
    this.bootstrapTimeoutMs = opts.bootstrapTimeoutMs ?? 10 * 60 * 1000;
    if (typeof opts.bootstrap === "string") this.bootstrapCommand = opts.bootstrap;
    this.local = new LocalEnvironment({
      cwd: this.worktreePath,
      ...(opts.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: opts.defaultTimeoutMs } : {}),
      ...(opts.extraBlockedPatterns !== undefined ? { extraBlockedPatterns: opts.extraBlockedPatterns } : {}),
    });
  }

  /** Create the worktree + branch and run the project's bootstrap
   * command if configured. Idempotent across
   * process restarts: if the target worktree directory already exists
   * and `git worktree list` confirms it's a registered worktree for
   * this repo, the existing one is reused (no `git worktree add`, no
   * re-bootstrap) so a HITL-paused run can survive a daemon restart
   * without double-provisioning. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(join(this.repoRoot, ".swarm", "worktrees"), { recursive: true });

    const alreadyProvisioned = await this.isExistingWorktree();
    if (!alreadyProvisioned) {
      const args = ["worktree", "add"];
      if (this.baseRef !== undefined) {
        args.push("-b", this.branch, this.worktreePath, this.baseRef);
      } else {
        args.push("-b", this.branch, this.worktreePath);
      }
      await runGit(this.repoRoot, args);
    }

    // Only bootstrap on FRESH provisioning — a resumed run's worktree
    // already has dependencies installed from the pre-crash life, and
    // re-running `bun install` etc. wastes a few minutes every resume
    // at best and churns lockfiles at worst.
    if (this.bootstrap !== undefined && !alreadyProvisioned) {
      if (typeof this.bootstrap === "string") {
        const result = await this.local.exec(this.bootstrap, { timeoutMs: this.bootstrapTimeoutMs });
        if (result.exitCode !== 0) {
          throw new Error(
            `bootstrap command failed (exit ${result.exitCode}): ${this.bootstrap}\n${result.stderr.trim()}`,
          );
        }
      } else {
        await this.bootstrap(this.local);
      }
      (this as { bootstrapRan: boolean }).bootstrapRan = true;
    }
    this.initialized = true;
  }

  /** Detect a pre-existing worktree for this run. Checks:
   *   1. The target directory exists (cheap).
   *   2. `git worktree list --porcelain` from the repo root lists it.
   *
   * The second check guards against a stale directory left behind
   * after an unclean dispose (user ran `rm -rf` on the worktree but
   * the branch is still registered). In that case we'd rather fail
   * loudly than silently reuse a broken state. */
  private async isExistingWorktree(): Promise<boolean> {
    let targetReal: string;
    try {
      await access(this.worktreePath);
      targetReal = await realpath(this.worktreePath);
    } catch {
      return false;
    }
    try {
      const { stdout } = await runGitCapture(this.repoRoot, ["worktree", "list", "--porcelain"]);
      // `--porcelain` emits records separated by blank lines; each
      // starts with `worktree <path>`. Compare realpaths — on macOS
      // `/var/...` is a symlink to `/private/var/...` and git emits
      // the resolved form, so a raw string compare loses.
      for (const line of stdout.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const path = line.slice("worktree ".length).trim();
        try {
          if ((await realpath(path)) === targetReal) return true;
        } catch {
          // entry removed between list + realpath; ignore
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Remove the worktree and its branch. No-op if keepAfterDispose or already disposed. */
  async dispose(): Promise<void> {
    if (this.disposed || this.keepAfterDispose) return;
    this.disposed = true;
    try {
      await runGit(this.repoRoot, ["worktree", "remove", "--force", this.worktreePath]);
    } catch {
      // worktree may already be gone
    }
    try {
      await runGit(this.repoRoot, ["branch", "-D", this.branch]);
    } catch {
      // branch may already be gone (e.g. user checked out + merged it)
    }
  }

  cwd(): string {
    return this.worktreePath;
  }

  readFile(path: string): Promise<string> {
    return this.local.readFile(path);
  }

  writeFile(path: string, contents: string): Promise<void> {
    return this.local.writeFile(path, contents);
  }

  exists(path: string): Promise<boolean> {
    return this.local.exists(path);
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.local.listDir(path);
  }

  glob(pattern: string, opts?: { cwd?: string }): Promise<string[]> {
    return this.local.glob(pattern, opts);
  }

  exec(
    command: string,
    opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<ExecResult> {
    return this.local.exec(command, opts);
  }
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on("error", rejectPromise);
  });
}

function runGitCapture(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on("error", rejectPromise);
  });
}
