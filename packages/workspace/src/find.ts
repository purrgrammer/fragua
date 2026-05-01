// Native glob enumeration — no shell spawn, no fd dependency.
//
// Mirrors pi-coding-agent's find tool surface (schema + result-detail
// flags) but delegates the walk to env.glob. The default ignore set
// is shared with grep through ./ignore.ts so the two tools can't
// drift.

import { Type } from "@sinclair/typebox";
import { DEFAULT_IGNORE_GLOBS, shouldIgnore } from "./ignore.ts";
import type { Tool } from "./types.ts";

export interface FindArgs {
  pattern: string;
  path?: string;
  limit?: number;
}

export interface FindResultData {
  path: string;
  matches: number;
  result_limit_reached?: number;
}

const DEFAULT_LIMIT = 1000;
const OUTPUT_BYTE_CAP = 50_000;

export const findTool: Tool<FindArgs, FindResultData> = {
  name: "find",
  description: `Search for files by glob pattern. Walks via the workspace env (no shell spawn). Returns paths relative to the search directory. Skips default-ignored directories (${DEFAULT_IGNORE_GLOBS.join(", ")}). Output is capped at ${DEFAULT_LIMIT} results.`,
  parameters: Type.Object({
    pattern: Type.String({
      description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    }),
    path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
  }),
  idempotent: true,
  truncation: { max_chars: OUTPUT_BYTE_CAP, mode: "head_tail" },
  async execute(args, env) {
    try {
      const searchRoot = args.path && args.path.length > 0 ? args.path : ".";
      if (!(await env.exists(searchRoot))) {
        return { text: `Path not found: ${searchRoot}`, is_error: true };
      }

      const effectiveLimit = Math.max(1, args.limit ?? DEFAULT_LIMIT);
      // dot: true mirrors fd's default `--hidden` posture so dotfiles
      // and hidden dirs are visible to the pattern. The default ignore
      // set still drops .git/, .swarm/, etc. via shouldIgnore().
      const raw = await env.glob(args.pattern, { cwd: searchRoot, dot: true });
      // env.glob returns paths relative to env.cwd(); strip the
      // searchRoot prefix so output is relative to the search
      // directory (matches pi-coding-agent and the tool's docstring).
      const trimmedRoot =
        searchRoot === "." || !searchRoot ? "" : searchRoot.endsWith("/") ? searchRoot.slice(0, -1) : searchRoot;
      const filtered: string[] = [];
      for (const envRel of raw) {
        let rel = envRel;
        if (trimmedRoot) {
          if (envRel === trimmedRoot) continue;
          if (envRel.startsWith(`${trimmedRoot}/`)) rel = envRel.slice(trimmedRoot.length + 1);
        }
        if (shouldIgnore(rel)) continue;
        filtered.push(rel);
        if (filtered.length > effectiveLimit) break;
      }

      const resultLimitReached = filtered.length > effectiveLimit;
      const trimmed = resultLimitReached ? filtered.slice(0, effectiveLimit) : filtered;

      if (trimmed.length === 0) {
        return {
          text: "No files found matching pattern",
          data: { path: searchRoot, matches: 0 },
        };
      }

      let outputText = trimmed.join("\n");
      if (outputText.length > OUTPUT_BYTE_CAP) {
        outputText = `${outputText.slice(0, OUTPUT_BYTE_CAP)}\n…[output truncated at ${OUTPUT_BYTE_CAP} bytes]`;
      }
      if (resultLimitReached) {
        outputText += `\n\n[${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern]`;
      }

      const data: FindResultData = { path: searchRoot, matches: trimmed.length };
      if (resultLimitReached) data.result_limit_reached = effectiveLimit;

      return { text: outputText, data };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};
