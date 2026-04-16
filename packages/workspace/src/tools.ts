// Phase 2 built-in tools: local:read_file, local:write_file, local:bash.
// Per-tool truncation defaults per Attractor Coding Agent Loop spec.

import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.ts";

export const readFileTool: Tool<{ path: string }, { path: string; size: number }> = {
  name: "local:read_file",
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
      return {
        text: err instanceof Error ? err.message : String(err),
        is_error: true,
      };
    }
  },
};

export const writeFileTool: Tool<{ path: string; contents: string }, { path: string; bytes: number }> = {
  name: "local:write_file",
  description: "Write UTF-8 text to a file. Creates parent directories as needed. Overwrites existing files.",
  parameters: Type.Object({
    path: Type.String({ description: "Absolute or cwd-relative path" }),
    contents: Type.String({ description: "Full file contents" }),
  }),
  // Writing the same content is idempotent from the filesystem's POV; writing
  // NEW content isn't. We mark it idempotent because the bytes-on-disk outcome
  // is a pure function of args — a resume will recreate the same file state.
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

export const bashTool: Tool<{ command: string; timeout_ms?: number }, { exit_code: number; duration_ms: number }> = {
  name: "local:bash",
  description: "Execute a shell command via /bin/sh. Returns stdout, stderr, and exit code.",
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

export const CORE_TOOLS: Tool[] = [readFileTool, writeFileTool, bashTool];
