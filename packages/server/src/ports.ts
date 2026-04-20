// Server ports. Under the store-backed architecture the only port we keep
// is WorkflowReader — listing DOT files on disk for the Workflows page.
// Everything else reads directly from @swarm/store.

import type { HealthDaemonInfo } from "./routes/health.ts";

export interface WorkflowSummary {
  name: string;
  path: string;
  sha: string;
  label?: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  source: string;
}

export interface WorkflowReader {
  list(): Promise<WorkflowSummary[]>;
  read(name: string): Promise<WorkflowDetail | undefined>;
}

export interface ServerPorts {
  workflowReader?: WorkflowReader;
  daemonInfo?: () => HealthDaemonInfo | Promise<HealthDaemonInfo>;
}
