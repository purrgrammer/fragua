// POST /pipelines/:runId/steer   — inject a user message at next turn
// POST /pipelines/:runId/pause   — soft-pause at next node boundary
// POST /pipelines/:runId/resume  — wake a paused run
// POST /pipelines/:runId/cancel  — graceful cancel; emits pipeline.canceled
//
// Every endpoint is a thin adapter over a `ControlGateway` port; see
// adapters/fs-control-gateway.ts for the default (filesystem-backed)
// implementation. The route layer only validates the request body and
// translates gateway results into HTTP status codes.
//
// On success each endpoint returns 202 + `{ id }` — the uuid assigned
// to the request. That id appears on the run's `control.requested`
// and `control.applied` events so clients can correlate acknowledgment
// back through the event stream without re-reading control.jsonl.

import { Value } from "@sinclair/typebox/value";
import { Hono } from "hono";
import type { ControlGateway, ControlSubmitResult } from "../ports.ts";
import { ControlCancelBody, ControlPauseBody, ControlSteerBody } from "../schemas.ts";

export interface ControlRouteOptions {
  controlGateway: ControlGateway;
}

export function controlRoutes(opts: ControlRouteOptions): Hono {
  const app = new Hono();

  app.post("/pipelines/:runId/steer", async (c) => {
    const runId = c.req.param("runId");
    const body = await parseBody(c.req.raw);
    if (body === null) return c.json(bad("invalid JSON body"), 400);
    if (!Value.Check(ControlSteerBody, body)) {
      return c.json(schemaError(ControlSteerBody, body), 400);
    }
    const result = await opts.controlGateway.steer(runId, body.message);
    return renderResult(c, result, { runId });
  });

  app.post("/pipelines/:runId/pause", async (c) => {
    const runId = c.req.param("runId");
    const body = await parseBodyOrEmpty(c.req.raw);
    if (body === null) return c.json(bad("invalid JSON body"), 400);
    if (!Value.Check(ControlPauseBody, body)) {
      return c.json(schemaError(ControlPauseBody, body), 400);
    }
    const result = await opts.controlGateway.pause(runId, body.reason);
    return renderResult(c, result, { runId });
  });

  app.post("/pipelines/:runId/resume", async (c) => {
    const runId = c.req.param("runId");
    const result = await opts.controlGateway.resume(runId);
    return renderResult(c, result, { runId });
  });

  app.post("/pipelines/:runId/cancel", async (c) => {
    const runId = c.req.param("runId");
    const body = await parseBodyOrEmpty(c.req.raw);
    if (body === null) return c.json(bad("invalid JSON body"), 400);
    if (!Value.Check(ControlCancelBody, body)) {
      return c.json(schemaError(ControlCancelBody, body), 400);
    }
    const result = await opts.controlGateway.cancel(runId, body.reason);
    return renderResult(c, result, { runId });
  });

  return app;
}

// biome-ignore lint/suspicious/noExplicitAny: Hono's untyped context is fine here; the narrow surface we use is stable.
function renderResult(c: any, result: ControlSubmitResult, ctx: { runId: string }) {
  if (result.ok) return c.json({ id: result.id }, 202);
  if (result.code === "not_found") {
    return c.json({ error: "run not found", code: "not_found", details: ctx }, 404);
  }
  return c.json({ error: "unknown error", code: "internal" }, 500);
}

function bad(message: string): { error: string; code: string } {
  return { error: message, code: "bad_request" };
}

// biome-ignore lint/suspicious/noExplicitAny: TypeBox's generic schema parameter is broad; untyped here is equivalent.
function schemaError(schema: any, raw: unknown) {
  const errors = [...Value.Errors(schema, raw)].slice(0, 5).map((e) => ({ path: e.path, message: e.message }));
  return { error: "invalid request body", code: "bad_request", details: { errors } };
}

/** POST /steer body is required; refuse an empty body. */
async function parseBody(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** POST /pause, /cancel bodies are optional — treat an empty body as `{}`
 * so the reason field is simply absent. */
async function parseBodyOrEmpty(req: Request): Promise<unknown | null> {
  const text = await req.text();
  if (!text || text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
