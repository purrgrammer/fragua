// Schedule routes \u2014 docs/proposals/scheduled-runs.md.
//
// CRUD over the `schedules` table plus pause/resume verbs. Each
// mutation writes a matching `intent.schedule_*` audit row to
// `daemon_events` so the daemon-side log is queryable. Schedule\n// rows themselves are the canonical state \u2014 the dispatcher fiber\n// picks them up on its next tick. No SSE here; UIs poll
// `GET /schedules` (small surface) or stream daemon events.

import { randomBytes } from "node:crypto";
import type { IEventStore } from "@swarm/store";
import { Hono } from "hono";

/** Whitelist of supported intervals. Proposal pins shorthand to four
 *  values (`30m`, `1h`, `6h`, `24h`) \u2014 cron expressions are explicitly
 *  out of scope. The `interval_ms` column is forward-compatible if cron
 *  is added later. */
const ALLOWED_INTERVALS: Record<string, number> = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

function parseInterval(text: unknown): { ms: number; text: string } | null {
  if (typeof text !== "string") return null;
  const ms = ALLOWED_INTERVALS[text];
  if (ms === undefined) return null;
  return { ms, text };
}

function newScheduleId(): string {
  const buf = randomBytes(6);
  let s = "";
  const alph = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < buf.length; i++) s += alph[buf[i]! % 36];
  return `sch_${s}`;
}

export interface ScheduleRoutesDeps {
  store: IEventStore;
  now?: () => number;
}

export function createScheduleRoutes(deps: ScheduleRoutesDeps): Hono {
  const app = new Hono();
  const now = (): number => (deps.now ?? Date.now)();

  app.post("/schedules", async (c) => {
    const body =
      (await readJson<{
        workflow?: string;
        cwd?: string;
        every?: string;
        input?: string;
        overlap?: string;
        fireOnCreate?: boolean;
      }>(c)) ?? {};

    if (typeof body.workflow !== "string" || body.workflow.length === 0) {
      return c.json({ error: "workflow required" }, 400);
    }
    if (typeof body.cwd !== "string" || body.cwd.length === 0) {
      return c.json({ error: "cwd required" }, 400);
    }
    const interval = parseInterval(body.every);
    if (interval == null) {
      return c.json(
        {
          error: `every must be one of ${Object.keys(ALLOWED_INTERVALS).join(", ")}`,
          code: "invalid_interval",
        },
        400,
      );
    }
    const overlap = body.overlap ?? "skip";
    if (overlap !== "skip" && overlap !== "queue" && overlap !== "concurrent") {
      return c.json({ error: "overlap must be one of skip, queue, concurrent", code: "invalid_overlap" }, 400);
    }
    const fireOnCreate = body.fireOnCreate !== false;
    const id = newScheduleId();
    const ts = now();

    const created = deps.store.createSchedule(
      {
        id,
        workflowRef: body.workflow,
        cwd: body.cwd,
        intervalMs: interval.ms,
        intervalText: interval.text,
        ...(typeof body.input === "string" ? { input: body.input } : {}),
        overlapPolicy: overlap,
        fireOnCreate,
      },
      ts,
    );

    deps.store.appendDaemonEvent({
      type: "intent.schedule_create",
      payload: {
        scheduleId: id,
        workflowRef: body.workflow,
        cwd: body.cwd,
        intervalMs: interval.ms,
        intervalText: interval.text,
        ...(typeof body.input === "string" ? { input: body.input } : {}),
        overlapPolicy: overlap,
        fireOnCreate,
      },
    });

    return c.json(created);
  });

  app.get("/schedules", (c) => {
    const cwd = c.req.query("cwd");
    const rows = deps.store.listSchedules(typeof cwd === "string" ? { cwd } : {});
    // Embed the last-10 run statuses per schedule (the health stripe).
    // Avoids N+1 HTTP calls from the CLI and keeps the contract simple:
    // every schedule row carries its own `recentRuns` array.
    const withStripe = rows.map((s) => ({
      ...s,
      recentRuns: deps.store.getScheduleRuns(s.id, 10),
    }));
    return c.json(withStripe);
  });

  app.get("/schedules/:id/runs", (c) => {
    const id = c.req.param("id");
    const existing = deps.store.getSchedule(id);
    if (existing == null) return c.json({ error: "not found" }, 404);
    const limit = Math.min(Number(c.req.query("limit") ?? 10), 100);
    return c.json(deps.store.getScheduleRuns(id, limit));
  });

  app.delete("/schedules/:id", (c) => {
    const id = c.req.param("id");
    const existing = deps.store.getSchedule(id);
    if (existing == null) return c.json({ error: "not found" }, 404);
    deps.store.deleteSchedule(id);
    deps.store.appendDaemonEvent({
      type: "intent.schedule_delete",
      payload: { scheduleId: id },
    });
    return c.json({ deleted: id });
  });

  app.post("/schedules/:id/pause", (c) => {
    const id = c.req.param("id");
    const existing = deps.store.getSchedule(id);
    if (existing == null) return c.json({ error: "not found" }, 404);
    deps.store.pauseSchedule(id, now());
    deps.store.appendDaemonEvent({
      type: "intent.schedule_pause",
      payload: { scheduleId: id },
    });
    const updated = deps.store.getSchedule(id);
    return c.json(updated);
  });

  app.post("/schedules/:id/resume", (c) => {
    const id = c.req.param("id");
    const existing = deps.store.getSchedule(id);
    if (existing == null) return c.json({ error: "not found" }, 404);
    deps.store.resumeSchedule(id, now());
    deps.store.appendDaemonEvent({
      type: "intent.schedule_resume",
      payload: { scheduleId: id },
    });
    const updated = deps.store.getSchedule(id);
    return c.json(updated);
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
