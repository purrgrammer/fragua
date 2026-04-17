// Assemble per-run system prompt extensions (context_files node attribute).
// Pulled into a separate module so it can be unit-tested without pi-agent-core.

import type { ExecutionEnvironment } from "@swarm/workspace";

/** Hard cap on the total bytes of project-conventions content prepended to the
 * system prompt. A single oversized AGENTS.md should not blow the context
 * window silently. Individual files are truncated; the final block never
 * exceeds this size. */
export const CONTEXT_FILES_MAX_BYTES = 32 * 1024;

export interface ContextBlock {
  /** The assembled `<project-conventions>` block, or "" if nothing was loaded. */
  text: string;
  /** Non-fatal issues (missing files, truncation). Callers forward these to
   * the event sink so replay/debug has a paper trail. */
  warnings: string[];
}

/** Read each path from the environment and wrap it in a single
 * `<project-conventions>` block. Missing files produce a warning and are
 * skipped. Truncates the final text to `CONTEXT_FILES_MAX_BYTES`. */
export async function loadContextFiles(
  env: Pick<ExecutionEnvironment, "readFile">,
  paths: readonly string[],
  max_bytes: number = CONTEXT_FILES_MAX_BYTES,
): Promise<ContextBlock> {
  if (paths.length === 0) return { text: "", warnings: [] };

  const warnings: string[] = [];
  const parts: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    try {
      const contents = await env.readFile(path);
      parts.push(`<project-conventions source="${escapeAttr(path)}">\n${contents}\n</project-conventions>`);
    } catch (err) {
      warnings.push(`context_files: could not read "${path}" — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (parts.length === 0) return { text: "", warnings };

  let text = parts.join("\n\n");
  if (text.length > max_bytes) {
    const truncatedLen = text.length - max_bytes;
    text = `${text.slice(0, max_bytes)}\n\n[context_files: truncated ${truncatedLen} bytes to stay under ${max_bytes}]`;
    warnings.push(`context_files: truncated ${truncatedLen} bytes (cap ${max_bytes})`);
  }
  return { text, warnings };
}

/** Merge a base system prompt with an optional extension block. Extension
 * goes first so repo-level conventions frame whatever the base prompt says. */
export function mergeSystemPrompt(base: string, extension: string): string {
  if (!extension) return base;
  if (!base) return extension;
  return `${extension}\n\n${base}`;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}
