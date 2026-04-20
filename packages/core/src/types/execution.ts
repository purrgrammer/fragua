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
  /** Execute a shell command. Returns stdout/stderr/exit code. */
  exec(command: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult>;
  /** List entries in a directory (non-recursive). */
  listDir(path: string): Promise<DirEntry[]>;
  /** Glob against env.cwd() (or override via opts.cwd). Returns sorted, cwd-relative paths. */
  glob(pattern: string, opts?: { cwd?: string }): Promise<string[]>;
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
