// GET  /pipelines/:runId/interview                → list pending questions
// POST /pipelines/:runId/interview/:questionId    → submit an answer
//
// Both routes route through an `InterviewGateway` port; see
// adapters/event-interview-gateway.ts for the default (events-jsonl-backed)
// implementation. The route layer only knows about the port contract and the
// TypeBox InterviewAnswer schema.

import { Value } from "@sinclair/typebox/value";
import { Hono } from "hono";
import type { InterviewGateway, RunReader } from "../ports.ts";
import { InterviewAnswer, type InterviewQuestion } from "../schemas.ts";

export interface InterviewRouteOptions {
  runReader: RunReader;
  interviewGateway: InterviewGateway;
}

export function interviewRoutes(opts: InterviewRouteOptions): Hono {
  const app = new Hono();

  app.get("/pipelines/:runId/interview", async (c) => {
    const runId = c.req.param("runId");
    // Touch the run first so we can 404 distinct from "no pending questions".
    const events = await opts.runReader.readEvents(runId);
    if (!events) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    const pending = await opts.interviewGateway.pending(runId);
    const body: InterviewQuestion[] = pending.map((q) => ({
      questionId: q.questionId,
      nodeId: q.nodeId,
      text: q.text,
      type: q.type,
      ...(q.options !== undefined ? { options: q.options } : {}),
      stage: q.stage,
      askedAt: q.askedAt,
    }));
    return c.json(body);
  });

  app.post("/pipelines/:runId/interview/:questionId", async (c) => {
    const runId = c.req.param("runId");
    const questionId = c.req.param("questionId");

    // TypeBox-validate the body. We accept either application/json or an
    // empty body with nothing to validate — fail hard on the latter.
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body", code: "bad_request" }, 400);
    }
    if (!Value.Check(InterviewAnswer, raw)) {
      const errors = [...Value.Errors(InterviewAnswer, raw)].slice(0, 5).map((e) => ({
        path: e.path,
        message: e.message,
      }));
      return c.json({ error: "invalid interview answer", code: "bad_request", details: { errors } }, 400);
    }

    const result = await opts.interviewGateway.answer(runId, questionId, raw);
    if (result.ok) {
      return c.json({ ok: true }, 202);
    }
    const status = result.code === "unknown_question" ? 404 : result.code === "already_answered" ? 409 : 400;
    return c.json({ error: result.message, code: result.code, details: { runId, questionId } }, status);
  });

  return app;
}
