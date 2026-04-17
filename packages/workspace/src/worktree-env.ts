// WorktreeEnvironment — ExecutionEnvironment backed by a short-lived
// `git worktree`. Each session gets its own branch so agents don't mutate
// the user's working copy.
//
// Layout:
//   <repoRoot>/.swarm/worktrees/<run-id>/   ← the worktree
//   branch: swarm/<run-id>                    ← tracking branch
//
// Untracked/ignored paths (node_modules, .env, etc.) are NOT copied into a
// fresh worktree. For transparent tooling (bun install, bun test), we
// symlink a configurable list of ignored paths from the main repo into the
// worktree. Default list is `["node_modules"]`. Users can extend via opts.
//
// WARNING: symlinked node_modules means `bun install` inside the worktree
// mutates the shared cache. For Phase 3 MVP this is the right trade-off
// (correctness + speed > isolation for deps). Proper CoW arrives later.

import { spawn } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { LocalEnvironment, type LocalEnvironmentOptions } from "./local-env.ts";
import type { DirEntry, ExecResult, ExecutionEnvironment } from "./types.ts";

export interface WorktreeEnvironmentOptions extends Omit<LocalEnvironmentOptions, "cwd"> {
  /** The repo that owns the worktree. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Opaque session identifier — becomes branch suffix + worktree dirname. */
  runId: string;
  /** Directory under repoRoot where worktrees live. Default `.swarm/worktrees`. */
  worktreesDir?: string;
  /** Ignored paths to symlink from repoRoot into the worktree. Default `["node_modules"]`. */
  shareIgnored?: string[];
  /** Starting branch/commit for the worktree. Default current HEAD. */
  baseRef?: string;
  /** Keep the worktree + branch after dispose() (for post-mortem). Default false. */
  keepAfterDispose?: boolean;
}

export class WorktreeEnvironment implements ExecutionEnvironment {
  private readonly repoRoot: string;
  readonly runId: string;
  readonly branch: string;
  readonly worktreePath: string;
  private readonly shareIgnored: string[];
  private readonly baseRef: string | undefined;
  private readonly keepAfterDispose: boolean;
  private readonly local: LocalEnvironment;
  private initialized = false;
  private disposed = false;

  constructor(opts: WorktreeEnvironmentOptions) {
    this.repoRoot = resolve(opts.repoRoot ?? process.cwd());
    this.runId = opts.runId;
    this.branch = `swarm/${opts.runId}`;
    const dir = opts.worktreesDir ?? ".swarm/worktrees";
    this.worktreePath = isAbsolute(dir) ? join(dir, opts.runId) : join(this.repoRoot, dir, opts.runId);
    this.shareIgnored = opts.shareIgnored ?? ["node_modules"];
    if (opts.baseRef !== undefined) this.baseRef = opts.baseRef;
    this.keepAfterDispose = opts.keepAfterDispose ?? false;
    this.local = new LocalEnvironment({
      cwd: this.worktreePath,
      ...(opts.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: opts.defaultTimeoutMs } : {}),
      ...(opts.extraBlockedPatterns !== undefined ? { extraBlockedPatterns: opts.extraBlockedPatterns } : {}),
    });
  }

  /** Create the worktree + branch and set up symlinks. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(join(this.repoRoot, ".swarm", "worktrees"), { recursive: true });
    const args = ["worktree", "add"];
    if (this.baseRef !== undefined) {
      args.push("-b", this.branch, this.worktreePath, this.baseRef);
    } else {
      args.push("-b", this.branch, this.worktreePath);
    }
    await runGit(this.repoRoot, args);
    for (const name of this.shareIgnored) {
      const src = join(this.repoRoot, name);
      const dst = join(this.worktreePath, name);
      if (existsSync(src) && !existsSync(dst)) {
        try {
          symlinkSync(src, dst, "dir");
        } catch {
          // ignore — symlinking is best-effort, some tools work without it
        }
      }
    }
    this.initialized = true;
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
