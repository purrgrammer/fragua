// Server ports. Under the store-backed architecture the only port we keep
// is WorkflowReader — listing workflow files on disk for the Workflows page.
// Everything else reads directly from @swarm/store.

import type { HealthDaemonInfo } from "./routes/health.ts";

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

export interface ServerPorts {
  workflowReader?: WorkflowReader;
  projectTreeReader?: ProjectTreeReader;
  daemonInfo?: () => HealthDaemonInfo | Promise<HealthDaemonInfo>;
}
