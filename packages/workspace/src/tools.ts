// Agent tools — the four LLM-callable primitives: read / write / edit / bash.
//
// Per the "less is more" directive, we ship a deliberately minimal tool
// surface. Anything an agent used to do with list_dir / glob / grep /
// git_read / apply_patch / web_fetch now goes through `bash` (ls, find,
// rg, git, curl). Skills are loaded by reading SKILL.md paths directly
// via `read` — no dedicated `load_skill` tool.
//
// Truncation defaults per Attractor Coding Agent Loop spec.
//
// Tool names have NO prefix. Older versions used `local:...`; the prefix
// was noise once the graph-level `tool` node (separate from agent tools)
// made the namespace distinction structural.

import { Type } from "@sinclair/typebox";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateTail } from "./truncate-v2.ts";
import type { Tool } from "./types.ts";

export const readFileTool: Tool<{ path: string; offset?: number; limit?: number }, { path: string; size: number }> = {
  name: "read",
  description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
  parameters: Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  }),
  idempotent: true,
  truncation: { max_chars: 200_000, mode: "head_tail" },
  async execute(args, env) {
    try {
      const contents = await env.readFile(args.path);
      const allLines = contents.split("\n");
      const totalFileLines = allLines.length;

      const startLine = args.offset ? Math.max(0, args.offset - 1) : 0;
      const startLineDisplay = startLine + 1;

      if (startLine >= allLines.length) {
        return {
          text: `Offset ${args.offset} is beyond end of file (${allLines.length} lines total)`,
          is_error: true,
        };
      }

      let selectedContent: string;
      let userLimitedLines: number | undefined;

      if (args.limit !== undefined) {
        const endLine = Math.min(startLine + args.limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      const truncation = truncateHead(selectedContent);
      let outputText: string;

      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine]!, "utf-8"));
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${args.path} | head -c ${DEFAULT_MAX_BYTES}]`;
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
        } else {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        }
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }

      return { text: outputText, data: { path: args.path, size: contents.length } };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};

export const writeFileTool: Tool<{ path: string; content: string }, { path: string; bytes: number }> = {
  name: "write",
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  parameters: Type.Object({
    path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
    content: Type.String({ description: "Content to write to the file" }),
  }),
  idempotent: true,
  truncation: { max_chars: 1_000, mode: "tail" },
  async execute(args, env) {
    try {
      await env.writeFile(args.path, args.content);
      return {
        text: `Successfully wrote ${args.content.length} bytes to ${args.path}`,
        data: { path: args.path, bytes: args.content.length },
      };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};

const replaceEditSchema = Type.Object({
  oldText: Type.String({
    description:
      "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
  }),
  newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

export const editFileTool: Tool<
  { path: string; edits: Array<{ oldText: string; newText: string }> },
  { path: string; diff: string | null; firstChangedLine: number | null }
> = {
  name: "edit",
  description:
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
  parameters: Type.Object({
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    edits: Type.Array(replaceEditSchema, {
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    }),
  }),
  idempotent: false,
  truncation: { max_chars: 10_000, mode: "tail" },
  async execute(args, env) {
    try {
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        return { text: "edits must contain at least one replacement.", is_error: true };
      }

      const rawContent = await env.readFile(args.path);
      const { bom, text: content } = stripBom(rawContent);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLF(content);

      const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, args.edits, args.path);

      const finalContent = bom + restoreLineEndings(newContent, originalEnding);
      await env.writeFile(args.path, finalContent);

      const diffResult = generateDiffString(baseContent, newContent);

      return {
        text: `Successfully replaced ${args.edits.length} block(s) in ${args.path}.`,
        data: { path: args.path, diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine ?? null },
      };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};

export const bashTool: Tool<{ command: string; timeout?: number }, { exit_code: number; duration_ms: number }> = {
  name: "bash",
  description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
  parameters: Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  }),
  idempotent: false,
  truncation: { max_chars: 200_000, mode: "tail" },
  async execute(args, env) {
    const timeoutMs = args.timeout !== undefined ? args.timeout * 1000 : undefined;
    const result = await env.exec(args.command, timeoutMs !== undefined ? { timeoutMs } : {});
    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const fullOutput = combined || "(no output)";

    const truncation = truncateTail(fullOutput);
    let outputText = truncation.content;

    if (truncation.truncated) {
      const startLine = truncation.totalLines - truncation.outputLines + 1;
      const endLine = truncation.totalLines;
      if (truncation.truncatedBy === "lines") {
        outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.]`;
      } else {
        outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).]`;
      }
    }

    if (result.exitCode !== 0) {
      outputText += `\n\nCommand exited with code ${result.exitCode}`;
    }

    return {
      text: outputText,
      data: { exit_code: result.exitCode, duration_ms: result.durationMs },
      is_error: result.exitCode !== 0,
    };
  },
};

export const CORE_TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, bashTool];
