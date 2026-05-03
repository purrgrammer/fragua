// Public entry point for @swarm/server.
//
// DB-first: `store` is required; reads and intent writes both go through
// @swarm/store. `workflowReader` (disk-backed DOT listing) stays optional
// for the Workflows page.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { AuthStorage, ModelRegistry } from "@swarm/agent";
import type { IEventStore } from "@swarm/store";
import { Hono } from "hono";
import { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
import type { ServerPorts, WorkflowReader } from "./ports.ts";
import { healthRoutes } from "./routes/health.ts";
import { providersRoutes } from "./routes/providers.ts";
import { workflowsRoutes } from "./routes/workflows.ts";
import { analyticsRoutes } from "./store/analytics-routes.ts";
import { createRoutes as createStoreRoutes, type WorkflowModelValidator } from "./store/routes.ts";
import { storeRunsRoutes } from "./store/runs-routes.ts";

export interface ServerOptions {
  /** SQLite event store — the backbone for all reads and intent writes. */
  store: IEventStore;
  /** Directory with `*.dot` workflow sources listed by `GET /workflows`.
   * Defaults to `<cwd>/.swarm/workflows`. */
  workflowsDir?: string;
  /** Project root. Defaults to `process.cwd()`. Used as the base for
   * `workflowsDir` when none is provided. */
  cwd?: string;
  /** Optional port overrides. Any omitted port falls back to defaults. */
  ports?: ServerPorts;
  /** Absolute path to the built web bundle (`packages/web/dist/`). When set,
   * the server also hosts the SPA from `/` with the existing API remounted
   * under `/api/*` (matching the client's BASE_URL = "/api"). Leave unset
   * for API-only deployments or tests. */
  webDistDir?: string;
  /** Optional enqueue preflight; passed through to the store routes.
   * When set, POST /runs rejects with code="provider_unavailable" if the
   * resolver returns `ok: false`. The CLI's `serve` / `daemon` commands
   * wire `envProviderPreflight` by default; leave unset in tests. */
  preflightProviders?: () => { ok: true } | { ok: false; detail: string };
  /** Optional workflow-registration validator. When set, POST /workflows
   * rejects with code="model_unresolved" if any codergen node declares a
   * `(provider, model)` pair the provider registry doesn't recognise.
   * The CLI's `daemon` command wires in the real pi-ai-backed resolver;
   * tests can omit it or inject a stub. */
  validateWorkflowModels?: WorkflowModelValidator;
  /** Backpressure cap on queued runs. POST /runs returns 429 with a
   * Retry-After header when the cap is met. Undefined = uncapped. */
  maxQueuedRuns?: number;
  /** When set, mounts `/providers*` for credential management + model
   * listing. Omit in tests that don't exercise those routes. Both must
   * be the same pair wired into the daemon / summariser so the web UI
   * and backend share state. */
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
}

function buildApiApp(opts: ServerOptions): Hono {
  const ports = opts.ports ?? {};
  const workflowsDir = opts.workflowsDir ?? resolve(opts.cwd ?? process.cwd(), ".swarm/workflows");
  const workflowReader: WorkflowReader = ports.workflowReader ?? createFsWorkflowReader({ workflowsDir });

  const api = new Hono();
  api.route("/", healthRoutes(ports.daemonInfo !== undefined ? { daemonInfo: ports.daemonInfo } : {}));
  api.route("/", workflowsRoutes({ workflowReader, store: opts.store }));
  api.route("/", storeRunsRoutes({ store: opts.store, workflowReader }));
  api.route("/", analyticsRoutes({ store: opts.store, workflowReader }));
  api.route(
    "/",
    createStoreRoutes({
      store: opts.store,
      ...(opts.preflightProviders !== undefined ? { preflightProviders: opts.preflightProviders } : {}),
      ...(opts.validateWorkflowModels !== undefined ? { validateWorkflowModels: opts.validateWorkflowModels } : {}),
      ...(opts.maxQueuedRuns !== undefined ? { maxQueuedRuns: opts.maxQueuedRuns } : {}),
    }),
  );
  if (opts.authStorage && opts.modelRegistry) {
    api.route("/", providersRoutes({ authStorage: opts.authStorage, modelRegistry: opts.modelRegistry }));
  }
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
    // /api/* is owned by the API. If we reach here it means the API didn't
    // match — return JSON 404 instead of the SPA shell so curl/fetch get a
    // sensible error and the browser doesn't render the app at /api.
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return c.json({ error: "not_found", path: pathname }, 404);
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
export type { ReapOptions, ReapResult } from "./reaper.ts";
export { DEFAULT_REAP_TTL_MS, reapStaleDaemon } from "./reaper.ts";
export type {
  DaemonInfoFromStoreOptions,
  HealthDaemonInfo,
} from "./routes/health.ts";
export {
  DAEMON_LIVENESS_TTL_MS,
  daemonInfoFromStore,
} from "./routes/health.ts";
export { providersRoutes } from "./routes/providers.ts";
export {
  ErrorBody,
  NodeState,
  ProjectSummary,
  RunDetail,
  RunSummary,
} from "./schemas.ts";
export type { ServerDeps } from "./store/index.ts";
export { createRoutes as createStoreRoutes, newRunId } from "./store/index.ts";
export type { WorkflowModelValidator } from "./store/routes.ts";
export { envProviderPreflight, registryPreflight } from "./store/routes.ts";
export {
  listRuns as listStoreRuns,
  mapStatus,
  runStateToDetail,
  runStateToSummary,
} from "./store/runs-adapter.ts";
export { storeRunsRoutes } from "./store/runs-routes.ts";
