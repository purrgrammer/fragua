// Server ports. Under the store-backed architecture the only port we keep
// is WorkflowReader — listing DOT files on disk for the Workflows page.
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

export interface ServerPorts {
  workflowReader?: WorkflowReader;
  daemonInfo?: () => HealthDaemonInfo | Promise<HealthDaemonInfo>;
}
