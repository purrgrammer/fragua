// Filesystem WorkflowReader: scans `<workflowsDir>` for `*.dot` files and
// reports their name, relative path, a short content sha, and any
// `label="..."` attribute extracted from the DOT source.
//
// This adapter is the only place in @swarm/server that reads workflow
// sources from disk. Handlers stay pure so tests can inject an in-memory
// reader and assert on the derived shape without touching the filesystem.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowReader, WorkflowSummary } from "../ports.ts";

export interface FsWorkflowReaderOptions {
  /** Directory containing `*.dot` workflow sources. */
  workflowsDir: string;
}

export function createFsWorkflowReader(opts: FsWorkflowReaderOptions): WorkflowReader {
  const { workflowsDir } = opts;

  return {
    async list(): Promise<WorkflowSummary[]> {
      let entries: string[];
      try {
        entries = await readdir(workflowsDir);
      } catch {
        // Missing directory is "no workflows", not an error — matches the
        // RunReader's treatment of an empty runs directory.
        return [];
      }
      const dots = entries.filter((n) => n.endsWith(".dot"));
      const out: WorkflowSummary[] = [];
      for (const name of dots) {
        const path = join(workflowsDir, name);
        let contents: string;
        try {
          contents = await readFile(path, "utf8");
        } catch {
          // Race with removal / permissions blip — skip rather than 500.
          continue;
        }
        const sha = shortSha(contents);
        const label = extractLabel(contents);
        out.push({
          name: basenameWithoutExt(name),
          path,
          sha,
          ...(label !== undefined ? { label } : {}),
        });
      }
      // Stable alphabetical ordering — callers can re-sort client-side.
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return out;
    },
  };
}

/** First 7 hex chars of sha256 — enough for visual "same?" comparison. */
function shortSha(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 7);
}

/** Strip directory + extension from a DOT filename. */
function basenameWithoutExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * Best-effort extraction of the graph-level `label="..."` attribute from
 * DOT source. We intentionally keep this a simple regex rather than
 * shelling out to a parser: the worst case is that a run-time graph with
 * a clever escape in its label falls back to `name` in the UI.
 *
 * Matches the first `label = "..."` occurrence, tolerating whitespace
 * around the `=`. Returns `undefined` when no literal match is found.
 */
function extractLabel(dotSource: string): string | undefined {
  const m = dotSource.match(/\blabel\s*=\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return undefined;
  const raw = m[1];
  if (raw === undefined || raw === "") return undefined;
  // Unescape the two sequences DOT commonly carries. Anything else we
  // leave as-is — the regex already refused unterminated escapes.
  return raw.replace(/\\n/g, "\n").replace(/\\"/g, '"');
}
