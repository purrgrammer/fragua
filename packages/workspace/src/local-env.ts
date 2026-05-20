// Local file-system ExecutionEnvironment.
// cwd + node:fs + node:child_process + Bun.Glob. Blocked commands refused before spawn.

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isBlockedCommand } from "./blocklist.ts";
import type { DirEntry, ExecResult, ExecutionEnvironment } from "./types.ts";

/**
 * Thrown by {@link LocalEnvironment} when a path argument resolves
 * outside the environment's `_cwd`. Agent tools catch this and return
 * a tool-error result so the model can self-correct on the next turn;
 * untouched paths (existsSync, readdir, etc.) propagate it as a
 * normal exception. A separate class (not a plain Error) lets callers
 * `instanceof` it without string-matching messages.
 */
export class PathEscapeError extends Error {
  constructor(
    public readonly path: string,
    public readonly resolved: string,
    public readonly cwd: string,
  ) {
    super(
      `path "${path}" resolves to "${resolved}" — outside the run's cwd "${cwd}". ` +
        "Use a relative path inside cwd; absolute paths into the project root or " +
        "elsewhere bypass worktree isolation.",
    );
    this.name = "PathEscapeError";
  }
}

/** Refuse-list regex for bash commands that escape the run's cwd via
 *  `cd <absolute-path>` segments. We only catch `cd` chains because
 *  blanket absolute-path detection in arbitrary shell would have far
 *  too many false positives (e.g. `/tmp/foo`, `/dev/null`, system
 *  binaries). The agent-side mitigation is the system prompt — this
 *  is the runtime backstop for the most common escape pattern. */
const CD_ESCAPE_PATTERN = /\bcd\s+(['"]?)(\/[^\s'"&;|()]+)\1/g;

export interface LocalEnvironmentOptions {
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Default command timeout in ms. Default 30_000. */
  defaultTimeoutMs?: number;
  /** Additional blocklist patterns appended to the built-in defaults. */
  extraBlockedPatterns?: string[];
}

/** Walk up `absolutePath` until a path component exists on disk, realpath
 *  that, and re-append the non-existing suffix. Returns the original path
 *  if no ancestor resolves (defensive — `/` always exists). Sync because
 *  the callers (resolvePath fast-path) are sync. */
function resolveExistingPrefixSync(absolutePath: string): string {
  const trailing: string[] = [];
  let current = absolutePath;
  while (true) {
    try {
      const real = realpathSync(current);
      return trailing.length > 0 ? join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolutePath;
      trailing.push(basename(current));
      current = parent;
    }
  }
}

export class LocalEnvironment implements ExecutionEnvironment {
  private readonly _cwd: string;
  private readonly defaultTimeoutMs: number;
  private readonly extraBlocked: string[];

  constructor(opts: LocalEnvironmentOptions = {}) {
    this._cwd = resolve(opts.cwd ?? process.cwd());
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.extraBlocked = opts.extraBlockedPatterns ?? [];
  }

  /** Memoised realpath(_cwd). Computed lazily because WorktreeEnvironment
   * constructs a LocalEnvironment with a path that doesn't exist until
   * init() runs `git worktree add`. realpathSync would throw on a missing
   * directory at construction time, so we defer until the first check —
   * by then the worktree has been provisioned. Falls back to the lexical
   * path on persistent failure so checks still run (just without symlink
   * dereferencing for the cwd itself). */
  private cwdRealCache: string | undefined;
  private cwdReal(): string {
    if (this.cwdRealCache !== undefined) return this.cwdRealCache;
    try {
      this.cwdRealCache = realpathSync(this._cwd);
    } catch {
      return this._cwd;
    }
    return this.cwdRealCache;
  }

  cwd(): string {
    return this._cwd;
  }

  /** LocalEnvironment runs directly in the project root; cwd === projectCwd. */
  projectCwd(): string {
    return this._cwd;
  }

  /**
   * Resolve `path` against the env's cwd and verify it stays under it.
   *
   * The check turns silent isolation leaks (Phase 9 run
   * 01ks01m6bt9ryccn4b: the agent passed
   * `/Users/bandarra/swarm/.agents/skills/workflows/SKILL.md` as a
   * write target while running in a `.swarm/worktrees/<runId>`
   * environment; the resolved absolute path bypassed `_cwd` and
   * landed in main) into loud {@link PathEscapeError}s. Tools catch
   * these and surface them as tool errors so the LLM self-corrects
   * with a relative path on its next turn rather than halting the run.
   */
  private resolvePath(path: string): string {
    const resolved = isAbsolute(path) ? path : resolve(this._cwd, path);
    const normalized = resolve(resolved);
    // Realpath check: walk the path up to the first existing ancestor,
    // realpath that, re-append the non-existing suffix, and verify the
    // result stays under realpath(_cwd). Covers three cases at once:
    //   - `../escape.txt`: normalized lexically escapes; realpath on the
    //     existing parent still produces a sibling-of-cwd path.
    //   - absolute path outside cwd: realpath agrees, still escapes.
    //   - symlink inside cwd pointing outside (the Phase 9 escape vector
    //     a plain `resolve()` misses): lexical path stays under cwd, but
    //     `realpathSync` dereferences the symlink and reveals the escape.
    const cwdReal = this.cwdReal();
    const real = resolveExistingPrefixSync(normalized);
    if (real !== cwdReal && !real.startsWith(cwdReal + sep)) {
      throw new PathEscapeError(path, real, cwdReal);
    }
    return normalized;
  }

  async readFile(path: string): Promise<string> {
    return readFile(this.resolvePath(path), "utf8");
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const absolute = this.resolvePath(path);
    await mkdir(dirname(absolute), { recursive: true });
    const tmp = `${absolute}.swarm-tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, contents, "utf8");
    await rename(tmp, absolute);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.resolvePath(path));
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const entries = await readdir(this.resolvePath(path), { withFileTypes: true });
    return entries
      .map((e) => ({
        name: e.name,
        kind: e.isDirectory()
          ? ("directory" as const)
          : e.isFile()
            ? ("file" as const)
            : e.isSymbolicLink()
              ? ("symlink" as const)
              : ("other" as const),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async glob(pattern: string, opts: { cwd?: string; dot?: boolean } = {}): Promise<string[]> {
    const base = opts.cwd ? this.resolvePath(opts.cwd) : this._cwd;
    const g = new Bun.Glob(pattern);
    const matches: string[] = [];
    for await (const absolute of g.scan({ cwd: base, absolute: true, onlyFiles: false, dot: opts.dot ?? false })) {
      matches.push(relative(this._cwd, absolute));
    }
    matches.sort();
    return matches;
  }

  async exec(
    command: string,
    opts: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      signal?: AbortSignal;
      onData?: (chunk: string, kind: "stdout" | "stderr") => void;
    } = {},
  ): Promise<ExecResult> {
    const blocked = isBlockedCommand(command, this.extraBlocked);
    if (blocked) {
      return {
        stdout: "",
        stderr: `[swarm: blocked command — matched pattern "${blocked}". Edit .swarm/config.yaml blocklist to adjust.]`,
        exitCode: 126,
        durationMs: 0,
      };
    }
    // Refuse `cd <abs-path-outside-cwd>` segments. Matches the agent's
    // most common escape pattern (`cd /Users/bandarra/swarm && bun
    // run …`) at Phase 9 run 01ks01m6bt9ryccn4b. Returned as a
    // non-zero exit so the LLM sees an actionable error and
    // self-corrects rather than halting the run.
    const cdEscape = this.firstCdEscape(command);
    if (cdEscape !== undefined) {
      return {
        stdout: "",
        stderr:
          `[swarm: command refused — \`cd ${cdEscape}\` escapes the run's cwd ${this._cwd}. ` +
          "All work must stay inside cwd; do not cd outside the worktree. " +
          "If you wanted to run tests/build commands, do so from cwd directly " +
          "(`bun run --filter='@swarm/<pkg>' typecheck`, etc.) — the worktree is a full git checkout.]",
        exitCode: 126,
        durationMs: 0,
      };
    }
    const cwd = opts.cwd ? this.resolvePath(opts.cwd) : this._cwd;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const start = Date.now();

    return new Promise((resolvePromise) => {
      // detached: true puts the shell in its own process group so we
      // can SIGTERM the whole tree on abort/timeout via process.kill
      // with a negative pid. Without this, grandchild processes
      // (e.g. `bash -c 'sleep 100 & sleep 200'`) survive a SIGTERM
      // sent only to the shell.
      const child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env: { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let killReason: "timeout" | "abort" | undefined;

      const killTree = (reason: "timeout" | "abort") => {
        killReason = reason;
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            // group may already be gone — fall through to per-pid kill
            try {
              child.kill("SIGTERM");
            } catch {
              // ignore
            }
          }
          // Escalate to SIGKILL after a short grace window. If the
          // process already exited the second kill is harmless.
          setTimeout(() => {
            if (child.pid !== undefined) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                try {
                  child.kill("SIGKILL");
                } catch {
                  // ignore
                }
              }
            }
          }, 2_000);
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        killTree("timeout");
      }, timeoutMs);

      const onAbort = () => {
        if (settled) return;
        killTree("abort");
      };
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout.on("data", (chunk) => {
        const s = chunk.toString();
        stdout += s;
        opts.onData?.(s, "stdout");
      });
      child.stderr.on("data", (chunk) => {
        const s = chunk.toString();
        stderr += s;
        opts.onData?.(s, "stderr");
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        if (killReason === "timeout") {
          resolvePromise({
            stdout,
            stderr: `${stderr}\n[swarm: exec timed out after ${timeoutMs}ms]`,
            exitCode: 124,
            durationMs: Date.now() - start,
          });
          return;
        }
        if (killReason === "abort") {
          resolvePromise({
            stdout,
            stderr: `${stderr}\n[swarm: exec aborted]`,
            exitCode: 130,
            durationMs: Date.now() - start,
          });
          return;
        }
        resolvePromise({ stdout, stderr, exitCode: code ?? 0, durationMs: Date.now() - start });
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        resolvePromise({ stdout, stderr: err.message, exitCode: 127, durationMs: Date.now() - start });
      });
    });
  }

  /** Scan a shell command for a `cd <abs-path>` segment whose target
   *  is outside the env's cwd. Returns the offending path or undefined.
   *  Used by {@link exec} to refuse the command before spawning. */
  private firstCdEscape(command: string): string | undefined {
    const cwdNorm = this.cwdReal();
    CD_ESCAPE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: stdlib regex/exec idiom
    while ((match = CD_ESCAPE_PATTERN.exec(command)) !== null) {
      const target = match[2];
      if (target === undefined) continue;
      // Realpath the existing prefix so a lexical-but-correct target
      // under a symlinked ancestor (macOS /tmp → /private/tmp; mktemp
      // dirs under /var/folders → /private/var/folders) is compared
      // against cwd after symlink resolution.
      const normalized = resolveExistingPrefixSync(resolve(target));
      if (normalized !== cwdNorm && !normalized.startsWith(cwdNorm + sep)) {
        return target;
      }
    }
    return undefined;
  }
}
