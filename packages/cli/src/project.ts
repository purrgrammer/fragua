// Project identity resolution — maps a working directory to a stable
// project (`id` + display `name`) and the project root it lives at.
//
// Resolution walks UP from `cwd` to the nearest `.fragua/config.yaml`,
// bounded by the git repo root (`git rev-parse --show-toplevel`): a root
// config gives the whole repo one identity; a subdirectory opts into its
// own identity by holding its own config. The git-root ceiling is
// load-bearing — it stops the climb before `~/.fragua/config.yaml` (the
// *global* config cascade, not a project config) is read as identity.
// Outside a git repo there is no safe ceiling, so resolution is exact-cwd
// only. When no `id` is found, `fragua run` auto-inits: a real UUIDv7 is
// minted and written at the project root (no `path:<cwd>` fallback), so
// every run carries a portable identity. The committed-ness of that
// config is gate 2 — reported, never blocking.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { uuidv7 } from "@fragua/core";
import YAML from "yaml";

export interface ResolvedProject {
  /** Stable project IDENTITY — the committed (or freshly minted) `id`. */
  projectId: string;
  /** Display label — config `name`, else the project-root basename. */
  projectName: string;
  /** The resolved project root: the dir holding the matched config (or
   *  the git root / cwd when auto-initing). This — NOT the invocation dir
   *  — is what a run records as its `cwd`, so all of `.fragua/` stays in
   *  one place. */
  projectRoot: string;
  /** True when this call minted/wrote the `id` (auto-init or back-fill). */
  created: boolean;
  /** Gate 2: is `.fragua/config.yaml` tracked by git at the project root?
   *  False for a fresh/untracked config (or a non-git project) — runs work
   *  but aren't portable until it's committed. */
  committed: boolean;
}

const GITIGNORE_BLOCK = `# fragua runtime — never commit these
.fragua/runs/
.fragua/worktrees/
.fragua/blobs/
.fragua/fragua.db*
.fragua/daemon/

# fragua — always commit these (negative patterns for clarity)
!.fragua/config.yaml
!.fragua/workflows/
`;

const GITIGNORE_MARKER = "# fragua runtime — never commit these";

/** realpath if the path exists, else a plain resolve — so symlinked
 *  parents (macOS `/var` → `/private/var`) match git's reported toplevel. */
function canonical(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

/** Absolute git toplevel for `cwd`, or null when not inside a work tree. */
export function findGitRoot(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status !== 0 || r.error != null) return null;
  const top = r.stdout.trim();
  return top.length > 0 ? top : null;
}

/** Nearest `.fragua/config.yaml` at or above `cwd`, stopping at (and
 *  including) `ceiling`. With `ceiling = null` (non-git), only `cwd`
 *  itself is checked — no walk-up. */
function findConfigUpward(cwd: string, ceiling: string | null): string | null {
  let dir = resolve(cwd);
  const stop = ceiling != null ? resolve(ceiling) : dir;
  for (;;) {
    const candidate = resolve(dir, ".fragua/config.yaml");
    if (existsSync(candidate)) return candidate;
    if (dir === stop) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isTrackedByGit(projectRoot: string, relPath: string): boolean {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", relPath], {
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return r.status === 0;
}

interface ConfigIdName {
  id?: string;
  name?: string;
}

async function readConfigIdName(configPath: string): Promise<ConfigIdName> {
  try {
    const body = await readFile(configPath, "utf8");
    const parsed = YAML.parse(body) as Record<string, unknown> | null;
    if (parsed == null || typeof parsed !== "object") return {};
    const out: ConfigIdName = {};
    const rawId = parsed["id"];
    if (typeof rawId === "string" && rawId.length > 0) out.id = rawId;
    const rawName = parsed["name"];
    if (typeof rawName === "string" && rawName.length > 0) out.name = rawName;
    return out;
  } catch {
    return {};
  }
}

function renderConfig(id: string, name: string): string {
  return `# fragua project config — project-specific knobs only.
# Generic preferences live in ~/.fragua/config.yaml.

# Stable project identity. Committed so every clone shares it and runs
# stay attributable across machines — do not change it.
id: ${id}
name: ${name}

# Uncomment if the project needs a per-worktree bootstrap command:
# bootstrap: "bun install --frozen-lockfile"
`;
}

async function mergeGitignore(projectRoot: string): Promise<void> {
  const path = resolve(projectRoot, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // missing — write fresh
  }
  if (existing.includes(GITIGNORE_MARKER)) return;
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
  await writeFile(path, `${existing}${sep}${GITIGNORE_BLOCK}`, "utf8");
}

/** Write the project scaffold at `projectRoot`: `.fragua/config.yaml`
 *  (with a fresh UUIDv7 `id` + dir-name `name`), the `.fragua/workflows/`
 *  dir, and the runtime `.gitignore` block. Shared by `fragua init` and
 *  the `fragua run` auto-init path. Returns the minted identity. */
export async function writeProjectScaffold(projectRoot: string): Promise<{ id: string; name: string }> {
  const id = uuidv7();
  const name = basename(projectRoot) || "project";
  await mkdir(resolve(projectRoot, ".fragua/workflows"), { recursive: true });
  await writeFile(resolve(projectRoot, ".fragua/config.yaml"), renderConfig(id, name), "utf8");
  await mergeGitignore(projectRoot);
  return { id, name };
}

/** Resolve the project for `cwd`, auto-initing when no `id` is found.
 *  Always returns a real identity — never a synthesized `path:<cwd>`. */
export async function resolveProject(cwd: string): Promise<ResolvedProject> {
  // Normalize through realpath so the git-root ceiling comparison holds:
  // `git rev-parse --show-toplevel` reports the real path (e.g. macOS
  // `/private/var/…`), and an un-normalized symlinked cwd (`/var/…`) would
  // never equal it, letting the walk escape the repo.
  const here = canonical(cwd);
  const gitRoot = findGitRoot(here);
  const configPath = findConfigUpward(here, gitRoot);

  if (configPath != null) {
    const projectRoot = dirname(dirname(configPath));
    const { id, name } = await readConfigIdName(configPath);
    const projectName = name ?? (basename(projectRoot) || "project");
    if (id != null) {
      return {
        projectId: id,
        projectName,
        projectRoot,
        created: false,
        committed: gitRoot != null && isTrackedByGit(projectRoot, ".fragua/config.yaml"),
      };
    }
    // A config exists but carries no `id` (hand-rolled, or pre-dates the
    // field). Back-fill a minted id without clobbering the file's comments:
    // prepend an `id:` line. (Skip if some `id:` line already exists to
    // avoid a duplicate-key document.)
    const minted = uuidv7();
    const body = await readFile(configPath, "utf8").catch(() => "");
    if (!/^id:/m.test(body)) {
      await writeFile(configPath, `id: ${minted}\n${body}`, "utf8");
    }
    return {
      projectId: minted,
      projectName,
      projectRoot,
      created: true,
      committed: false,
    };
  }

  // No config anywhere in range → auto-init at the git root (else cwd).
  const projectRoot = gitRoot ?? here;
  const { id, name } = await writeProjectScaffold(projectRoot);
  return { projectId: id, projectName: name, projectRoot, created: true, committed: false };
}
