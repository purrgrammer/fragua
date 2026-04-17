// Public entry point for @swarm/server.
//
// Exports a `createServer(opts)` factory that returns a configured Hono app.
// The factory is intentionally pure: it does not bind to a port. Callers
// (tests, the CLI `serve` command, future adapters) decide how to serve —
// `Bun.serve({ fetch: app.fetch })` or `@hono/node-server` both work.

import { Hono } from "hono";
import { eventsRoutes } from "./routes/events.ts";
import { healthRoutes } from "./routes/health.ts";

export interface ServerOptions {
  /**
   * Directory containing per-run subdirectories with `events.jsonl`.
   * Usually `.swarm/runs/` from the project root.
   */
  runsDir: string;
}

/**
 * Build an unbound Hono app. The caller is responsible for listening:
 *
 *   const app = createServer({ runsDir: ".swarm/runs" });
 *   Bun.serve({ port: 3000, fetch: app.fetch });
 */
export function createServer(opts: ServerOptions): Hono {
  const app = new Hono();
  app.route("/", healthRoutes());
  app.route("/", eventsRoutes({ runsDir: opts.runsDir }));
  return app;
}

export type { EventsRouteOptions } from "./routes/events.ts";
