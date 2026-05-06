// Skills HTTP endpoints — read-only surface backing the web UI's /skills
// and /projects/:id/skills views. All routes re-walk the filesystem on
// each request (frontmatter-only reads, ms-scale for realistic skill
// counts); tanstack-query holds results client-side with manual
// invalidation on the rescan button.
//
// Identity: `:locId = base64url(skill_dir)`. Names aren't globally
// unique — two projects can both ship a skill named `frontend` — so the
// detail/tree/file paths key on the absolute skill_dir, opaquely
// b64url-encoded for URL safety.
//
// Project enumeration: `cwd ∪ store.listCwds()`. Same set the daemon
// walks at boot. Per-project filtering is via `?project_cwd=<cwd>` on
// list endpoints — keeps user-scope records visible plus the one
// project's project-scope records. Add `&scope=project_only` to drop
// user-scope rows entirely; the project-detail tabs use this so
// operators see exactly what's anchored to that project root.

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { IEventStore } from "@swarm/store";
import type { Skill, SkillsConfig } from "@swarm/types";
import { discoverSkills, parseSkillMd } from "@swarm/workspace";
import { Hono } from "hono";

export interface SkillsRoutesOpts {
  store: IEventStore;
  /** User home directory. Drives `~/.agents/skills/` + `~/.claude/skills/`. */
  homeDir: string;
  /** Server's startup cwd. Always unioned into the project enumeration so
   * a fresh deployment with no runs yet still discovers its own
   * project-scope skills. */
  cwd: string;
  /** Project-config skills override — same shape the daemon honours.
   * When set, its `paths` / `disabled` / `trustProject` apply globally
   * across all enumerated project cwds (per-project config reading
   * is out of scope here). */
  skillsConfig?: SkillsConfig;
}

interface TreeEntry {
  /** Path relative to skill_dir, posix-separated. Empty string for the
   * root entry. */
  path: string;
  type: "file" | "dir";
  /** Byte length for files, 0 for directories. */
  size: number;
}

/** Cap on the recursive tree walk. Skills are tens of files at most;
 * a runaway count points at a misbehaving skill author or symlink
 * loop. Returned entries are truncated past this cap. */
const TREE_ENTRY_CAP = 5000;

/** Cap on the recursive walk depth. Same rationale as above. */
const TREE_DEPTH_CAP = 10;

export function skillsRoutes(opts: SkillsRoutesOpts): Hono {
  const app = new Hono();

  app.get("/skills", async (c) => {
    const filterCwd = c.req.query("project_cwd");
    const strict = c.req.query("scope") === "project_only";
    const projectCwds = filterCwd !== undefined ? [filterCwd] : enumerateProjectCwds(opts);
    const { skills } = await discoverFor(opts, projectCwds);
    // When `project_cwd` is supplied, the discovery walked only that
    // cwd's project roots — combined with user-scope, the response is
    // already the right shape. With `scope=project_only` we additionally
    // drop user-scope rows so the project detail tabs show exactly the
    // skills anchored to that project root.
    const filtered =
      strict && filterCwd !== undefined
        ? skills.filter((s) => s.scope === "project" && s.project_cwd === filterCwd)
        : skills;
    return c.json({ skills: filtered.map(toListItem) });
  });

  app.get("/skills/:locId", async (c) => {
    const skill = await resolveByLocId(opts, c.req.param("locId"));
    if (!skill) return c.json({ error: "skill not found", code: "not_found" }, 404);
    let raw: string;
    try {
      raw = await readFile(skill.location, "utf8");
    } catch (err) {
      return c.json(
        { error: `failed to read SKILL.md: ${err instanceof Error ? err.message : String(err)}`, code: "io_error" },
        500,
      );
    }
    const parsed = parseSkillMd(raw);
    return c.json({
      skill: toListItem(skill),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  });

  app.get("/skills/:locId/tree", async (c) => {
    const skill = await resolveByLocId(opts, c.req.param("locId"));
    if (!skill) return c.json({ error: "skill not found", code: "not_found" }, 404);
    let tree: TreeEntry[];
    try {
      tree = await walkTree(skill.skill_dir);
    } catch (err) {
      return c.json(
        { error: `tree walk failed: ${err instanceof Error ? err.message : String(err)}`, code: "io_error" },
        500,
      );
    }
    return c.json({ tree, truncated: tree.length >= TREE_ENTRY_CAP });
  });

  app.get("/skills/:locId/file", async (c) => {
    const skill = await resolveByLocId(opts, c.req.param("locId"));
    if (!skill) return c.json({ error: "skill not found", code: "not_found" }, 404);
    const relPath = c.req.query("path");
    if (relPath === undefined || relPath.length === 0) {
      return c.json({ error: "missing required `path` query parameter", code: "bad_request" }, 400);
    }
    // Sandbox: resolve normalises `..`/`.` so a path like
    // `../../../etc/passwd` resolves to `/etc/passwd` and fails the
    // prefix check below.
    const resolved = resolve(skill.skill_dir, relPath);
    const safeRoot = skill.skill_dir.endsWith(sep) ? skill.skill_dir : skill.skill_dir + sep;
    if (resolved !== skill.skill_dir && !resolved.startsWith(safeRoot)) {
      return c.json({ error: "path escapes skill_dir", code: "forbidden" }, 403);
    }
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(resolved);
    } catch {
      return c.json({ error: "file not found", code: "not_found" }, 404);
    }
    if (stats.isDirectory()) {
      return c.json({ error: "path is a directory", code: "bad_request" }, 400);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(resolved);
    } catch (err) {
      return c.json(
        { error: `read failed: ${err instanceof Error ? err.message : String(err)}`, code: "io_error" },
        500,
      );
    }
    // Content-Type derived from extension; the client viewer dispatches
    // on this header (markdown / image / monospace / hex-dump). Default
    // to octet-stream so unknown extensions land in the hex-dump bucket.
    return new Response(bytes, {
      headers: {
        "Content-Type": mimeFromExt(resolved),
        "Content-Length": String(stats.size),
      },
    });
  });

  return app;
}

function enumerateProjectCwds(opts: SkillsRoutesOpts): string[] {
  const known = opts.store.listCwds().map((r) => r.cwd);
  return Array.from(new Set([opts.cwd, ...known]));
}

async function discoverFor(opts: SkillsRoutesOpts, projectCwds: readonly string[]) {
  return discoverSkills({
    projectCwds,
    homeDir: opts.homeDir,
    ...(opts.skillsConfig ? { config: opts.skillsConfig } : {}),
  });
}

async function resolveByLocId(opts: SkillsRoutesOpts, locId: string): Promise<Skill | undefined> {
  let skillDir: string;
  try {
    skillDir = decodeB64Url(locId);
  } catch {
    return undefined;
  }
  const { skills } = await discoverFor(opts, enumerateProjectCwds(opts));
  return skills.find((s) => s.skill_dir === skillDir);
}

async function walkTree(rootAbs: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  await walkInto(rootAbs, "", 0, out);
  return out;
}

async function walkInto(rootAbs: string, relBase: string, depth: number, out: TreeEntry[]): Promise<void> {
  if (out.length >= TREE_ENTRY_CAP) return;
  if (depth > TREE_DEPTH_CAP) return;
  const dirAbs = relBase === "" ? rootAbs : resolve(rootAbs, relBase);
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await readdir(dirAbs, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
  } catch {
    return;
  }
  // Sort within each directory — readdir is filesystem-order, which is
  // platform-dependent and ugly in the UI.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= TREE_ENTRY_CAP) return;
    if (entry.name.startsWith(".")) continue; // hidden files / .DS_Store
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    const abs = resolve(rootAbs, rel);
    if (entry.isDirectory()) {
      out.push({ path: rel, type: "dir", size: 0 });
      await walkInto(rootAbs, rel, depth + 1, out);
    } else if (entry.isFile()) {
      let size = 0;
      try {
        const s = await stat(abs);
        size = s.size;
      } catch {
        // unreadable file — surface as size 0 rather than failing the
        // whole tree walk.
      }
      out.push({ path: rel, type: "file", size });
    }
  }
}

/** Compact list-row shape for `GET /skills`. Drops `skill_dir` (the URL
 * is the canonical handle) and the SKILL.md body (loaded on demand by
 * the detail endpoint). */
function toListItem(s: Skill): Record<string, unknown> {
  const locId = encodeB64Url(s.skill_dir);
  const out: Record<string, unknown> = {
    locId,
    name: s.name,
    description: s.description,
    location: s.location,
    skill_dir: s.skill_dir,
    sha256: s.sha256,
    bytes: s.bytes,
    scope: s.scope,
    source_dir: s.source_dir,
  };
  if (s.version !== undefined) out["version"] = s.version;
  if (s.compatibility !== undefined) out["compatibility"] = s.compatibility;
  if (s.allowed_tools !== undefined) out["allowed_tools"] = s.allowed_tools;
  if (s.license !== undefined) out["license"] = s.license;
  if (s.metadata !== undefined) out["metadata"] = s.metadata;
  if (s.project_cwd !== undefined) out["project_cwd"] = s.project_cwd;
  if (s.disabled_reason !== undefined) out["disabled_reason"] = s.disabled_reason;
  return out;
}

function encodeB64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function decodeB64Url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".mjs": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".bash": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function mimeFromExt(absPath: string): string {
  const dot = absPath.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = absPath.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
