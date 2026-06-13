// GET /projects/:id/tree   \u2014 flat {path,type}[] for the Files pane.
// GET /projects/:id/blob?path=\u2026  \u2014 raw text content of one file.
//
// `:id` is the project IDENTITY (`run_state.project_id`). The routes
// resolve it to a local cwd via `store.listProjects()` (the same
// enumeration `GET /projects` uses) and then read files there. A project
// that is known but has no local checkout (imported-only \u2014 NULL cwdHint)
// degrades to `not_found`, which the web renders as "not checked out
// here". Resolving by identity keeps the wire consistent across endpoints
// and refuses requests against arbitrary host paths.
//
// All filesystem work happens in the injected `ProjectTreeReader`. The
// routes only do lookup and response shaping.

import type { IEventReader } from "@fragua/store";
import { Hono } from "hono";
import type { ProjectTreeReader } from "../ports.ts";

export interface ProjectsRouteOptions {
  store: Pick<IEventReader, "listProjects">;
  reader: ProjectTreeReader;
}

export function projectsRoutes(opts: ProjectsRouteOptions): Hono {
  const app = new Hono();
  const { store, reader } = opts;

  app.get("/projects/:id/tree", async (c) => {
    const cwd = resolveProjectCwd(store, c.req.param("id"));
    if (cwd.kind !== "ok") return c.json({ error: cwd.kind }, statusFor(cwd.kind));
    const entries = await reader.list(cwd.cwd);
    return c.json(entries);
  });

  app.get("/projects/:id/blob", async (c) => {
    const cwd = resolveProjectCwd(store, c.req.param("id"));
    if (cwd.kind !== "ok") return c.json({ error: cwd.kind }, statusFor(cwd.kind));

    const path = c.req.query("path");
    if (typeof path !== "string" || path.length === 0) {
      return c.json({ error: "invalid_path" }, 400);
    }
    // Pre-flight rejection so a clearly bad input gets a 400 (a request
    // bug) instead of a 404 from the reader (a missing-file shape).
    if (!isPreflightSafe(path)) {
      return c.json({ error: "invalid_path" }, 400);
    }

    const result = await reader.readBlob(cwd.cwd, path);
    switch (result.kind) {
      case "ok":
        return new Response(result.text, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      case "invalid_path":
        return c.json({ error: "invalid_path" }, 400);
      case "not_found":
        return c.json({ error: "not_found" }, 404);
      case "too_large":
        return c.json({ error: "too_large" }, 413);
      case "binary":
        return c.json({ error: "unsupported_media_type" }, 415);
    }
  });

  return app;
}

type ProjectLookup = { kind: "ok"; cwd: string } | { kind: "invalid_id" } | { kind: "not_found" };

/** Resolve a `project_id` to a local cwd via the project enumeration.
 *  Unknown id → not_found; known but no local checkout (imported-only,
 *  NULL cwdHint) → not_found so the web shows "not checked out here". */
function resolveProjectCwd(store: Pick<IEventReader, "listProjects">, id: string | undefined): ProjectLookup {
  if (typeof id !== "string" || id.length === 0) return { kind: "invalid_id" };
  const project = store.listProjects().find((row) => row.projectId === id);
  if (project == null || project.cwdHint == null) return { kind: "not_found" };
  return { kind: "ok", cwd: project.cwdHint };
}

function statusFor(kind: "invalid_id" | "not_found"): 400 | 404 {
  return kind === "invalid_id" ? 400 : 404;
}

/** Reject `..` segments / leading `/` / NUL bytes before any FS access.
 *  The reader applies the same checks (returning `invalid_path`) but
 *  catching them here lets us distinguish a clearly-bad request from a
 *  missing file, which the web treats differently. */
function isPreflightSafe(p: string): boolean {
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  for (const seg of p.split(/[\\/]/)) {
    if (seg === "..") return false;
  }
  return true;
}
