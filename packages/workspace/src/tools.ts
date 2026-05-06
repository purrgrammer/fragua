// Agent tools — read / write / edit / bash. The four power tools.
//
// These are the LLM-callable primitives that drive every codergen
// node. They mirror pi-coding-agent's tools 1:1 in behavior so swarm
// agents debug the same way pi-coding-agent users do, and a fix
// upstream can land here verbatim.
//
// What each tool does and the contract it observes:
//
//   read   — text or image. For text: offset/limit + truncation with
//            actionable continuation hints. For image: returns an
//            ImageContent block in `output.content`. Resolves macOS
//            screenshot paths with NFD/AM-PM/curly-quote fallbacks.
//   write  — atomic temp+rename via env.writeFile, serialized per-
//            path through `withFileMutationQueue` so concurrent
//            edits to the same file can't interleave.
//   edit   — multi-edit exact-text replacement with fuzzy fallback.
//            `prepareArguments` recovers from JSON-stringified `edits`
//            (Opus 4.6, GLM-5.1) and legacy `{oldText, newText}`
//            flat shape. Per-edit error messages reference edits[i]
//            so the model can self-correct.
//   bash   — detached spawn so we can kill the entire process tree.
//            Rolling buffer + temp-file spill keeps the full
//            transcript recoverable when output exceeds the truncation
//            window. Optional onUpdate streams partial output during
//            execution. Blocklist refuses dangerous commands before
//            spawn; that check is swarm-specific (pi has no blocklist).
//
// Tool result shape:
//   - `text` is the human/LLM-readable summary, always set.
//   - `content[]` carries multi-modal blocks (images for read, plain
//     text otherwise). When set, the agent loop forwards it verbatim;
//     truncation only applies to the `text` fallback.
//   - `data` carries structured metadata for downstream nodes
//     (`$nodeId.output.path`) and rich UI rendering (diff for edit,
//     full-output path for bash, image dimensions for read).

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { agentTool } from "./agent.ts";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { detectImageMimeType, resolveReadPath, withFileMutationQueue } from "./path-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateTail } from "./truncate-v2.ts";
import type { AnyTool, ExecutionEnvironment, SwarmToolContext, Tool, ToolRegistry } from "./types.ts";

// ─── read ──────────────────────────────────────────────────────────

export interface ReadResultData {
  path: string;
  size: number;
  /** Set on image reads. The model sees the image in `content[]`; this
   * field gives downstream nodes the dimensions for routing/logging. */
  image?: { mimeType: string; bytes: number };
}

export const readFileTool: Tool<{ path: string; offset?: number; limit?: number }, ReadResultData> = {
  name: "read",
  description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are returned as inline attachments the model can see. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
  parameters: Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  }),
  idempotent: true,
  idempotentOnReplay: true,
  truncation: { max_chars: 200_000, mode: "head_tail" },
  async execute(args, env) {
    try {
      const cwd = env.cwd();
      const resolved = resolveReadPath(args.path, cwd);

      // Read once as a buffer so we can sniff for image magic bytes
      // without doing a second IO. exists() before read keeps the
      // error message stable across LocalEnvironment / WorktreeEnv.
      if (!(await env.exists(resolved))) {
        return { text: `File not found: ${args.path}`, is_error: true };
      }

      // env.readFile returns a string today; for images we go through
      // the underlying fs to get bytes. The detection function returns
      // null for non-image content so we fall through to the text path.
      const buffer = await readFileBytes(resolved);
      const mimeType = detectImageMimeType(buffer, resolved);
      if (mimeType) {
        const base64 = buffer.toString("base64");
        const sizeNote = `${formatSize(buffer.length)}, ${mimeType}`;
        const textBlock: TextContent = { type: "text", text: `Read image file [${mimeType}, ${sizeNote}]` };
        const imageBlock: ImageContent = { type: "image", data: base64, mimeType };
        return {
          text: `Read image file [${mimeType}, ${sizeNote}]`,
          content: [textBlock, imageBlock],
          data: { path: args.path, size: buffer.length, image: { mimeType, bytes: buffer.length } },
        };
      }

      const contents = buffer.toString("utf-8");
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

// ─── write ─────────────────────────────────────────────────────────

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
      // Serialize per-path so two concurrent writes to the same file
      // don't race past the env's atomic rename and lose work.
      return await withFileMutationQueue(args.path, async () => {
        await env.writeFile(args.path, args.content);
        return {
          text: `Successfully wrote ${args.content.length} bytes to ${args.path}`,
          data: { path: args.path, bytes: args.content.length },
        };
      });
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};

// ─── edit ──────────────────────────────────────────────────────────

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  },
  { additionalProperties: false },
);

interface EditArgs {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

/** Coerce raw tool-call arguments into the canonical `{path, edits[]}`
 * shape. Recovers from two real-world provider quirks:
 *   1. `edits` arriving as a JSON-stringified array (Opus 4.6, GLM-5.1
 *      sometimes do this when the schema declares an array of objects).
 *   2. Legacy flat `{path, oldText, newText}` shape from older models
 *      or hand-crafted prompts. We promote those to a single-element
 *      `edits` array. */
function prepareEditArguments(input: unknown): EditArgs {
  if (!input || typeof input !== "object") return input as EditArgs;
  const args = input as Record<string, unknown>;

  if (typeof args["edits"] === "string") {
    try {
      const parsed = JSON.parse(args["edits"] as string);
      if (Array.isArray(parsed)) args["edits"] = parsed;
    } catch {
      // fall through; schema validation will reject
    }
  }

  if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") {
    const existing = Array.isArray(args["edits"])
      ? [...(args["edits"] as Array<{ oldText: string; newText: string }>)]
      : [];
    existing.push({ oldText: args["oldText"] as string, newText: args["newText"] as string });
    const { oldText: _o, newText: _n, ...rest } = args;
    return { ...rest, edits: existing } as unknown as EditArgs;
  }

  return args as unknown as EditArgs;
}

export interface EditResultData {
  path: string;
  /** Unified diff with line numbers; null on empty diff (shouldn't
   * happen because applyEditsToNormalizedContent throws on no-change). */
  diff: string | null;
  /** Line number of the first change in the new file — useful for
   * editor navigation in the UI. */
  firstChangedLine: number | null;
}

export const editFileTool: Tool<EditArgs, EditResultData> = {
  name: "edit",
  description:
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
  parameters: Type.Object(
    {
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      edits: Type.Array(replaceEditSchema, {
        description:
          "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      }),
    },
    { additionalProperties: false },
  ),
  idempotent: false,
  truncation: { max_chars: 10_000, mode: "tail" },
  prepareArguments: prepareEditArguments,
  async execute(args, env) {
    try {
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        return { text: "edits must contain at least one replacement.", is_error: true };
      }

      return await withFileMutationQueue(args.path, async () => {
        if (!(await env.exists(args.path))) {
          return { text: `File not found: ${args.path}`, is_error: true };
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
      });
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), is_error: true };
    }
  },
};

// ─── bash ──────────────────────────────────────────────────────────

export interface BashResultData {
  exit_code: number;
  duration_ms: number;
  /** Set when total output exceeded the truncation window. The full
   * transcript is preserved here so the agent can `cat` it for the
   * full payload. The path is on the host filesystem; remote
   * environments that can't surface a host path should leave this
   * unset. */
  full_output_path?: string;
  /** True when output was truncated by the byte/line cap. */
  truncated?: boolean;
  /** Original total bytes before truncation. */
  total_bytes?: number;
  /** Original total lines before truncation. */
  total_lines?: number;
}

function bashTempFile(): string {
  return join(tmpdir(), `swarm-bash-${randomBytes(8).toString("hex")}.log`);
}

export const bashTool: Tool<{ command: string; timeout?: number }, BashResultData> = {
  name: "bash",
  description: `Execute a bash command in the working directory. Returns stdout and stderr combined. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); when truncated, the full transcript is saved to a temp file whose path appears in the truncation notice. Optionally provide a timeout in seconds.`,
  parameters: Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  }),
  idempotent: false,
  truncation: { max_chars: 200_000, mode: "tail" },
  async execute(args, env, opts) {
    const timeoutMs = args.timeout !== undefined ? args.timeout * 1000 : undefined;
    const start = Date.now();

    // Spill the full transcript to a host-side temp file the moment
    // total bytes exceed our truncation window. The agent can then
    // recover the full payload via `cat <path>` if it needs more
    // context than the truncated view shows. Spool is created lazily
    // — small commands never touch disk.
    let spillPath: string | undefined;
    let spillStream: ReturnType<typeof createWriteStream> | undefined;
    let totalBytes = 0;
    const ensureSpill = () => {
      if (spillStream) return;
      try {
        spillPath = bashTempFile();
        spillStream = createWriteStream(spillPath);
      } catch {
        spillPath = undefined;
        spillStream = undefined;
      }
    };

    // Rolling buffer keeps recent output for the partial-update path
    // and final tail truncation. Trim when it grows past 2x the cap
    // so a long-running command doesn't balloon memory.
    const chunks: Buffer[] = [];
    let chunksBytes = 0;
    const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

    const onChunk = (chunk: string, _kind: "stdout" | "stderr") => {
      const buf = Buffer.from(chunk, "utf-8");
      totalBytes += buf.length;
      if (totalBytes > DEFAULT_MAX_BYTES) ensureSpill();
      spillStream?.write(buf);
      chunks.push(buf);
      chunksBytes += buf.length;
      while (chunksBytes > maxChunksBytes && chunks.length > 1) {
        const removed = chunks.shift()!;
        chunksBytes -= removed.length;
      }
      // Emit a partial update so the UI / consumer can render
      // progress mid-execution. Truncate from the tail because that's
      // where the interesting recent output lives.
      if (opts?.onUpdate) {
        const partial = Buffer.concat(chunks).toString("utf-8");
        const partialTrunc = truncateTail(partial);
        opts.onUpdate({
          text: partialTrunc.content,
          data: {
            exit_code: -1,
            duration_ms: Date.now() - start,
            ...(spillPath ? { full_output_path: spillPath } : {}),
            ...(partialTrunc.truncated ? { truncated: true } : {}),
          },
        });
      }
    };

    let result: { stdout: string; stderr: string; exitCode: number; durationMs: number };
    try {
      result = await env.exec(args.command, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
        onData: onChunk,
      });
    } catch (err) {
      spillStream?.end();
      const message = err instanceof Error ? err.message : String(err);
      return {
        text: message,
        data: { exit_code: 1, duration_ms: Date.now() - start },
        is_error: true,
      };
    }

    spillStream?.end();

    // Use the rolling buffer for the final payload — it contains the
    // streamed chunks in order, mirroring what the user / model saw
    // during execution. env.exec also returns stdout/stderr separately
    // for backends that don't stream; fall back to those if the buffer
    // is somehow empty.
    const streamed = chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : "";
    const combined = streamed || [result.stdout, result.stderr].filter(Boolean).join("\n");
    const fullOutput = combined || "(no output)";

    const totalLines = fullOutput.split("\n").length;
    const truncation = truncateTail(fullOutput);
    let outputText = truncation.content;

    if (truncation.truncated) {
      ensureSpill();
      const startLine = truncation.totalLines - truncation.outputLines + 1;
      const endLine = truncation.totalLines;
      const tail = spillPath ? ` Full output: ${spillPath}` : "";
      if (truncation.lastLinePartial) {
        const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
        outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}).${tail}]`;
      } else if (truncation.truncatedBy === "lines") {
        outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.${tail}]`;
      } else {
        outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${tail}]`;
      }
    }

    if (result.exitCode !== 0) {
      outputText += `\n\nCommand exited with code ${result.exitCode}`;
    }

    return {
      text: outputText,
      data: {
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
        ...(spillPath ? { full_output_path: spillPath } : {}),
        ...(truncation.truncated
          ? { truncated: true, total_bytes: totalBytes || Buffer.byteLength(fullOutput), total_lines: totalLines }
          : {}),
      },
      is_error: result.exitCode !== 0,
    };
  },
};

import { skillTool } from "./skill-tool.ts";
import { webFetchTool } from "./web-fetch.ts";

// `web_fetch` and `agent` are included but `defaultDisabled: true`
// keeps them out of any node's tool set unless `allowed_tools=` lists
// them explicitly. Workflows that want public-web reading or sub-agents
// opt in per node; everything else stays unaffected.
//
// `skill` is built-in: included here so it lands in every node's tool
// pool by default, AND force-included by the codergen backend even when
// a node's `allowed_tools` / `denied_tools` would exclude it. The
// proposal is explicit — "always available, zero .dot migration".
export const CORE_TOOLS: AnyTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  bashTool,
  grepTool,
  findTool,
  lsTool,
  webFetchTool,
  agentTool,
  skillTool,
];

/** Structurally remove the `agent` tool from a pool. The `agent` tool
 *  spawns sub-agents; allowing a sub-agent to reach for `agent` itself
 *  would invite arbitrarily deep nesting. Belt-and-braces with the
 *  spec-time strip in spawnSubagent. */
export function stripAgentTool(tools: AnyTool[]): AnyTool[] {
  return tools.filter((t) => t.name !== "agent");
}

// ─── helpers ───────────────────────────────────────────────────────

// ─── rehydrate sanitiser ───────────────────────────────────────────
//
// When a daemon crash interrupts a codergen call mid-tool-execution,
// the persisted transcript ends with an unpaired toolCall block:
// `[..., assistant{toolCall A, toolCall B}]` with no following user
// message carrying matching toolResults. Anthropic's API (and pi-ai's
// transport) rejects this shape — every tool_use block must be
// followed by a user message containing tool_result blocks for every
// id. The sanitiser pairs every trailing toolCall before the
// transcript reaches `new Agent({initialState: {messages: ...}})` in
// PiCodergenBackend.run.
//
// Per-block policy:
//   - `name === "agent"`     re-execute via the registry. The agent
//                            tool's deterministic-id resume path
//                            handles the recursion: the child
//                            rehydrates from __subagent:<id>,
//                            detects already-completed, returns its
//                            summary without burning another LLM
//                            turn.
//   - tool.idempotentOnReplay  re-execute. Pure reads (read / grep /
//                              find / ls): same input, same output.
//   - everything else        synthesise an error toolResult so the
//                            LLM sees the interruption and decides
//                            — retry, reverify, abandon. Never
//                            silently re-run a destructive tool.
//
// See `docs/proposals/sub-agent-crash-resilience.md`.

/** Per-call dependencies the sanitiser hands to re-executed tools.
 *  Mirrors the shape `PiCodergenBackend.run` already builds for the
 *  in-flight `toAgentTool` adapter. */
export interface SanitiseUnpairedCtx {
  toolRegistry: ToolRegistry;
  env: ExecutionEnvironment;
  swarmContext: SwarmToolContext;
  signal?: AbortSignal;
}

/** Replace unpaired toolCall blocks at the tail of `messages` with a
 *  paired `toolResult` user message. Returns the input array
 *  reference unchanged when no pairing is needed (no trailing
 *  assistant, no toolCalls). */
export async function sanitiseUnpairedToolCalls(
  messages: AgentMessage[],
  ctx: SanitiseUnpairedCtx,
): Promise<AgentMessage[]> {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return messages;

  type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
  const toolCalls = (last.content as Array<{ type: string }>).filter((b): b is ToolCallBlock => b.type === "toolCall");
  if (toolCalls.length === 0) return messages;

  const synthesised: AgentMessage[] = [];
  for (const tc of toolCalls) {
    const tool = ctx.toolRegistry.get(tc.name);
    const canReExecute = tool !== undefined && (tc.name === "agent" || tool.idempotentOnReplay === true);
    if (canReExecute && tool !== undefined) {
      try {
        const out = await tool.execute(tc.arguments, ctx.env, {
          swarmContext: ctx.swarmContext,
          tool_call_id: tc.id,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        const content: (TextContent | ImageContent)[] =
          out.content !== undefined && out.content.length > 0
            ? out.content
            : [{ type: "text", text: out.text } as TextContent];
        synthesised.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content,
          isError: out.is_error === true,
          timestamp: Date.now(),
        } as unknown as AgentMessage);
      } catch (err) {
        synthesised.push({
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: [
            {
              type: "text",
              text: `Tool '${tc.name}' rehydrate re-execution threw: ${err instanceof Error ? err.message : String(err)}`,
            } as TextContent,
          ],
          isError: true,
          timestamp: Date.now(),
        } as unknown as AgentMessage);
      }
    } else {
      synthesised.push({
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: [
          {
            type: "text",
            text: `Tool '${tc.name}' execution was interrupted by a daemon restart and cannot be safely replayed (the prior partial effect on the working tree is unknown). Re-issue the call if you still need this work; verify state first if the operation was destructive.`,
          } as TextContent,
        ],
        isError: true,
        timestamp: Date.now(),
      } as unknown as AgentMessage);
    }
  }

  return [...messages, ...synthesised];
}

async function readFileBytes(absolutePath: string): Promise<Buffer> {
  // Direct fs read so we get bytes for image MIME sniffing. Tools
  // shouldn't reach into node:fs in general (handler discipline test
  // forbids it on handlers), but the workspace package owns the
  // filesystem layer.
  return fsReadFile(absolutePath);
}
