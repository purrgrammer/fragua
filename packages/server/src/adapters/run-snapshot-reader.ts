// Snapshot-specific git reads for the worktree snapshot endpoints.
//
// Every method is a one-shot `git` invocation against the run's project
// `cwd` git dir — no checkouts, no worktree mutation. The snapshot
// commits are reachable via `refs/fragua/snapshots/<runId>`; we query by
// raw sha so the single tip ref carries the whole chain without needing
// per-eventIdx refs.
//
// Shape mirrors `adapters/project-tree-reader.ts`: factory with no
// module-level state, 5-second git timeout, maxBuffer 64 MiB.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunSnapshotReader, SnapshotTreeEntry } from "../ports.ts";

const execFileAsync = promisify(execFile);

/** Wall-clock cap on every git invocation. Same as
 *  `adapters/project-tree-reader.ts` (5 s). */
const GIT_TIMEOUT_MS = 5_000;

/** Hard ceiling on a single diff or blob response. Keeps pathological
 *  bulk changes from melting the wire payload. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export function createRunSnapshotReader(): RunSnapshotReader {
  return {
    async lsTree(cwd: string, commitSha: string) {
      let stdout: string;
      try {
        const result = await execFileAsync("git", ["ls-tree", "-l", "-z", "--full-tree", commitSha], {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: MAX_RESPONSE_BYTES,
        });
        stdout = result.stdout;
      } catch {
        return null;
      }
      return { entries: parseLsTree(stdout) };
    },

    async showFile(cwd: string, commitSha: string, path: string) {
      let stdout: Buffer;
      try {
        const result = await execFileAsync("git", ["show", `${commitSha}:${path}`], {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: MAX_RESPONSE_BYTES,
          encoding: "buffer",
        } as Parameters<typeof execFileAsync>[2]);
        stdout = (result as unknown as { stdout: Buffer }).stdout;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("does not exist") ||
          msg.includes("not a valid object") ||
          msg.includes("Path") ||
          msg.includes("pathspec")
        ) {
          return { kind: "not_found" };
        }
        return { kind: "not_found" };
      }
      if (stdout.length > MAX_RESPONSE_BYTES) return { kind: "too_large" };
      return { kind: "ok", bytes: stdout };
    },

    async diff(cwd: string, fromSha: string, toSha: string, path?: string) {
      const args = ["diff", `${fromSha}..${toSha}`];
      if (path !== undefined && path.length > 0) args.push("--", path);
      try {
        const result = await execFileAsync("git", args, {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: MAX_RESPONSE_BYTES,
        });
        return result.stdout;
      } catch {
        return "";
      }
    },

    async mergeability(cwd: string, intoRef: string, headsRef: string) {
      const into = await revParse(cwd, intoRef);
      const heads = await revParse(cwd, headsRef);
      if (into == null || heads == null) return { resolved: false };
      // ff ⟺ the target tip is an ancestor of the run's heads commit
      // (mirrors the daemon's `applyMerge` predicate exactly so server
      // validation and the sweep never disagree).
      const ff = (await gitExit(cwd, ["merge-base", "--is-ancestor", into, heads])) === 0;
      // A non-zero `merge-tree --write-tree` exit signals a conflict.
      const conflict = ff ? false : (await gitExit(cwd, ["merge-tree", "--write-tree", into, heads])) !== 0;
      return { resolved: true, ff, conflict };
    },

    async refExists(cwd: string, ref: string) {
      return (await revParse(cwd, ref)) != null;
    },
  };
}

/** Resolve a ref to its sha via `rev-parse --verify --quiet`, or null. */
async function revParse(cwd: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    const sha = stdout.trim();
    return sha === "" ? null : sha;
  } catch {
    return null;
  }
}

/** Run a git command, returning its exit code (0 on success). */
async function gitExit(cwd: string, args: string[]): Promise<number> {
  try {
    await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_RESPONSE_BYTES });
    return 0;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "number" ? code : 1;
  }
}

/** Parse `git ls-tree -l -z --full-tree <sha>` output.
 *
 *  Each NUL-delimited record is:
 *    `<mode> SP <type> SP <sha> SP <padded-size> TAB <path>`
 *
 *  The `-l` flag makes git pad `size` to a fixed-width column (blobs
 *  only; trees/commits print `-`). We strip leading whitespace and
 *  treat `-` as 0. */
function parseLsTree(raw: string): SnapshotTreeEntry[] {
  const entries: SnapshotTreeEntry[] = [];
  if (raw.length === 0) return entries;
  const records = raw.split("\0");
  for (const record of records) {
    if (record.length === 0) continue;
    const tabIdx = record.indexOf("\t");
    if (tabIdx === -1) continue;
    const meta = record.slice(0, tabIdx);
    const path = record.slice(tabIdx + 1);
    const parts = meta.trimEnd().split(/\s+/);
    if (parts.length < 4) continue;
    const mode = parts[0] ?? "";
    const rawType = parts[1] ?? "";
    const rawSize = parts[3] ?? "-";
    const type: SnapshotTreeEntry["type"] = rawType === "blob" ? "blob" : rawType === "commit" ? "commit" : "tree";
    const size = rawSize === "-" ? 0 : Number(rawSize) || 0;
    if (path.length > 0 && mode.length > 0) {
      entries.push({ path, mode, size, type });
    }
  }
  return entries;
}
