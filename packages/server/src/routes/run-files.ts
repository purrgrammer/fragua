// GET /runs/:runId/tree           — flat {path,type}[] under the run's worktree.
// GET /runs/:runId/blob?path=…    — raw text of one file inside the worktree.
// GET /runs/:runId/changes        — git diff numstat + name-status from
//                                   `baseGitSha..refs/heads/swarm/runs/<id>`.
//
// Lookup model:
//
//   1) `state = store.getState(runId)` → 404 when null. Same shape as
//      `runs-routes.ts:GET /runs/:id` so the web treats unknown runs
//      consistently.
//   2) Worktree path: `<state.cwd>/.swarm/worktrees/<runId>` — the
//      canonical layout `WorktreeProvisioner` writes (cli/daemon.ts:349,
//      worktreesDir default ".swarm/worktrees"). `fs.access` the dir;
//      ENOENT → 410 Gone (`worktree_disposed`). 410 is the precise
//      "this used to exist; it doesn't anymore" status, which lets the
//      web branch on `error.status === 410` to keep the diff view but
//      drop the live file tree.
//   3) `/changes` doesn't need the worktree on disk — it runs git
//      against the run's project root (`state.cwd`) and reads the
//      `swarm/runs/<runId>` ref `WorktreeEnvironment.dispose()`
//      preserves (worktree-env.ts §`branch` doc) plus the `baseGitSha`
//      stamped on `fact.run_started` (worktree-env.ts:158). Survives
//      worktree disposal by design.
//
// All filesystem reads inside the worktree go through the same
// `ProjectTreeReader` the projects routes use — only the root path
// differs (worktreePath vs project cwd).

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IEventStore, StoredEvent } from "@swarm/store";
import { Hono } from "hono";
import type { ProjectTreeReader } from "../ports.ts";

const execFileAsync = promisify(execFile);

/** Wall-clock cap on every git invocation. Same shape as
 *  `adapters/project-tree-reader.ts` (5s). A wedged repo shouldn't
 *  block a request indefinitely. */
const GIT_TIMEOUT_MS = 5_000;

/** Defensive cap on the `/changes` response. A pathological diff
 *  (vendored-dir flip, generated lockfile churn) shouldn't shovel
 *  hundreds of MB of JSON across the wire. */
const MAX_CHANGES = 5_000;

export interface RunFilesRouteOptions {
  store: IEventStore;
  reader: ProjectTreeReader;
}

export interface RunChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export function runFilesRoutes(opts: RunFilesRouteOptions): Hono {
  const app = new Hono();
  const { store, reader } = opts;

  app.get("/runs/:runId/tree", async (c) => {
    const runId = c.req.param("runId");
    const lookup = await resolveRunWorktree(store, runId);
    if (lookup.kind === "not_found") return c.json({ error: "not_found" }, 404);
    if (lookup.kind === "disposed") return c.json({ error: "worktree_disposed" }, 410);
    const entries = await reader.list(lookup.worktreePath);
    return c.json(entries);
  });

  app.get("/runs/:runId/blob", async (c) => {
    const runId = c.req.param("runId");
    const lookup = await resolveRunWorktree(store, runId);
    if (lookup.kind === "not_found") return c.json({ error: "not_found" }, 404);
    if (lookup.kind === "disposed") return c.json({ error: "worktree_disposed" }, 410);

    const path = c.req.query("path");
    if (typeof path !== "string" || path.length === 0) {
      return c.json({ error: "invalid_path" }, 400);
    }
    if (!isPreflightSafe(path)) {
      return c.json({ error: "invalid_path" }, 400);
    }

    const result = await reader.readBlob(lookup.worktreePath, path);
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

  app.get("/runs/:runId/changes", async (c) => {
    const runId = c.req.param("runId");
    const state = store.getState(runId);
    if (state == null) return c.json({ error: "not_found" }, 404);
    if (state.cwd == null) return c.json([]);

    const baseGitSha = pickBaseGitSha(state.baseGitSha, store.getEvents(runId, { limit: 200 }));
    if (baseGitSha == null) return c.json([]);

    const tip = await resolveRunTip(state.cwd, runId);
    if (tip == null) return c.json([]);

    const changes = await diffNumstatNameStatus(state.cwd, baseGitSha, tip);
    return c.json(changes.slice(0, MAX_CHANGES));
  });

  return app;
}

type WorktreeLookup = { kind: "ok"; cwd: string; worktreePath: string } | { kind: "not_found" } | { kind: "disposed" };

async function resolveRunWorktree(store: IEventStore, runId: string): Promise<WorktreeLookup> {
  const state = store.getState(runId);
  if (state == null) return { kind: "not_found" };
  if (state.cwd == null) return { kind: "disposed" };
  const worktreePath = join(state.cwd, ".swarm", "worktrees", runId);
  try {
    await access(worktreePath);
  } catch {
    return { kind: "disposed" };
  }
  return { kind: "ok", cwd: state.cwd, worktreePath };
}

/** Mirror of `routes/projects.ts:isPreflightSafe`. Reject `..` segments,
 *  leading separators, and NUL bytes before any FS access. */
function isPreflightSafe(p: string): boolean {
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  for (const seg of p.split(/[\\/]/)) {
    if (seg === "..") return false;
  }
  return true;
}

/** Prefer the projection's `baseGitSha` (cheap, already there) and
 *  fall back to walking events for `fact.run_started.payload.baseGitSha`
 *  (set by the executor from `WorktreeEnvironment.baseGitSha`,
 *  worktree-env.ts:158). Returns null when neither is present —
 *  there's no diff baseline to render. */
function pickBaseGitSha(projected: string | null, events: StoredEvent[]): string | null {
  if (projected != null && projected.length > 0) return projected;
  for (const ev of events) {
    if (ev.type !== "fact.run_started") continue;
    const sha = (ev.payload as { baseGitSha?: unknown }).baseGitSha;
    if (typeof sha === "string" && sha.length > 0) return sha;
  }
  return null;
}

/** `git rev-parse refs/heads/swarm/runs/<runId>` from the run's project
 *  root. Returns null if the ref doesn't exist (run never had its
 *  worktree disposed with content) or git itself is unavailable. */
async function resolveRunTip(cwd: string, runId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", `refs/heads/swarm/runs/${runId}`], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/** Build the change list from two git invocations:
 *
 *   - `git diff --numstat -z <base>..<tip>` → `(additions, deletions, path)`
 *     (or `(additions, deletions, oldPath, newPath)` for renames).
 *   - `git diff --name-status -z <base>..<tip>` → `(letter, path)` /
 *     `(letter, oldPath, newPath)` for renames + copies.
 *
 *  Both are NUL-delimited via `-z` so paths with newlines / spaces
 *  survive intact. We key by the canonical (new) path and join the
 *  status letter onto the numstat row.
 *
 *  Binary files emit `-` for both add/delete counts in numstat — we
 *  surface them as `0/0` since the diff still happened (just not in
 *  lines). The `status` letter is what the UI uses to badge them. */
async function diffNumstatNameStatus(cwd: string, base: string, tip: string): Promise<RunChange[]> {
  const [numstatRaw, nameStatusRaw] = await Promise.all([
    runGitCapture(cwd, ["diff", "--numstat", "-z", `${base}..${tip}`]),
    runGitCapture(cwd, ["diff", "--name-status", "-z", `${base}..${tip}`]),
  ]);

  const counts = parseNumstat(numstatRaw);
  const statuses = parseNameStatus(nameStatusRaw);

  const out: RunChange[] = [];
  for (const [path, c] of counts) {
    const status = statuses.get(path) ?? inferStatus(c);
    out.push({ path, status, additions: c.additions, deletions: c.deletions });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

async function runGitCapture(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

interface NumstatRow {
  additions: number;
  deletions: number;
  rename: boolean;
}

/** Parse `git diff --numstat -z` output. Each record is three or four
 *  NUL-terminated tokens:
 *    - normal: `<adds>\t<dels>\t<path>\0`
 *    - rename: `<adds>\t<dels>\0<oldPath>\0<newPath>\0`
 *  We dispatch on whether the first token's tail (after the second
 *  TAB) is empty — that's the rename shape. */
function parseNumstat(raw: string): Map<string, NumstatRow> {
  const out = new Map<string, NumstatRow>();
  if (raw.length === 0) return out;
  const tokens = raw.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (head === undefined || head.length === 0) {
      i++;
      continue;
    }
    const parts = head.split("\t");
    if (parts.length < 3) {
      i++;
      continue;
    }
    const adds = parseCount(parts[0] ?? "");
    const dels = parseCount(parts[1] ?? "");
    const inlinePath = parts.slice(2).join("\t");
    if (inlinePath.length > 0) {
      out.set(inlinePath, { additions: adds, deletions: dels, rename: false });
      i++;
    } else {
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      const key = newPath.length > 0 ? newPath : oldPath;
      if (key.length > 0) out.set(key, { additions: adds, deletions: dels, rename: true });
      i += 3;
    }
  }
  return out;
}

/** Parse `git diff --name-status -z` output. Each record is two or
 *  three NUL-terminated tokens:
 *    - normal: `<letter>\0<path>\0`     (A / M / D / T / U / X)
 *    - rename: `R<score>\0<old>\0<new>` (also C<score> for copy)
 *  We map the letter to one of the four statuses the wire format
 *  exposes; copies surface as `added` (the new file is a brand-new
 *  path on the tip). */
function parseNameStatus(raw: string): Map<string, RunChange["status"]> {
  const out = new Map<string, RunChange["status"]>();
  if (raw.length === 0) return out;
  const tokens = raw.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const letter = tokens[i];
    if (letter === undefined || letter.length === 0) {
      i++;
      continue;
    }
    const code = letter[0];
    if (code === "R") {
      const newPath = tokens[i + 2] ?? "";
      if (newPath.length > 0) out.set(newPath, "renamed");
      i += 3;
      continue;
    }
    if (code === "C") {
      const newPath = tokens[i + 2] ?? "";
      if (newPath.length > 0) out.set(newPath, "added");
      i += 3;
      continue;
    }
    const path = tokens[i + 1] ?? "";
    if (path.length === 0) {
      i++;
      continue;
    }
    if (code === "A") out.set(path, "added");
    else if (code === "D") out.set(path, "deleted");
    else if (code === "M" || code === "T") out.set(path, "modified");
    else out.set(path, "modified");
    i += 2;
  }
  return out;
}

/** Numstat emits `-` for binary files. Treat as 0 so the JSON shape
 *  stays integer-only; the `status` field still carries the change
 *  type so the UI can render a "binary" hint if it cares. */
function parseCount(s: string): number {
  if (s === "-" || s.length === 0) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Best-effort fallback when `--name-status` didn't tag a path the
 *  numstat row mentioned (shouldn't happen in practice — keep it
 *  defensive). Pure deletions get `deleted`; pure additions get
 *  `added`; everything else `modified`. */
function inferStatus(c: NumstatRow): RunChange["status"] {
  if (c.rename) return "renamed";
  if (c.additions === 0 && c.deletions > 0) return "deleted";
  if (c.deletions === 0 && c.additions > 0) return "added";
  return "modified";
}
