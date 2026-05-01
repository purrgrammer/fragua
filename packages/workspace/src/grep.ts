// Native regex search across files — no shell spawn, no rg dependency.
//
// Mirrors pi-coding-agent's grep tool surface (schema, result-detail
// flags, output format) but the implementation walks via
// `env.glob("**/*")` + per-file regex match instead of shelling out.
// That matters because env-scoping (packages/core/src/handler/context.ts)
// gates env.exec on `bash` being in allowed_tools — a node with
// `allowed_tools = "read, grep"` would silently fail if grep tried to
// run a binary.
//
// Defaults match pi: 100-match cap, line truncation at 500 chars,
// binary sniff on first 1KB null byte, file-size cap at 1MB.

import { Type } from "@sinclair/typebox";
import { DEFAULT_IGNORE_GLOBS, shouldIgnore } from "./ignore.ts";
import type { Tool } from "./types.ts";

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export interface GrepResultData {
  /** Search root (echoes args.path ?? "."). */
  path: string;
  /** Number of match lines returned (post-limit). */
  matches: number;
  /** Set when the byte cap on the joined output trimmed content. */
  truncated?: boolean;
  /** Set to the effective limit when matchCount hit it. */
  match_limit_reached?: number;
  /** Set when at least one line exceeded GREP_MAX_LINE_LENGTH. */
  lines_truncated?: boolean;
}

const DEFAULT_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;
const FILE_SIZE_CAP_BYTES = 1_000_000;
const BINARY_SNIFF_BYTES = 1024;
const OUTPUT_BYTE_CAP = 50_000;

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_META, "\\$&");
}

function truncateLine(s: string): { text: string; wasTruncated: boolean } {
  if (s.length <= GREP_MAX_LINE_LENGTH) return { text: s, wasTruncated: false };
  return { text: `${s.slice(0, GREP_MAX_LINE_LENGTH)}…`, wasTruncated: true };
}

export const grepTool: Tool<GrepArgs, GrepResultData> = {
  name: "grep",
  description: `Search file contents for a pattern. Returns matching lines as path:line: text. Walks via the workspace env (no shell spawn). Skips default-ignored directories (${DEFAULT_IGNORE_GLOBS.join(", ")}), binary files (null byte in first 1KB), and files larger than 1MB. Output is capped at ${DEFAULT_LIMIT} matches; lines longer than ${GREP_MAX_LINE_LENGTH} chars are truncated.`,
  parameters: Type.Object({
    pattern: Type.String({ description: "Search pattern (regex by default; literal string when literal=true)" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
    glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
    literal: Type.Optional(
      Type.Boolean({ description: "Treat pattern as a literal string instead of regex (default: false)" }),
    ),
    context: Type.Optional(
      Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
    ),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
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
      const contextLines = args.context && args.context > 0 ? args.context : 0;
      const flags = args.ignoreCase ? "gi" : "g";
      let regex: RegExp;
      try {
        const source = args.literal ? escapeRegex(args.pattern) : args.pattern;
        regex = new RegExp(source, flags);
      } catch (err) {
        return { text: `Invalid pattern: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }

      // Determine whether `searchRoot` is a directory; if not, treat it
      // as a single-file search (still goes through env.readFile).
      let isDirectory = true;
      try {
        await env.listDir(searchRoot);
      } catch {
        isDirectory = false;
      }

      // Both env.glob() returns are env-cwd-relative — `cwd: searchRoot`
      // scopes the *scan*, but local-env.ts:71 relativises matches
      // against `this._cwd`. We need:
      //   readPath  — env-cwd-relative, so env.readFile resolves it.
      //   displayPath — search-root-relative, so output paths look like
      //                 pi's (`a.txt:1: …` not `sub/a.txt:1: …`).
      const stripPrefix = (p: string): string => {
        if (!searchRoot || searchRoot === ".") return p;
        const trimmed = searchRoot.endsWith("/") ? searchRoot.slice(0, -1) : searchRoot;
        if (p === trimmed) return "";
        if (p.startsWith(`${trimmed}/`)) return p.slice(trimmed.length + 1);
        return p;
      };

      let candidates: Array<{ readPath: string; displayPath: string }>;
      if (isDirectory) {
        const allEntries = await env.glob("**/*", { cwd: searchRoot });
        const baseSet = args.glob ? new Set(await env.glob(args.glob, { cwd: searchRoot })) : null;
        candidates = [];
        for (const readPath of allEntries) {
          if (baseSet && !baseSet.has(readPath)) continue;
          candidates.push({ readPath, displayPath: stripPrefix(readPath) });
        }
      } else {
        candidates = [{ readPath: searchRoot, displayPath: searchRoot }];
      }

      const outputLines: string[] = [];
      let matchCount = 0;
      let matchLimitReached = false;
      let linesTruncated = false;

      outer: for (const { readPath, displayPath } of candidates) {
        if (shouldIgnore(displayPath || readPath)) continue;

        let content: string;
        try {
          content = await env.readFile(readPath);
        } catch {
          continue;
        }
        if (content.length === 0) continue;
        if (content.length > FILE_SIZE_CAP_BYTES) continue;
        if (content.slice(0, BINARY_SNIFF_BYTES).includes("\0")) continue;

        const lines = content.split("\n");
        const rel = displayPath || readPath;
        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i] ?? "";
          regex.lastIndex = 0;
          if (!regex.test(lineText)) continue;
          matchCount++;
          if (contextLines === 0) {
            const { text, wasTruncated } = truncateLine(lineText);
            if (wasTruncated) linesTruncated = true;
            outputLines.push(`${rel}:${i + 1}: ${text}`);
          } else {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length - 1, i + contextLines);
            for (let j = start; j <= end; j++) {
              const ctxText = lines[j] ?? "";
              const { text, wasTruncated } = truncateLine(ctxText);
              if (wasTruncated) linesTruncated = true;
              if (j === i) outputLines.push(`${rel}:${j + 1}: ${text}`);
              else outputLines.push(`${rel}-${j + 1}- ${text}`);
            }
          }
          if (matchCount >= effectiveLimit) {
            matchLimitReached = true;
            break outer;
          }
        }
      }

      if (matchCount === 0) {
        return {
          text: "No matches found",
          data: { path: searchRoot, matches: 0 },
        };
      }

      let outputText = outputLines.join("\n");
      let truncated = false;
      if (outputText.length > OUTPUT_BYTE_CAP) {
        outputText = `${outputText.slice(0, OUTPUT_BYTE_CAP)}\n…[output truncated at ${OUTPUT_BYTE_CAP} bytes]`;
        truncated = true;
      }

      const notices: string[] = [];
      if (matchLimitReached) notices.push(`${effectiveLimit} matches limit reached`);
      if (truncated) notices.push(`${OUTPUT_BYTE_CAP} bytes output cap reached`);
      if (linesTruncated) notices.push(`some lines truncated to ${GREP_MAX_LINE_LENGTH} chars`);
      if (notices.length > 0) outputText += `\n\n[${notices.join(". ")}]`;

      const data: GrepResultData = { path: searchRoot, matches: matchCount };
      if (matchLimitReached) data.match_limit_reached = effectiveLimit;
      if (truncated) data.truncated = true;
      if (linesTruncated) data.lines_truncated = true;

      return { text: outputText, data };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};
