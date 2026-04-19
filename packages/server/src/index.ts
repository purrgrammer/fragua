// Public entry point for @swarm/server.
//
// Exports a `createServer(opts)` factory that returns a configured Hono app.
// Pure factory: it does not bind to a port. Callers (tests, the CLI
// `serve` command, future adapters) decide how to serve — `Bun.serve({
// fetch: app.fetch })` or `@hono/node-server` both work.

import { Hono } from "hono";
import type { IEventStore } from "@swarm/store";
import { createFsRunReader } from "./adapters/fs-run-reader.ts";
import { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
import type { RunReader, ServerPorts, WorkflowReader } from "./ports.ts";
import { healthRoutes } from "./routes/health.ts";
import { pipelinesRoutes } from "./routes/pipelines.ts";
import { workflowsRoutes } from "./routes/workflows.ts";
import { createRoutes as createStoreRoutes } from "./store/routes.ts";

export interface ServerOptions {
  /** Directory with legacy per-run JSONL (used only until M5 cutover). */
  runsDir: string;
  /** Directory with `*.dot` workflow sources listed by `GET /workflows`. */
  workflowsDir?: string;
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Optional port overrides. Any omitted port falls back to defaults. */
  ports?: ServerPorts;
  /**
   * SQLite event store (packages/store). When provided, `/runs` and
   * `/runs/:id/*` are served by the DB-backed routes (intent writes, SSE,
   * metrics). Omit to run in legacy fs-only mode.
   */
  store?: IEventStore;
}

export function createServer(opts: ServerOptions): Hono {
  const ports = opts.ports ?? {};
  const workflowsDir = opts.workflowsDir ?? "workflows";
  const runReader: RunReader =
    ports.runReader ?? createFsRunReader({ runsDir: opts.runsDir });
  const workflowReader: WorkflowReader =
    ports.workflowReader ?? createFsWorkflowReader({ workflowsDir });

  const app = new Hono();
  app.route(
    "/",
    healthRoutes(
      ports.daemonInfo !== undefined ? { daemonInfo: ports.daemonInfo } : {},
    ),
  );
  app.route("/", pipelinesRoutes({ runReader }));
  app.route("/", workflowsRoutes({ workflowReader }));
  if (opts.store) {
    app.route("/", createStoreRoutes({ store: opts.store }));
  }
  return app;
}

export { createFsRunReader } from "./adapters/fs-run-reader.ts";
export { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
export type {
  RunReader,
  ServerPorts,
  WorkflowDetail,
  WorkflowReader,
  WorkflowSummary,
} from "./ports.ts";
export type { HealthDaemonInfo } from "./routes/health.ts";
export { deriveDetail, deriveSummary } from "./routes/pipelines.ts";
export {
  ErrorBody,
  NodeState,
  PipelineDetail,
  PipelineSummary,
} from "./schemas.ts";
export { createRoutes as createStoreRoutes, newRunId } from "./store/index.ts";
export type { ServerDeps } from "./store/index.ts";
