// POST   /jobs            — enqueue a workflow run
// GET    /jobs            — list jobs, optionally filtered by status
// GET    /jobs/:id        — load one row
// DELETE /jobs/:id        — cancel (queued → remove; running → control.cancel)
//                             [DELETE lands in phase 5; this file stubs it as 501]
//
// Every handler is a thin adapter over a `JobQueue` port. The routes are
// registered unconditionally by `createServer`; when no queue is injected
// (foreground `swarm serve` with no daemon) each handler returns 503 so
// the web UI can surface "daemon not running" clearly.
//
// POST responses include both `jobId` and `runId` so callers can deep-link
// to `/pipelines/:runId/events` without a second round-trip.

import { Value } from "@sinclair/typebox/value";
import { Hono } from "hono";
import type { ControlGateway, JobQueue, JobRow, JobStatus, WorkflowReader } from "../ports.ts";
import { JobEnqueueBody, type JobRowSchema } from "../schemas.ts";

export interface JobsRouteOptions {
  /** Optional — undefined when the server runs without a daemon (e.g.
   * plain `swarm serve` for dev). Routes return 503 when unset. */
  jobQueue?: JobQueue;
  /** ControlGateway for forwarding cancel requests to running workers.
   * Same instance the `/pipelines/:id/cancel` route uses. When unset,
   * cancel of running jobs returns 501. */
  controlGateway?: ControlGateway;
  /** Used by POST /jobs to resolve bare workflow names (e.g. "build-feature")
   * to the filesystem path the worker expects. Clients that already send a
   * path (the CLI) bypass the lookup. */
  workflowReader?: WorkflowReader;
}

export function jobsRoutes(opts: JobsRouteOptions): Hono {
  const app = new Hono();
  const queue = opts.jobQueue;

  app.post("/jobs", async (c) => {
    if (!queue) return noQueue(c);
    const body = await parseJsonBody(c.req.raw);
    if (body === null) return c.json(bad("invalid JSON body"), 400);
    if (!Value.Check(JobEnqueueBody, body)) {
      return c.json(schemaError(JobEnqueueBody, body), 400);
    }
    // Accept either a path (e.g. "workflows/build.dot", "/abs/foo.dot")
    // or a bare name ("build-feature") for the `workflow` field. Bare
    // names go through the WorkflowReader so the daemon's cwd doesn't
    // have to match the client's — the CLI already resolves to an
    // absolute path and skips this branch.
    let workflow = body.workflow;
    if (isBareWorkflowName(workflow)) {
      if (!opts.workflowReader) {
        return c.json(
          { error: `workflow '${workflow}' requires a path; server has no workflow reader`, code: "bad_request" },
          400,
        );
      }
      const list = await opts.workflowReader.list();
      const match = list.find((w) => w.name === workflow);
      if (!match) {
        return c.json({ error: `workflow not found: ${workflow}`, code: "not_found" }, 404);
      }
      workflow = match.path;
    }
    try {
      const row = await queue.enqueue({
        workflow,
        ...(body.input !== undefined ? { inputJson: body.input } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.runId !== undefined ? { runId: body.runId } : {}),
        ...(body.id !== undefined ? { id: body.id } : {}),
        ...(body.worktree !== undefined ? { worktree: body.worktree } : {}),
      });
      return c.json({ jobId: row.id, runId: row.runId }, 202);
    } catch (err) {
      // UNIQUE constraint on id or runId → 409 so clients can safely retry.
      const msg = (err as Error).message ?? String(err);
      if (/unique|constraint/i.test(msg)) {
        return c.json({ error: "job id or run id already exists", code: "conflict" }, 409);
      }
      return c.json({ error: msg, code: "internal" }, 500);
    }
  });

  /** A bare name has no path separators and no `.dot` extension. Both are
   * the signals the CLI uses today to distinguish paths from names. */
  function isBareWorkflowName(value: string): boolean {
    return !value.includes("/") && !value.includes("\\") && !value.endsWith(".dot");
  }

  app.get("/jobs", async (c) => {
    if (!queue) return noQueue(c);
    const statusRaw = c.req.query("status");
    const limitRaw = c.req.query("limit");
    let status: JobStatus | undefined;
    if (statusRaw !== undefined) {
      if (!isJobStatus(statusRaw)) {
        return c.json(bad(`invalid status: ${statusRaw}`), 400);
      }
      status = statusRaw;
    }
    const limit = clampLimit(limitRaw);
    const rows = await queue.list({ ...(status !== undefined ? { status } : {}), limit });
    return c.json(rows.map(toWire));
  });

  app.get("/jobs/:id", async (c) => {
    if (!queue) return noQueue(c);
    const row = await queue.get(c.req.param("id"));
    if (!row) return c.json({ error: "job not found", code: "not_found" }, 404);
    return c.json(toWire(row));
  });

  // DELETE /jobs/:id
  //   queued      → remove from queue outright, 200
  //   running     → forward cancel to the control gateway, 202
  //                 (the child emits pipeline.canceled → scheduler
  //                  reconciles the job row to status='canceled')
  //   terminal    → 409
  //   not found   → 404
  app.delete("/jobs/:id", async (c) => {
    if (!queue) return noQueue(c);
    const row = await queue.get(c.req.param("id"));
    if (!row) return c.json({ error: "job not found", code: "not_found" }, 404);
    if (row.status === "queued") {
      await queue.delete(row.id);
      return c.json({ status: "removed", jobId: row.id }, 200);
    }
    if (row.status === "running") {
      if (!opts.controlGateway) {
        return c.json(
          { error: "cancel of running jobs requires a control gateway", code: "not_implemented" },
          501,
        );
      }
      const reason = c.req.query("reason");
      const result = await opts.controlGateway.cancel(row.runId, reason);
      if (!result.ok) {
        if (result.code === "not_found") {
          // Rare but possible: job exists in DB but .swarm/runs/<runId>/
          // hasn't been created yet (worker crashed before emitting any
          // events). Treat as a no-op cancel — mark the job canceled
          // directly so the caller isn't blocked.
          await queue.markTerminal(row.id, "canceled", "canceled before worker wrote events");
          return c.json({ status: "canceled", jobId: row.id }, 200);
        }
        return c.json({ error: "cancel failed", code: "internal" }, 500);
      }
      return c.json({ status: "canceling", jobId: row.id, requestId: result.id }, 202);
    }
    return c.json(
      { error: `cannot delete job in terminal state '${row.status}'`, code: "conflict" },
      409,
    );
  });

  return app;
}

/** Map the internal JobRow to the wire shape (inputJson → input). */
function toWire(row: JobRow): JobRowSchema {
  const wire: JobRowSchema = {
    id: row.id,
    runId: row.runId,
    workflow: row.workflow,
    status: row.status,
    priority: row.priority,
    enqueuedAt: row.enqueuedAt,
    worktree: row.worktree,
  };
  if (row.inputJson !== undefined) wire.input = row.inputJson;
  if (row.model !== undefined) wire.model = row.model;
  if (row.startedAt !== undefined) wire.startedAt = row.startedAt;
  if (row.completedAt !== undefined) wire.completedAt = row.completedAt;
  if (row.childPid !== undefined) wire.childPid = row.childPid;
  if (row.error !== undefined) wire.error = row.error;
  return wire;
}

function isJobStatus(s: string): s is JobStatus {
  return s === "queued" || s === "running" || s === "success" || s === "failed" || s === "canceled";
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 100);
}

async function parseJsonBody(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function bad(message: string): { error: string; code: string } {
  return { error: message, code: "bad_request" };
}

// biome-ignore lint/suspicious/noExplicitAny: TypeBox schema is broad; untyped equivalent.
function schemaError(schema: any, raw: unknown) {
  const errors = [...Value.Errors(schema, raw)].slice(0, 5).map((e) => ({ path: e.path, message: e.message }));
  return { error: "invalid request body", code: "bad_request", details: { errors } };
}

// biome-ignore lint/suspicious/noExplicitAny: Hono's context is fine untyped here.
function noQueue(c: any) {
  return c.json(
    {
      error: "job queue not available — the daemon is not running",
      code: "service_unavailable",
    },
    503,
  );
}
