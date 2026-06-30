// Public entry point for @fragua/server.
//
// DB-first: `store` is required; reads and intent writes both go through
// @fragua/store. `workflowReader` (disk-backed workflow listing) stays optional
// for the Workflows page.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { AuthStorage, ModelRegistry } from "@fragua/agent";
import type { IEventStore } from "@fragua/store";
import { Hono } from "hono";
import { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
import { createMultiSourceWorkflowReader } from "./adapters/multi-source-workflow-reader.ts";
import { createFsProjectTreeReader } from "./adapters/project-tree-reader.ts";
import { createRunSnapshotReader } from "./adapters/run-snapshot-reader.ts";
import type { ProjectTreeReader, RunSnapshotReader, ServerPorts, WorkflowReader } from "./ports.ts";
import { healthRoutes } from "./routes/health.ts";
import { projectsRoutes } from "./routes/projects.ts";
import { type ProviderTester, providersRoutes } from "./routes/providers.ts";
import { runFilesRoutes } from "./routes/run-files.ts";
import { runSnapshotsRoutes } from "./routes/run-snapshots.ts";
import { workflowsRoutes } from "./routes/workflows.ts";
import { analyticsRoutes } from "./store/analytics-routes.ts";
import { createRoutes as createStoreRoutes, type WorkflowModelValidator } from "./store/routes.ts";
import { storeRunsRoutes } from "./store/runs-routes.ts";
import { createScheduleRoutes } from "./store/schedule-routes.ts";
import { skillsRoutes } from "./store/skills-routes.ts";

export interface ServerOptions {
  /** SQLite event store — the backbone for all reads and intent writes. */
  store: IEventStore;
  /** Global workflows directory listed by `GET /workflows` alongside every
   * project root the store has ever seen. Defaults to
   * `~/.fragua/workflows`. The single-source `workflowsDir` option below
   * overrides this aggregation entirely (one directory, no projects);
   * leave it unset to get the multi-source view the web UI expects. */
  globalWorkflowsDir?: string;
  /** Legacy single-directory override. When set, the server scans only
   * this path and ignores the project list — kept for the CI-primitive
   * `fragua serve --workflows-dir` shape and tests. New deployments
   * should leave it unset and let `globalWorkflowsDir` + the store-fed
   * project enumeration drive the listing. */
  workflowsDir?: string;
  /** Project root. Defaults to `process.cwd()`. Always added to the
   * project enumeration so a freshly-started harness shows its own
   * cwd workflows even before the first run lands in `listCwds()`. */
  cwd?: string;
  /** Optional port overrides. Any omitted port falls back to defaults. */
  ports?: ServerPorts;
  /** Absolute path to the built web bundle (`packages/web/dist/`). When set,
   * the server also hosts the SPA from `/` with the existing API remounted
   * under `/api/*` (matching the client's BASE_URL = "/api"). Leave unset
   * for API-only deployments or tests. */
  webDistDir?: string;
  /** In-memory web bundle (path → embedded asset path). Used by the
   * `bun build --compile` binary: every dist file is imported with
   * `with { type: "file" }`, and the resulting virtual paths under
   * `/$bunfs/root/` are passed in here. Mutually exclusive with
   * `webDistDir`; when both are set, `webBundle` wins. */
  webBundle?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** Optional enqueue preflight; passed through to the store routes.
   * When set, POST /runs rejects with code="provider_unavailable" if the
   * resolver returns `ok: false`. The CLI's `serve` / `daemon` commands
   * wire `envProviderPreflight` by default; leave unset in tests. */
  preflightProviders?: () => { ok: true } | { ok: false; detail: string };
  /** Optional workflow-registration validator. When set, POST /workflows
   * rejects with code="model_unresolved" if any llm node declares a
   * `(provider, model)` pair the provider registry doesn't recognise.
   * The CLI's `daemon` command wires in the real pi-ai-backed resolver;
   * tests can omit it or inject a stub. */
  validateWorkflowModels?: WorkflowModelValidator;
  /** Backpressure cap on queued runs. POST /runs returns 429 with a
   * Retry-After header when the cap is met. Undefined = uncapped. */
  maxQueuedRuns?: number;
  /** When set (together with `defaultModels` + `testProvider`), mounts
   * `/providers*` for credential management + model listing. Omit in
   * tests that don't exercise those routes. Both must be the same pair
   * wired into the daemon / summariser so the web UI and backend share
   * state. */
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  /** Default model id per provider for the `/providers*` routes. The CLI
   * injects @fragua/agent's `defaultModelPerProvider`; injected rather
   * than imported so @fragua/server carries no @fragua/agent runtime
   * dependency. */
  defaultModels?: Readonly<Record<string, string>>;
  /** 1-token probe behind `POST /providers/:name/test`. The CLI wires a
   * pi-ai `streamSimple`-backed implementation; injected rather than
   * imported so @fragua/server stays free of pi-ai — same seam as
   * `validateWorkflowModels`. */
  testProvider?: ProviderTester;
}

function buildApiApp(opts: ServerOptions): Hono {
  const ports = opts.ports ?? {};
  const cwd = opts.cwd ?? process.cwd();
  const workflowReader: WorkflowReader = ports.workflowReader ?? defaultWorkflowReader(opts, cwd);
  const projectTreeReader: ProjectTreeReader = ports.projectTreeReader ?? createFsProjectTreeReader();
  const snapshotReader: RunSnapshotReader = ports.runSnapshotReader ?? createRunSnapshotReader();

  const api = new Hono();
  api.route("/", healthRoutes(ports.daemonInfo !== undefined ? { daemonInfo: ports.daemonInfo } : {}));
  api.route("/", workflowsRoutes({ workflowReader, store: opts.store }));
  api.route("/", projectsRoutes({ store: opts.store, reader: projectTreeReader }));
  api.route("/", runSnapshotsRoutes({ store: opts.store, reader: snapshotReader }));
  api.route("/", runFilesRoutes({ store: opts.store, reader: projectTreeReader }));
  api.route("/", storeRunsRoutes({ store: opts.store, workflowReader }));
  api.route("/", analyticsRoutes({ store: opts.store, workflowReader }));
  api.route(
    "/",
    createStoreRoutes({
      store: opts.store,
      workflowReader,
      runSnapshotReader: snapshotReader,
      ...(ports.runActions !== undefined ? { runActions: ports.runActions } : {}),
      ...(opts.preflightProviders !== undefined ? { preflightProviders: opts.preflightProviders } : {}),
      ...(opts.validateWorkflowModels !== undefined ? { validateWorkflowModels: opts.validateWorkflowModels } : {}),
      ...(opts.maxQueuedRuns !== undefined ? { maxQueuedRuns: opts.maxQueuedRuns } : {}),
    }),
  );
  api.route("/", createScheduleRoutes({ store: opts.store }));
  api.route("/", skillsRoutes({ store: opts.store, homeDir: homedir(), cwd }));
  if (opts.authStorage && opts.modelRegistry && opts.defaultModels && opts.testProvider) {
    api.route(
      "/",
      providersRoutes({
        authStorage: opts.authStorage,
        modelRegistry: opts.modelRegistry,
        defaultModels: opts.defaultModels,
        testProvider: opts.testProvider,
      }),
    );
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

function embeddedFileResponse(virtualPath: string, urlPath: string): Response | null {
  // Bun.file() on a `/$bunfs/root/…` path returned by a `with { type: "file" }`
  // import resolves to the embedded bytes. We re-stream the blob so Hono
  // sets content-length from the underlying File.
  try {
    const file = Bun.file(virtualPath);
    const ct = MIME[extname(urlPath).toLowerCase()] ?? "application/octet-stream";
    return new Response(file, { headers: { "content-type": ct } });
  } catch {
    return null;
  }
}

function toMap(input: ReadonlyMap<string, string> | Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  if (input instanceof Map) return input;
  return new Map(Object.entries(input));
}

export function createServer(opts: ServerOptions): Hono {
  const api = buildApiApp(opts);
  const bundle = opts.webBundle ? toMap(opts.webBundle) : undefined;
  const distDir = opts.webDistDir ? resolve(opts.webDistDir) : undefined;

  // Embedded bundle wins over a passed distDir (compiled binary path).
  // Otherwise we need a distDir whose index.html exists; missing → API only.
  const hasEmbedded = bundle !== undefined && bundle.size > 0;
  if (!hasEmbedded) {
    if (!distDir) return api;
    if (!existsSync(join(distDir, "index.html"))) return api;
  }

  const app = new Hono();
  // In web mode the API lives ONLY at `/api/*`. The bare paths (`/runs/:id`,
  // `/workflows`) are client-side routes owned by React Router — anything
  // unmatched on the server falls through to index.html so SPA routing works.
  // `fragua run` uses the discovery file's URL which already includes `/api`
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
      const key = pathname.replace(/^\/+/, "");
      if (hasEmbedded) {
        const virtualPath = bundle?.get(key);
        if (virtualPath) {
          const res = embeddedFileResponse(virtualPath, pathname);
          if (res) return res;
        }
      } else if (distDir) {
        const filePath = join(distDir, pathname);
        if (filePath.startsWith(distDir)) {
          const res = staticFileResponse(filePath);
          if (res) return res;
        }
      }
    }
    // SPA fallback for client-side routes (e.g. `/runs/:id`).
    if (hasEmbedded) {
      const indexPath = bundle?.get("index.html");
      const res = indexPath ? embeddedFileResponse(indexPath, "/index.html") : null;
      return res ?? c.notFound();
    }
    const res = distDir ? staticFileResponse(join(distDir, "index.html")) : null;
    return res ?? c.notFound();
  });
  return app;
}

function defaultWorkflowReader(opts: ServerOptions, cwd: string): WorkflowReader {
  // Legacy single-source override: tests + the CI-primitive `fragua serve
  // --workflows-dir <dir>` shape pin one directory and skip the project
  // enumeration entirely. Also covers anyone who was previously relying
  // on the old `<cwd>/.fragua/workflows`-only behaviour by setting the
  // option explicitly.
  if (opts.workflowsDir !== undefined) {
    return createFsWorkflowReader({ workflowsDir: opts.workflowsDir });
  }
  const globalDir = opts.globalWorkflowsDir ?? resolve(homedir(), ".fragua/workflows");
  return createMultiSourceWorkflowReader({
    store: opts.store,
    globalDir,
    extraCwds: [resolve(cwd)],
  });
}

export {
  listRuns as listStoreRuns,
  mapStatus,
  runStateToDetail,
  runStateToSummary,
} from "@fragua/core/read-plane";
export { createFsWorkflowReader } from "./adapters/fs-workflow-reader.ts";
export { createMultiSourceWorkflowReader } from "./adapters/multi-source-workflow-reader.ts";
export { createFsProjectTreeReader } from "./adapters/project-tree-reader.ts";
export { createRunSnapshotReader } from "./adapters/run-snapshot-reader.ts";
export type {
  ProjectTreeEntry,
  ProjectTreeReader,
  ReadBlobResult,
  RunActionExec,
  RunSnapshotReader,
  ServerPorts,
  SnapshotTreeEntry,
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
export type {
  ProvidersRouteOptions,
  ProviderTester,
  ProviderTestOutcome,
  RegisteredModel,
} from "./routes/providers.ts";
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
export { registryPreflight } from "./store/routes.ts";
export { storeRunsRoutes } from "./store/runs-routes.ts";
