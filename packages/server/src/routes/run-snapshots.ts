// GET /runs/:id/snapshots
//   Ordered scrubber feed: snapshot.captured (observability) +
//   fact.snapshot_recorded (terminal fact), in event-log order.
//   → Array<{ eventIdx, nodeId, label, commitSha, treeSha, committed, uncommitted }>
//
// GET /runs/:id/snapshots/:eventIdx/tree
//   git ls-tree against the resolved commitSha.
//   → { entries: Array<{ path, mode, size, type }> }
//
// GET /runs/:id/snapshots/:eventIdx/file?path=<repo-relative>
//   git show <commitSha>:<path>
//   → text/plain or application/octet-stream
//
// GET /runs/:id/snapshots/:eventIdx/diff?against=base|previous|<eventIdx>&path=<optional>
//   git diff between two resolved commits.
//   base     = run_state.diff_base_sha (fallback: base_git_sha)
//   previous = prior snapshot's commitSha (first snapshot diffs against base)
//   <int>    = that snapshot's commitSha
//   → text/x-diff
//
// eventIdx URL parameter is the seq number of the snapshot event.
// 404 when the run is unknown or the eventIdx doesn't map to a snapshot.
// All git invocations go through the injected RunSnapshotReader — no
// direct git calls here; pure request routing + error shaping.

import { extractCommitSha, makeReadPlane, parseEventIdx } from "@fragua/core/read-plane";
import type { IEventStore } from "@fragua/store";
import { Hono } from "hono";
import type { RunSnapshotReader } from "../ports.ts";

export interface RunSnapshotsRouteOptions {
  store: IEventStore;
  reader: RunSnapshotReader;
}

export function runSnapshotsRoutes(opts: RunSnapshotsRouteOptions): Hono {
  const app = new Hono();
  const { store, reader } = opts;
  const readPlane = makeReadPlane({ store });

  // ── GET /runs/:id/snapshots ─────────────────────────────────────────

  app.get("/runs/:id/snapshots", (c) => {
    const snapshots = readPlane.snapshots(c.req.param("id"));
    if (snapshots == null) return c.json({ error: "not_found" }, 404);
    return c.json(snapshots);
  });

  // ── GET /runs/:id/snapshots/:eventIdx/tree ──────────────────────────

  app.get("/runs/:id/snapshots/:eventIdx/tree", async (c) => {
    const resolved = resolveSnapshot(store, c.req.param("id"), c.req.param("eventIdx"));
    if (resolved.kind === "run_not_found") return c.json({ error: "not_found" }, 404);
    if (resolved.kind === "bad_event_idx") return c.json({ error: "invalid_event_idx" }, 400);
    if (resolved.kind === "snapshot_not_found") return c.json({ error: "not_found" }, 404);

    const result = await reader.lsTree(resolved.cwd, resolved.commitSha);
    if (result == null) return c.json({ entries: [] });
    return c.json({ entries: result.entries });
  });

  // ── GET /runs/:id/snapshots/:eventIdx/file ──────────────────────────

  app.get("/runs/:id/snapshots/:eventIdx/file", async (c) => {
    const resolved = resolveSnapshot(store, c.req.param("id"), c.req.param("eventIdx"));
    if (resolved.kind === "run_not_found") return c.json({ error: "not_found" }, 404);
    if (resolved.kind === "bad_event_idx") return c.json({ error: "invalid_event_idx" }, 400);
    if (resolved.kind === "snapshot_not_found") return c.json({ error: "not_found" }, 404);

    const path = c.req.query("path");
    if (typeof path !== "string" || path.length === 0) {
      return c.json({ error: "invalid_path" }, 400);
    }
    if (!isPreflightSafe(path)) {
      return c.json({ error: "invalid_path" }, 400);
    }

    const result = await reader.showFile(resolved.cwd, resolved.commitSha, path);
    switch (result.kind) {
      case "ok": {
        const ct = looksLikeText(result.bytes) ? "text/plain; charset=utf-8" : "application/octet-stream";
        return new Response(result.bytes, {
          status: 200,
          headers: { "content-type": ct },
        });
      }
      case "not_found":
        return c.json({ error: "not_found" }, 404);
      case "too_large":
        return c.json({ error: "too_large" }, 413);
    }
  });

  // ── GET /runs/:id/snapshots/:eventIdx/diff ──────────────────────────

  app.get("/runs/:id/snapshots/:eventIdx/diff", async (c) => {
    const eventIdx = parseEventIdx(c.req.param("eventIdx"));
    if (eventIdx == null) return c.json({ error: "invalid_event_idx" }, 400);

    const against = c.req.query("against") ?? "base";
    const range = readPlane.diffRange(c.req.param("id"), eventIdx, against);
    if (!range.ok) {
      switch (range.reason) {
        case "run_not_found":
        case "no_worktree":
        case "snapshot_not_found":
          return c.json({ error: "not_found" }, 404);
        case "invalid_against":
          return c.json({ error: "invalid_against" }, 400);
        case "base_missing":
          return c.json({ error: "base_missing" }, 410);
      }
    }

    const pathFilter = c.req.query("path");
    const diff = await reader.diff(
      range.cwd,
      range.fromSha,
      range.toSha,
      pathFilter !== undefined && pathFilter.length > 0 ? pathFilter : undefined,
    );
    return new Response(diff, {
      status: 200,
      headers: { "content-type": "text/x-diff; charset=utf-8" },
    });
  });

  return app;
}

// ── Helpers ─────────────────────────────────────────────────────────

type ResolveResult =
  | { kind: "run_not_found" }
  | { kind: "bad_event_idx" }
  | { kind: "snapshot_not_found" }
  | { kind: "ok"; cwd: string; commitSha: string };

function resolveSnapshot(store: IEventStore, runId: string, idxParam: string): ResolveResult {
  const state = store.getState(runId);
  if (state == null) return { kind: "run_not_found" };
  if (state.cwd == null) return { kind: "run_not_found" };

  const eventIdx = parseEventIdx(idxParam);
  if (eventIdx == null) return { kind: "bad_event_idx" };

  const snapshots = store.getSnapshotEvents(runId);
  const ev = snapshots.find((s) => s.seq === eventIdx);
  if (ev == null) return { kind: "snapshot_not_found" };

  const commitSha = extractCommitSha(ev);
  if (commitSha == null) return { kind: "snapshot_not_found" };

  return { kind: "ok", cwd: state.cwd, commitSha };
}

/** Reject inputs that could escape the project root before any git
 *  access. Same logic as `run-files.ts` and `routes/projects.ts`. */
function isPreflightSafe(p: string): boolean {
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  for (const seg of p.split(/[\\/]/)) {
    if (seg === "..") return false;
  }
  return true;
}

/** Heuristic: if there's a NUL byte in the first 8 KiB, treat as binary. */
function looksLikeText(buf: Buffer): boolean {
  const head = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return false;
  }
  return true;
}
