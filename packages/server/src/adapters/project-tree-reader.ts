// Filesystem ProjectTreeReader: enumerates files under a project root
// (the absolute `cwd` that runs were enqueued from) and serves their
// raw bytes for the web Files pane.
//
// Listing prefers `git ls-files -co --exclude-standard` so .gitignore is
// honoured for free; a pure dir-walk is the fallback for non-git
// checkouts. Blob reads enforce three guards before any FS access:
//   1) no `..` segment / leading `/` / NUL byte in the relative path;
//   2) the resolved absolute path must stay inside the project root;
//   3) size cap (1 MiB) and binary sniff (NUL byte in head) reject
//      anything the CodeBlock viewer can't render.
//
// The adapter is a pure factory — no module-level state — so tests
// instantiate it per-fixture and inject a different reader when they
// need to.

import { execFile } from "node:child_process";
import { type Dirent, promises as fsp } from "node:fs";

const { readdir, readFile, stat } = fsp;

import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ProjectTreeEntry, ProjectTreeReader, ReadBlobResult } from "../ports.ts";

const execFileAsync = promisify(execFile);

/** Hard ceiling on a single served file. CodeBlock isn't built for
 *  multi-MB sources and the wire payload would dwarf the rest of the
 *  page. Above this we return `too_large` (route → 413). */
const MAX_BLOB_BYTES = 1024 * 1024;

/** Cap on entries returned by the dir-walk fallback. The git path is
 *  already self-limiting (it returns tracked + untracked-not-ignored);
 *  the walk is what would explode on a `node_modules` checkout that's
 *  not a git repo. */
const MAX_WALK_ENTRIES = 20_000;

/** Bytes inspected for the binary sniff. Same heuristic the Grep tool
 *  uses (`docs/AGENTS.md`-mentioned "null byte in first 1KB") rounded
 *  up to an 8 KiB read so small-file cost is unchanged. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** 5-second wall-clock cap on `git ls-files`. A repo with millions of
 *  files would still finish well inside this; anything slower probably
 *  means git is wedged and we'd rather fall through to the dir-walk. */
const GIT_TIMEOUT_MS = 5_000;

export function createFsProjectTreeReader(): ProjectTreeReader {
  return {
    async list(cwd: string): Promise<ProjectTreeEntry[]> {
      const root = resolve(cwd);
      const files = (await listViaGit(root)) ?? (await listViaWalk(root));
      return foldEntries(files);
    },

    async readBlob(cwd: string, relPath: string): Promise<ReadBlobResult> {
      if (!isSafeRelPath(relPath)) return { kind: "invalid_path" };
      const root = resolve(cwd);
      const abs = resolve(root, relPath);
      // Defence in depth: even after the segment check, a symlink or a
      // weird normalisation could in principle escape. Refuse anything
      // that isn't a strict descendant of the project root.
      if (abs !== root && !abs.startsWith(root + sep)) return { kind: "invalid_path" };

      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(abs);
      } catch {
        return { kind: "not_found" };
      }
      if (!st.isFile()) return { kind: "not_found" };
      if (st.size > MAX_BLOB_BYTES) return { kind: "too_large" };

      // Read the head first to sniff for binary content. For files
      // ≤ BINARY_SNIFF_BYTES this is the whole file and we save a
      // second read.
      const buf = await readFile(abs);
      const head = buf.length > BINARY_SNIFF_BYTES ? buf.subarray(0, BINARY_SNIFF_BYTES) : buf;
      for (let i = 0; i < head.length; i++) {
        if (head[i] === 0) return { kind: "binary" };
      }
      return { kind: "ok", text: buf.toString("utf8") };
    },
  };
}

/** Run `git ls-files -co --exclude-standard` from `root`. Returns the
 *  list of repo-relative file paths on success, or `null` if `cwd` is
 *  not a git repo / git is unavailable / the call timed out. */
async function listViaGit(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    // `-z` uses NUL terminators so paths with newlines survive intact.
    return stdout.split("\0").filter((p) => p.length > 0);
  } catch {
    return null;
  }
}

/** Recursive dir-walk fallback for non-git checkouts. Skips dot-dirs
 *  (`.git`, `.fragua`, …) and symlinks; caps total entries to keep a
 *  pathological tree from melting the response. */
async function listViaWalk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    if (out.length >= MAX_WALK_ENTRIES) break;
    const dir = queue.shift() as string;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      // `isSymbolicLink` catches the common "node_modules → /elsewhere"
      // shape without us needing a separate `lstat` call per entry.
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(abs);
      } else if (entry.isFile()) {
        out.push(relative(root, abs));
        if (out.length >= MAX_WALK_ENTRIES) break;
      }
    }
  }
  return out;
}

/** Expand a flat list of file paths into the `{path,type}[]` the wire
 *  format promises: every file plus every ancestor directory, deduped,
 *  sorted depth-first by path so the web can render without a second
 *  pass. */
function foldEntries(files: string[]): ProjectTreeEntry[] {
  const dirs = new Set<string>();
  const seen = new Set<string>();
  const out: ProjectTreeEntry[] = [];
  for (const raw of files) {
    // Normalise Windows separators just in case the walk landed on a
    // host that hands them back. The wire format is always `/`.
    const path = raw.split(sep).join("/");
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    let parent = dirname(path);
    while (parent && parent !== "." && parent !== "/") {
      dirs.add(parent);
      parent = dirname(parent);
    }
    out.push({ path, type: "file" });
  }
  for (const d of dirs) out.push({ path: d, type: "dir" });
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Reject inputs that could escape the project root before we touch
 *  the filesystem. The route layer also pre-checks (so we can return a
 *  distinct 400) but we keep the same logic here so the adapter is
 *  safe in isolation — direct unit tests hit `readBlob` without going
 *  through Hono. */
function isSafeRelPath(p: string): boolean {
  if (p.length === 0) return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  for (const seg of p.split(/[\\/]/)) {
    if (seg === "..") return false;
  }
  return true;
}
