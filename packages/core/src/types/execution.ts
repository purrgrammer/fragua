// ExecutionEnvironment — the shell + filesystem surface a run operates
// against. The interface lives in @swarm/core (not @swarm/workspace)
// so HandlerContext can carry an `env: ExecutionEnvironment` without
// inducing a @swarm/core → @swarm/workspace dependency. Concrete
// implementations (`LocalEnvironment`, `WorktreeEnvironment`) still
// live in @swarm/workspace and re-export this type for convenience.
//
// Keep this surface small and fully serialisable over IPC-style
// boundaries — a remote / Docker / sandbox backend should be able to
// implement it without reaching back into the host.

export interface ExecutionEnvironment {
  /** Absolute path of the working directory for this run. */
  cwd(): string;
  /** Read a text file. Path is resolved against cwd() when relative. */
  readFile(path: string): Promise<string>;
  /** Write a text file (atomic replace). */
  writeFile(path: string, contents: string): Promise<void>;
  /** Check if a file exists. */
  exists(path: string): Promise<boolean>;
  /** Execute a shell command. Returns stdout/stderr/exit code. The
   * optional `onData` callback streams chunks as they arrive — tools
   * use it to surface partial output to the UI during long commands.
   * `signal` triggers process-tree termination; backends should send
   * SIGTERM to the whole process group, then SIGKILL after a short
   * grace window, so stuck child processes don't leak past abort. */
  exec(
    command: string,
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      signal?: AbortSignal;
      onData?: (chunk: string, kind: "stdout" | "stderr") => void;
    },
  ): Promise<ExecResult>;
  /** List entries in a directory (non-recursive). */
  listDir(path: string): Promise<DirEntry[]>;
  /** Glob against env.cwd() (or override via opts.cwd). Returns sorted, cwd-relative paths.
   * `opts.dot` controls whether dotfiles / hidden directories are visible to the
   * pattern; defaults to false to match Bun.Glob. Tools that mirror pi-coding-agent's
   * `--hidden` posture (grep, find) pass `dot: true`. */
  glob(pattern: string, opts?: { cwd?: string; dot?: boolean }): Promise<string[]>;
}

export interface DirEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Total wall-clock ms. */
  durationMs: number;
}
