// GET /workflows — list workflow sources (typically `*.dot` under the
// configured `workflowsDir`). Delegates all I/O to an injected
// `WorkflowReader` port so tests can drive the handler with an in-memory
// fake.

import { Hono } from "hono";
import type { WorkflowReader } from "../ports.ts";

export interface WorkflowsRouteOptions {
  workflowReader: WorkflowReader;
}

export function workflowsRoutes(opts: WorkflowsRouteOptions): Hono {
  const app = new Hono();

  app.get("/workflows", async (c) => {
    const list = await opts.workflowReader.list();
    return c.json(list);
  });

  return app;
}
