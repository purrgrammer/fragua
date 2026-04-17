// Built-in tools exposed to LLM agents.
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
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
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

export const listDirTool: Tool<
  { path: string; recursive?: boolean; max_depth?: number },
  { path: string; count: number }
> = {
  name: "local:list_dir",
  description:
    "List entries in a directory. Each row is `<name> (file|dir|symlink)`. Optional shallow recursion via max_depth.",
  parameters: Type.Object({
    path: Type.String({ description: "Absolute or cwd-relative directory path" }),
    recursive: Type.Optional(Type.Boolean({ description: "Recurse into subdirectories (default false)" })),
    max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "Max recursion depth (default 2)" })),
  }),
  idempotent: true,
  truncation: { max_chars: 20_000, mode: "tail", max_lines: 500 },
  async execute(args, env) {
    try {
      const entries = await collect(env, args.path, args.recursive === true, args.max_depth ?? 2, 0);
      const text = entries.map((e) => `${e.path} (${e.kind})`).join("\n") || "[empty]";
      return { text, data: { path: args.path, count: entries.length } };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};

async function collect(
  env: Parameters<typeof listDirTool.execute>[1],
  path: string,
  recursive: boolean,
  maxDepth: number,
  depth: number,
): Promise<Array<{ path: string; kind: "file" | "directory" | "symlink" | "other" }>> {
  const out: Array<{ path: string; kind: "file" | "directory" | "symlink" | "other" }> = [];
  const entries = await env.listDir(path);
  for (const e of entries) {
    const rel = path.endsWith("/") ? `${path}${e.name}` : `${path}/${e.name}`;
    out.push({ path: rel, kind: e.kind });
    if (recursive && e.kind === "directory" && depth + 1 < maxDepth) {
      out.push(...(await collect(env, rel, true, maxDepth, depth + 1)));
    }
  }
  return out;
}

export const globTool: Tool<{ pattern: string; cwd?: string }, { pattern: string; count: number }> = {
  name: "local:glob",
  description:
    "Find files matching a glob pattern (e.g. `**/*.ts`, `packages/*/src/**`). Returns cwd-relative paths, sorted.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Glob pattern — supports ** and * wildcards" }),
    cwd: Type.Optional(Type.String({ description: "Override search root (default env.cwd())" })),
  }),
  idempotent: true,
  truncation: { max_chars: 20_000, mode: "tail", max_lines: 500 },
  async execute(args, env) {
    try {
      const matches = await env.glob(args.pattern, args.cwd !== undefined ? { cwd: args.cwd } : {});
      const text = matches.length > 0 ? matches.join("\n") : "[no matches]";
      return { text, data: { pattern: args.pattern, count: matches.length } };
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};

export const grepTool: Tool<
  { pattern: string; path?: string; case_insensitive?: boolean; max_results?: number },
  { pattern: string; count: number; files_searched: number }
> = {
  name: "local:grep",
  description:
    "Regex search over files in a directory (recursive). Output: `path:line: text`. Best for finding where a symbol/string appears.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Regular expression" }),
    path: Type.Optional(Type.String({ description: "Root directory (default env.cwd())" })),
    case_insensitive: Type.Optional(Type.Boolean()),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "Default 200" })),
  }),
  idempotent: true,
  truncation: { max_chars: 20_000, mode: "tail", max_lines: 200 },
  async execute(args, env) {
    try {
      const re = new RegExp(args.pattern, args.case_insensitive ? "i" : "");
      const root = args.path ?? ".";
      const maxResults = args.max_results ?? 200;
      const files = await env.glob("**/*", root === "." ? {} : { cwd: root });
      const rows: string[] = [];
      let filesSearched = 0;
      for (const rel of files) {
        if (rows.length >= maxResults) break;
        if (/(^|\/)(node_modules|\.git|\.swarm|dist|build|\.turbo|\.next|coverage)(\/|$)/.test(rel)) continue;
        let contents: string;
        try {
          contents = await env.readFile(rel);
        } catch {
          continue; // skip unreadable (binary, permission, etc.)
        }
        filesSearched++;
        const lines = contents.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            rows.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 500)}`);
            if (rows.length >= maxResults) break;
          }
        }
      }
      const text = rows.length > 0 ? rows.join("\n") : "[no matches]";
      return {
        text,
        data: { pattern: args.pattern, count: rows.length, files_searched: filesSearched },
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
  name: "local:edit_file",
  description:
    "Replace a unique occurrence of `old_string` with `new_string` in a file. Fails if old_string is missing or matches multiple places — include enough surrounding context to make it unique. Use local:write_file for whole-file writes or new files.",
  parameters: Type.Object({
    path: Type.String({ description: "Absolute or cwd-relative path to an existing file" }),
    old_string: Type.String({ description: "Verbatim text to replace (must be unique in the file)" }),
    new_string: Type.String({ description: "Replacement text" }),
  }),
  idempotent: false, // the old_string only exists once; re-running after success will not find a match
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

export const CORE_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  bashTool,
  listDirTool,
  globTool,
  grepTool,
  editFileTool,
];
