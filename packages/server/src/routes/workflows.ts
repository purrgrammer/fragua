// GET /workflows — list workflow sources (typically `*.dot` under the
// configured `workflowsDir`). Delegates all I/O to an injected
// `WorkflowReader` port so tests can drive the handler with an in-memory
// fake.
//
// GET /workflows/:name — single workflow with its raw DOT source for the
// web detail page. Accepts either a workflow name (e.g. `my-workflow`) or
// a full 64-char hex workflowSha (e.g. the sha stored in the DB by the
// executor on run.started). Name-based lookup delegates to `WorkflowReader`;
// sha-based lookup hits the store's `workflows` table first (populated by
// POST /workflows), then falls back to the file reader for forward
// compatibility. 404 when neither source resolves the identifier.

import type { IEventStore } from "@swarm/store";
import { Hono } from "hono";
import type { WorkflowDetail, WorkflowReader } from "../ports.ts";

/** Regex for a full-length (64 hex char) sha256 digest. */
const SHA256_RE = /^[0-9a-f]{64}$/i;

export interface WorkflowsRouteOptions {
  workflowReader: WorkflowReader;
  /** Optional store for sha-keyed workflow lookups (populated by POST
   * /workflows on enqueue). When provided, GET /workflows/:sha resolves
   * via the DB rather than the filesystem. */
  store?: IEventStore;
}

export function workflowsRoutes(opts: WorkflowsRouteOptions): Hono {
  const app = new Hono();

  app.get("/workflows", async (c) => {
    const list = await opts.workflowReader.list();
    return c.json(list);
  });

  app.get("/workflows/:name", async (c) => {
    const name = c.req.param("name");
    // Optional source pin: `?cwd=` is the project root that the listing
    // surface tagged the workflow with. Empty string is meaningful — it
    // pins the lookup to the global source, which lets a caller pick the
    // global `change` over a project that defines the same name.
    const cwdParam = c.req.query("cwd");

    // ── sha-based lookup ───────────────────────────────────────────────
    // When the caller supplies a 64-char hex sha (e.g. a workflowSha
    // stored alongside a run) we resolve via the DB's workflows table
    // before falling back to the file reader. This lets /workflows/<sha>
    // deep-links work even when the workflow has been renamed or moved.
    if (SHA256_RE.test(name)) {
      if (opts.store) {
        const row = opts.store.getWorkflow(name);
        if (row) {
          const detail: WorkflowDetail = {
            name: row.name,
            path: "",
            sha: name,
            source: row.dotSource,
          };
          return c.json(detail);
        }
      }
      // Fall back to the file reader in case the sha happens to be a
      // valid workflow name (extremely unlikely but harmless).
    }

    // ── name-based lookup (existing behaviour) ────────────────────────
    const detail = await opts.workflowReader.read(name, cwdParam !== undefined ? { cwd: cwdParam } : undefined);
    if (!detail) return c.json({ error: "not_found", name }, 404);
    return c.json(detail);
  });

  return app;
}
