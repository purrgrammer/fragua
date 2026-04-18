// Public entry point for @swarm/server.
//
// Exports a `createServer(opts)` factory that returns a configured Hono app.
// The factory is intentionally pure: it does not bind to a port. Callers
// (tests, the CLI `serve` command, future adapters) decide how to serve —
// `Bun.serve({ fetch: app.fetch })` or `@hono/node-server` both work.
//
// Ports can be overridden for tests; defaults wire up filesystem-backed
// adapters so the production path stays zero-config.

import type { SkillsConfig } from "@swarm/workspace";
import { Hono } from "hono";
import { createDiscoverSkillReader } from "./adapters/discover-skill-reader.ts";
import { createEventInterviewGateway } from "./adapters/event-interview-gateway.ts";
import { createFsControlGateway } from "./adapters/fs-control-gateway.ts";
import { createFsRunReader } from "./adapters/fs-run-reader.ts";
import { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
import type {
  ControlGateway,
  InterviewGateway,
  RunReader,
  ServerPorts,
  SkillReader,
  WorkflowReader,
} from "./ports.ts";
import { controlRoutes } from "./routes/control.ts";
import { eventsRoutes } from "./routes/events.ts";
import { healthRoutes } from "./routes/health.ts";
import { interviewRoutes } from "./routes/interview.ts";
import { pipelinesRoutes } from "./routes/pipelines.ts";
import { skillsRoutes } from "./routes/skills.ts";
import { statsRoutes } from "./routes/stats.ts";
import { workflowsRoutes } from "./routes/workflows.ts";

export interface ServerOptions {
  /**
   * Directory containing per-run subdirectories with `events.jsonl`.
   * Usually `.swarm/runs/` from the project root.
   */
  runsDir: string;
  /**
   * Directory containing `*.dot` workflow sources listed by
   * `GET /workflows`. Defaults to `"workflows"` relative to the runtime
   * working directory — matches the repo convention.
   */
  workflowsDir?: string;
  /** Project root used for skill discovery (`.swarm/skills`, etc.).
   * Defaults to `process.cwd()`. */
  cwd?: string;
  /** Merged `skills` block from `.swarm/config.yaml`. When omitted the
   * default adapter auto-discovers every well-known path. */
  skillsConfig?: SkillsConfig;
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
  const workflowsDir = opts.workflowsDir ?? "workflows";
  const cwd = opts.cwd ?? process.cwd();
  const runReader: RunReader = ports.runReader ?? createFsRunReader({ runsDir: opts.runsDir });
  const interviewGateway: InterviewGateway =
    ports.interviewGateway ??
    createEventInterviewGateway({
      runReader,
      ...(ports.eventSink ? { eventSink: ports.eventSink } : {}),
    });
  const workflowReader: WorkflowReader = ports.workflowReader ?? createFsWorkflowReader({ workflowsDir });
  const controlGateway: ControlGateway =
    ports.controlGateway ?? createFsControlGateway({ runsDir: opts.runsDir, runReader });
  const skillReader: SkillReader =
    ports.skillReader ??
    createDiscoverSkillReader({
      cwd,
      ...(opts.skillsConfig !== undefined ? { config: opts.skillsConfig } : {}),
    });

  const app = new Hono();
  app.route("/", healthRoutes());
  app.route("/", eventsRoutes({ runsDir: opts.runsDir }));
  app.route("/", pipelinesRoutes({ runReader }));
  app.route("/", statsRoutes({ runReader }));
  app.route("/", interviewRoutes({ runReader, interviewGateway }));
  app.route("/", workflowsRoutes({ workflowReader }));
  app.route("/", controlRoutes({ controlGateway }));
  app.route("/", skillsRoutes({ skillReader, runReader }));
  return app;
}

export { createDiscoverSkillReader } from "./adapters/discover-skill-reader.ts";
export { createEventInterviewGateway } from "./adapters/event-interview-gateway.ts";
export { createFsControlGateway } from "./adapters/fs-control-gateway.ts";
export { createFsRunReader } from "./adapters/fs-run-reader.ts";
export { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
export type {
  ControlGateway,
  ControlSubmitResult,
  InterviewAnswerResult,
  InterviewGateway,
  PendingQuestion,
  RunReader,
  ServerPorts,
  SkillDetail,
  SkillReader,
  SkillSummary,
  WorkflowReader,
  WorkflowSummary,
} from "./ports.ts";
export type { EventsRouteOptions } from "./routes/events.ts";
export { deriveDetail, deriveSummary } from "./routes/pipelines.ts";
export {
  ControlAccepted,
  ControlCancelBody,
  ControlPauseBody,
  ControlSteerBody,
  ErrorBody,
  InterviewAnswer,
  InterviewQuestion,
  NodeState,
  PipelineDetail,
  PipelineSummary,
  SkillDetailSchema,
  SkillSummarySchema,
  StatsPayload,
} from "./schemas.ts";
