// Public entry point for @swarm/server.
//
// Exports a `createServer(opts)` factory that returns a configured Hono app.
// The new shape is DB-first: the store is required; the fs-based
// RunReader is gone. WorkflowReader (listing DOT files on disk) is
// still optional for the Workflows page.

import { Hono } from "hono";
import type { IEventStore } from "@swarm/store";
import { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
import type { ServerPorts, WorkflowReader } from "./ports.ts";
import { healthRoutes } from "./routes/health.ts";
import { workflowsRoutes } from "./routes/workflows.ts";
import { storePipelinesRoutes } from "./store/pipelines-routes.ts";
import { createRoutes as createStoreRoutes } from "./store/routes.ts";

export interface ServerOptions {
  /** SQLite event store — the backbone for all reads and intent writes. */
  store: IEventStore;
  /** Directory with `*.dot` workflow sources listed by `GET /workflows`. */
  workflowsDir?: string;
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Optional port overrides. Any omitted port falls back to defaults. */
  ports?: ServerPorts;
}

export function createServer(opts: ServerOptions): Hono {
  const ports = opts.ports ?? {};
  const workflowsDir = opts.workflowsDir ?? "workflows";
  const workflowReader: WorkflowReader =
    ports.workflowReader ?? createFsWorkflowReader({ workflowsDir });

  const app = new Hono();
  app.route(
    "/",
    healthRoutes(
      ports.daemonInfo !== undefined ? { daemonInfo: ports.daemonInfo } : {},
    ),
  );
  app.route("/", workflowsRoutes({ workflowReader }));
  app.route(
    "/",
    storePipelinesRoutes({ store: opts.store, workflowReader }),
  );
  app.route("/", createStoreRoutes({ store: opts.store }));
  return app;
}

export { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
export type {
  ServerPorts,
  WorkflowDetail,
  WorkflowReader,
  WorkflowSummary,
} from "./ports.ts";
export type { HealthDaemonInfo } from "./routes/health.ts";
export {
  ErrorBody,
  NodeState,
  PipelineDetail,
  PipelineSummary,
} from "./schemas.ts";
export { createRoutes as createStoreRoutes, newRunId } from "./store/index.ts";
export { storePipelinesRoutes } from "./store/pipelines-routes.ts";
export type { ServerDeps } from "./store/index.ts";
export {
  listRuns as listStoreRuns,
  mapStatus,
  runStateToDetail,
  runStateToSummary,
} from "./store/pipelines-adapter.ts";
