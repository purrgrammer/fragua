// Public entry point for @swarm/server.
//
// Exports a `createServer(opts)` factory that returns a configured Hono app.
// The factory is intentionally pure: it does not bind to a port. Callers
// (tests, the CLI `serve` command, future adapters) decide how to serve —
// `Bun.serve({ fetch: app.fetch })` or `@hono/node-server` both work.
//
// Ports can be overridden for tests; defaults wire up filesystem-backed
// adapters so the production path stays zero-config.

import { Hono } from "hono";
import { createDotGraphRenderer } from "./adapters/dot-graph-renderer.ts";
import { createEventInterviewGateway } from "./adapters/event-interview-gateway.ts";
import { createFsRunReader } from "./adapters/fs-run-reader.ts";
import type { GraphRenderer, InterviewGateway, RunReader, ServerPorts } from "./ports.ts";
import { eventsRoutes } from "./routes/events.ts";
import { graphRoutes } from "./routes/graph.ts";
import { healthRoutes } from "./routes/health.ts";
import { interviewRoutes } from "./routes/interview.ts";
import { pipelinesRoutes } from "./routes/pipelines.ts";

export interface ServerOptions {
  /**
   * Directory containing per-run subdirectories with `events.jsonl`.
   * Usually `.swarm/runs/` from the project root.
   */
  runsDir: string;
  /** Optional port overrides. Any omitted port falls back to defaults. */
  ports?: ServerPorts;
}

/**
 * Build an unbound Hono app. The caller is responsible for listening:
 *
 *   const app = createServer({ runsDir: ".swarm/runs" });
 *   Bun.serve({ port: 3000, fetch: app.fetch });
 */
export function createServer(opts: ServerOptions): Hono {
  const ports = opts.ports ?? {};
  const runReader: RunReader = ports.runReader ?? createFsRunReader({ runsDir: opts.runsDir });
  const graphRenderer: GraphRenderer = ports.graphRenderer ?? createDotGraphRenderer();
  const interviewGateway: InterviewGateway =
    ports.interviewGateway ??
    createEventInterviewGateway({
      runReader,
      ...(ports.eventSink ? { eventSink: ports.eventSink } : {}),
    });

  const app = new Hono();
  app.route("/", healthRoutes());
  app.route("/", eventsRoutes({ runsDir: opts.runsDir }));
  app.route("/", pipelinesRoutes({ runReader }));
  app.route("/", graphRoutes({ runReader, graphRenderer }));
  app.route("/", interviewRoutes({ runReader, interviewGateway }));
  return app;
}

export { createDotGraphRenderer } from "./adapters/dot-graph-renderer.ts";
export { createEventInterviewGateway } from "./adapters/event-interview-gateway.ts";
export { createFsRunReader } from "./adapters/fs-run-reader.ts";
export type {
  GraphRenderer,
  InterviewAnswerResult,
  InterviewGateway,
  PendingQuestion,
  RunReader,
  ServerPorts,
} from "./ports.ts";
export type { EventsRouteOptions } from "./routes/events.ts";
export { deriveDetail, deriveSummary } from "./routes/pipelines.ts";
export {
  ErrorBody,
  InterviewAnswer,
  InterviewQuestion,
  NodeState,
  PipelineDetail,
  PipelineSummary,
} from "./schemas.ts";
