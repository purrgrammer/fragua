// Public entry point for @swarm/server.
//
// DB-first: `store` is required; reads and intent writes both go through
// @swarm/store. `workflowReader` (disk-backed DOT listing) stays optional
// for the Workflows page.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Hono } from "hono";
import type { IEventStore } from "@swarm/store";
import { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
import type { ServerPorts, WorkflowReader } from "./ports.ts";
import { healthRoutes } from "./routes/health.ts";
import { workflowsRoutes } from "./routes/workflows.ts";
import { storePipelinesRoutes } from "./store/pipelines-routes.ts";
import { createRoutes as createStoreRoutes } from "./store/routes.ts";

export interface ServerOptions {
  /** SQLite event store — the backbone for all reads and intent writes. */
  store: IEventStore;
  /** Directory with `*.dot` workflow sources listed by `GET /workflows`. */
  workflowsDir?: string;
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Optional port overrides. Any omitted port falls back to defaults. */
  ports?: ServerPorts;
  /** Absolute path to the built web bundle (`packages/web/dist/`). When set,
   * the server also hosts the SPA from `/` with the existing API remounted
   * under `/api/*` (matching the client's BASE_URL = "/api"). Leave unset
   * for API-only deployments or tests. */
  webDistDir?: string;
}

function buildApiApp(opts: ServerOptions): Hono {
  const ports = opts.ports ?? {};
  const workflowsDir = opts.workflowsDir ?? "workflows";
  const workflowReader: WorkflowReader =
    ports.workflowReader ?? createFsWorkflowReader({ workflowsDir });

  const api = new Hono();
  api.route(
    "/",
    healthRoutes(
      ports.daemonInfo !== undefined ? { daemonInfo: ports.daemonInfo } : {},
    ),
  );
  api.route("/", workflowsRoutes({ workflowReader }));
  api.route("/", storePipelinesRoutes({ store: opts.store, workflowReader }));
  api.route("/", createStoreRoutes({ store: opts.store }));
  return api;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function staticFileResponse(filePath: string): Response | null {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    const ct = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    return new Response(readFileSync(filePath), {
      headers: { "content-type": ct, "content-length": String(st.size) },
    });
  } catch {
    return null;
  }
}

export function createServer(opts: ServerOptions): Hono {
  const api = buildApiApp(opts);
  if (!opts.webDistDir) return api;

  const distDir = resolve(opts.webDistDir);
  const indexHtml = join(distDir, "index.html");
  if (!existsSync(indexHtml)) {
    // No built bundle — serve API only. Callers (the CLI) print a hint.
    return api;
  }

  const app = new Hono();
  // In web mode the API lives ONLY at `/api/*`. The bare paths (`/runs/:id`,
  // `/workflows`) are client-side routes owned by React Router — anything
  // unmatched on the server falls through to index.html so SPA routing works.
  // `swarm run` uses the discovery file's URL which already includes `/api`
  // (see packages/cli/src/commands/serve.ts).
  app.route("/api", api);

  // Static files + SPA fallback. Hono evaluates routes in registration
  // order, so these run only after the API routes miss.
  app.get("*", (c) => {
    const url = new URL(c.req.url);
    const pathname = decodeURIComponent(url.pathname);
    // Defence in depth: refuse path-traversal before touching the FS.
    if (pathname.includes("\0") || pathname.split("/").some((p) => p === "..")) {
      return c.notFound();
    }
    if (pathname !== "/") {
      const filePath = join(distDir, pathname);
      if (filePath.startsWith(distDir)) {
        const res = staticFileResponse(filePath);
        if (res) return res;
      }
    }
    // SPA fallback for client-side routes (e.g. `/runs/:id`).
    const res = staticFileResponse(indexHtml);
    return res ?? c.notFound();
  });
  return app;
}

export { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
export type {
  ServerPorts,
  WorkflowDetail,
  WorkflowReader,
  WorkflowSummary,
} from "./ports.ts";
export type { HealthDaemonInfo } from "./routes/health.ts";
export {
  ErrorBody,
  NodeState,
  PipelineDetail,
  PipelineSummary,
} from "./schemas.ts";
export { createRoutes as createStoreRoutes, newRunId } from "./store/index.ts";
export { storePipelinesRoutes } from "./store/pipelines-routes.ts";
export type { ServerDeps } from "./store/index.ts";
export {
  listRuns as listStoreRuns,
  mapStatus,
  runStateToDetail,
  runStateToSummary,
} from "./store/pipelines-adapter.ts";
