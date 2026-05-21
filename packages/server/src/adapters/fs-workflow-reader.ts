// Filesystem WorkflowReader: scans `<workflowsDir>` for `*.yaml` files and
// reports their name, relative path, a short content sha, and any
// `label:` attribute extracted from the YAML source. For
// `GET /workflows/:name` the `read` method returns the same metadata
// plus the raw YAML source on demand.
//
// This adapter is the only place in @fragua/server that reads workflow
// sources from disk. Handlers stay pure so tests can inject an in-memory
// reader and assert on the derived shape without touching the filesystem.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflow } from "@fragua/core";
import type { WorkflowDetail, WorkflowReader, WorkflowSummary } from "../ports.ts";

export interface FsWorkflowReaderOptions {
  /** Directory containing `*.yaml` workflow sources. */
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
      const yamls = entries.filter((n) => n.endsWith(".yaml"));
      const out: WorkflowSummary[] = [];
      for (const name of yamls) {
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

    async read(name: string, _opts?: { cwd?: string }): Promise<WorkflowDetail | undefined> {
      // Defence-in-depth: the route pattern already constrains `:name`,
      // but rejecting path separators + traversal here keeps this
      // adapter safe in isolation (unit tests call `read` directly).
      if (!isSafeName(name)) return undefined;
      const path = join(workflowsDir, `${name}.yaml`);
      let source: string;
      try {
        source = await readFile(path, "utf8");
      } catch {
        return undefined;
      }
      const sha = shortSha(source);
      const label = extractLabel(source);
      const detail: WorkflowDetail = { name, path, sha, source };
      if (label !== undefined) detail.label = label;
      try {
        const parsed = parseWorkflow(source);
        if (parsed.attrs.inputs && parsed.attrs.inputs.length > 0) {
          detail.inputs = parsed.attrs.inputs;
        }
      } catch {
        // Unparseable source — inputs remain absent; the error surfaces
        // elsewhere (e.g. at enqueue validation).
      }
      return detail;
    },
  };
}

/** Reject anything that could escape `workflowsDir` or address a file
 *  other than `<name>.yaml`. The filename grammar the list endpoint
 *  already enforces is "basename of a *.yaml file" — we mirror that. */
function isSafeName(name: string): boolean {
  if (name.length === 0 || name.length > 128) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name === "." || name === ".." || name.startsWith(".")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/** First 7 hex chars of sha256 — enough for visual "same?" comparison. */
function shortSha(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 7);
}

/** Strip directory + extension from a YAML filename. */
function basenameWithoutExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * Best-effort extraction of the top-level `label:` attribute from YAML
 * source. We intentionally keep this a simple regex rather than
 * full-parsing — the worst case is a run-time graph with a clever value
 * in its label falls back to `name` in the UI listing.
 *
 * Matches `^label: <rest>` at the document root (line-start, no leading
 * whitespace), stripping optional surrounding quotes. Returns undefined
 * when no literal match is found.
 */
function extractLabel(yamlSource: string): string | undefined {
  const m = yamlSource.match(/^label\s*:\s*(.+)$/m);
  if (!m) return undefined;
  const raw = m[1]?.trim();
  if (raw === undefined || raw === "") return undefined;
  // Strip matching quotes (`"…"` or `'…'`) if the value was authored
  // with them. Inline quotes inside an unquoted scalar pass through.
  const quoted = raw.match(/^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/);
  if (quoted) return (quoted[1] ?? quoted[2] ?? "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
  return raw;
}
