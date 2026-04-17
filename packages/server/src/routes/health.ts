// GET /health — liveness probe. Deliberately trivial: tests and the TUI both
// use this to confirm the process is up before opening SSE streams.

import { Hono } from "hono";

export function healthRoutes(): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}
