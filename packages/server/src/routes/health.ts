// GET /health — liveness probe.
//
// Shape:
//   { ok: true }                                 — plain `swarm serve` (no daemon)
//   { ok: true, daemon: {...} }                  — running as the swarm daemon
//
// The `daemon` key lets the web UI distinguish "can I enqueue jobs?"
// from "view-only archive". Keys:
//   pid, port, startedAt, version                — straight from the rendezvous
//   concurrency                                  — active global cap
//   inflight                                     — count of rows in status='running'
//   queued                                       — count of rows in status='queued'
//
// The two counters are derived from the JobQueue on each request. It's
// cheap (indexed SELECT COUNT) and we don't poll `/health` often enough
// for it to matter.
//
// TUI + existing client code only assert `ok:true`; the extra key is
// additive and safe.
//
// NOTE: we intentionally do NOT bake the daemon info into the route
// factory itself — the daemon injects a small provider callback, and
// the standalone `swarm serve` path leaves it unset. That keeps
// `createServer()` free of daemon lifecycle concerns.

import { Hono } from "hono";

export interface HealthDaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  concurrency: number;
  inflight: number;
  queued: number;
}

export interface HealthRouteOptions {
  /** When set, the result is merged into the `/health` response under
   * `daemon`. Called per request so counters stay fresh. */
  daemonInfo?: () => HealthDaemonInfo | Promise<HealthDaemonInfo>;
}

export function healthRoutes(opts: HealthRouteOptions = {}): Hono {
  const app = new Hono();
  app.get("/health", async (c) => {
    if (!opts.daemonInfo) return c.json({ ok: true });
    try {
      const info = await opts.daemonInfo();
      return c.json({ ok: true, daemon: info });
    } catch {
      // If the provider throws (e.g. closed SQLite handle during shutdown),
      // still report ok:true so liveness probes don't flap — just omit the
      // enrichment. Servers behind load balancers care about liveness, not
      // ergonomics.
      return c.json({ ok: true });
    }
  });
  return app;
}
