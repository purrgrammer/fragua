// GET /workflows — list workflow sources (typically `*.dot` under the
// configured `workflowsDir`). Delegates all I/O to an injected
// `WorkflowReader` port so tests can drive the handler with an in-memory
// fake.
//
// GET /workflows/:name — single workflow with its raw DOT source for the
// web detail page. 404 when the workflow is unknown; the name grammar is
// enforced in the adapter (defence-in-depth — handlers stay pure).

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

  app.get("/workflows/:name", async (c) => {
    const name = c.req.param("name");
    const detail = await opts.workflowReader.read(name);
    if (!detail) return c.json({ error: "not_found", name }, 404);
    return c.json(detail);
  });

  return app;
}
