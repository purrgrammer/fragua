// Assemble per-run system prompt extensions (context_files node attribute).
// Pulled into a separate module so it can be unit-tested without pi-agent-core.

import { createHash } from "node:crypto";
import type { ExecutionEnvironment } from "@swarm/workspace";

/** Hard cap on the total bytes of project-conventions content prepended to the
 * system prompt. A single oversized AGENTS.md should not blow the context
 * window silently. Individual files are truncated; the final block never
 * exceeds this size. */
export const CONTEXT_FILES_MAX_BYTES = 32 * 1024;

/** Per-file record captured alongside the assembled system prompt. Durable on
 * `llm.start.context_files` so replay consumers can reason about whether a
 * file has changed between a run and its replay without needing the original
 * bytes. */
export interface ContextFileRecord {
  path: string;
  /** Hex sha256 of the file's raw contents (pre-truncation). */
  sha256: string;
  /** Byte length of the raw contents (pre-truncation). */
  bytes: number;
  /** True if this file's contribution to the final block was truncated to
   * fit under `CONTEXT_FILES_MAX_BYTES`. */
  truncated: boolean;
  /** "ok" when read succeeded; "missing" when `readFile` threw. Missing files
   * contribute no bytes but keep a record so the event log shows the full
   * set the workflow author asked for. */
  status: "ok" | "missing";
  /** Present only when `status === "missing"`. */
  error?: string;
}

export interface ContextBlock {
  /** The assembled `<project-conventions>` block, or "" if nothing was loaded. */
  text: string;
  /** Non-fatal issues (missing files, truncation). Callers forward these to
   * the event sink so replay/debug has a paper trail. */
  warnings: string[];
  /** Per-file records for durable capture on `llm.start.context_files`. In
   * the same order as the input `paths`. */
  files: ContextFileRecord[];
}

/** Read each path from the environment and wrap it in a single
 * `<project-conventions>` block. Missing files produce a warning and are
 * skipped. Truncates the final text to `CONTEXT_FILES_MAX_BYTES`. */
export async function loadContextFiles(
  env: Pick<ExecutionEnvironment, "readFile">,
  paths: readonly string[],
  max_bytes: number = CONTEXT_FILES_MAX_BYTES,
): Promise<ContextBlock> {
  if (paths.length === 0) return { text: "", warnings: [], files: [] };

  const warnings: string[] = [];
  const parts: string[] = [];
  const files: ContextFileRecord[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    try {
      const contents = await env.readFile(path);
      parts.push(`<project-conventions source="${escapeAttr(path)}">\n${contents}\n</project-conventions>`);
      files.push({
        path,
        sha256: sha256Hex(contents),
        bytes: Buffer.byteLength(contents, "utf8"),
        truncated: false,
        status: "ok",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`context_files: could not read "${path}" — ${msg}`);
      files.push({ path, sha256: "", bytes: 0, truncated: false, status: "missing", error: msg });
    }
  }
  if (parts.length === 0) return { text: "", warnings, files };

  let text = parts.join("\n\n");
  if (text.length > max_bytes) {
    const truncatedLen = text.length - max_bytes;
    text = `${text.slice(0, max_bytes)}\n\n[context_files: truncated ${truncatedLen} bytes to stay under ${max_bytes}]`;
    warnings.push(`context_files: truncated ${truncatedLen} bytes (cap ${max_bytes})`);
    // Flag every successfully-loaded file as truncated. Individual provenance
    // (which file was clipped) is recoverable from the ordered sha256s and
    // byte counts; the flag is a cheap signal for UIs.
    for (const f of files) if (f.status === "ok") f.truncated = true;
  }
  return { text, warnings, files };
}

/** Merge a base system prompt with an optional extension block. Extension
 * goes first so repo-level conventions frame whatever the base prompt says. */
export function mergeSystemPrompt(base: string, extension: string): string {
  if (!extension) return base;
  if (!base) return extension;
  return `${extension}\n\n${base}`;
}

export interface BuildSystemPromptInput {
  /** Global system prompt configured on the backend (e.g. a project-wide
   * "you are the coding agent" preamble). Becomes the fallback when no
   * node-level override is set. */
  global: string;
  /** Optional per-node override from `node.attrs.system_prompt`. When set,
   * this replaces `global` — a reviewer subagent or a planner node can
   * therefore swap the whole persona without hacking `context_files`. */
  perNode: string | undefined;
  /** Context-files block returned by `loadContextFiles`. Prepended so
   * repo conventions frame whatever the base prompt says. */
  contextBlock: string;
}

/** Assemble the final system prompt for a single agent call. Isolated from
 * the backend so tests can round-trip the combinator without standing up
 * pi-agent-core, and so the fidelity/cache layer in `./fidelity.ts` can
 * compose it without duplicating the merge rules. */
export function buildSystemPrompt({ global, perNode, contextBlock }: BuildSystemPromptInput): string {
  const base = perNode !== undefined && perNode.length > 0 ? perNode : global;
  return mergeSystemPrompt(base, contextBlock);
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}
