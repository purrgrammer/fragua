// Server ports. Under the store-backed architecture the only port we keep
// is WorkflowReader — listing workflow files on disk for the Workflows page.
// Everything else reads directly from @swarm/store.

import type { InputDecl } from "@swarm/core";
import type { HealthDaemonInfo } from "./routes/health.ts";

export type { InputDecl };

export interface WorkflowSummary {
  name: string;
  path: string;
  sha: string;
  label?: string;
  /** Project root that owns this workflow. `undefined` means the global
   *  source (`~/.swarm/workflows/`); a string is the absolute cwd of a
   *  project listed by `GET /projects`. Workflow names are unique within
   *  a source but may collide across sources, so the wire identity is
   *  `(name, cwd)` — list consumers must show the cwd to disambiguate. */
  cwd?: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  source: string;
  /** Parsed `inputs:` block from the workflow source. Absent when the
   *  workflow declares no inputs or the source failed to parse. */
  inputs?: InputDecl[];
}

export interface WorkflowReadOptions {
  /** When set, restrict lookup to the named project. `undefined` resolves
   *  global first, then projects in `listCwds()` order; first hit wins. */
  cwd?: string;
}

export interface WorkflowReader {
  list(): Promise<WorkflowSummary[]>;
  read(name: string, opts?: WorkflowReadOptions): Promise<WorkflowDetail | undefined>;
}

/** One row in `GET /projects/:id/tree`. The list is flat — every file
 *  plus every ancestor directory it implies — so the web can fold the
 *  tree client-side without us picking a transport-specific shape. */
export interface ProjectTreeEntry {
  path: string;
  type: "file" | "dir";
}

/** Outcome of `readBlob`. Each kind maps to a distinct HTTP status at
 *  the route layer (`ok` → 200 text/plain, `not_found` → 404,
 *  `too_large` → 413, `binary` → 415, `invalid_path` → 400). */
export type ReadBlobResult =
  | { kind: "ok"; text: string }
  | { kind: "not_found" }
  | { kind: "too_large" }
  | { kind: "binary" }
  | { kind: "invalid_path" };

export interface ProjectTreeReader {
  /** Enumerate files under `cwd`. Honours `.gitignore` when `cwd` is a
   *  git repo; falls back to a recursive dir-walk otherwise. */
  list(cwd: string): Promise<ProjectTreeEntry[]>;
  /** Read a project-relative file as utf-8 text, with size + binary
   *  guards. The same path-traversal checks the route layer applies
   *  are repeated here so the adapter is safe in isolation. */
  readBlob(cwd: string, relPath: string): Promise<ReadBlobResult>;
}

/** One row in `GET /runs/:id/snapshots/:eventIdx/tree`. `size` is 0
 *  for tree and commit entries (git ls-tree -l only emits sizes for
 *  blobs). `mode` is the six-digit octal string git prints. */
export interface SnapshotTreeEntry {
  path: string;
  mode: string;
  size: number;
  type: "blob" | "tree" | "commit";
}

/** Adapter for snapshot-specific git reads against the run's project
 *  git dir. All operations are pure object-database queries (ls-tree,
 *  show, diff) — no checkout, no worktree mutation. */
export interface RunSnapshotReader {
  /** `git ls-tree -l -z <commitSha>` from `cwd`. Returns null when git
   *  is unavailable or the sha doesn't resolve. */
  lsTree(cwd: string, commitSha: string): Promise<{ entries: SnapshotTreeEntry[] } | null>;
  /** `git show <commitSha>:<path>` from `cwd`. */
  showFile(
    cwd: string,
    commitSha: string,
    path: string,
  ): Promise<{ kind: "ok"; bytes: Buffer } | { kind: "not_found" } | { kind: "too_large" }>;
  /** `git diff <fromSha> <toSha> [-- <path>]` from `cwd`. Returns empty
   *  string when there are no changes or git fails. */
  diff(cwd: string, fromSha: string, toSha: string, path?: string): Promise<string>;
  /** Whether merging `headsRef` into `intoRef` is a fast-forward and/or
   *  conflicts — used by `POST /runs/:id/merge` to refuse a non-ff or
   *  conflicting merge synchronously. `resolved: false` when either ref is
   *  missing (no committed work / target branch gone). Pure object-DB reads
   *  (`merge-base --is-ancestor`, `merge-tree --write-tree`). */
  mergeability(
    cwd: string,
    intoRef: string,
    headsRef: string,
  ): Promise<{ resolved: false } | { resolved: true; ff: boolean; conflict: boolean }>;
  /** Whether `ref` resolves in `cwd` — used by `POST /runs/:id/branch` to
   *  refuse a name collision synchronously (without `--force`) instead of
   *  letting the daemon silently no-op. */
  refExists(cwd: string, ref: string): Promise<boolean>;
}

export interface ServerPorts {
  workflowReader?: WorkflowReader;
  projectTreeReader?: ProjectTreeReader;
  runSnapshotReader?: RunSnapshotReader;
  daemonInfo?: () => HealthDaemonInfo | Promise<HealthDaemonInfo>;
}
