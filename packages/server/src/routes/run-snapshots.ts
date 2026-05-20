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

import type { IEventStore, StoredEvent } from "@swarm/store";
import type { SnapshotCapturedData } from "@swarm/types";
import { Hono } from "hono";
import type { RunSnapshotReader } from "../ports.ts";

export interface RunSnapshotsRouteOptions {
  store: IEventStore;
  reader: RunSnapshotReader;
}

/** Wire shape of one item in the scrubber list. */
export interface SnapshotItem {
  eventIdx: number;
  nodeId: string | null;
  /** Human-readable label for this boundary.
   *  "terminal" = fact.snapshot_recorded
   *  "hitl"     = snapshot.captured with nodeId null (HITL pause)
   *  "step"     = snapshot.captured with a nodeId (per-step) */
  label: "terminal" | "hitl" | "step";
  commitSha: string;
  treeSha: string;
  committed: SnapshotStat | null;
  uncommitted: SnapshotStat | null;
}

interface SnapshotStat {
  files: number;
  additions: number;
  deletions: number;
}

export function runSnapshotsRoutes(opts: RunSnapshotsRouteOptions): Hono {
  const app = new Hono();
  const { store, reader } = opts;

  // ── GET /runs/:id/snapshots ─────────────────────────────────────────

  app.get("/runs/:id/snapshots", (c) => {
    const runId = c.req.param("id");
    const state = store.getState(runId);
    if (state == null) return c.json({ error: "not_found" }, 404);
    const events = store.getSnapshotEvents(runId);
    return c.json(events.map(toScrubberRow));
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
    const runId = c.req.param("id");
    const state = store.getState(runId);
    if (state == null) return c.json({ error: "not_found" }, 404);
    if (state.cwd == null) return c.json({ error: "not_found" }, 404);

    const snapshots = store.getSnapshotEvents(runId).map(toScrubberRow);

    const idxParam = c.req.param("eventIdx");
    const eventIdx = parseEventIdx(idxParam);
    if (eventIdx == null) return c.json({ error: "invalid_event_idx" }, 400);

    const snapshotPos = snapshots.findIndex((s) => s.eventIdx === eventIdx);
    if (snapshotPos === -1) return c.json({ error: "not_found" }, 404);
    const snapshot = snapshots[snapshotPos] as SnapshotItem;

    const against = c.req.query("against") ?? "base";
    const pathFilter = c.req.query("path");

    let fromSha: string;

    if (against === "base") {
      const base = state.diffBaseSha ?? state.baseGitSha;
      if (base == null || base.length === 0) {
        return c.json({ error: "base_missing" }, 410);
      }
      fromSha = base;
    } else if (against === "previous") {
      if (snapshotPos === 0) {
        // First snapshot: diff against base (same behaviour as against=base)
        const base = state.diffBaseSha ?? state.baseGitSha;
        if (base == null || base.length === 0) {
          return c.json({ error: "base_missing" }, 410);
        }
        fromSha = base;
      } else {
        const prev = snapshots[snapshotPos - 1] as SnapshotItem;
        fromSha = prev.commitSha;
      }
    } else {
      // Treat as an eventIdx number
      const againstIdx = parseEventIdx(against);
      if (againstIdx == null) return c.json({ error: "invalid_against" }, 400);
      const againstSnap = snapshots.find((s) => s.eventIdx === againstIdx);
      if (againstSnap == null) return c.json({ error: "not_found" }, 404);
      fromSha = againstSnap.commitSha;
    }

    const diff = await reader.diff(
      state.cwd,
      fromSha,
      snapshot.commitSha,
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

function parseEventIdx(s: string): number | null {
  if (s.length === 0) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function extractCommitSha(ev: StoredEvent): string | null {
  const p = ev.payload as Record<string, unknown>;
  const sha = p["commitSha"];
  return typeof sha === "string" && sha.length > 0 ? sha : null;
}

function toScrubberRow(ev: StoredEvent): SnapshotItem {
  const p = ev.payload as Partial<SnapshotCapturedData> & {
    // fact.snapshot_recorded has these as non-optional
    committed?: { files: number; additions: number; deletions: number } | null;
    uncommitted?: { files: number; additions: number; deletions: number } | null;
  };

  const nodeId = p.nodeId ?? null;
  const label: SnapshotItem["label"] =
    ev.type === "fact.snapshot_recorded" ? "terminal" : nodeId === null ? "hitl" : "step";

  return {
    eventIdx: ev.seq,
    nodeId,
    label,
    commitSha: (p.commitSha as string) ?? "",
    treeSha: (p.treeSha as string) ?? "",
    committed: (p.committed as SnapshotStat | null | undefined) ?? null,
    uncommitted: (p.uncommitted as SnapshotStat | null | undefined) ?? null,
  };
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
