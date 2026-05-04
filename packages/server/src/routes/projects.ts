// GET /projects/:id/tree   \u2014 flat {path,type}[] for the Files pane.
// GET /projects/:id/blob?path=\u2026  \u2014 raw text content of one file.
//
// `:id` is the base64url encoding of the absolute project root, matching
// `packages/web/src/lib/projectId.ts` so the URL the web builds round-trips
// without escaping. Both routes 404 unless the decoded cwd appears in
// `store.listCwds()` \u2014 the same authoritative project enumeration `GET
// /projects` uses (`store/routes.ts:539`). That keeps the wire identity
// of "a project" consistent across every endpoint and refuses requests
// against arbitrary paths on the host.
//
// All filesystem work happens in the injected `ProjectTreeReader`. The
// routes only do decoding, store-lookup, and response shaping \u2014 same
// pattern as `workflowsRoutes` (`routes/workflows.ts`).

import type { IEventStore } from "@swarm/store";
import { Hono } from "hono";
import type { ProjectTreeReader } from "../ports.ts";

export interface ProjectsRouteOptions {
  store: IEventStore;
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

function resolveProjectCwd(store: IEventStore, id: string | undefined): ProjectLookup {
  if (typeof id !== "string" || id.length === 0) return { kind: "invalid_id" };
  const cwd = decodeProjectId(id);
  if (cwd === null) return { kind: "invalid_id" };
  const known = store.listCwds().some((row) => row.cwd === cwd);
  if (!known) return { kind: "not_found" };
  return { kind: "ok", cwd };
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

/** Inverse of `web/src/lib/projectId.ts:encodeProjectId`. Base64url \u2192
 *  utf-8 string; returns `null` on malformed input so the route can map
 *  it to a 400 instead of crashing. */
function decodeProjectId(segment: string): string | null {
  try {
    const padded = segment.padEnd(segment.length + ((4 - (segment.length % 4)) % 4), "=");
    const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    // Buffer.from with 'base64' is lenient \u2014 it accepts the base64url
    // alphabet after the `replace` above. Round-trip via utf-8.
    const buf = Buffer.from(b64, "base64");
    const decoded = buf.toString("utf8");
    // Reject if the decode is lossy (non-utf8 bytes) by checking the
    // re-encode round-trips. Buffer.toString won't throw on invalid
    // utf-8; this catches the garbage-segment case.
    if (Buffer.from(decoded, "utf8").length !== buf.length) return null;
    if (decoded.length === 0) return null;
    return decoded;
  } catch {
    return null;
  }
}
