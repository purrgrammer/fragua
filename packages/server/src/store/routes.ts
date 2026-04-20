// DB-backed HTTP routes — REARCHITECTURE.md §7.
//
// All writes are intents (writer: "web"). Daemon-facing facts are never
// written here. Reads hit the store projection directly and work even when
// the daemon is offline.

import type { Database } from "bun:sqlite";
import { type IEventStore, type StoredEvent, sha256Hex } from "@swarm/store";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { newRunId } from "./run-id.ts";

export interface ServerDeps {
  store: IEventStore;
  /** Poll interval for SSE streams in ms. */
  ssePollMs?: number;
  /** Used by tests to deterministically cap stream lifetimes. */
  now?: () => number;
}

const DEFAULT_SSE_POLL_MS = 100;

export function createRoutes(deps: ServerDeps): Hono {
  const app = new Hono();
  const pollMs = deps.ssePollMs ?? DEFAULT_SSE_POLL_MS;

  // ─── Workflow upload ────────────────────────────────────────

  app.post("/workflows", async (c) => {
    const body = await readJson<{ name?: string; dotSource?: string }>(c);
    if (
      !body ||
      typeof body.name !== "string" ||
      body.name.length === 0 ||
      typeof body.dotSource !== "string" ||
      body.dotSource.length === 0
    ) {
      return c.json({ error: "name and dotSource required" }, 400);
    }
    const sha = sha256Hex(body.dotSource);
    deps.store.saveWorkflow(sha, body.name, body.dotSource);
    return c.json({ sha, name: body.name });
  });

  // ─── Writes (intents) ───────────────────────────────────────

  app.post("/runs", async (c) => {
    const body = await readJson<{
      workflowSha: string;
      priority?: number;
      runId?: string;
      routing?: Record<string, unknown>;
    }>(c);
    if (!body || typeof body.workflowSha !== "string") {
      return c.json({ error: "workflowSha required" }, 400);
    }
    const runId = body.runId ?? newRunId();
    try {
      deps.store.enqueueRun({
        runId,
        workflowSha: body.workflowSha,
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.routing !== undefined ? { initialRouting: body.routing } : {}),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ runId });
  });

  app.post("/runs/:id/steer", async (c) => {
    const body = await readJson<{ text?: string }>(c);
    if (!body || typeof body.text !== "string" || body.text.length === 0) {
      return c.json({ error: "text required" }, 400);
    }
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.steering_requested",
      payload: { text: body.text },
    });
    return c.json({ seq });
  });

  app.post("/runs/:id/pause", (c) => {
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.pause_requested",
      payload: {},
    });
    return c.json({ seq });
  });

  app.post("/runs/:id/cancel", async (c) => {
    const body = (await readJson<{ reason?: string }>(c)) ?? {};
    const payload: { reason?: string } = {};
    if (typeof body.reason === "string") payload.reason = body.reason;
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.cancel_requested",
      payload,
    });
    return c.json({ seq });
  });

  app.post("/runs/:id/hitl", async (c) => {
    const body = await readJson<{ input: unknown }>(c);
    if (!body || !("input" in body)) {
      return c.json({ error: "input required" }, 400);
    }
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.hitl_input",
      payload: { input: body.input },
    });
    return c.json({ seq });
  });

  app.post("/runs/:id/unquarantine", async (c) => {
    const body = await readJson<{
      resolution?: "treat_as_done" | "retry" | "cancel";
      note?: string;
    }>(c);
    if (!body || (body.resolution !== "treat_as_done" && body.resolution !== "retry" && body.resolution !== "cancel")) {
      return c.json({ error: "resolution required" }, 400);
    }
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.unquarantine",
      payload: { resolution: body.resolution, note: body.note ?? "" },
    });
    return c.json({ seq });
  });

  app.post("/runs/:id/priority", async (c) => {
    const body = await readJson<{ newPriority?: number; note?: string }>(c);
    if (!body || typeof body.newPriority !== "number") {
      return c.json({ error: "newPriority required" }, 400);
    }
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.priority_adjusted",
      payload: { newPriority: body.newPriority, note: body.note ?? "" },
    });
    return c.json({ seq });
  });

  // ─── Reads ──────────────────────────────────────────────────
  //
  // `GET /runs/:id` is served by `storeRunsRoutes` (RunDetail shape).
  // Raw events + messages stay here because they want `since`/`limit`
  // pagination that the detail adapter doesn't expose.

  app.get("/runs/:id/events", (c) => {
    const sinceSeq = Number(c.req.query("since") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 1000), 5000);
    const events = deps.store.getEvents(c.req.param("id"), {
      sinceSeq,
      limit,
    });
    return c.json(events);
  });

  app.get("/runs/:id/messages", (c) => {
    const since = Number(c.req.query("since") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 1000), 5000);
    const msgs = deps.store.getMessages(c.req.param("id"), {
      sinceOrdinal: since,
      limit,
    });
    return c.json(msgs);
  });

  // ─── SSE stream ─────────────────────────────────────────────

  app.get("/runs/:id/stream", (c) =>
    streamSSE(c, async (stream) => {
      const runId = c.req.param("id");
      const lastEventId = c.req.header("Last-Event-ID");
      let lastSeq = lastEventId != null ? Number(lastEventId) : 0;
      if (!Number.isFinite(lastSeq) || lastSeq < 0) lastSeq = 0;

      while (!stream.aborted) {
        const batch = deps.store.getEvents(runId, {
          sinceSeq: lastSeq,
          limit: 500,
        });
        for (const event of batch) {
          await stream.writeSSE({
            id: String(event.seq),
            event: event.type,
            data: serializeEvent(event),
          });
          lastSeq = event.seq;
        }
        if (batch.length === 0) await stream.sleep(pollMs);
      }
    }),
  );

  // ─── Store-level metrics (performance) ──────────────────────

  app.get("/metrics/store", (c) => {
    const store = deps.store as unknown as {
      metricsSnapshot?: () => unknown;
    };
    if (typeof store.metricsSnapshot !== "function") {
      return c.json({ error: "metrics unavailable" }, 503);
    }
    return c.json(store.metricsSnapshot());
  });

  // ─── Aggregate metrics (dashboard) ──────────────────────────

  app.get("/metrics/global", (c) => {
    const windowHours = Number(c.req.query("windowHours") ?? 24 * 30);
    const cutoffMs = (deps.now?.() ?? Date.now()) - windowHours * 3_600_000;
    const db = unsafeDb(deps.store);
    if (db == null) return c.json({ error: "metrics unavailable" }, 503);

    const global = db
      .query<
        {
          total_runs: number;
          total_usd: number | null;
          total_tokens: number | null;
          successful: number;
          halted: number;
          running: number;
          queued: number;
          paused: number;
          quarantined: number;
        },
        [number]
      >(
        `SELECT
           COUNT(*) AS total_runs,
           SUM(total_cost_usd) AS total_usd,
           SUM(total_tokens)   AS total_tokens,
           SUM(CASE WHEN status = 'completed'  THEN 1 ELSE 0 END) AS successful,
           SUM(CASE WHEN status = 'halted'     THEN 1 ELSE 0 END) AS halted,
           SUM(CASE WHEN status = 'running'    THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status = 'queued'     THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'paused_hitl' THEN 1 ELSE 0 END) AS paused,
           SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS quarantined
         FROM run_state
         WHERE updated_at >= ?`,
      )
      .get(cutoffMs) ?? {
      total_runs: 0,
      total_usd: 0,
      total_tokens: 0,
      successful: 0,
      halted: 0,
      running: 0,
      queued: 0,
      paused: 0,
      quarantined: 0,
    };

    // Per-model breakdown via json_each pivot.
    const models = db
      .query<{ model_name: string; tokens: number; cost_usd: number }, [number]>(
        `SELECT
           kv.key  AS model_name,
           SUM(CAST(json_extract(kv.value, '$.tokens') AS INTEGER))  AS tokens,
           SUM(CAST(json_extract(kv.value, '$.costUsd') AS REAL))    AS cost_usd
         FROM run_state, json_each(run_state.metrics, '$.models') AS kv
         WHERE updated_at >= ?
         GROUP BY kv.key
         ORDER BY cost_usd DESC`,
      )
      .all(cutoffMs);

    return c.json({
      ...global,
      breakdownByModel: models,
    });
  });

  return app;
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

function serializeEvent(event: StoredEvent): string {
  return JSON.stringify({
    runId: event.runId,
    seq: event.seq,
    type: event.type,
    writer: event.writer,
    payload: event.payload,
    ts: event.ts,
  });
}

function unsafeDb(store: IEventStore): Database | null {
  const raw = (store as unknown as { db?: Database }).db;
  return raw ?? null;
}
