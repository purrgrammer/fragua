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
import type { Tool } from "./types.ts";

export const readFileTool: Tool<{ path: string }, { path: string; size: number }> = {
  name: "read",
  description: "Read the contents of a UTF-8 text file at the given path.",
  parameters: Type.Object({
    path: Type.String({ description: "Absolute or cwd-relative path" }),
  }),
  idempotent: true,
  truncation: { max_chars: 50_000, mode: "head_tail" },
  async execute(args, env) {
    try {
      const contents = await env.readFile(args.path);
      return { text: contents, data: { path: args.path, size: contents.length } };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};

export const writeFileTool: Tool<{ path: string; contents: string }, { path: string; bytes: number }> = {
  name: "write",
  description: "Write UTF-8 text to a file. Creates parent directories as needed. Overwrites existing files.",
  parameters: Type.Object({
    path: Type.String({ description: "Absolute or cwd-relative path" }),
    contents: Type.String({ description: "Full file contents" }),
  }),
  idempotent: true,
  truncation: { max_chars: 1_000, mode: "tail" },
  async execute(args, env) {
    try {
      await env.writeFile(args.path, args.contents);
      return {
        text: `wrote ${args.contents.length} bytes to ${args.path}`,
        data: { path: args.path, bytes: args.contents.length },
      };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};

export const editFileTool: Tool<
  { path: string; old_string: string; new_string: string },
  { path: string; bytes_before: number; bytes_after: number }
> = {
  name: "edit",
  description:
    "Replace a unique occurrence of `old_string` with `new_string` in a file. Fails if old_string is missing or matches multiple places — include enough surrounding context to make it unique. Use `write` for whole-file writes or new files.",
  parameters: Type.Object({
    path: Type.String({ description: "Absolute or cwd-relative path to an existing file" }),
    old_string: Type.String({ description: "Verbatim text to replace (must be unique in the file)" }),
    new_string: Type.String({ description: "Replacement text" }),
  }),
  // the old_string only exists once; re-running after success will not find a match
  idempotent: false,
  truncation: { max_chars: 10_000, mode: "tail" },
  async execute(args, env) {
    try {
      if (args.old_string === args.new_string) {
        return { text: "old_string and new_string are identical — nothing to do", is_error: true };
      }
      const before = await env.readFile(args.path);
      const idx = before.indexOf(args.old_string);
      if (idx === -1) {
        return {
          text: `old_string not found in ${args.path}. Double-check whitespace + surrounding context.`,
          is_error: true,
        };
      }
      if (before.indexOf(args.old_string, idx + 1) !== -1) {
        return {
          text: `old_string matches more than once in ${args.path}. Add surrounding lines to make it unique.`,
          is_error: true,
        };
      }
      const after = before.slice(0, idx) + args.new_string + before.slice(idx + args.old_string.length);
      await env.writeFile(args.path, after);
      return {
        text: `edited ${args.path} (${before.length} → ${after.length} bytes)`,
        data: { path: args.path, bytes_before: before.length, bytes_after: after.length },
      };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};

export const bashTool: Tool<{ command: string; timeout_ms?: number }, { exit_code: number; duration_ms: number }> = {
  name: "bash",
  description:
    "Execute a shell command via /bin/sh. Returns stdout, stderr, and exit code. Use this for directory listing (ls/find), regex search (grep/rg), git plumbing (git log/diff/status), HTTP (curl), and any other read or mutation beyond the file primitives.",
  parameters: Type.Object({
    command: Type.String({ description: "Shell command to execute" }),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout in ms (default 30000)" })),
  }),
  idempotent: false,
  truncation: { max_chars: 30_000, mode: "head_tail", max_lines: 256 },
  async execute(args, env) {
    const result = await env.exec(args.command, args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {});
    const combined = [
      result.stdout && `--- stdout ---\n${result.stdout}`,
      result.stderr && `--- stderr ---\n${result.stderr}`,
      `--- exit: ${result.exitCode} (${result.durationMs}ms) ---`,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      text: combined,
      data: { exit_code: result.exitCode, duration_ms: result.durationMs },
      is_error: result.exitCode !== 0,
    };
  },
};

export const CORE_TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, bashTool];
