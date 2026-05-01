// Non-recursive directory listing via env.listDir.
//
// Mirrors pi-coding-agent's ls tool surface (schema + result-detail
// flags). Sort is alphabetical case-insensitive, directories carry a
// trailing `/`. Includes dotfiles. 500-entry cap.

import { Type } from "@sinclair/typebox";
import type { DirEntry, Tool } from "./types.ts";

export interface LsArgs {
  path?: string;
  limit?: number;
}

export interface LsResultData {
  path: string;
  entries: number;
  entry_limit_reached?: number;
}

const DEFAULT_LIMIT = 500;
const OUTPUT_BYTE_CAP = 20_000;

export const lsTool: Tool<LsArgs, LsResultData> = {
  name: "ls",
  description: `List directory contents (non-recursive) via the workspace env. Returns entries sorted alphabetically (case-insensitive); directories carry a '/' suffix. Includes dotfiles. Output is capped at ${DEFAULT_LIMIT} entries.`,
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
  }),
  idempotent: true,
  truncation: { max_chars: OUTPUT_BYTE_CAP, mode: "head_tail" },
  async execute(args, env) {
    try {
      const dirPath = args.path && args.path.length > 0 ? args.path : ".";
      if (!(await env.exists(dirPath))) {
        return { text: `Path not found: ${dirPath}`, is_error: true };
      }

      const effectiveLimit = Math.max(1, args.limit ?? DEFAULT_LIMIT);
      let entries: DirEntry[];
      try {
        entries = await env.listDir(dirPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: `Not a directory: ${dirPath} (${message})`, is_error: true };
      }

      entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

      const formatted: string[] = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        if (formatted.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        formatted.push(entry.kind === "directory" ? `${entry.name}/` : entry.name);
      }

      if (formatted.length === 0) {
        return {
          text: "(empty directory)",
          data: { path: dirPath, entries: 0 },
        };
      }

      let outputText = formatted.join("\n");
      if (outputText.length > OUTPUT_BYTE_CAP) {
        outputText = `${outputText.slice(0, OUTPUT_BYTE_CAP)}\n…[output truncated at ${OUTPUT_BYTE_CAP} bytes]`;
      }
      if (entryLimitReached) {
        outputText += `\n\n[${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more]`;
      }

      const data: LsResultData = { path: dirPath, entries: formatted.length };
      if (entryLimitReached) data.entry_limit_reached = effectiveLimit;

      return { text: outputText, data };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};
