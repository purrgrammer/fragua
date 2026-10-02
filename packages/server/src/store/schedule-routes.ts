// Schedule routes.
//
// CRUD over the `schedules` table plus pause/resume verbs. Every mutation
// routes through the intent plane, which writes the schedule row and its
// matching `intent.schedule_*` audit row to `daemon_events` in ONE transaction
// (so the row and its audit can't land separately) and is the single
// implementation the CLI shares. Schedule rows are the canonical state — the
// dispatcher fiber picks them up on its next tick. No SSE here; UIs poll
// `GET /schedules` (small surface) or stream daemon events.

import type { IntentPlane } from "@fragua/core/intent-plane";
import type { IDaemonCoordinator } from "@fragua/store";
import { Hono } from "hono";

export interface ScheduleRoutesDeps {
  store: IDaemonCoordinator;
  /** Intent plane bound to the same store — owns validation + the atomic
   *  row + audit-event write for every schedule mutation. */
  plane: IntentPlane;
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
        projectId?: string;
        every?: string;
        title?: string;
        overlap?: string;
        fireOnCreate?: boolean;
      }>(c)) ?? {};

    const build = deps.plane.buildScheduleCreate({
      workflow: body.workflow ?? "",
      cwd: body.cwd ?? "",
      every: body.every ?? "",
      ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.overlap === "string" ? { overlap: body.overlap } : {}),
      ...(typeof body.fireOnCreate === "boolean" ? { fireOnCreate: body.fireOnCreate } : {}),
    });
    if (!build.ok) {
      return c.json(build.code !== undefined ? { error: build.error, code: build.code } : { error: build.error }, 400);
    }

    const created = deps.plane.commitScheduleCreate(build.create, now());
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
    deps.plane.commitScheduleDelete(id, deps.plane.buildScheduleDelete(id), now());
    return c.json({ deleted: id });
  });

  app.post("/schedules/:id/pause", (c) => {
    const id = c.req.param("id");
    const existing = deps.store.getSchedule(id);
    if (existing == null) return c.json({ error: "not found" }, 404);
    deps.plane.commitSchedulePause(id, deps.plane.buildSchedulePause(id), now());
    return c.json(deps.store.getSchedule(id));
  });

  app.post("/schedules/:id/resume", (c) => {
    const id = c.req.param("id");
    const existing = deps.store.getSchedule(id);
    if (existing == null) return c.json({ error: "not found" }, 404);
    deps.plane.commitScheduleResume(id, deps.plane.buildScheduleResume(id), now());
    return c.json(deps.store.getSchedule(id));
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
