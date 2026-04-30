// Local file-system ExecutionEnvironment.
// cwd + node:fs + node:child_process + Bun.Glob. Blocked commands refused before spawn.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isBlockedCommand } from "./blocklist.ts";
import type { DirEntry, ExecResult, ExecutionEnvironment } from "./types.ts";

export interface LocalEnvironmentOptions {
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Default command timeout in ms. Default 30_000. */
  defaultTimeoutMs?: number;
  /** Additional blocklist patterns appended to the built-in defaults. */
  extraBlockedPatterns?: string[];
}

export class LocalEnvironment implements ExecutionEnvironment {
  private readonly _cwd: string;
  private readonly defaultTimeoutMs: number;
  private readonly extraBlocked: string[];

  constructor(opts: LocalEnvironmentOptions = {}) {
    this._cwd = opts.cwd ?? process.cwd();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.extraBlocked = opts.extraBlockedPatterns ?? [];
  }

  cwd(): string {
    return this._cwd;
  }

  private resolvePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this._cwd, path);
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

  async glob(pattern: string, opts: { cwd?: string } = {}): Promise<string[]> {
    const base = opts.cwd ? this.resolvePath(opts.cwd) : this._cwd;
    const g = new Bun.Glob(pattern);
    const matches: string[] = [];
    for await (const absolute of g.scan({ cwd: base, absolute: true, onlyFiles: false })) {
      matches.push(relative(this._cwd, absolute));
    }
    matches.sort();
    return matches;
  }

  async exec(
    command: string,
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<ExecResult> {
    const blocked = isBlockedCommand(command, this.extraBlocked);
    if (blocked) {
      return {
        stdout: "",
        stderr: `[swarm: blocked command — matched pattern "${blocked}". Edit .swarm/config.jsonc blocklist to adjust.]`,
        exitCode: 126,
        durationMs: 0,
      };
    }
    const cwd = opts.cwd ? this.resolvePath(opts.cwd) : this._cwd;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const start = Date.now();

    return new Promise((resolvePromise) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env: { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000);
        resolvePromise({
          stdout,
          stderr: `${stderr}\n[swarm: exec timed out after ${timeoutMs}ms]`,
          exitCode: 124,
          durationMs: Date.now() - start,
        });
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ stdout, stderr, exitCode: code ?? 0, durationMs: Date.now() - start });
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ stdout, stderr: err.message, exitCode: 127, durationMs: Date.now() - start });
      });
    });
  }
}
