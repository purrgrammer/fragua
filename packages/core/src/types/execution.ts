// ExecutionEnvironment — the shell + filesystem surface a run operates
// against. The interface lives in @fragua/core (not @fragua/workspace)
// so HandlerContext can carry an `env: ExecutionEnvironment` without
// inducing a @fragua/core → @fragua/workspace dependency. Concrete
// implementations (`LocalEnvironment`, `WorktreeEnvironment`) still
// live in @fragua/workspace and re-export this type for convenience.
//
// Keep this surface small and fully serialisable over IPC-style
// boundaries — a remote / Docker / sandbox backend should be able to
// implement it without reaching back into the host.

export interface ExecutionEnvironment {
  /** Absolute path of the working directory for this run. For
   * worktree-backed runs this points at the run's isolated worktree
   * (under `.fragua/worktrees/<run-id>/`); for `LocalEnvironment` this
   * coincides with the project root. */
  cwd(): string;
  /** Absolute path of the *project root* this env was provisioned from.
   * For `LocalEnvironment` this equals `cwd()`; for `WorktreeEnvironment`
   * it's the source repo root (the worktree's parent project), which is
   * the cwd recorded on `run_state.cwd`. Used by per-run catalogue
   * filtering so a run only sees its own project's project-scope skills
   * and agent profiles. */
  projectCwd(): string;
  /** Read a text file. Path is resolved against cwd() when relative. */
  readFile(path: string): Promise<string>;
  /** Write a text file (atomic replace). */
  writeFile(path: string, contents: string): Promise<void>;
  /** Check if a file exists. */
  exists(path: string): Promise<boolean>;
  /** Size of a file in bytes without reading it — lets a bounded reader
   * refuse an oversized file before it is in memory. Optional: an
   * environment that cannot stat falls back to read-then-measure. */
  fileSize?(path: string): Promise<number>;
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
  /** Allocate a scratch file for out-of-band IPC with a spawned process — the
   * `$FRAGUA_OUTPUT` channel a producing `tool` step writes its typed struct to.
   * The path is DETERMINISTIC in `(runId, nodeId, iteration)` and lives OUTSIDE
   * `cwd()`, so it never enters a snapshot delta or a `fragua runs diff`. The
   * implementation unlinks any file already at that path, then creates a fresh
   * inode itself and retains the fd; the read-back reads from that retained fd,
   * never by re-opening the child-controlled path — so a child that swaps a
   * symlink, FIFO, or device onto the path reads back empty and fails closed.
   * Optional: only the real spawning environments (`LocalEnvironment`,
   * `WorktreeEnvironment`) implement it. A tool that declares `outputs:` in an
   * env lacking it fails closed at the node. Rejects on allocation failure. */
  createScratchFile?(key: ScratchKey): Promise<ScratchFile>;
}

export interface ScratchKey {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
}

/** Result of a scratch read-back. `absent` — the process left no bytes on the
 * retained inode (it never wrote; no valid JSON is zero-length). `renamed` —
 * the retained inode is empty but the path now resolves to a DIFFERENT regular
 * inode holding bytes (a temp-file + `mv`/`sponge`/`--output` idiom the retained
 * fd never sees); the handler surfaces this as an actionable fault naming the
 * in-place-`>` requirement rather than a misleading `no_emission`. `oversize` —
 * more than `maxBytes` bytes are present; the read never allocates past the cap.
 * `ok` — the retained inode carries `text`. */
export type ScratchReadResult =
  | { kind: "absent" }
  | { kind: "renamed" }
  | { kind: "oversize" }
  | { kind: "ok"; text: string };

export interface ScratchFile {
  /** Absolute deterministic path, outside cwd(); handed to the child via
   * `FRAGUA_OUTPUT`. The child writes into it IN PLACE (`> "$FRAGUA_OUTPUT"`
   * truncates the same inode). */
  readonly path: string;
  /** Read back this dispatch's file from the retained fd, bounded at
   * `maxBytes + 1` independently of any stat. `signal` bounds the read for
   * defence in depth. */
  read(maxBytes: number, signal: AbortSignal): Promise<ScratchReadResult>;
  /** Close the retained fd and unlink the path; idempotent, never throws. */
  dispose(): Promise<void>;
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
